import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { crearServidor } from "../src/app.js";
import { crearAlmacen } from "../src/almacen.js";
import { CABECERA_FIRMA, crearEmisorWebhooks } from "../src/webhooks.js";

/**
 * Levanta un servidor con su almacen y un emisor que no toca la red.
 */
async function levantarServidor() {
  const almacen = crearAlmacen();
  /** @type {Array<{url: string, cabeceras: Record<string, string>, cuerpo: any}>} */
  const avisos = [];

  const emisor = crearEmisorWebhooks({
    intentosMaximos: 2,
    tiempoBaseMs: 10,
    esperar: async () => {},
    enviar: async (url, peticion) => {
      avisos.push({
        url,
        cabeceras: peticion.headers,
        cuerpo: JSON.parse(peticion.body),
      });
      return { status: 200 };
    },
  });

  const servidor = crearServidor({ almacen, emisor });
  await new Promise((resolver) => servidor.listen(0, "127.0.0.1", resolver));
  const direccion = servidor.address();

  return {
    almacen,
    emisor,
    avisos,
    base: `http://127.0.0.1:${direccion.port}`,
    cerrar: () => new Promise((resolver) => servidor.close(resolver)),
  };
}

/**
 * Espera a que se cumpla una condicion, sin dormir de mas.
 * @param {() => boolean} condicion
 */
async function esperarA(condicion) {
  for (let intento = 0; intento < 100; intento += 1) {
    if (condicion()) {
      return;
    }
    await new Promise((resolver) => setTimeout(resolver, 10));
  }
  throw new Error("La condicion no se cumplio a tiempo.");
}

describe("suscripciones por HTTP", () => {
  /** @type {Awaited<ReturnType<typeof levantarServidor>>} */
  let contexto;

  before(async () => {
    contexto = await levantarServidor();
  });

  after(async () => {
    await contexto.cerrar();
  });

  test("POST /suscripciones registra y no devuelve el secreto", async () => {
    const respuesta = await fetch(`${contexto.base}/suscripciones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://ejemplo.com/webhooks/rastreo",
        secreto: "secreto-compartido-1234",
        descripcion: "Notificaciones",
      }),
    });

    assert.equal(respuesta.status, 201);
    const cuerpo = await respuesta.json();
    assert.match(cuerpo.suscripcion.id, /^sus-/);
    assert.equal(JSON.stringify(cuerpo).includes("secreto-compartido-1234"), false);
  });

  test("POST /suscripciones con secreto corto responde 400 y nombra el campo", async () => {
    const respuesta = await fetch(`${contexto.base}/suscripciones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://ejemplo.com/otro", secreto: "corto" }),
    });

    assert.equal(respuesta.status, 400);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.campo, "secreto");
  });

  test("POST /suscripciones repetida responde 409", async () => {
    const datos = { url: "https://repetida.example.com/h", secreto: "secreto-compartido-1234" };

    const primera = await fetch(`${contexto.base}/suscripciones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(datos),
    });
    assert.equal(primera.status, 201);

    const segunda = await fetch(`${contexto.base}/suscripciones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(datos),
    });
    assert.equal(segunda.status, 409);

    const cuerpo = await segunda.json();
    assert.equal(cuerpo.campo, "url");
  });

  test("GET /suscripciones lista las registradas", async () => {
    const respuesta = await fetch(`${contexto.base}/suscripciones`);
    assert.equal(respuesta.status, 200);

    const cuerpo = await respuesta.json();
    assert.ok(Array.isArray(cuerpo.suscripciones));
    assert.ok(cuerpo.suscripciones.length >= 1);
    assert.equal(JSON.stringify(cuerpo).includes("secreto-compartido"), false);
  });

  test("DELETE /suscripciones/:id borra y un id desconocido responde 404", async () => {
    const creada = contexto.emisor.suscribir({
      url: "https://borrable.example.com/h",
      secreto: "secreto-compartido-1234",
    });

    const respuesta = await fetch(`${contexto.base}/suscripciones/${creada.id}`, { method: "DELETE" });
    assert.equal(respuesta.status, 200);

    const otra = await fetch(`${contexto.base}/suscripciones/${creada.id}`, { method: "DELETE" });
    assert.equal(otra.status, 404);
  });
});

describe("emision de webhooks al registrar un evento", () => {
  /** @type {Awaited<ReturnType<typeof levantarServidor>>} */
  let contexto;

  before(async () => {
    contexto = await levantarServidor();
    contexto.emisor.suscribir({
      url: "https://ejemplo.com/webhooks/rastreo",
      secreto: "secreto-compartido-1234",
    });
  });

  after(async () => {
    await contexto.cerrar();
  });

  test("un evento nuevo dispara el aviso firmado", async () => {
    const respuesta = await fetch(`${contexto.base}/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guia: "GUI-7001",
        transportadora: "Servientrega",
        estadoOriginal: "EN REPARTO",
        ocurridoEn: "2026-11-02T08:15:00-05:00",
        ciudad: "Medellin",
      }),
    });

    assert.equal(respuesta.status, 201);
    await esperarA(() => contexto.avisos.length === 1);

    const aviso = contexto.avisos[0];
    assert.equal(aviso.cuerpo.tipo, "evento.rastreo");
    assert.equal(aviso.cuerpo.datos.guia, "GUI-7001");
    assert.equal(aviso.cuerpo.datos.estado, "en_transito");

    const esperada = createHmac("sha256", "secreto-compartido-1234")
      .update(JSON.stringify(aviso.cuerpo), "utf8")
      .digest("hex");
    assert.equal(aviso.cabeceras[CABECERA_FIRMA], `sha256=${esperada}`);
  });

  test("un evento duplicado no vuelve a avisar", async () => {
    const cuerpo = {
      guia: "GUI-7002",
      transportadora: "Servientrega",
      estadoOriginal: "EN REPARTO",
      ocurridoEn: "2026-11-02T10:15:00-05:00",
    };

    const primera = await fetch(`${contexto.base}/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    assert.equal(primera.status, 201);
    await esperarA(() => contexto.avisos.length === 2);

    const segunda = await fetch(`${contexto.base}/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    assert.equal(segunda.status, 200);

    await new Promise((resolver) => setTimeout(resolver, 60));
    assert.equal(contexto.avisos.length, 2);
  });
});
