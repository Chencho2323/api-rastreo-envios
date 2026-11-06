/**
 * Consulta del estado de un envio por numero de guia.
 *
 * Junta los eventos guardados de una guia, los ordena y arma la respuesta que
 * consumen las otras aplicaciones del negocio: estado actual, fecha del ultimo
 * movimiento e historial completo.
 */

import { ErrorDeValidacion, esEstadoFinal, resumirEventos } from "./evento.js";

/** Longitud maxima de una guia, para no aceptar cualquier cadena en la ruta. */
export const LONGITUD_MAXIMA_GUIA = 60;

/**
 * Limpia y valida el numero de guia que llega por la ruta.
 *
 * Las guias de las paqueterias colombianas son alfanumericas y a veces traen
 * guion. Cualquier otro caracter se rechaza en vez de adivinarlo: una guia con
 * espacios o barras no es una guia, es una ruta mal armada.
 * @param {unknown} guia
 * @returns {string}
 */
export function normalizarGuia(guia) {
  if (typeof guia !== "string" || guia.trim() === "") {
    throw new ErrorDeValidacion("guia", 'El campo "guia" es obligatorio.');
  }

  const limpia = decodeURIComponent(guia).trim().toUpperCase();

  if (limpia.length > LONGITUD_MAXIMA_GUIA) {
    throw new ErrorDeValidacion(
      "guia",
      `El numero de guia no puede pasar de ${LONGITUD_MAXIMA_GUIA} caracteres.`,
    );
  }

  if (!/^[A-Z0-9-]+$/.test(limpia)) {
    throw new ErrorDeValidacion(
      "guia",
      "El numero de guia solo admite letras, numeros y guion.",
    );
  }

  return limpia;
}

/**
 * Arma la respuesta de consulta de una guia.
 *
 * Si la guia no tiene eventos se lanza un error de validacion con el codigo
 * `NO_ENCONTRADA`, que la capa HTTP traduce a 404. Una guia que existe pero
 * todavia no tiene movimientos no se inventa: se responde que no hay datos.
 * @param {{deGuia: (guia: string) => Array<object>}} almacen
 * @param {unknown} guia
 * @returns {{
 *   guia: string,
 *   estado: string,
 *   ocurridoEn: string,
 *   cerrado: boolean,
 *   eventos: Array<object>,
 *   totalEventos: number,
 * }}
 */
export function consultarGuia(almacen, guia) {
  const numero = normalizarGuia(guia);
  const eventos = almacen.deGuia(numero);

  if (eventos.length === 0) {
    const error = new ErrorDeValidacion("guia", `La guia "${numero}" no tiene eventos registrados.`);
    error.codigo = "NO_ENCONTRADA";
    throw error;
  }

  const resumen = resumirEventos(
    /** @type {Array<{estado: string, ocurridoEn: string}>} */ (eventos),
  );

  return {
    guia: numero,
    estado: /** @type {string} */ (resumen.estado),
    ocurridoEn: /** @type {string} */ (resumen.ocurridoEn),
    cerrado: esEstadoFinal(/** @type {string} */ (resumen.estado)),
    eventos,
    totalEventos: eventos.length,
  };
}
