# Alertas operativas de Lyngus Halo

El dashboard analítico continúa leyendo PostgreSQL/PostGIS mediante
`DATA_BACKEND=postgres`. MongoDB Atlas se conecta en paralelo y se utiliza para
la colección operacional `alertas_entrantes`.

## Preparación de Atlas

```bash
npm run mongo:setup-incoming-alerts
```

El comando instala el validador estricto, confirma los índices e inserta de
forma idempotente `HALO-20260815-000001`.

## API

- `GET /api/v1/alertas-operativas?estado=nueva&limite=50`: cola ordenada por
  `recibida_en` descendente.
- `GET /api/v1/alertas-operativas/:id-o-codigo`: detalle operacional.
- `GET /api/v1/alertas-operativas/eventos`: Server-Sent Events. Las inserciones
  en Atlas se publican como eventos `alerta_nueva`.
- `PATCH /api/v1/alertas-operativas/:id-o-codigo/estado`: avanza el flujo
  secuencial `nueva → revisando → atendida → cerrada`. Las modificaciones se
  publican por SSE como `alerta_actualizada`.

## Ruta vial con PostGIS y pgRouting

La cola y los eventos SSE no calculan rutas, de modo que la recepción desde
Atlas se mantiene liviana. Al solicitar el detalle de una alerta, el backend
ajusta el origen municipal y el destino a los vértices más cercanos de
`vita_routing.ways_vertices_pgr` y ejecuta `pgr_dijkstra` sobre
`vita_routing.ways`.

El algoritmo optimiza `cost_s`/`reverse_cost_s`, por lo que el ETA proviene de
los costos temporales y velocidades de la red OSM. La distancia se obtiene de
la suma de `length_m` de los segmentos recorridos. No se utiliza Haversine, una
velocidad fija ni una recta entre las coordenadas para calcular viaje o ETA.

Variables configurables:

```dotenv
MUNICIPALIDAD_LONGITUDE=-70.6014167
MUNICIPALIDAD_LATITUDE=-33.3986516
POSTGRES_ROUTING_SCHEMA=vita_routing
OPERATIONAL_ROUTING_MARGIN_DEGREES=0.05
OPERATIONAL_ROUTING_MAX_SNAP_METERS=1500
```

El margen limita el subgrafo enviado a pgRouting y se amplía una vez si no se
encuentra un camino. La distancia de ajuste a la red solo valida que los puntos
sean utilizables; no participa en el ETA.

La cámara pertenece a cada alerta. El frontend solo presenta el indicador y el
botón cuando el documento contiene `camara: true`.

## Contingencia PostgreSQL

La API reconstruye el pool y coordina una única sonda de recuperación cuando
recibe errores transitorios como `ECONNRESET`, `57P01` o una salida inesperada
del postmaster. Si la recuperación inmediata falla, abre el circuito durante
cinco segundos para evitar una tormenta de conexiones y responde `503`.

Las respuestas del resumen, mapa y analítica se conservan por filtro. Durante
una interrupción se entrega la última respuesta válida con
`metadata.contingencia.activa = true`. Las rutas calculadas también se guardan
para poder reabrir una alerta ya consultada sin depender de una nueva ejecución
de pgRouting. Si el navegador todavía no tiene información, utiliza el snapshot
local y vuelve a consultar la API automáticamente.

El endpoint `GET /api/v1/health` permanece disponible y expone el estado del
circuito, las fallas consecutivas, el último éxito y el estado de la caché.
