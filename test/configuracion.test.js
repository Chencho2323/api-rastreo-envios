import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { leerConfiguracion } from "../src/configuracion.js";

describe("leerConfiguracion", () => {
  test("usa el puerto 3000 cuando no hay variable PORT", () => {
    const configuracion = leerConfiguracion({});
    assert.equal(configuracion.puerto, 3000);
  });

  test("lee el puerto desde PORT", () => {
    const configuracion = leerConfiguracion({ PORT: "8080" });
    assert.equal(configuracion.puerto, 8080);
  });

  test("rechaza un puerto que no es un entero valido", () => {
    assert.throws(() => leerConfiguracion({ PORT: "ochenta" }), /no es valido/);
  });

  test("rechaza un puerto fuera del rango permitido", () => {
    assert.throws(() => leerConfiguracion({ PORT: "70000" }), /entre 1 y 65535/);
  });

  test("toma desarrollo como entorno por defecto", () => {
    const configuracion = leerConfiguracion({});
    assert.equal(configuracion.entorno, "desarrollo");
  });

  test("usa la ruta de base de datos indicada en el entorno", () => {
    const configuracion = leerConfiguracion({ RUTA_BASE_DATOS: "/tmp/prueba.sqlite" });
    assert.equal(configuracion.rutaBaseDatos, "/tmp/prueba.sqlite");
  });
});
