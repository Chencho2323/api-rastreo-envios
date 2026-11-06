/**
 * Servidor HTTP de la API de rastreo.
 *
 * Expone el chequeo de salud y la consulta de estado por numero de guia. El
 * registro de eventos y la emision de webhooks llegan en las tareas siguientes.
 */

import { createServer } from "node:http";

import { crearAlmacen } from "./almacen.js";
import { consultarGuia } from "./consulta.js";

/**
 * Escribe una respuesta JSON con su codigo de estado.
 * @param {import("node:http").ServerResponse} respuesta
 * @param {number} codigo
 * @param {unknown} cuerpo
 */
function responderJson(respuesta, codigo, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  respuesta.writeHead(codigo, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(texto),
  });
  respuesta.end(texto);
}

/**
 * Crea el manejador de peticiones con su almacen.
 * @param {{deGuia: (guia: string) => Array<object>}} almacen
 * @returns {(peticion: import("node:http").IncomingMessage, respuesta: import("node:http").ServerResponse) => void}
 */
export function crearManejador(almacen) {
  /**
   * @param {import("node:http").IncomingMessage} peticion
   * @param {import("node:http").ServerResponse} respuesta
   */
  return function manejarPeticion(peticion, respuesta) {
    const url = new URL(peticion.url ?? "/", "http://localhost");

    if (peticion.method === "GET" && url.pathname === "/salud") {
      responderJson(respuesta, 200, { estado: "ok", servicio: "api-rastreo-envios" });
      return;
    }

    const consulta = url.pathname.match(/^\/guias\/([^/]+)$/);

    if (peticion.method === "GET" && consulta !== null) {
      try {
        responderJson(respuesta, 200, consultarGuia(almacen, consulta[1]));
      } catch (error) {
        if (error instanceof Error && "codigo" in error && error.codigo === "NO_ENCONTRADA") {
          responderJson(respuesta, 404, { error: error.message });
          return;
        }
        if (error instanceof Error && error.name === "ErrorDeValidacion") {
          responderJson(respuesta, 400, {
            error: error.message,
            campo: /** @type {{campo?: string}} */ (error).campo ?? null,
          });
          return;
        }
        responderJson(respuesta, 500, { error: "Error interno del servidor." });
      }
      return;
    }

    responderJson(respuesta, 404, { error: "Ruta no encontrada." });
  };
}

/** Almacen por defecto del servidor: uno solo por proceso. */
const almacenPorDefecto = crearAlmacen();

/**
 * Crea el servidor HTTP sin ponerlo a escuchar.
 * @param {{almacen?: {deGuia: (guia: string) => Array<object>}}} opciones
 * @returns {import("node:http").Server}
 */
export function crearServidor(opciones = {}) {
  const almacen = opciones.almacen ?? almacenPorDefecto;
  return createServer(crearManejador(almacen));
}
