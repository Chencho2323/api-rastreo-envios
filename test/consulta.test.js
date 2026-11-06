import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { crearAlmacen } from "../src/almacen.js";
import { consultarGuia, normalizarGuia } from "../src/consulta.js";
import { crearEvento } from "../src/evento.js";

/**
 * Arma un evento canonico con lo minimo que necesita la consulta.
 * @param {string} guia
 * @param {string} estado
 * @param {string} ocurridoEn
 * @returns {object}
 */
function evento(guia, estado, ocurridoEn) {
  return crearEvento({
    guia,
    transportadora: "servientrega",
    estado,
    ocurridoEn,
  });
}

describe("normalizacion del numero de guia", () => {
  test("pasa a mayusculas y quita los espacios de los extremos", () => {
    assert.equal(normalizarGuia("  gui-9001 "), "GUI-9001");
  });

  test("acepta solo letras, numeros y guion", () => {
    assert.throws(() => normalizarGuia("GUI 9001"), /solo admite letras, numeros y guion/);
    assert.throws(() => normalizarGuia("GUI/9001"), /solo admite letras, numeros y guion/);
  });

  test("rechaza una guia vacia", () => {
    assert.throws(() => normalizarGuia("   "), /obligatorio/);
  });

  test("rechaza una guia demasiado larga", () => {
    assert.throws(() => normalizarGuia("A".repeat(61)), /no puede pasar de 60 caracteres/);
  });
});

describe("consulta de estado por guia", () => {
  test("devuelve el estado del evento mas reciente aunque lleguen desordenados", () => {
    const almacen = crearAlmacen();
    almacen.agregar(evento("GUI-9001", "entregado", "2026-11-02T15:00:00-05:00"));
    almacen.agregar(evento("GUI-9001", "generado", "2026-11-01T08:00:00-05:00"));
    almacen.agregar(evento("GUI-9001", "en_transito", "2026-11-02T09:00:00-05:00"));

    const resultado = consultarGuia(almacen, "gui-9001");

    assert.equal(resultado.guia, "GUI-9001");
    assert.equal(resultado.estado, "entregado");
    assert.equal(resultado.totalEventos, 3);
    assert.deepEqual(
      resultado.eventos.map((e) => e.estado),
      ["generado", "en_transito", "entregado"],
    );
  });

  test("marca como cerrado un envio entregado, devuelto o perdido", () => {
    const almacen = crearAlmacen();
    almacen.agregar(evento("GUI-1", "entregado", "2026-11-02T10:00:00Z"));
    almacen.agregar(evento("GUI-2", "en_transito", "2026-11-02T10:00:00Z"));

    assert.equal(consultarGuia(almacen, "GUI-1").cerrado, true);
    assert.equal(consultarGuia(almacen, "GUI-2").cerrado, false);
  });

  test("una guia sin eventos responde con el codigo NO_ENCONTRADA", () => {
    const almacen = crearAlmacen();

    try {
      consultarGuia(almacen, "GUI-0000");
      assert.fail("debio lanzar el error de guia no encontrada");
    } catch (error) {
      assert.equal(error.codigo, "NO_ENCONTRADA");
      assert.match(error.message, /no tiene eventos registrados/);
    }
  });

  test("la respuesta no comparte la lista interna del almacen", () => {
    const almacen = crearAlmacen();
    almacen.agregar(evento("GUI-7", "generado", "2026-11-02T10:00:00Z"));

    const resultado = consultarGuia(almacen, "GUI-7");
    resultado.eventos.length = 0;
    resultado.eventos.push({ estado: "inventado" });

    assert.equal(consultarGuia(almacen, "GUI-7").totalEventos, 1);
  });
});

describe("almacen de eventos", () => {
  test("agrupa los eventos por guia y los cuenta", () => {
    const almacen = crearAlmacen();
    almacen.agregar(evento("GUI-1", "generado", "2026-11-01T10:00:00Z"));
    almacen.agregar(evento("GUI-2", "generado", "2026-11-01T11:00:00Z"));

    assert.deepEqual(almacen.guias(), ["GUI-1", "GUI-2"]);
    assert.equal(almacen.total(), 2);
  });

  test("rechaza un evento sin guia", () => {
    const almacen = crearAlmacen();
    assert.throws(() => almacen.agregar({ estado: "generado" }), /"guia" es obligatorio/);
  });

  test("deGuia devuelve una lista vacia para una guia desconocida", () => {
    assert.deepEqual(crearAlmacen().deGuia("NADIE"), []);
  });
});
