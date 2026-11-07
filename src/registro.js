/**
 * Registro de eventos de rastreo.
 *
 * Entre el adaptador de la transportadora y el almacen hay una pieza que
 * decide si un evento es nuevo. Las paqueterias reintentan sus notificaciones
 * y mandan el mismo movimiento dos o tres veces; sin este filtro el historial
 * de una guia se llena de copias y la consulta miente.
 *
 * Dos caminos de idempotencia:
 *
 * - La huella del evento. Se calcula con los cuatro datos que describen el
 *   hecho: guia, transportadora, estado y fecha. Si ya hay un evento con la
 *   misma huella en la guia, el nuevo se descarta como duplicado.
 * - La clave de idempotencia. La manda quien publica el evento y sirve para
 *   reconocer un reintento aunque el cuerpo cambie en algo que no es el hecho.
 *   Una clave distinta con el mismo contenido tambien se reconoce.
 *
 * Ademas vigila el cierre: un envio entregado, devuelto o perdido no acepta
 * movimientos nuevos. Un evento tardio de una guia cerrada se rechaza en vez
 * de reescribir la historia.
 */

import { createHash } from "node:crypto";

import { crearEvento, ErrorDeValidacion, esEstadoFinal } from "./evento.js";

/** Longitud maxima de la clave de idempotencia que manda el cliente. */
export const LONGITUD_MAXIMA_CLAVE = 120;

/**
 * Arma el error con su codigo para que la capa HTTP elija el estado.
 * @param {string} campo
 * @param {string} mensaje
 * @param {string} codigo
 * @returns {ErrorDeValidacion}
 */
function errorConCodigo(campo, mensaje, codigo) {
  const error = new ErrorDeValidacion(campo, mensaje);
  error.codigo = codigo;
  return error;
}

/**
 * Calcula la huella de un evento canonico.
 *
 * Solo entran los campos que describen el hecho. La descripcion, el codigo
 * original y los datos crudos quedan por fuera a proposito: la misma
 * notificacion puede llegar con textos distintos o con campos extra del
 * operador y sigue siendo el mismo movimiento.
 * @param {{
 *   guia: string,
 *   transportadora: string,
 *   estado: string,
 *   ocurridoEn: string,
 *   codigoOriginal?: string|null,
 *   descripcion?: string|null,
 * }} evento
 * @returns {string}
 */
export function huellaDeEvento(evento) {
  const partes = [
    String(evento.guia ?? "").trim().toUpperCase(),
    String(evento.transportadora ?? "").trim().toLowerCase(),
    String(evento.estado ?? "").trim().toLowerCase(),
    String(evento.ocurridoEn ?? "").trim(),
  ];

  return createHash("sha256").update(JSON.stringify(partes)).digest("hex");
}

/**
 * Limpia y valida la clave de idempotencia del cliente.
 * @param {unknown} valor
 * @returns {string|null}
 */
function normalizarClave(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return null;
  }

  if (typeof valor !== "string") {
    throw new ErrorDeValidacion("claveIdempotencia", 'El campo "claveIdempotencia" debe ser texto.');
  }

  const limpia = valor.trim();

  if (limpia === "") {
    return null;
  }

  if (limpia.length > LONGITUD_MAXIMA_CLAVE) {
    throw new ErrorDeValidacion(
      "claveIdempotencia",
      `La clave de idempotencia no puede pasar de ${LONGITUD_MAXIMA_CLAVE} caracteres.`,
    );
  }

  return limpia;
}

/**
 * Crea el registro que envuelve un almacen.
 *
 * Las claves de idempotencia viven en memoria, igual que el almacen actual.
 * La deduplicacion por huella no depende de esa lista: se recalcula contra los
 * eventos guardados, asi que sigue funcionando si el proceso arranca de cero
 * con una base ya poblada.
 * @param {{
 *   agregar: (evento: object) => object,
 *   deGuia: (guia: string) => Array<object>,
 *   total: () => number,
 * }} almacen
 * @returns {{
 *   registrar: (evento: object, opciones?: {claveIdempotencia?: unknown}) => {evento: object, duplicado: boolean, total: number},
 *   olvidarClaves: () => void,
 * }}
 */
export function crearRegistro(almacen) {
  /** @type {Map<string, string>} */
  const claves = new Map();

  /**
   * Cuenta los eventos guardados de una guia.
   * @param {string} guia
   * @returns {number}
   */
  function contarDeGuia(guia) {
    return almacen.deGuia(guia).length;
  }

  /**
   * Busca en la guia un evento con la huella dada.
   * @param {string} guia
   * @param {string} huella
   * @returns {object|null}
   */
  function buscarPorHuella(guia, huella) {
    for (const guardado of almacen.deGuia(guia)) {
      if (huellaDeEvento(guardado) === huella) {
        return guardado;
      }
    }
    return null;
  }

  return {
    /**
     * Registra un evento canonico y dice si era nuevo.
     *
     * Un evento repetido no se guarda y devuelve el que ya estaba, para que
     * quien reintenta reciba la misma respuesta que la primera vez.
     * @param {object} evento
     * @param {{claveIdempotencia?: unknown}} [opciones]
     * @returns {{evento: object, duplicado: boolean, total: number}} `total` es la
     *   cantidad de eventos que tiene la guia despues del registro.
     */
    registrar(evento, opciones = {}) {
      const canonico = crearEvento(
        /** @type {Parameters<typeof crearEvento>[0]} */ (evento),
      );
      const clave = normalizarClave(opciones.claveIdempotencia);
      const huella = huellaDeEvento(canonico);

      if (clave !== null) {
        const conocida = claves.get(clave);

        if (conocida !== undefined) {
          if (conocida !== huella) {
            throw errorConCodigo(
              "claveIdempotencia",
              `La clave de idempotencia "${clave}" ya se uso para otro evento.`,
              "CONFLICTO_IDEMPOTENCIA",
            );
          }

          const previo = buscarPorHuella(canonico.guia, huella);
          return {
            evento: previo ?? canonico,
            duplicado: true,
            total: contarDeGuia(canonico.guia),
          };
        }
      }

      const repetido = buscarPorHuella(canonico.guia, huella);

      if (repetido !== null) {
        if (clave !== null) {
          claves.set(clave, huella);
        }
        return { evento: repetido, duplicado: true, total: contarDeGuia(canonico.guia) };
      }

      const historial = almacen.deGuia(canonico.guia);
      const ultimo = historial.at(-1);

      if (ultimo !== undefined && esEstadoFinal(String(ultimo.estado))) {
        throw errorConCodigo(
          "guia",
          `La guia "${canonico.guia}" esta cerrada en el estado "${ultimo.estado}" y no acepta eventos nuevos.`,
          "ENVIO_CERRADO",
        );
      }

      const guardado = almacen.agregar(canonico);

      if (clave !== null) {
        claves.set(clave, huella);
      }

      return { evento: guardado, duplicado: false, total: contarDeGuia(canonico.guia) };
    },

    /**
     * Vacia las claves recordadas. No toca los eventos.
     */
    olvidarClaves() {
      claves.clear();
    },
  };
}
