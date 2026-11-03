import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { crearServidor } from "../src/app.js";

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
