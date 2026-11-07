# API de rastreo de envios multitransportadora

Normaliza los estados y fechas de paqueterias colombianas a un modelo comun (generado, en transito, entregado, devuelto, perdido) y expone eventos por webhook a las otras aplicaciones del negocio.

![CI](https://github.com/Chencho2323/api-rastreo-envios/actions/workflows/ci.yml/badge.svg)
![Licencia](https://img.shields.io/badge/licencia-MIT-03A8FA?style=flat-square)

**Stack:** Node.js 24 · SQLite · node --test

## Que resuelve

Este repositorio es parte del portafolio publico de
[InheritDevs](https://inheritdevs.com/): software empresarial que funciona en
produccion. El codigo esta aqui para que se pueda leer, ejecutar y auditar.

- Codigo completo, no un ejemplo recortado.
- Pruebas que corren en cada push (`npm test`, `phpunit` o `pytest`, segun el
  stack) y en cada pull request.
- Sin dependencias ocultas: lo que dice el README es lo que hace falta.

## Instalacion

```bash
git clone https://github.com/Chencho2323/api-rastreo-envios.git
cd api-rastreo-envios
npm install
```

No hay dependencias externas: `npm install` solo crea el arbol vacio y deja
listo el runner. Hace falta Node.js 24 o superior.

## Uso

```bash
npm start                 # levanta el servidor en el puerto 3000
PORT=8080 npm start       # otro puerto
```

El servidor responde el chequeo de salud, recibe eventos y consulta el estado
por guia:

```bash
curl http://localhost:3000/salud
# {"estado":"ok","servicio":"api-rastreo-envios"}

curl http://localhost:3000/guias/gui-9001
```

Los eventos entran por `POST /eventos` o por `POST /guias/:guia/eventos`. El
cuerpo puede traer el estado ya canonico o el texto crudo de la transportadora
en `estadoOriginal`:

```bash
curl -X POST http://localhost:3000/eventos \
  -H "content-type: application/json" \
  -H "idempotency-key: notif-001" \
  -d '{
    "guia": "GUI-9001",
    "transportadora": "Servientrega",
    "estadoOriginal": "EN REPARTO",
    "ocurridoEn": "2026-11-02T08:15:00-05:00",
    "ciudad": "Medellin"
  }'
# 201 {"evento":{...},"duplicado":false,"totalEventos":1}
```

El registro es idempotente. Un evento con la misma guia, transportadora, estado
y fecha no se guarda dos veces: la segunda vez responde 200 con
`"duplicado": true` y el evento que ya estaba. La cabecera `idempotency-key` (o
el campo `claveIdempotencia` en el cuerpo) cubre el caso en que el reintento
llega con un texto distinto; reutilizar la clave para otro hecho responde 409.

Un envio cerrado (entregado, devuelto o perdido) no acepta movimientos nuevos:
responde 409 y nombra la guia. La repeticion del mismo hecho si se acepta, como
duplicado.

La consulta devuelve el estado actual del envio, la fecha del ultimo
movimiento, si el envio ya cerro y el historial completo ordenado del mas viejo
al mas nuevo:

```json
{
  "guia": "GUI-9001",
  "estado": "en_transito",
  "ocurridoEn": "2026-11-02T14:00:00.000Z",
  "cerrado": false,
  "totalEventos": 2,
  "eventos": [
    { "estado": "generado", "ocurridoEn": "2026-11-01T13:00:00.000Z" },
    { "estado": "en_transito", "ocurridoEn": "2026-11-02T14:00:00.000Z" }
  ]
}
```

El numero de guia se normaliza a mayusculas y solo admite letras, numeros y
guion. Una guia sin eventos responde 404; una guia mal formada responde 400 y
nombra el campo culpable.

La configuracion se lee del entorno: `PORT`, `NODE_ENV` y `RUTA_BASE_DATOS`.

## Transportadoras

Cada transportadora tiene su adaptador en `src/transportadoras.js`, con la
tabla que traduce sus codigos y sus textos de novedad al modelo comun. Hoy
estan Servientrega, Interrapidisimo, TCC, Envia y Coordinadora.

```js
import { traducirEvento } from "./src/transportadoras.js";

traducirEvento({
  transportadora: "Servientrega",
  guia: "gui-9001",
  estadoOriginal: "EN REPARTO",
  ocurridoEn: "2026-11-02T08:15:00-05:00",
});
// estado: "en_transito", codigoOriginal: "EN REPARTO"
```

Un estado que no este en la tabla no se adivina: el adaptador falla y nombra el
valor original para que se agregue la equivalencia.

## Pruebas

```bash
npm test        # runner de Node, sin dependencias
./verificar.sh  # el mismo gate que corre el CI
```

## Estructura

```
src/        codigo de la aplicacion
  app.js            servidor HTTP y rutas
  almacen.js        guarda los eventos por guia
  registro.js       deduplica eventos y aplica la idempotencia
  consulta.js       arma el estado actual y el historial de una guia
test/       pruebas automaticas
```

## Licencia

MIT. Ver `LICENSE`.
