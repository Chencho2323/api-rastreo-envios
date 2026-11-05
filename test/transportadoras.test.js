import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ErrorDeValidacion } from "../src/evento.js";
import {
  ADAPTADORES,
  listarTransportadoras,
  mapearEstado,
  normalizarClave,
  obtenerAdaptador,
  traducirEvento,
  traducirEventos,
} from "../src/transportadoras.js";

describe("normalizarClave", () => {
  test("quita tildes, mayusculas y espacios de sobra", () => {
    assert.equal(normalizarClave("  En tránsito  "), "EN TRANSITO");
  });

  test("cambia signos por un espacio", () => {
    assert.equal(normalizarClave("en-reparto/al_destinatario"), "EN REPARTO AL DESTINATARIO");
  });

  test("un valor nulo queda en cadena vacia", () => {
    assert.equal(normalizarClave(null), "");
    assert.equal(normalizarClave(undefined), "");
  });
});

describe("catalogo de transportadoras", () => {
  test("lista las cinco soportadas con su etiqueta", () => {
    const lista = listarTransportadoras();
    assert.deepEqual(
      lista.map((transportadora) => transportadora.nombre),
      ["servientrega", "interrapidisimo", "tcc", "envia", "coordinadora"],
    );
    assert.equal(lista.find((t) => t.nombre === "tcc").etiqueta, "TCC");
  });

  test("cada adaptador mapea a estados canonicos", () => {
    const canonicos = ["generado", "en_transito", "entregado", "devuelto", "perdido"];

    for (const adaptador of Object.values(ADAPTADORES)) {
      for (const estado of Object.values(adaptador.codigos)) {
        assert.ok(canonicos.includes(estado), `${adaptador.nombre}: ${estado} no es canonico`);
      }
      for (const { estado } of adaptador.patrones) {
        assert.ok(canonicos.includes(estado), `${adaptador.nombre}: patron ${estado} no es canonico`);
      }
    }
  });

  test("resuelve el nombre sin importar mayusculas ni tildes", () => {
    assert.equal(obtenerAdaptador("Servientrega").nombre, "servientrega");
    assert.equal(obtenerAdaptador("INTERRAPIDÍSIMO").nombre, "interrapidisimo");
    assert.equal(obtenerAdaptador("Envia").nombre, "envia");
  });

  test("rechaza una transportadora sin adaptador y dice cuales hay", () => {
    assert.throws(
      () => obtenerAdaptador("DHL"),
      /no tiene adaptador\. Las soportadas son: servientrega, interrapidisimo, tcc, envia, coordinadora\./,
    );
  });

  test("rechaza una transportadora vacia", () => {
    assert.throws(() => obtenerAdaptador("   "), /es obligatorio/);
  });
});

describe("mapearEstado", () => {
  test("traduce por codigo numerico", () => {
    const servientrega = obtenerAdaptador("servientrega");
    assert.equal(mapearEstado(servientrega, "4"), "entregado");
    assert.equal(mapearEstado(servientrega, 4), "entregado");
  });

  test("traduce por texto libre con tildes y mayusculas", () => {
    const interrapidisimo = obtenerAdaptador("interrapidisimo");
    assert.equal(mapearEstado(interrapidisimo, "En reparto"), "en_transito");
    assert.equal(mapearEstado(interrapidisimo, "ENTREGADO AL DESTINATARIO"), "entregado");
  });

  test("el codigo gana sobre el patron", () => {
    const coordinadora = obtenerAdaptador("coordinadora");
    assert.equal(mapearEstado(coordinadora, "3"), "entregado");
  });

  test("rechaza un estado desconocido y nombra el valor original", () => {
    assert.throws(
      () => mapearEstado(obtenerAdaptador("tcc"), "REPROGRAMADO"),
      (error) => {
        assert.ok(error instanceof ErrorDeValidacion);
        assert.equal(error.campo, "estadoOriginal");
        assert.match(error.message, /"REPROGRAMADO"/);
        assert.match(error.message, /Falta agregarlo al adaptador/);
        return true;
      },
    );
  });

  test("rechaza un estado vacio", () => {
    assert.throws(() => mapearEstado(obtenerAdaptador("envia"), "  "), /es obligatorio/);
  });
});

describe("traducirEvento", () => {
  test("deja el evento con la guia, el estado y la fecha normalizados", () => {
    const evento = traducirEvento({
      transportadora: "Servientrega",
      guia: " gui-9001 ",
      estadoOriginal: "EN REPARTO",
      ocurridoEn: "2026-11-02T08:15:00-05:00",
      ciudad: "Medellin",
      departamento: "Antioquia",
    });

    assert.equal(evento.guia, "GUI-9001");
    assert.equal(evento.transportadora, "servientrega");
    assert.equal(evento.estado, "en_transito");
    assert.equal(evento.codigoOriginal, "EN REPARTO");
    assert.equal(evento.ocurridoEn, "2026-11-02T13:15:00.000Z");
    assert.equal(evento.ciudad, "Medellin");
    assert.equal(evento.departamento, "Antioquia");
  });

  test("guarda la respuesta original en los datos crudos", () => {
    const crudos = { estado: "4", novedad: null };
    const evento = traducirEvento({
      transportadora: "tcc",
      guia: "TCC-1",
      estadoOriginal: "en camino",
      ocurridoEn: "2026-11-02T08:15:00Z",
      datosCrudos: crudos,
    });

    assert.deepEqual(evento.datosCrudos, crudos);
  });

  test("rechaza un evento que no es objeto", () => {
    assert.throws(() => traducirEvento("EN REPARTO"), /debe ser un objeto/);
  });

  test("propaga el fallo de una guia vacia", () => {
    assert.throws(
      () =>
        traducirEvento({
          transportadora: "envia",
          guia: " ",
          estadoOriginal: "ENTREGADA",
          ocurridoEn: "2026-11-02T08:15:00Z",
        }),
      /es obligatorio/,
    );
  });
});

describe("traducirEventos", () => {
  test("traduce la lista completa y la ordena por fecha", () => {
    const eventos = traducirEventos([
      {
        transportadora: "coordinadora",
        guia: "COO-77",
        estadoOriginal: "ENTREGADO",
        ocurridoEn: "2026-11-03T16:00:00Z",
      },
      {
        transportadora: "coordinadora",
        guia: "COO-77",
        estadoOriginal: "GUIA GENERADA",
        ocurridoEn: "2026-11-01T09:00:00Z",
      },
      {
        transportadora: "coordinadora",
        guia: "COO-77",
        estadoOriginal: "EN REPARTO",
        ocurridoEn: "2026-11-03T07:30:00Z",
      },
    ]);

    assert.deepEqual(
      eventos.map((evento) => evento.estado),
      ["generado", "en_transito", "entregado"],
    );
  });

  test("una lista vacia devuelve lista vacia", () => {
    assert.deepEqual(traducirEventos([]), []);
  });

  test("rechaza algo que no es lista", () => {
    assert.throws(() => traducirEventos({ guia: "X" }), /debe ser una lista/);
  });
});
