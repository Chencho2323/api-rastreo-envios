/**
 * Emision de webhooks a las aplicaciones del negocio.
 *
 * Cuando entra un evento nuevo, las otras aplicaciones no van a consultar la
 * API cada minuto: se les avisa. Ese aviso tiene tres problemas que este
 * modulo resuelve.
 *
 * - Autenticidad: el cuerpo se firma con HMAC-SHA256 y el secreto que se
 *   acordo con cada suscriptor. Quien recibe puede comprobar que el aviso
 *   salio de aqui y que nadie lo cambio en el camino.
 * - Disponibilidad: el otro lado se cae, reinicia o responde 503. El aviso se
 *   reintenta con espera creciente y solo se da por perdido al agotar los
 *   intentos.
 * - Orden: los avisos de una misma suscripcion salen uno detras de otro, para
 *   que un "entregado" no llegue antes que el "en_transito" que lo precede.
 *
 * El emisor no sabe de HTTP entrante ni de la base: recibe eventos canonicos
 * y devuelve el resultado de cada entrega.
 */

import { createHmac, randomUUID } from "node:crypto";

import { huellaDeEvento } from "./registro.js";
import { ErrorDeValidacion } from "./evento.js";

/** Cantidad maxima de suscripciones registradas. */
export const MAXIMO_SUSCRIPCIONES = 100;

/** Longitud minima del secreto compartido con un suscriptor. */
export const LONGITUD_MINIMA_SECRETO = 16;

/** Cabecera donde viaja la firma del cuerpo. */
export const CABECERA_FIRMA = "x-firma-sha256";

/** Cabecera con el identificador estable del evento. */
export const CABECERA_EVENTO = "x-evento-id";

/** Tipo de aviso que manda esta API. */
export const TIPO_AVISO = "evento.rastreo";

/**
 * Estados HTTP que no se reintentan.
 *
 * Un 400 o un 404 dicen que el suscriptor rechazo el aviso y reintentarlo solo
 * gasta tiempo. Un 408 o un 429 si son pasajeros: el otro lado esta saturado o
 * se le vencio la espera, y vale la pena volver a intentar.
 * @param {number} estado
 * @returns {boolean}
 */
export function esReintentable(estado) {
  if (estado === 408 || estado === 429) {
    return true;
  }
  return estado >= 500;
}

/**
 * Firma un cuerpo con el secreto del suscriptor.
 * @param {string} cuerpo
 * @param {string} secreto
 * @returns {string} Firma con el prefijo `sha256=`, lista para la cabecera.
 */
export function firmarCuerpo(cuerpo, secreto) {
  const firma = createHmac("sha256", secreto).update(cuerpo, "utf8").digest("hex");
  return `sha256=${firma}`;
}

/**
 * Calcula el identificador estable de un aviso.
 *
 * Sale de la huella del evento, asi que un reintento lleva el mismo id y el
 * suscriptor puede descartar la copia sin volver a procesar el movimiento.
 * @param {object} evento
 * @returns {string}
 */
export function identificadorDeAviso(evento) {
  return `avi-${huellaDeEvento(/** @type {any} */ (evento)).slice(0, 32)}`;
}

/**
 * Valida la URL de un suscriptor.
 * @param {unknown} valor
 * @returns {string}
 */
function validarUrl(valor) {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new ErrorDeValidacion("url", 'El campo "url" es obligatorio.');
  }

  /** @type {URL} */
  let url;

  try {
    url = new URL(valor.trim());
  } catch {
    throw new ErrorDeValidacion("url", `La url "${valor}" no es una direccion valida.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ErrorDeValidacion("url", "La url del webhook debe usar http o https.");
  }

  return url.toString();
}

/**
 * Valida el secreto compartido con un suscriptor.
 *
 * Se exige un minimo de longitud porque un secreto corto se adivina y la firma
 * deja de servir para nada. El secreto nunca se devuelve en las respuestas.
 * @param {unknown} valor
 * @returns {string}
 */
function validarSecreto(valor) {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new ErrorDeValidacion("secreto", 'El campo "secreto" es obligatorio.');
  }

  const limpio = valor.trim();

  if (limpio.length < LONGITUD_MINIMA_SECRETO) {
    throw new ErrorDeValidacion(
      "secreto",
      `El secreto debe tener al menos ${LONGITUD_MINIMA_SECRETO} caracteres.`,
    );
  }

  return limpio;
}

/**
 * Espera la cantidad de milisegundos indicada.
 * @param {number} milisegundos
 * @returns {Promise<void>}
 */
function esperarPorDefecto(milisegundos) {
  return new Promise((resolver) => setTimeout(resolver, milisegundos));
}

/**
 * Envia una peticion HTTP con limite de tiempo.
 * @param {string} url
 * @param {{method: string, headers: Record<string, string>, body: string}} opciones
 * @returns {Promise<{status: number}>}
 */
async function enviarPorDefecto(url, opciones) {
  const respuesta = await fetch(url, {
    ...opciones,
    signal: AbortSignal.timeout(10_000),
  });
  // El cuerpo de la respuesta no interesa: basta con el estado, y no leerlo
  // deja que la conexion se cierre sola.
  return { status: respuesta.status };
}

/**
 * Crea el emisor de webhooks.
 *
 * `enviar` y `esperar` se pueden reemplazar para probar los reintentos sin
 * tocar la red ni dormir el proceso.
 * @param {{
 *   enviar?: (url: string, opciones: {method: string, headers: Record<string, string>, body: string}) => Promise<{status: number}>,
 *   esperar?: (milisegundos: number) => Promise<void>,
 *   intentosMaximos?: number,
 *   tiempoBaseMs?: number,
 *   tiempoMaximoMs?: number,
 * }} [opciones]
 * @returns {{
 *   suscribir: (datos: {url: unknown, secreto: unknown, descripcion?: unknown}) => object,
 *   suscripciones: () => Array<object>,
 *   eliminar: (id: unknown) => boolean,
 *   emitir: (evento: object) => Promise<Array<object>>,
 *   pendientes: () => number,
 * }}
 */
export function crearEmisorWebhooks(opciones = {}) {
  const enviar = opciones.enviar ?? enviarPorDefecto;
  const esperar = opciones.esperar ?? esperarPorDefecto;
  const intentosMaximos = opciones.intentosMaximos ?? 5;
  const tiempoBaseMs = opciones.tiempoBaseMs ?? 500;
  const tiempoMaximoMs = opciones.tiempoMaximoMs ?? 30_000;

  if (!Number.isInteger(intentosMaximos) || intentosMaximos < 1) {
    throw new Error("Los intentos maximos deben ser un entero mayor o igual a 1.");
  }

  /** @type {Array<{id: string, url: string, secreto: string, descripcion: string|null, creadaEn: string}>} */
  const suscripciones = [];

  /** @type {Map<string, Promise<unknown>>} */
  const colas = new Map();

  /**
   * Espera creciente entre intentos: base, doble, doble, hasta el tope.
   * @param {number} intento
   * @returns {number}
   */
  function calcularEspera(intento) {
    return Math.min(tiempoBaseMs * 2 ** (intento - 1), tiempoMaximoMs);
  }

  /**
   * Arma el cuerpo y las cabeceras de un aviso.
   * @param {object} evento
   * @param {string} secreto
   * @param {number} intento
   * @returns {{texto: string, cabeceras: Record<string, string>}}
   */
  function armarAviso(evento, secreto, intento) {
    const id = identificadorDeAviso(evento);
    const texto = JSON.stringify({
      id,
      tipo: TIPO_AVISO,
      emitidoEn: new Date().toISOString(),
      datos: evento,
    });

    return {
      texto,
      cabeceras: {
        "content-type": "application/json; charset=utf-8",
        [CABECERA_EVENTO]: id,
        [CABECERA_FIRMA]: firmarCuerpo(texto, secreto),
        "x-intento": String(intento),
      },
    };
  }

  /**
   * Entrega un aviso con sus reintentos.
   * @param {{id: string, url: string, secreto: string}} suscripcion
   * @param {object} evento
   * @returns {Promise<{suscripcion: string, url: string, exito: boolean, intentos: number, estado: number|null, error: string|null}>}
   */
  async function entregar(suscripcion, evento) {
    let ultimoEstado = null;
    let ultimoError = null;

    for (let intento = 1; intento <= intentosMaximos; intento += 1) {
      const { texto, cabeceras } = armarAviso(evento, suscripcion.secreto, intento);

      try {
        const respuesta = await enviar(suscripcion.url, {
          method: "POST",
          headers: cabeceras,
          body: texto,
        });

        ultimoEstado = typeof respuesta?.status === "number" ? respuesta.status : null;
        ultimoError = null;

        if (ultimoEstado !== null && ultimoEstado >= 200 && ultimoEstado < 300) {
          return {
            suscripcion: suscripcion.id,
            url: suscripcion.url,
            exito: true,
            intentos: intento,
            estado: ultimoEstado,
            error: null,
          };
        }

        if (ultimoEstado !== null && !esReintentable(ultimoEstado)) {
          return {
            suscripcion: suscripcion.id,
            url: suscripcion.url,
            exito: false,
            intentos: intento,
            estado: ultimoEstado,
            error: `El suscriptor respondio ${ultimoEstado} y no se reintenta.`,
          };
        }
      } catch (error) {
        ultimoEstado = null;
        ultimoError = error instanceof Error ? error.message : String(error);
      }

      if (intento < intentosMaximos) {
        await esperar(calcularEspera(intento));
      }
    }

    return {
      suscripcion: suscripcion.id,
      url: suscripcion.url,
      exito: false,
      intentos: intentosMaximos,
      estado: ultimoEstado,
      error: ultimoError ?? "Se agotaron los intentos de entrega.",
    };
  }

  return {
    /**
     * Registra una suscripcion nueva.
     * @param {{url: unknown, secreto: unknown, descripcion?: unknown}} datos
     * @returns {{id: string, url: string, descripcion: string|null, creadaEn: string}}
     */
    suscribir(datos) {
      if (suscripciones.length >= MAXIMO_SUSCRIPCIONES) {
        throw new ErrorDeValidacion(
          "suscripciones",
          `No se pueden registrar mas de ${MAXIMO_SUSCRIPCIONES} suscripciones.`,
        );
      }

      const url = validarUrl(datos.url);
      const secreto = validarSecreto(datos.secreto);

      if (suscripciones.some((suscripcion) => suscripcion.url === url)) {
        const error = new ErrorDeValidacion("url", `La url "${url}" ya tiene una suscripcion.`);
        error.codigo = "SUSCRIPCION_DUPLICADA";
        throw error;
      }

      const descripcion =
        typeof datos.descripcion === "string" && datos.descripcion.trim() !== ""
          ? datos.descripcion.trim().slice(0, 120)
          : null;

      const suscripcion = {
        id: `sus-${randomUUID()}`,
        url,
        secreto,
        descripcion,
        creadaEn: new Date().toISOString(),
      };

      suscripciones.push(suscripcion);

      return { id: suscripcion.id, url, descripcion, creadaEn: suscripcion.creadaEn };
    },

    /**
     * Lista las suscripciones sin exponer los secretos.
     * @returns {Array<{id: string, url: string, descripcion: string|null, creadaEn: string}>}
     */
    suscripciones() {
      return suscripciones.map(({ id, url, descripcion, creadaEn }) => ({
        id,
        url,
        descripcion,
        creadaEn,
      }));
    },

    /**
     * Elimina una suscripcion por su id.
     * @param {unknown} id
     * @returns {boolean} `true` si existia.
     */
    eliminar(id) {
      if (typeof id !== "string" || id.trim() === "") {
        throw new ErrorDeValidacion("id", 'El campo "id" es obligatorio.');
      }

      const indice = suscripciones.findIndex((suscripcion) => suscripcion.id === id.trim());

      if (indice === -1) {
        return false;
      }

      suscripciones.splice(indice, 1);
      colas.delete(id.trim());
      return true;
    },

    /**
     * Emite un evento a todas las suscripciones.
     *
     * Cada suscripcion tiene su propia cola: los avisos se entregan en el
     * orden en que se emitieron. Las suscripciones avanzan en paralelo entre
     * si, para que una caida no retrase a las demas.
     * @param {object} evento
     * @returns {Promise<Array<object>>} Un resultado por suscripcion.
     */
    async emitir(evento) {
      if (evento === null || typeof evento !== "object") {
        throw new ErrorDeValidacion("evento", "El evento a emitir debe ser un objeto.");
      }

      const destinos = [...suscripciones];

      if (destinos.length === 0) {
        return [];
      }

      const entregas = destinos.map((suscripcion) => {
        const anterior = colas.get(suscripcion.id) ?? Promise.resolve();
        const actual = anterior.then(
          () => entregar(suscripcion, evento),
          () => entregar(suscripcion, evento),
        );

        // La cola guarda la promesa ya resuelta para no arrastrar un rechazo.
        colas.set(
          suscripcion.id,
          actual.then(
            () => undefined,
            () => undefined,
          ),
        );

        return actual;
      });

      return Promise.all(entregas);
    },

    /**
     * Cuenta las suscripciones vivas.
     * @returns {number}
     */
    pendientes() {
      return suscripciones.length;
    },
  };
}
