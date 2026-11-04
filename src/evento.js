/**
 * Modelo canonico de evento de rastreo.
 *
 * Cada transportadora habla su propio idioma: una dice "EN REPARTO", otra
 * "en camino al destinatario" y otra "OUT FOR DELIVERY". Este modulo traduce
 * todas esas variantes a un unico evento con estados y fechas comparables, que
 * es lo que consumen las demas aplicaciones del negocio.
 *
 * El modelo no sabe nada de HTTP ni de base de datos: solo valida y normaliza.
 */

/**
 * Estados canonicos por los que pasa un envio.
 * El orden de la lista es el orden del ciclo de vida.
 */
export const ESTADOS = Object.freeze([
  "generado",
  "en_transito",
  "entregado",
  "devuelto",
  "perdido",
]);

/**
 * Estados en los que el envio ya no cambia de situacion.
 * Un evento posterior sobre un envio cerrado solo se acepta si es el mismo
 * hecho repetido; el registro se encarga de deduplicarlo.
 */
export const ESTADOS_FINALES = Object.freeze(["entregado", "devuelto", "perdido"]);

/** Longitud maxima de los textos libres, para que un dato sucio no reviente la base. */
const LONGITUD_MAXIMA_TEXTO = 500;

/**
 * Error de un dato que no cumple el contrato del modelo.
 * Lleva el campo culpable para que el mensaje sirva en la respuesta HTTP.
 */
export class ErrorDeValidacion extends Error {
  /**
   * @param {string} campo
   * @param {string} mensaje
   */
  constructor(campo, mensaje) {
    super(mensaje);
    this.name = "ErrorDeValidacion";
    this.campo = campo;
  }
}

/**
 * Indica si un valor es uno de los estados canonicos.
 * @param {unknown} estado
 * @returns {boolean}
 */
export function esEstadoValido(estado) {
  return typeof estado === "string" && ESTADOS.includes(estado);
}

/**
 * Indica si el envio ya llego a un estado terminal.
 * @param {string} estado
 * @returns {boolean}
 */
export function esEstadoFinal(estado) {
  return ESTADOS_FINALES.includes(estado);
}

/**
 * Convierte un texto obligatorio en su forma limpia.
 * @param {unknown} valor
 * @param {string} campo
 * @returns {string}
 */
function textoObligatorio(valor, campo) {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new ErrorDeValidacion(campo, `El campo "${campo}" es obligatorio.`);
  }

  const limpio = valor.trim().replace(/\s+/g, " ");

  if (limpio.length > LONGITUD_MAXIMA_TEXTO) {
    throw new ErrorDeValidacion(
      campo,
      `El campo "${campo}" no puede pasar de ${LONGITUD_MAXIMA_TEXTO} caracteres.`,
    );
  }

  return limpio;
}

/**
 * Convierte un texto opcional en su forma limpia.
 * @param {unknown} valor
 * @param {string} campo
 * @returns {string|null}
 */
function textoOpcional(valor, campo) {
  if (valor === undefined || valor === null || valor === "") {
    return null;
  }
  return textoObligatorio(valor, campo);
}

/**
 * Normaliza una fecha a ISO 8601 en UTC con milisegundos.
 *
 * Acepta un objeto Date, una cadena ISO o una marca de tiempo en milisegundos.
 * Las fechas sin zona se interpretan en UTC para que dos servidores no
 * registren el mismo hecho con horas distintas.
 * @param {unknown} valor
 * @param {string} campo
 * @returns {string}
 */
export function normalizarFecha(valor, campo = "ocurridoEn") {
  /** @type {Date} */
  let fecha;

  if (valor instanceof Date) {
    fecha = valor;
  } else if (typeof valor === "number") {
    fecha = new Date(valor);
  } else if (typeof valor === "string" && valor.trim() !== "") {
    const texto = valor.trim();
    const sinZona = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(texto);
    fecha = new Date(sinZona ? `${texto.replace(" ", "T")}Z` : texto);
  } else {
    throw new ErrorDeValidacion(campo, `El campo "${campo}" debe ser una fecha.`);
  }

  if (Number.isNaN(fecha.getTime())) {
    throw new ErrorDeValidacion(campo, `El campo "${campo}" no es una fecha valida.`);
  }

  return fecha.toISOString();
}

/**
 * Crea un evento canonico a partir de los datos crudos de una transportadora.
 *
 * Solo se guarda lo que el modelo necesita. Los datos originales quedan en
 * `datosCrudos` para poder auditar una traduccion equivocada sin volver a
 * consultar a la transportadora.
 * @param {{
 *   guia: string,
 *   transportadora: string,
 *   estado: string,
 *   codigoOriginal?: string|null,
 *   descripcion?: string|null,
 *   ocurridoEn: string|number|Date,
 *   ciudad?: string|null,
 *   departamento?: string|null,
 *   datosCrudos?: Record<string, unknown>|null,
 * }} datos
 * @returns {{
 *   guia: string,
 *   transportadora: string,
 *   estado: string,
 *   codigoOriginal: string|null,
 *   descripcion: string|null,
 *   ocurridoEn: string,
 *   ciudad: string|null,
 *   departamento: string|null,
 *   datosCrudos: Record<string, unknown>|null,
 * }}
 */
export function crearEvento(datos) {
  if (datos === null || typeof datos !== "object" || Array.isArray(datos)) {
    throw new ErrorDeValidacion("evento", "El evento debe ser un objeto.");
  }

  const guia = textoObligatorio(datos.guia, "guia").toUpperCase();
  const transportadora = textoObligatorio(datos.transportadora, "transportadora").toLowerCase();
  const estado = textoObligatorio(datos.estado, "estado").toLowerCase();

  if (!esEstadoValido(estado)) {
    throw new ErrorDeValidacion(
      "estado",
      `El estado "${estado}" no existe. Los estados validos son: ${ESTADOS.join(", ")}.`,
    );
  }

  if (datos.datosCrudos !== undefined && datos.datosCrudos !== null) {
    if (typeof datos.datosCrudos !== "object" || Array.isArray(datos.datosCrudos)) {
      throw new ErrorDeValidacion("datosCrudos", 'El campo "datosCrudos" debe ser un objeto.');
    }
  }

  return {
    guia,
    transportadora,
    estado,
    codigoOriginal: textoOpcional(datos.codigoOriginal, "codigoOriginal"),
    descripcion: textoOpcional(datos.descripcion, "descripcion"),
    ocurridoEn: normalizarFecha(datos.ocurridoEn, "ocurridoEn"),
    ciudad: textoOpcional(datos.ciudad, "ciudad"),
    departamento: textoOpcional(datos.departamento, "departamento"),
    datosCrudos: datos.datosCrudos ?? null,
  };
}

/**
 * Ordena dos eventos de la misma guia del mas viejo al mas nuevo.
 *
 * Si dos eventos ocurrieron en el mismo instante, gana el que llego primero:
 * asi el orden es estable y dos consultas seguidas devuelven lo mismo.
 * @param {{ocurridoEn: string}} a
 * @param {{ocurridoEn: string}} b
 * @returns {number}
 */
export function compararEventos(a, b) {
  const diferencia = Date.parse(a.ocurridoEn) - Date.parse(b.ocurridoEn);
  return diferencia === 0 ? 0 : diferencia;
}

/**
 * Aplica una lista de eventos desordenados y devuelve el estado actual del envio.
 *
 * Sirve para reconstruir el historial que llega en cualquier orden desde las
 * transportadoras. Una lista vacia quiere decir que la guia no tiene eventos.
 * @param {Array<{estado: string, ocurridoEn: string}>} eventos
 * @returns {{estado: string|null, ocurridoEn: string|null, eventos: Array<{estado: string, ocurridoEn: string}>}}
 */
export function resumirEventos(eventos) {
  if (!Array.isArray(eventos)) {
    throw new ErrorDeValidacion("eventos", 'El campo "eventos" debe ser una lista.');
  }

  const ordenados = [...eventos].sort(compararEventos);
  const ultimo = ordenados.at(-1) ?? null;

  return {
    estado: ultimo?.estado ?? null,
    ocurridoEn: ultimo?.ocurridoEn ?? null,
    eventos: ordenados,
  };
}
