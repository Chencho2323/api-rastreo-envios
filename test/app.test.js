import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { crearServidor } from "../src/app.js";
import { crearAlmacen } from "../src/almacen.js";
import { crearEvento } from "../src/evento.js";

describe("servidor HTTP", () => {
  /** @type {import("node:http").Server} */
  let servidor;
  /** @type {string} */
  let base;

  before(async () => {
    servidor = crearServidor();
    await new Promise((resolver) => servidor.listen(0, "127.0.0.1", resolver));
    const direccion = servidor.address();
    base = `http://127.0.0.1:${direccion.port}`;
  });

  after(async () => {
    await new Promise((resolver) => servidor.close(resolver));
  });

  test("GET /salud responde 200 con el estado del servicio", async () => {
    const respuesta = await fetch(`${base}/salud`);
    assert.equal(respuesta.status, 200);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.estado, "ok");
    assert.equal(cuerpo.servicio, "api-rastreo-envios");
  });

  test("una ruta desconocida responde 404 con un mensaje en espanol", async () => {
    const respuesta = await fetch(`${base}/no-existe`);
    assert.equal(respuesta.status, 404);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.error, "Ruta no encontrada.");
  });

  test("un metodo distinto de GET en /salud responde 404", async () => {
    const respuesta = await fetch(`${base}/salud`, { method: "POST" });
    assert.equal(respuesta.status, 404);
  });
});

describe("GET /guias/:guia", () => {
  /** @type {import("node:http").Server} */
  let servidor;
  /** @type {string} */
  let base;
  /** @type {ReturnType<typeof crearAlmacen>} */
  let almacen;

  before(async () => {
    almacen = crearAlmacen();
    almacen.agregar(
      crearEvento({
        guia: "GUI-9001",
        transportadora: "servientrega",
        estado: "generado",
        ocurridoEn: "2026-11-01T08:00:00-05:00",
      }),
    );
    almacen.agregar(
      crearEvento({
        guia: "GUI-9001",
        transportadora: "servientrega",
        estado: "en_transito",
        ocurridoEn: "2026-11-02T09:00:00-05:00",
        ciudad: "Medellin",
      }),
    );

    servidor = crearServidor({ almacen });
    await new Promise((resolver) => servidor.listen(0, "127.0.0.1", resolver));
    const direccion = servidor.address();
    base = `http://127.0.0.1:${direccion.port}`;
  });

  after(async () => {
    await new Promise((resolver) => servidor.close(resolver));
  });

  test("responde 200 con el estado actual y el historial", async () => {
    const respuesta = await fetch(`${base}/guias/gui-9001`);
    assert.equal(respuesta.status, 200);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.guia, "GUI-9001");
    assert.equal(cuerpo.estado, "en_transito");
    assert.equal(cuerpo.cerrado, false);
    assert.equal(cuerpo.totalEventos, 2);
    assert.equal(cuerpo.eventos[1].ciudad, "Medellin");
  });

  test("una guia sin eventos responde 404", async () => {
    const respuesta = await fetch(`${base}/guias/GUI-0000`);
    assert.equal(respuesta.status, 404);

    const cuerpo = await respuesta.json();
    assert.match(cuerpo.error, /no tiene eventos registrados/);
  });

  test("una guia con caracteres invalidos responde 400 y nombra el campo", async () => {
    const respuesta = await fetch(`${base}/guias/GUI%209001`);
    assert.equal(respuesta.status, 400);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.campo, "guia");
  });
});

describe("POST /eventos", () => {
  /** @type {import("node:http").Server} */
  let servidor;
  /** @type {string} */
  let base;
  /** @type {ReturnType<typeof crearAlmacen>} */
  let almacen;

  before(async () => {
    almacen = crearAlmacen();
    servidor = crearServidor({ almacen });
    await new Promise((resolver) => servidor.listen(0, "127.0.0.1", resolver));
    const direccion = servidor.address();
    base = `http://127.0.0.1:${direccion.port}`;
  });

  after(async () => {
    await new Promise((resolver) => servidor.close(resolver));
  });

  /**
   * Publica un evento en la API.
   * @param {Record<string, unknown>} cuerpo
   * @param {Record<string, string>} [cabeceras]
   * @returns {Promise<Response>}
   */
  function publicar(cuerpo, cabeceras = {}) {
    return fetch(`${base}/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cabeceras },
      body: JSON.stringify(cuerpo),
    });
  }

  test("guarda un evento traducido y responde 201", async () => {
    const respuesta = await publicar({
      guia: "gui-9001",
      transportadora: "Servientrega",
      estadoOriginal: "EN REPARTO",
      ocurridoEn: "2026-11-02T08:15:00-05:00",
      ciudad: "Medellin",
    });

    assert.equal(respuesta.status, 201);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.duplicado, false);
    assert.equal(cuerpo.evento.guia, "GUI-9001");
    assert.equal(cuerpo.evento.estado, "en_transito");
    assert.equal(cuerpo.evento.codigoOriginal, "EN REPARTO");
    assert.equal(cuerpo.totalEventos, 1);
  });

  test("el reintento exacto responde 200 y no duplica", async () => {
    const cuerpo = {
      guia: "GUI-9002",
      transportadora: "tcc",
      estado: "generado",
      ocurridoEn: "2026-11-01T13:00:00Z",
    };

    const primera = await publicar(cuerpo);
    const segunda = await publicar(cuerpo);

    assert.equal(primera.status, 201);
    assert.equal(segunda.status, 200);

    const datos = await segunda.json();
    assert.equal(datos.duplicado, true);
    assert.equal(datos.totalEventos, 1);
  });

  test("acepta la clave de idempotencia por cabecera", async () => {
    const cuerpo = {
      guia: "GUI-9003",
      transportadora: "envia",
      estado: "generado",
      ocurridoEn: "2026-11-01T13:00:00Z",
      descripcion: "Guia creada",
    };

    await publicar(cuerpo, { "idempotency-key": "notif-100" });
    const reintento = await publicar(
      { ...cuerpo, descripcion: "Guia creada en el sistema" },
      { "idempotency-key": "notif-100" },
    );

    assert.equal(reintento.status, 200);
    assert.equal((await reintento.json()).totalEventos, 1);
  });

  test("un cuerpo que no es JSON responde 400 y nombra el campo", async () => {
    const respuesta = await fetch(`${base}/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ esto no es json",
    });

    assert.equal(respuesta.status, 400);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.campo, "cuerpo");
  });

  test("un estado sin equivalencia responde 400 con el valor original", async () => {
    const respuesta = await publicar({
      guia: "GUI-9004",
      transportadora: "coordinadora",
      estadoOriginal: "ESTADO RARO",
      ocurridoEn: "2026-11-01T13:00:00Z",
    });

    assert.equal(respuesta.status, 400);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.campo, "estadoOriginal");
    assert.match(cuerpo.error, /ESTADO RARO/);
  });

  test("un movimiento nuevo sobre una guia cerrada responde 409", async () => {
    await publicar({
      guia: "GUI-9005",
      transportadora: "tcc",
      estado: "entregado",
      ocurridoEn: "2026-11-02T14:00:00Z",
    });

    const respuesta = await publicar({
      guia: "GUI-9005",
      transportadora: "tcc",
      estado: "en_transito",
      ocurridoEn: "2026-11-03T08:00:00Z",
    });

    assert.equal(respuesta.status, 409);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.campo, "guia");
    assert.match(cuerpo.error, /esta cerrada/);
  });
});

describe("POST /guias/:guia/eventos", () => {
  /** @type {import("node:http").Server} */
  let servidor;
  /** @type {string} */
  let base;

  before(async () => {
    servidor = crearServidor();
    await new Promise((resolver) => servidor.listen(0, "127.0.0.1", resolver));
    const direccion = servidor.address();
    base = `http://127.0.0.1:${direccion.port}`;
  });

  after(async () => {
    await new Promise((resolver) => servidor.close(resolver));
  });

  test("toma la guia de la ruta y responde 201", async () => {
    const respuesta = await fetch(`${base}/guias/gui-9100/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transportadora: "interrapidisimo",
        ocurridoEn: "2026-11-02T09:00:00Z",
        estadoOriginal: "EN REPARTO",
      }),
    });

    assert.equal(respuesta.status, 201);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.evento.guia, "GUI-9100");
    assert.equal(cuerpo.evento.estado, "en_transito");
  });

  test("rechaza un cuerpo que contradice la guia de la ruta", async () => {
    const respuesta = await fetch(`${base}/guias/GUI-9101/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guia: "GUI-9999",
        transportadora: "tcc",
        estado: "generado",
        ocurridoEn: "2026-11-02T09:00:00Z",
      }),
    });

    assert.equal(respuesta.status, 400);

    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.campo, "guia");
    assert.match(cuerpo.error, /la ruta dice/);
  });

  test("una guia mal formada en la ruta responde 400", async () => {
    const respuesta = await fetch(`${base}/guias/GUI%209101/eventos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transportadora: "tcc", estado: "generado", ocurridoEn: "2026-11-02T09:00:00Z" }),
    });

    assert.equal(respuesta.status, 400);
  });
});
