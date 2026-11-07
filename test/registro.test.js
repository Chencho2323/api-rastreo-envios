import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { crearAlmacen } from "../src/almacen.js";
import { crearEvento } from "../src/evento.js";
import { LONGITUD_MAXIMA_CLAVE, crearRegistro, huellaDeEvento } from "../src/registro.js";

/**
 * Arma un evento canonico listo para el registro.
 * @param {Record<string, unknown>} [cambios]
 * @returns {object}
 */
function evento(cambios = {}) {
  return crearEvento({
    guia: "GUI-9001",
    transportadora: "servientrega",
    estado: "en_transito",
    ocurridoEn: "2026-11-02T14:00:00Z",
    ...cambios,
  });
}

describe("huella de evento", () => {
  test("es estable para el mismo hecho", () => {
    assert.equal(huellaDeEvento(evento()), huellaDeEvento(evento()));
  });

  test("cambia cuando cambia el estado o la fecha", () => {
    assert.notEqual(huellaDeEvento(evento()), huellaDeEvento(evento({ estado: "entregado" })));
    assert.notEqual(
      huellaDeEvento(evento()),
      huellaDeEvento(evento({ ocurridoEn: "2026-11-02T15:00:00Z" })),
    );
  });

  test("no depende de los datos crudos, que sobran para el hecho", () => {
    const uno = evento({ datosCrudos: { codigo: "A" } });
    const otro = evento({ datosCrudos: { codigo: "B", extra: true } });
    assert.equal(huellaDeEvento(uno), huellaDeEvento(otro));
  });
});

describe("registro con deduplicacion", () => {
  test("guarda el primer evento y descarta la copia exacta", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    const primera = registro.registrar(evento());
    const segunda = registro.registrar(evento());

    assert.equal(primera.duplicado, false);
    assert.equal(segunda.duplicado, true);
    assert.equal(almacen.total(), 1);
    assert.equal(segunda.evento.ocurridoEn, primera.evento.ocurridoEn);
  });

  test("dos movimientos distintos del mismo estado si se guardan", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento({ ocurridoEn: "2026-11-02T14:00:00Z" }));
    registro.registrar(evento({ ocurridoEn: "2026-11-03T09:30:00Z" }));

    assert.equal(almacen.total(), 2);
  });

  test("la misma huella en otra guia no es un duplicado", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento());
    registro.registrar(evento({ guia: "GUI-9002" }));

    assert.equal(almacen.total(), 2);
  });

  test("la deduplicacion sigue funcionando si el proceso arranca con la base poblada", () => {
    const almacen = crearAlmacen();
    almacen.agregar(evento());

    const registro = crearRegistro(almacen);
    const resultado = registro.registrar(evento());

    assert.equal(resultado.duplicado, true);
    assert.equal(almacen.total(), 1);
  });
});

describe("idempotencia por clave", () => {
  test("un reintento con la misma clave y otro cuerpo no crea un evento nuevo", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    const primera = registro.registrar(evento({ descripcion: "En reparto" }), {
      claveIdempotencia: "notif-001",
    });
    const reintento = registro.registrar(evento({ descripcion: "En reparto en moto" }), {
      claveIdempotencia: "notif-001",
    });

    assert.equal(primera.duplicado, false);
    assert.equal(reintento.duplicado, true);
    assert.equal(almacen.total(), 1);
    assert.equal(reintento.evento.descripcion, "En reparto");
  });

  test("la misma clave con otro hecho es un conflicto", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento(), { claveIdempotencia: "notif-002" });

    assert.throws(
      () => registro.registrar(evento({ estado: "entregado" }), { claveIdempotencia: "notif-002" }),
      (error) => {
        assert.equal(error.name, "ErrorDeValidacion");
        assert.equal(error.codigo, "CONFLICTO_IDEMPOTENCIA");
        assert.equal(error.campo, "claveIdempotencia");
        return true;
      },
    );
    assert.equal(almacen.total(), 1);
  });

  test("una clave sin evento previo se recuerda tras un duplicado por huella", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento());
    const conClave = registro.registrar(evento(), { claveIdempotencia: "notif-003" });

    assert.equal(conClave.duplicado, true);

    assert.throws(
      () => registro.registrar(evento({ estado: "entregado" }), { claveIdempotencia: "notif-003" }),
      /ya se uso para otro evento/,
    );
  });

  test("rechaza una clave que no es texto o que pasa del limite", () => {
    const registro = crearRegistro(crearAlmacen());

    assert.throws(() => registro.registrar(evento(), { claveIdempotencia: 42 }), /debe ser texto/);
    assert.throws(
      () => registro.registrar(evento(), { claveIdempotencia: "x".repeat(LONGITUD_MAXIMA_CLAVE + 1) }),
      /no puede pasar de 120 caracteres/,
    );
  });

  test("una clave vacia se trata como si no hubiera clave", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento(), { claveIdempotencia: "   " });
    registro.registrar(evento(), { claveIdempotencia: "" });

    assert.equal(almacen.total(), 1);
  });

  test("olvidarClaves permite reutilizar una clave sin reiniciar el almacen", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento(), { claveIdempotencia: "notif-004" });
    registro.olvidarClaves();

    const otro = registro.registrar(evento({ estado: "entregado" }), {
      claveIdempotencia: "notif-004",
    });

    assert.equal(otro.duplicado, false);
    assert.equal(almacen.total(), 2);
  });
});

describe("envios cerrados", () => {
  test("no acepta un movimiento nuevo sobre una guia entregada", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento({ estado: "entregado", ocurridoEn: "2026-11-02T14:00:00Z" }));

    assert.throws(
      () => registro.registrar(evento({ estado: "en_transito", ocurridoEn: "2026-11-03T08:00:00Z" })),
      (error) => {
        assert.equal(error.codigo, "ENVIO_CERRADO");
        assert.equal(error.campo, "guia");
        assert.match(error.message, /esta cerrada en el estado "entregado"/);
        return true;
      },
    );
    assert.equal(almacen.total(), 1);
  });

  test("si acepta el mismo hecho repetido de una guia cerrada", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    const entregado = evento({ estado: "entregado", ocurridoEn: "2026-11-02T14:00:00Z" });
    registro.registrar(entregado);
    const repeticion = registro.registrar(entregado, { claveIdempotencia: "notif-005" });

    assert.equal(repeticion.duplicado, true);
    assert.equal(almacen.total(), 1);
  });

  test("un envio en transito acepta el siguiente movimiento", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    registro.registrar(evento());
    const entrega = registro.registrar(
      evento({ estado: "entregado", ocurridoEn: "2026-11-02T18:00:00Z" }),
    );

    assert.equal(entrega.duplicado, false);
    assert.equal(almacen.total(), 2);
  });
});

describe("validacion dentro del registro", () => {
  test("rechaza un evento sin estado valido antes de tocar el almacen", () => {
    const almacen = crearAlmacen();
    const registro = crearRegistro(almacen);

    assert.throws(() => registro.registrar({ guia: "GUI-1", transportadora: "tcc", estado: "volando" }), /no existe/);
    assert.equal(almacen.total(), 0);
  });
});
