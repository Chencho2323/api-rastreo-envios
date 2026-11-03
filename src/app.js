/**
 * Servidor HTTP de la API de rastreo.
 *
 * Por ahora solo expone el chequeo de salud. Las rutas de consulta de guias y
 * el registro de eventos se agregan en las tareas siguientes.
 */

import { createServer } from "node:http";

/**
 * Maneja una peticion y escribe la respuesta.
 * @param {import("node:http").IncomingMessage} peticion
 * @param {import("node:http").ServerResponse} respuesta
 */
export function manejarPeticion(peticion, respuesta) {
  const url = new URL(peticion.url ?? "/", "http://localhost");

  if (peticion.method === "GET" && url.pathname === "/salud") {
    const cuerpo = JSON.stringify({ estado: "ok", servicio: "api-rastreo-envios" });
    respuesta.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(cuerpo),
    });
    respuesta.end(cuerpo);
    return;
  }

  const cuerpo = JSON.stringify({ error: "Ruta no encontrada." });
  respuesta.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(cuerpo),
  });
  respuesta.end(cuerpo);
}

/**
 * Crea el servidor HTTP sin ponerlo a escuchar.
 * @returns {import("node:http").Server}
 */
export function crearServidor() {
  return createServer(manejarPeticion);
}
