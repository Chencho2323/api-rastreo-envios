/**
 * Adaptadores de transportadora.
 *
 * Cada paqueteria nombra sus estados a su manera y no hay dos que coincidan.
 * Un adaptador guarda esa traduccion en un solo sitio: el codigo o el texto que
 * llega de la transportadora contra el estado canonico del modelo.
 *
 * El modulo no inventa equivalencias. Si un estado llega y no esta en la tabla,
 * se lanza un error con el valor original para que alguien lo revise y agregue
 * la linea que falta.
 */

import { crearEvento, ErrorDeValidacion } from "./evento.js";

/**
 * Quita tildes, mayusculas y signos para comparar textos que llegan sucios.
 * "En tránsito  " y "EN TRANSITO" tienen que caer en la misma clave.
 * @param {unknown} valor
 * @returns {string}
 */
export function normalizarClave(valor) {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Tabla de una transportadora.
 *
 * `codigos` se compara por igualdad y `patrones` por expresion regular sobre el
 * texto normalizado, en ese orden. Los patrones existen porque varias
 * transportadoras mandan la novedad como frase libre.
 *
 * @typedef {{
 *   nombre: string,
 *   etiqueta: string,
 *   codigos: Record<string, string>,
 *   patrones: Array<{ expresion: RegExp, estado: string }>,
 * }} Adaptador
 */

/** @type {Record<string, Adaptador>} */
export const ADAPTADORES = Object.freeze({
  servientrega: {
    nombre: "servientrega",
    etiqueta: "Servientrega",
    codigos: {
      "1": "generado",
      "2": "en_transito",
      "3": "en_transito",
      "4": "entregado",
      "5": "devuelto",
      "6": "perdido",
    },
    patrones: [
      { expresion: /GUIA (GENERADA|CREADA)/, estado: "generado" },
      { expresion: /(RECOLECTAD|RECIBID|EN TRANSITO|EN REPARTO|EN RUTA|EN CAMINO)/, estado: "en_transito" },
      { expresion: /ENTREGAD/, estado: "entregado" },
      { expresion: /(DEVOLUC|DEVUELT|RECHAZAD)/, estado: "devuelto" },
      { expresion: /(EXTRAVI|PERDID|SINIESTR|NOVEDAD)/, estado: "perdido" },
    ],
  },

  interrapidisimo: {
    nombre: "interrapidisimo",
    etiqueta: "Interrapidisimo",
    codigos: {
      "01": "generado",
      "10": "en_transito",
      "11": "en_transito",
      "20": "entregado",
      "30": "devuelto",
      "40": "perdido",
    },
    patrones: [
      { expresion: /ADMITID|GUIA GENERADA/, estado: "generado" },
      { expresion: /(EN TRANSITO|EN REPARTO|EN RUTA|DISTRIBUCION)/, estado: "en_transito" },
      { expresion: /ENTREGAD/, estado: "entregado" },
      { expresion: /(DEVOLUC|DEVUELT|RECHAZAD|DIRECCION NO EXISTE)/, estado: "devuelto" },
      { expresion: /(EXTRAVI|PERDID|SINIESTR)/, estado: "perdido" },
    ],
  },

  tcc: {
    nombre: "tcc",
    etiqueta: "TCC",
    codigos: {
      RECIBIDO: "generado",
      ADMITIDO: "generado",
      EN_CAMINO: "en_transito",
      EN_REPARTO: "en_transito",
      ENTREGADO: "entregado",
      DEVUELTO: "devuelto",
      PERDIDO: "perdido",
    },
    patrones: [
      { expresion: /(RECIBID|ADMITID|GENERAD)/, estado: "generado" },
      { expresion: /(EN CAMINO|EN REPARTO|EN TRANSITO|EN BODEGA)/, estado: "en_transito" },
      { expresion: /ENTREGAD/, estado: "entregado" },
      { expresion: /(DEVOLUC|DEVUELT)/, estado: "devuelto" },
      { expresion: /(PERDID|EXTRAVI|SINIESTR)/, estado: "perdido" },
    ],
  },

  envia: {
    nombre: "envia",
    etiqueta: "Envía",
    codigos: {
      GENERADA: "generado",
      ADMITIDA: "generado",
      EN_RUTA: "en_transito",
      EN_REPARTO: "en_transito",
      ENTREGADA: "entregado",
      DEVUELTA: "devuelto",
      SINIESTRADA: "perdido",
    },
    patrones: [
      { expresion: /(GENERAD|ADMITID|CREAD)/, estado: "generado" },
      { expresion: /(EN RUTA|EN REPARTO|EN TRANSITO|ALISTAMIENTO)/, estado: "en_transito" },
      { expresion: /ENTREGAD/, estado: "entregado" },
      { expresion: /(DEVUELT|DEVOLUC|RECHAZAD)/, estado: "devuelto" },
      { expresion: /(SINIESTR|PERDID|EXTRAVI)/, estado: "perdido" },
    ],
  },

  coordinadora: {
    nombre: "coordinadora",
    etiqueta: "Coordinadora",
    codigos: {
      "0": "generado",
      "1": "en_transito",
      "2": "en_transito",
      "3": "entregado",
      "4": "devuelto",
      "9": "perdido",
    },
    patrones: [
      { expresion: /GUIA GENERADA/, estado: "generado" },
      { expresion: /(EN TRANSPORTE|EN REPARTO|EN TRANSITO|RECOLECTAD)/, estado: "en_transito" },
      { expresion: /ENTREGAD/, estado: "entregado" },
      { expresion: /(DEVOLUC|DEVUELT)/, estado: "devuelto" },
      { expresion: /(PERDID|EXTRAVI)/, estado: "perdido" },
    ],
  },
});

/**
 * Nombres con los que las transportadoras se presentan en los archivos y en
 * las respuestas de sus APIs. Se comparan ya normalizados.
 */
const ALIAS = Object.freeze({
  servientrega: "servientrega",
  servientregas: "servientrega",
  "servi entrega": "servientrega",
  interrapidisimo: "interrapidisimo",
  interrapido: "interrapidisimo",
  "inter rapidisimo": "interrapidisimo",
  tcc: "tcc",
  envia: "envia",
  coordinadora: "coordinadora",
});

/**
 * Devuelve la lista de transportadoras soportadas.
 * @returns {Array<{nombre: string, etiqueta: string}>}
 */
export function listarTransportadoras() {
  return Object.values(ADAPTADORES).map(({ nombre, etiqueta }) => ({ nombre, etiqueta }));
}

/**
 * Busca el adaptador de una transportadora por nombre o alias.
 * @param {unknown} nombre
 * @returns {Adaptador}
 */
export function obtenerAdaptador(nombre) {
  const clave = normalizarClave(nombre).toLowerCase();

  if (clave === "") {
    throw new ErrorDeValidacion("transportadora", 'El campo "transportadora" es obligatorio.');
  }

  const canonico = ALIAS[clave];

  if (canonico === undefined) {
    const soportadas = Object.values(ADAPTADORES).map((adaptador) => adaptador.nombre).join(", ");
    throw new ErrorDeValidacion(
      "transportadora",
      `La transportadora "${String(nombre).trim()}" no tiene adaptador. Las soportadas son: ${soportadas}.`,
    );
  }

  return ADAPTADORES[canonico];
}

/**
 * Traduce el estado original de una transportadora al estado canonico.
 * @param {Adaptador} adaptador
 * @param {unknown} estadoOriginal
 * @returns {string}
 */
export function mapearEstado(adaptador, estadoOriginal) {
  const clave = normalizarClave(estadoOriginal);

  if (clave === "") {
    throw new ErrorDeValidacion("estadoOriginal", 'El campo "estadoOriginal" es obligatorio.');
  }

  const porCodigo = adaptador.codigos[clave];

  if (porCodigo !== undefined) {
    return porCodigo;
  }

  for (const { expresion, estado } of adaptador.patrones) {
    if (expresion.test(clave)) {
      return estado;
    }
  }

  throw new ErrorDeValidacion(
    "estadoOriginal",
    `La transportadora "${adaptador.etiqueta}" reporto el estado "${String(estadoOriginal).trim()}", que no tiene equivalente en el modelo. Falta agregarlo al adaptador.`,
  );
}

/**
 * Convierte un evento crudo de una transportadora en un evento canonico.
 *
 * El estado original se guarda en `codigoOriginal` y el resto de la respuesta
 * queda en `datosCrudos`, para poder auditar la traduccion sin volver a
 * consultar al operador.
 * @param {{
 *   transportadora: string,
 *   guia: string,
 *   estadoOriginal: string|number,
 *   ocurridoEn: string|number|Date,
 *   descripcion?: string|null,
 *   ciudad?: string|null,
 *   departamento?: string|null,
 *   datosCrudos?: Record<string, unknown>|null,
 * }} datos
 * @returns {ReturnType<typeof crearEvento>}
 */
export function traducirEvento(datos) {
  if (datos === null || typeof datos !== "object" || Array.isArray(datos)) {
    throw new ErrorDeValidacion("evento", "El evento debe ser un objeto.");
  }

  const adaptador = obtenerAdaptador(datos.transportadora);

  return crearEvento({
    guia: datos.guia,
    transportadora: adaptador.nombre,
    estado: mapearEstado(adaptador, datos.estadoOriginal),
    codigoOriginal: String(datos.estadoOriginal ?? "").trim() || null,
    descripcion: datos.descripcion,
    ocurridoEn: datos.ocurridoEn,
    ciudad: datos.ciudad,
    departamento: datos.departamento,
    datosCrudos: datos.datosCrudos ?? null,
  });
}

/**
 * Traduce varios eventos crudos de la misma guia y los devuelve en orden.
 * @param {Array<Parameters<typeof traducirEvento>[0]>} eventos
 * @returns {Array<ReturnType<typeof traducirEvento>>}
 */
export function traducirEventos(eventos) {
  if (!Array.isArray(eventos)) {
    throw new ErrorDeValidacion("eventos", 'El campo "eventos" debe ser una lista.');
  }

  return eventos
    .map((evento) => traducirEvento(evento))
    .sort((a, b) => Date.parse(a.ocurridoEn) - Date.parse(b.ocurridoEn));
}
