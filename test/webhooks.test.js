import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  CABECERA_EVENTO,
  CABECERA_FIRMA,
  crearEmisorWebhooks,
  esReintentable,
  firmarCuerpo,
  identificadorDeAviso,
} from "../src/webhooks.js";
import { crearEvento } from "../src/evento.js";

/** Evento de ejemplo: el mismo hecho que se publica en todos los casos. */
function eventoDePrueba(extra = {}) {
  return crearEvento({
    guia: "GUI-9001",
    transportadora: "servientrega",
    estado: "en_transito",
    ocurridoEn: "2026-11-02T09:00:00-05:00",
    ...extra,
  });
}

/**
 * Emisor con el envio y la espera reemplazados: sin red y sin dormir.
 * @param {{
 *   respuestas?: Array<number|Error>,
 *   intentosMaximos?: number,
 * }} [opciones]
 */
function emisorDePrueba(opciones = {}) {
  const respuestas = [...(opciones.respuestas ?? [200])];
  /** @type {Array<{url: string, cabeceras: Record<string, string>, cuerpo: any}>} */
  const llamadas = [];
  /** @type {Array<number>} */
  const esperas = [];

  const emisor = crearEmisorWebhooks({
    intentosMaximos: opciones.intentosMaximos ?? 3,
    tiempoBaseMs: 100,
    tiempoMaximoMs: 400,
    enviar: async (url, peticion) => {
      llamadas.push({
        url,
        cabeceras: peticion.headers,
        cuerpo: JSON.parse(peticion.body),
      });

      const siguiente = respuestas.length > 1 ? respuestas.shift() : respuestas[0];

      if (siguiente instanceof Error) {
        throw siguiente;
      }

      return { status: Number(siguiente) };
    },
    esperar: async (milisegundos) => {
      esperas.push(milisegundos);
    },
  });

  return { emisor, llamadas, esperas };
}

describe("firma de los avisos", () => {
  test("la firma es HMAC-SHA256 del cuerpo con el secreto, en hexadecimal", () => {
    const cuerpo = JSON.stringify({ hola: "mundo" });
    const firma = firmarCuerpo(cuerpo, "secreto-de-prueba-1234");

    const esperada = createHmac("sha256", "secreto-de-prueba-1234")
      .update(cuerpo, "utf8")
      .digest("hex");

    assert.equal(firma, `sha256=${esperada}`);
  });

  test("dos secretos distintos producen firmas distintas", () => {
    const cuerpo = "{}";
    assert.notEqual(firmarCuerpo(cuerpo, "secreto-uno-1234567"), firmarCuerpo(cuerpo, "secreto-dos-1234567"));
  });

  test("el identificador del aviso es estable para el mismo hecho", () => {
    assert.equal(
      identificadorDeAviso(eventoDePrueba()),
      identificadorDeAviso(eventoDePrueba()),
    );
    assert.match(identificadorDeAviso(eventoDePrueba()), /^avi-[0-9a-f]{32}$/);
  });

  test("el identificador cambia cuando cambia el hecho", () => {
    assert.notEqual(
      identificadorDeAviso(eventoDePrueba()),
      identificadorDeAviso(eventoDePrueba({ estado: "entregado" })),
    );
  });
});

describe("clasificacion de la respuesta del suscriptor", () => {
  test("los errores del servidor y los pasajeros se reintentan", () => {
    assert.equal(esReintentable(500), true);
    assert.equal(esReintentable(503), true);
    assert.equal(esReintentable(429), true);
    assert.equal(esReintentable(408), true);
  });

  test("un rechazo del contenido no se reintenta", () => {
    assert.equal(esReintentable(400), false);
    assert.equal(esReintentable(404), false);
    assert.equal(esReintentable(422), false);
  });
});

describe("suscripciones", () => {
  test("registra una suscripcion y no devuelve el secreto", () => {
    const { emisor } = emisorDePrueba();
    const creada = emisor.suscribir({
      url: "https://ejemplo.com/webhooks/rastreo",
      secreto: "secreto-compartido-1234",
      descripcion: "Sistema de notificaciones",
    });

    assert.match(creada.id, /^sus-/);
    assert.equal(creada.url, "https://ejemplo.com/webhooks/rastreo");
    assert.equal(creada.descripcion, "Sistema de notificaciones");
    assert.equal("secreto" in creada, false);
    assert.equal(JSON.stringify(emisor.suscripciones()).includes("secreto-compartido-1234"), false);
  });

  test("rechaza un secreto corto y nombra el campo", () => {
    const { emisor } = emisorDePrueba();

    assert.throws(
      () => emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "corto" }),
      (error) => {
        assert.equal(error.name, "ErrorDeValidacion");
        assert.equal(error.campo, "secreto");
        assert.match(error.message, /al menos 16 caracteres/);
        return true;
      },
    );
  });

  test("rechaza una url que no es http ni https", () => {
    const { emisor } = emisorDePrueba();

    assert.throws(
      () => emisor.suscribir({ url: "ftp://ejemplo.com/h", secreto: "secreto-compartido-1234" }),
      /debe usar http o https/,
    );
  });

  test("no permite dos suscripciones a la misma url", () => {
    const { emisor } = emisorDePrueba();
    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    assert.throws(
      () => emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "otro-secreto-123456" }),
      (error) => {
        assert.equal(error.codigo, "SUSCRIPCION_DUPLICADA");
        return true;
      },
    );
  });

  test("elimina una suscripcion y responde si existia", () => {
    const { emisor } = emisorDePrueba();
    const creada = emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    assert.equal(emisor.eliminar(creada.id), true);
    assert.equal(emisor.pendientes(), 0);
    assert.equal(emisor.eliminar(creada.id), false);
  });
});

describe("emision de avisos", () => {
  test("sin suscripciones no envia nada", async () => {
    const { emisor, llamadas } = emisorDePrueba();
    assert.deepEqual(await emisor.emitir(eventoDePrueba()), []);
    assert.equal(llamadas.length, 0);
  });

  test("entrega el evento con su firma y su identificador", async () => {
    const { emisor, llamadas } = emisorDePrueba();
    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    const evento = eventoDePrueba();
    const [resultado] = await emisor.emitir(evento);

    assert.equal(resultado.exito, true);
    assert.equal(resultado.intentos, 1);
    assert.equal(resultado.estado, 200);
    assert.equal(llamadas.length, 1);

    const llamada = llamadas[0];
    assert.equal(llamada.cuerpo.tipo, "evento.rastreo");
    assert.equal(llamada.cuerpo.id, identificadorDeAviso(evento));
    assert.equal(llamada.cuerpo.datos.guia, "GUI-9001");
    assert.equal(llamada.cabeceras[CABECERA_EVENTO], llamada.cuerpo.id);

    const esperada = createHmac("sha256", "secreto-compartido-1234")
      .update(JSON.stringify(llamada.cuerpo), "utf8")
      .digest("hex");
    assert.equal(llamada.cabeceras[CABECERA_FIRMA], `sha256=${esperada}`);
  });

  test("reintenta un 503 y termina en verde", async () => {
    const { emisor, llamadas, esperas } = emisorDePrueba({ respuestas: [503, 200] });
    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    const [resultado] = await emisor.emitir(eventoDePrueba());

    assert.equal(resultado.exito, true);
    assert.equal(resultado.intentos, 2);
    assert.equal(llamadas.length, 2);
    assert.equal(llamadas[1].cabeceras["x-intento"], "2");
    // La espera crece entre intentos: una sola espera, de la base.
    assert.deepEqual(esperas, [100]);
  });

  test("reintenta cuando la conexion falla", async () => {
    const { emisor, llamadas } = emisorDePrueba({
      respuestas: [new Error("ECONNREFUSED"), 200],
    });
    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    const [resultado] = await emisor.emitir(eventoDePrueba());

    assert.equal(resultado.exito, true);
    assert.equal(resultado.intentos, 2);
    assert.equal(llamadas.length, 2);
  });

  test("se rinde al agotar los intentos y reporta el ultimo estado", async () => {
    const { emisor, llamadas } = emisorDePrueba({ respuestas: [500], intentosMaximos: 3 });
    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    const [resultado] = await emisor.emitir(eventoDePrueba());

    assert.equal(resultado.exito, false);
    assert.equal(resultado.intentos, 3);
    assert.equal(resultado.estado, 500);
    assert.match(resultado.error, /Se agotaron los intentos/);
    assert.equal(llamadas.length, 3);
  });

  test("un 422 no se reintenta", async () => {
    const { emisor, llamadas } = emisorDePrueba({ respuestas: [422] });
    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    const [resultado] = await emisor.emitir(eventoDePrueba());

    assert.equal(resultado.exito, false);
    assert.equal(resultado.intentos, 1);
    assert.equal(resultado.estado, 422);
    assert.equal(llamadas.length, 1);
  });

  test("entrega a cada suscripcion y reporta una por una", async () => {
    const { emisor, llamadas } = emisorDePrueba();
    emisor.suscribir({ url: "https://uno.example.com/h", secreto: "secreto-compartido-1234" });
    emisor.suscribir({ url: "https://dos.example.com/h", secreto: "secreto-compartido-5678" });

    const resultados = await emisor.emitir(eventoDePrueba());

    assert.equal(resultados.length, 2);
    assert.equal(resultados.every((resultado) => resultado.exito), true);
    assert.equal(llamadas.length, 2);
    // Cada suscriptor tiene su propia firma.
    assert.notEqual(llamadas[0].cabeceras[CABECERA_FIRMA], llamadas[1].cabeceras[CABECERA_FIRMA]);
  });

  test("los avisos de una suscripcion conservan el orden de emision", async () => {
    /** @type {Array<string>} */
    const orden = [];
    const emisor = crearEmisorWebhooks({
      intentosMaximos: 1,
      enviar: async (_url, peticion) => {
        const cuerpo = JSON.parse(peticion.body);
        // El primero tarda mas que el segundo: sin cola, llegaria al reves.
        await new Promise((resolver) => setTimeout(resolver, cuerpo.datos.estado === "generado" ? 40 : 0));
        orden.push(cuerpo.datos.estado);
        return { status: 200 };
      },
      esperar: async () => {},
    });

    emisor.suscribir({ url: "https://ejemplo.com/h", secreto: "secreto-compartido-1234" });

    const primero = emisor.emitir(eventoDePrueba({ estado: "generado" }));
    const segundo = emisor.emitir(eventoDePrueba({ estado: "en_transito", ocurridoEn: "2026-11-03T09:00:00-05:00" }));

    await Promise.all([primero, segundo]);
    assert.deepEqual(orden, ["generado", "en_transito"]);
  });
});
