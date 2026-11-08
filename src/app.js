/**
 * Servidor HTTP de la API de rastreo.
 *
 * Expone el chequeo de salud, el registro de eventos y la consulta de estado
 * por numero de guia. Cada evento nuevo se avisa a las suscripciones de
 * webhook registradas.
 */

import { createServer } from "node:http";

import { crearAlmacen } from "./almacen.js";
import { consultarGuia, normalizarGuia } from "./consulta.js";
import { crearEvento, ErrorDeValidacion } from "./evento.js";
import { crearRegistro } from "./registro.js";
import { traducirEvento } from "./transportadoras.js";
import { crearEmisorWebhooks } from "./webhooks.js";

/** Tamano maximo del cuerpo de una peticion, en bytes. */
export const LIMITE_CUERPO = 1024 * 100;

/**
 * Escribe una respuesta JSON con su codigo de estado.
 * @param {import("node:http").ServerResponse} respuesta
 * @param {number} codigo
 * @param {unknown} cuerpo
 */
function responderJson(respuesta, codigo, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  respuesta.writeHead(codigo, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(texto),
  });
  respuesta.end(texto);
}

/**
 * Lee el cuerpo de la peticion y lo interpreta como objeto JSON.
 *
 * Un cuerpo vacio o mal formado no se adivina: se rechaza con el campo
 * `cuerpo` para que el cliente sepa que el problema no esta en sus datos de
 * negocio sino en lo que mando.
 * @param {import("node:http").IncomingMessage} peticion
 * @returns {Promise<Record<string, unknown>>}
 */
function leerCuerpo(peticion) {
  return new Promise((resolver, rechazar) => {
    /** @type {Array<Buffer>} */
    const partes = [];
    let tamano = 0;
    let rechazado = false;

    peticion.on("data", (parte) => {
      if (rechazado) {
        return;
      }

      tamano += parte.length;

      if (tamano > LIMITE_CUERPO) {
        rechazado = true;
        rechazar(
          new ErrorDeValidacion(
            "cuerpo",
            `El cuerpo de la peticion no puede pasar de ${LIMITE_CUERPO} bytes.`,
          ),
        );
        peticion.destroy();
        return;
      }

      partes.push(parte);
    });

    peticion.on("error", (error) => {
      if (!rechazado) {
        rechazado = true;
        rechazar(error);
      }
    });

    peticion.on("end", () => {
      if (rechazado) {
        return;
      }

      const texto = Buffer.concat(partes).toString("utf8").trim();

      if (texto === "") {
        rechazar(new ErrorDeValidacion("cuerpo", "El cuerpo de la peticion esta vacio."));
        return;
      }

      /** @type {unknown} */
      let datos;

      try {
        datos = JSON.parse(texto);
      } catch {
        rechazar(new ErrorDeValidacion("cuerpo", "El cuerpo de la peticion no es JSON valido."));
        return;
      }

      if (datos === null || typeof datos !== "object" || Array.isArray(datos)) {
        rechazar(new ErrorDeValidacion("cuerpo", "El cuerpo de la peticion debe ser un objeto JSON."));
        return;
      }

      resolver(/** @type {Record<string, unknown>} */ (datos));
    });
  });
}

/**
 * Convierte el cuerpo de una peticion en un evento canonico.
 *
 * Se aceptan las dos formas en que llega un movimiento: tal como lo reporta la
 * transportadora (con `estadoOriginal`) o ya traducido (con `estado`). El
 * adaptador tiene la ultima palabra sobre la traduccion.
 * @param {Record<string, unknown>} datos
 * @returns {object}
 */
export function eventoDesdeCuerpo(datos) {
  if ("estadoOriginal" in datos && datos.estadoOriginal !== null && datos.estadoOriginal !== undefined) {
    return traducirEvento(
      /** @type {Parameters<typeof traducirEvento>[0]} */ (datos),
    );
  }

  return crearEvento(
    /** @type {Parameters<typeof crearEvento>[0]} */ (datos),
  );
}

/**
 * Traduce un error de dominio en la respuesta HTTP que le corresponde.
 * @param {import("node:http").ServerResponse} respuesta
 * @param {unknown} error
 */
function responderError(respuesta, error) {
  if (error instanceof Error) {
    const codigo = /** @type {{codigo?: string}} */ (error).codigo;

    if (codigo === "NO_ENCONTRADA") {
      responderJson(respuesta, 404, { error: error.message });
      return;
    }

    if (codigo === "CONFLICTO_IDEMPOTENCIA") {
      responderJson(respuesta, 409, { error: error.message, campo: "claveIdempotencia" });
      return;
    }

    if (codigo === "ENVIO_CERRADO") {
      responderJson(respuesta, 409, { error: error.message, campo: "guia" });
      return;
    }

    if (codigo === "SUSCRIPCION_DUPLICADA") {
      responderJson(respuesta, 409, { error: error.message, campo: "url" });
      return;
    }

    if (error.name === "ErrorDeValidacion") {
      responderJson(respuesta, 400, {
        error: error.message,
        campo: /** @type {{campo?: string}} */ (error).campo ?? null,
      });
      return;
    }
  }

  responderJson(respuesta, 500, { error: "Error interno del servidor." });
}

/**
 * Crea el manejador de peticiones con su almacen y su registro.
 * @param {{
 *   agregar: (evento: object) => object,
 *   deGuia: (guia: string) => Array<object>,
 *   total: () => number,
 * }} almacen
 * @param {{emisor?: ReturnType<typeof crearEmisorWebhooks>}} [opciones]
 * @returns {(peticion: import("node:http").IncomingMessage, respuesta: import("node:http").ServerResponse) => Promise<void>}
 */
export function crearManejador(almacen, opciones = {}) {
  const registro = crearRegistro(almacen);
  const emisor = opciones.emisor ?? crearEmisorWebhooks();

  /**
   * Avisa a los suscriptores sin retrasar la respuesta al que publico el
   * evento. Un webhook caido no puede tumbar la recepcion: los fallos se
   * quedan en el resultado de la entrega y no en la peticion original.
   * @param {object} evento
   */
  function avisar(evento) {
    emisor.emitir(evento).catch(() => {
      // El emisor ya reintenta y reporta por suscripcion; aqui solo se evita
      // que un rechazo quede sin manejar.
    });
  }

  /**
   * @param {import("node:http").IncomingMessage} peticion
   * @param {import("node:http").ServerResponse} respuesta
   */
  return async function manejarPeticion(peticion, respuesta) {
    const url = new URL(peticion.url ?? "/", "http://localhost");

    if (peticion.method === "GET" && url.pathname === "/salud") {
      responderJson(respuesta, 200, { estado: "ok", servicio: "api-rastreo-envios" });
      return;
    }

    if (peticion.method === "POST" && url.pathname === "/suscripciones") {
      try {
        const datos = await leerCuerpo(peticion);
        responderJson(respuesta, 201, { suscripcion: emisor.suscribir(datos) });
      } catch (error) {
        responderError(respuesta, error);
      }
      return;
    }

    if (peticion.method === "GET" && url.pathname === "/suscripciones") {
      responderJson(respuesta, 200, { suscripciones: emisor.suscripciones() });
      return;
    }

    const suscripcion = url.pathname.match(/^\/suscripciones\/([^/]+)$/);

    if (peticion.method === "DELETE" && suscripcion !== null) {
      try {
        const borrada = emisor.eliminar(decodeURIComponent(suscripcion[1]));

        if (!borrada) {
          responderJson(respuesta, 404, { error: "La suscripcion no existe." });
          return;
        }

        responderJson(respuesta, 200, { eliminada: true });
      } catch (error) {
        responderError(respuesta, error);
      }
      return;
    }

    if (peticion.method === "POST" && url.pathname === "/eventos") {
      try {
        const datos = await leerCuerpo(peticion);
        const evento = eventoDesdeCuerpo(datos);

        const claveDelCuerpo = datos.claveIdempotencia;
        const claveDeCabecera = peticion.headers["idempotency-key"];
        const claveIdempotencia = claveDelCuerpo ?? claveDeCabecera;

        const resultado = registro.registrar(evento, { claveIdempotencia });

        if (!resultado.duplicado) {
          avisar(resultado.evento);
        }

        responderJson(respuesta, resultado.duplicado ? 200 : 201, {
          evento: resultado.evento,
          duplicado: resultado.duplicado,
          totalEventos: resultado.total,
        });
      } catch (error) {
        responderError(respuesta, error);
      }
      return;
    }

    const consulta = url.pathname.match(/^\/guias\/([^/]+)$/);

    if (peticion.method === "GET" && consulta !== null) {
      try {
        responderJson(respuesta, 200, consultarGuia(almacen, consulta[1]));
      } catch (error) {
        responderError(respuesta, error);
      }
      return;
    }

    const deGuia = url.pathname.match(/^\/guias\/([^/]+)\/eventos$/);

    if (peticion.method === "POST" && deGuia !== null) {
      try {
        const guia = normalizarGuia(deGuia[1]);
        const datos = await leerCuerpo(peticion);

        if (datos.guia !== undefined && datos.guia !== null && datos.guia !== "") {
          const guiaDelCuerpo = normalizarGuia(datos.guia);

          if (guiaDelCuerpo !== guia) {
            throw new ErrorDeValidacion(
              "guia",
              `El cuerpo dice la guia "${guiaDelCuerpo}" y la ruta dice "${guia}".`,
            );
          }
        }

        const evento = eventoDesdeCuerpo({ ...datos, guia });

        const claveDelCuerpo = datos.claveIdempotencia;
        const claveDeCabecera = peticion.headers["idempotency-key"];
        const claveIdempotencia = claveDelCuerpo ?? claveDeCabecera;

        const resultado = registro.registrar(evento, { claveIdempotencia });

        if (!resultado.duplicado) {
          avisar(resultado.evento);
        }

        responderJson(respuesta, resultado.duplicado ? 200 : 201, {
          evento: resultado.evento,
          duplicado: resultado.duplicado,
          totalEventos: resultado.total,
        });
      } catch (error) {
        responderError(respuesta, error);
      }
      return;
    }

    responderJson(respuesta, 404, { error: "Ruta no encontrada." });
  };
}

/** Almacen por defecto del servidor: uno solo por proceso. */
const almacenPorDefecto = crearAlmacen();

/**
 * Crea el servidor HTTP sin ponerlo a escuchar.
 * @param {{
 *   almacen?: {agregar: (evento: object) => object, deGuia: (guia: string) => Array<object>, total: () => number},
 *   emisor?: ReturnType<typeof crearEmisorWebhooks>,
 * }} opciones
 * @returns {import("node:http").Server}
 */
export function crearServidor(opciones = {}) {
  const almacen = opciones.almacen ?? almacenPorDefecto;
  return createServer(crearManejador(almacen, { emisor: opciones.emisor }));
}
