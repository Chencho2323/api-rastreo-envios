/**
 * Configuracion de la aplicacion.
 *
 * Todo lo que la API necesita para arrancar se lee de variables de entorno,
 * con valores por defecto pensados para desarrollo local. No hay secretos
 * escritos en el repositorio: las credenciales reales se inyectan al desplegar.
 */

const PUERTO_POR_DEFECTO = 3000;

/**
 * Convierte un valor de entorno en un puerto valido.
 * @param {string|undefined} valor
 * @param {number} porDefecto
 * @returns {number}
 */
function leerPuerto(valor, porDefecto = PUERTO_POR_DEFECTO) {
  if (valor === undefined || valor === null || String(valor).trim() === "") {
    return porDefecto;
  }

  const puerto = Number(valor);

  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    throw new Error(`El puerto "${valor}" no es valido: debe ser un entero entre 1 y 65535.`);
  }

  return puerto;
}

/**
 * Lee la configuracion a partir de un objeto de entorno.
 * @param {Record<string, string|undefined>} entorno
 * @returns {{puerto: number, entorno: string, rutaBaseDatos: string}}
 */
export function leerConfiguracion(entorno = process.env) {
  const ambiente = entorno.NODE_ENV || "desarrollo";

  return {
    puerto: leerPuerto(entorno.PORT),
    entorno: ambiente,
    rutaBaseDatos: entorno.RUTA_BASE_DATOS || "datos/rastreo.sqlite",
  };
}
