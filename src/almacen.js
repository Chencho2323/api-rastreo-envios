/**
 * Almacen de eventos de rastreo.
 *
 * Guarda los eventos canonicos agrupados por guia y los devuelve en el orden
 * en que ocurrieron. La consulta no toca la base: pregunta al almacen, y el
 * almacen es lo unico que sabe donde viven los datos.
 *
 * Esta primera version guarda en memoria. La interfaz es la misma que usara
 * la version persistente, para que el resto del codigo no cambie cuando se
 * conecte SQLite.
 */

import { ErrorDeValidacion, normalizarFecha } from "./evento.js";

/**
 * Copia un evento para que quien lo guardo no pueda modificarlo despues.
 * @param {ReturnType<typeof import("./evento.js").crearEvento>} evento
 * @returns {ReturnType<typeof import("./evento.js").crearEvento>}
 */
function copiarEvento(evento) {
  return {
    ...evento,
    datosCrudos: evento.datosCrudos === null ? null : structuredClone(evento.datosCrudos),
  };
}

/**
 * Crea un almacen de eventos en memoria.
 *
 * El evento que llega ya viene validado por `crearEvento` o `traducirEvento`.
 * Aqui solo se comprueba lo minimo para que un error de programacion no meta
 * basura en la lista.
 * @returns {{
 *   agregar: (evento: object) => object,
 *   deGuia: (guia: string) => Array<object>,
 *   guias: () => Array<string>,
 *   total: () => number,
 *   limpiar: () => void,
 * }}
 */
export function crearAlmacen() {
  /** @type {Map<string, Array<object>>} */
  const porGuia = new Map();

  return {
    /**
     * Agrega un evento canonico y devuelve la copia guardada.
     * @param {object} evento
     * @returns {object}
     */
    agregar(evento) {
      if (evento === null || typeof evento !== "object" || Array.isArray(evento)) {
        throw new ErrorDeValidacion("evento", "El evento debe ser un objeto.");
      }
      if (typeof evento.guia !== "string" || evento.guia.trim() === "") {
        throw new ErrorDeValidacion("guia", 'El campo "guia" es obligatorio.');
      }
      if (typeof evento.estado !== "string" || evento.estado.trim() === "") {
        throw new ErrorDeValidacion("estado", 'El campo "estado" es obligatorio.');
      }

      const copia = copiarEvento(
        /** @type {ReturnType<typeof import("./evento.js").crearEvento>} */ ({
          ...evento,
          ocurridoEn: normalizarFecha(evento.ocurridoEn, "ocurridoEn"),
        }),
      );

      const guia = copia.guia;
      const lista = porGuia.get(guia);

      if (lista === undefined) {
        porGuia.set(guia, [copia]);
      } else {
        lista.push(copia);
      }

      return copiarEvento(copia);
    },

    /**
     * Devuelve los eventos de una guia, del mas viejo al mas nuevo.
     * @param {string} guia
     * @returns {Array<object>}
     */
    deGuia(guia) {
      const lista = porGuia.get(guia) ?? [];
      return lista
        .map((evento) => copiarEvento(evento))
        .sort((a, b) => Date.parse(a.ocurridoEn) - Date.parse(b.ocurridoEn));
    },

    /**
     * Lista las guias que tienen al menos un evento.
     * @returns {Array<string>}
     */
    guias() {
      return [...porGuia.keys()].sort();
    },

    /**
     * Cuenta los eventos guardados.
     * @returns {number}
     */
    total() {
      let suma = 0;
      for (const lista of porGuia.values()) {
        suma += lista.length;
      }
      return suma;
    },

    /**
     * Vacia el almacen. Se usa en las pruebas.
     */
    limpiar() {
      porGuia.clear();
    },
  };
}
