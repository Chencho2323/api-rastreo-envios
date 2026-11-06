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
