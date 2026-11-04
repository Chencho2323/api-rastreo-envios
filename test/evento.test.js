import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ESTADOS,
  ErrorDeValidacion,
  compararEventos,
  crearEvento,
  esEstadoFinal,
  esEstadoValido,
  normalizarFecha,
  resumirEventos,
} from "../src/evento.js";

describe("crearEvento", () => {
  const base = {
    guia: "  gui-123456  ",
    transportadora: "Servientrega",
    estado: "EN_TRANSITO",
    ocurridoEn: "2026-10-30T14:05:00Z",
  };

  test("normaliza la guia y la transportadora", () => {
    const evento = crearEvento(base);
    assert.equal(evento.guia, "GUI-123456");
    assert.equal(evento.transportadora, "servientrega");
    assert.equal(evento.estado, "en_transito");
  });

  test("deja la fecha en ISO 8601 con milisegundos", () => {
    const evento = crearEvento({ ...base, ocurridoEn: "2026-10-30T09:05:00-05:00" });
    assert.equal(evento.ocurridoEn, "2026-10-30T14:05:00.000Z");
  });

  test("interpreta una fecha sin zona como UTC", () => {
    const evento = crearEvento({ ...base, ocurridoEn: "2026-10-30 09:05" });
    assert.equal(evento.ocurridoEn, "2026-10-30T09:05:00.000Z");
  });

  test("acepta un objeto Date y una marca de tiempo", () => {
    const conDate = crearEvento({ ...base, ocurridoEn: new Date("2026-10-30T14:05:00Z") });
    const conNumero = crearEvento({ ...base, ocurridoEn: Date.parse("2026-10-30T14:05:00Z") });

    assert.equal(conDate.ocurridoEn, "2026-10-30T14:05:00.000Z");
    assert.equal(conNumero.ocurridoEn, conDate.ocurridoEn);
  });

  test("guarda los campos opcionales como nulos cuando no llegan", () => {
    const evento = crearEvento(base);
    assert.equal(evento.codigoOriginal, null);
    assert.equal(evento.descripcion, null);
    assert.equal(evento.ciudad, null);
    assert.equal(evento.departamento, null);
    assert.equal(evento.datosCrudos, null);
  });

  test("conserva los datos crudos para poder auditar la traduccion", () => {
    const crudos = { estadoOriginal: "EN REPARTO", intentos: 2 };
    const evento = crearEvento({ ...base, datosCrudos: crudos });
    assert.deepEqual(evento.datosCrudos, crudos);
  });

  test("rechaza una guia vacia", () => {
    assert.throws(() => crearEvento({ ...base, guia: "   " }), ErrorDeValidacion);
  });

  test("rechaza un estado que no esta en el modelo", () => {
    assert.throws(
      () => crearEvento({ ...base, estado: "en_reparto" }),
      /no existe\. Los estados validos son/,
    );
  });

  test("rechaza una fecha invalida", () => {
    assert.throws(() => crearEvento({ ...base, ocurridoEn: "30 de octubre" }), /no es una fecha valida/);
  });

  test("rechaza datos crudos que no son un objeto", () => {
    assert.throws(
      () => crearEvento({ ...base, datosCrudos: ["no", "es", "objeto"] }),
      /debe ser un objeto/,
    );
  });

  test("rechaza textos demasiado largos", () => {
    assert.throws(
      () => crearEvento({ ...base, descripcion: "x".repeat(501) }),
      /no puede pasar de 500 caracteres/,
    );
  });

  test("el error de validacion dice cual campo fallo", () => {
    try {
      crearEvento({ ...base, guia: "" });
      assert.fail("deberia haber lanzado");
    } catch (error) {
      assert.ok(error instanceof ErrorDeValidacion);
      assert.equal(error.campo, "guia");
      assert.match(error.message, /es obligatorio/);
    }
  });
});

describe("estados canonicos", () => {
  test("son los cinco del modelo y no cambian por accidente", () => {
    assert.deepEqual([...ESTADOS], ["generado", "en_transito", "entregado", "devuelto", "perdido"]);
  });

  test("esEstadoValido distingue los canonicos de los inventados", () => {
    assert.equal(esEstadoValido("entregado"), true);
    assert.equal(esEstadoValido("EN_REPARTO"), false);
    assert.equal(esEstadoValido(""), false);
    assert.equal(esEstadoValido(undefined), false);
  });

  test("esEstadoFinal cubre solo los estados que cierran el envio", () => {
    assert.equal(esEstadoFinal("entregado"), true);
    assert.equal(esEstadoFinal("devuelto"), true);
    assert.equal(esEstadoFinal("perdido"), true);
    assert.equal(esEstadoFinal("en_transito"), false);
    assert.equal(esEstadoFinal("generado"), false);
  });
});

describe("resumirEventos", () => {
  test("toma como estado actual el evento mas reciente aunque llegue desordenado", () => {
    const resumen = resumirEventos([
      { estado: "entregado", ocurridoEn: "2026-10-31T10:00:00.000Z" },
      { estado: "generado", ocurridoEn: "2026-10-29T08:00:00.000Z" },
      { estado: "en_transito", ocurridoEn: "2026-10-30T14:05:00.000Z" },
    ]);

    assert.equal(resumen.estado, "entregado");
    assert.equal(resumen.ocurridoEn, "2026-10-31T10:00:00.000Z");
    assert.deepEqual(
      resumen.eventos.map((evento) => evento.estado),
      ["generado", "en_transito", "entregado"],
    );
  });

  test("con el mismo instante mantiene el orden de llegada", () => {
    const mismoInstante = "2026-10-30T14:05:00.000Z";
    const a = { estado: "en_transito", ocurridoEn: mismoInstante, orden: 1 };
    const b = { estado: "en_transito", ocurridoEn: mismoInstante, orden: 2 };

    assert.equal(compararEventos(a, b), 0);
    assert.equal(compararEventos(b, a), 0);
  });

  test("una guia sin eventos queda sin estado", () => {
    const resumen = resumirEventos([]);
    assert.equal(resumen.estado, null);
    assert.equal(resumen.ocurridoEn, null);
    assert.deepEqual(resumen.eventos, []);
  });

  test("rechaza algo que no es una lista", () => {
    assert.throws(() => resumirEventos({ estado: "entregado" }), /debe ser una lista/);
  });
});

describe("normalizarFecha", () => {
  test("deja intacta una fecha ya normalizada", () => {
    assert.equal(normalizarFecha("2026-10-30T14:05:00.000Z"), "2026-10-30T14:05:00.000Z");
  });

  test("rechaza una cadena vacia y un valor nulo", () => {
    assert.throws(() => normalizarFecha("", "fecha"), /debe ser una fecha/);
    assert.throws(() => normalizarFecha(null, "fecha"), /debe ser una fecha/);
  });
});
