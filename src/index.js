/**
 * Punto de entrada de la API de rastreo de envios.
 *
 * Levanta el servidor con la configuracion del entorno y cierra de forma
 * ordenada cuando el proceso recibe SIGINT o SIGTERM.
 */

import { leerConfiguracion } from "./configuracion.js";
import { crearServidor } from "./app.js";

const configuracion = leerConfiguracion();
const servidor = crearServidor();

servidor.listen(configuracion.puerto, () => {
  console.log(`API de rastreo escuchando en el puerto ${configuracion.puerto} (${configuracion.entorno}).`);
});

/**
 * Cierra el servidor y termina el proceso.
 * @param {string} senal
 */
function cerrar(senal) {
  console.log(`Recibida la senal ${senal}: cerrando el servidor.`);
  servidor.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => cerrar("SIGINT"));
process.on("SIGTERM", () => cerrar("SIGTERM"));
