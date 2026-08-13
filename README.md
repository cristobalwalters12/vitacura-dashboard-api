# Vitacura Dashboard API

Backend NestJS + Fastify con backends intercambiables MongoDB/PostgreSQL para consultar la analítica sin descargar las alertas completas en el frontend.

## Requisitos

- Node.js 22.12 o superior.
- Acceso de red al cluster MongoDB Atlas.
- La IP del equipo autorizada en Atlas: **Security → Network Access**.
- Un usuario de base de datos con lectura sobre la base configurada. Para preparar una base nueva también necesita permisos temporales de escritura y `createIndex`.

## Configuración

```powershell
Copy-Item .env.example .env
```

Completa `.env` sin agregarlo al repositorio:

```dotenv
PORT=3000
FRONTEND_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://USUARIO:CONTRASENA@cluster.mongodb.net
MONGODB_DATABASE=community_sos_demo_v3
DATA_BACKEND=mongo
POSTGRES_HOST=159.112.133.28
POSTGRES_PORT=5432
POSTGRES_DATABASE=geodb
POSTGRES_SCHEMA=vita
POSTGRES_USER=postgres
POSTGRES_PASSWORD=CONTRASENA_POSTGRES
POSTGRES_SSL=false
ANALYTICS_CUTOFF_DATE=2026-08-15T23:59:59.999Z
MUNICIPALIDAD_ID=64f000000000000000000132
MAPA_LIMITE_PREDETERMINADO=5000
```

Si la contraseña contiene caracteres como `@`, `:`, `/`, `?`, `#` o `%`, debe codificarse como URL antes de incluirla en la URI.

## PostgreSQL/PostGIS en paralelo

La migración POC vive dentro del esquema `vita` sin modificar ni reemplazar MongoDB. `DATA_BACKEND=mongo` mantiene el funcionamiento actual; `DATA_BACKEND=postgres` selecciona las implementaciones SQL de los cuatro contratos y arranca sin abrir una conexión MongoDB. El cambio no requiere modificar rutas ni configuración del frontend.

Las migraciones crean tablas relacionales para municipalidades, zonas, usuarios, dispositivos, perfiles de cuidado y alertas. Los campos usados por filtros y métricas se almacenan como columnas, el documento original se conserva en `jsonb`, y las geometrías utilizan SRID 4326 e índices GiST.

```powershell
npm run postgres:migrate
npm run postgres:migration-status
npm run postgres:import-scenario
npm run postgres:verify-data
npm run postgres:explain
```

El ejecutor:

- crea o confirma el esquema configurado;
- aplica cada archivo SQL dentro de una transacción;
- evita ejecuciones simultáneas mediante un advisory lock;
- registra versión y checksum en `vita.schema_migrations`;
- se niega a continuar si una migración ya aplicada fue modificada.

`postgres:migration-status` muestra conexión, versiones de PostGIS, migraciones, tablas e índices sin imprimir credenciales. `postgres:import-scenario` carga el paquete Extended JSON en una única transacción y se niega a escribir si las tablas ya contienen información. `postgres:verify-data` compara el manifiesto, conteos, agregados, relaciones, geometrías y columnas extraídas contra el paquete de origen. `postgres:explain` confirma con `EXPLAIN (ANALYZE, BUFFERS)` que las consultas representativas utilizan índices analíticos, GiST y de clave primaria.

El importador conserva los identificadores Mongo como `varchar(24)`, normaliza puntos y polígonos a SRID 4326 y guarda cada documento original en la columna `detalle jsonb`. Las agregaciones y filtros consultan columnas relacionales; el JSONB se reserva para reconstruir el detalle rico sin perder información.

Para una comparación previa al corte, arranca temporalmente cada motor en un puerto distinto y ejecuta la matriz automática:

```powershell
# Terminal 1: el .env permanece con DATA_BACKEND=mongo
$env:DATA_BACKEND='mongo'; $env:PORT='3000'; npm start

# Terminal 2
$env:DATA_BACKEND='postgres'; $env:PORT='3001'; npm start

# Terminal 3
npm run postgres:verify-api-parity
```

La matriz cubre resumen, mapa/PostGIS, analítica y detalle con períodos de 7, 30 y 90 días, categoría, zona, filtros múltiples y `bbox`. Los conteos, documentos e indicadores deterministas deben ser exactos; medianas y p90 admiten una tolerancia pequeña porque MongoDB usa acumuladores aproximados y PostgreSQL calcula percentiles continuos exactos.

Cuando se apruebe el corte, basta con cambiar `DATA_BACKEND=postgres` y reiniciar la API. Para volver atrás, restablece `DATA_BACKEND=mongo`; ninguna de las dos acciones escribe ni elimina datos del otro motor.

El resultado de la validación funcional, visual y de rendimiento está documentado en [`docs/postgres-precut-2026-08-13.md`](docs/postgres-precut-2026-08-13.md).

## Instalar y ejecutar

```powershell
npm install
npm run mongo:indexes
npm run mongo:explain
npm run start:dev
npm run dashboard:verify
```

Si PowerShell bloquea `npm.ps1`:

```powershell
npm.cmd install
npm.cmd run mongo:indexes
npm.cmd run mongo:explain
npm.cmd run start:dev
```

Pruebas rápidas:

```text
GET http://localhost:3000/api/v1/health
GET http://localhost:3000/api/v1/dashboard/resumen?dias=90&categoria=todas
GET http://localhost:3000/api/v1/dashboard/mapa?dias=90&categoria=todas&limite=5000
GET http://localhost:3000/api/v1/dashboard/analitica?dias=90&categoria=todas
GET http://localhost:3000/api/v1/alertas/ID_DE_ALERTA
```

## Carga del escenario sintético

El frontend genera un paquete Extended JSON reproducible. La carga se realiza una sola vez sobre una base nueva:

```powershell
# En vitacura-dashboard-react
npm run data:export-mongo -- --output=generated-mongo
npm run data:verify-mongo -- --input=generated-mongo

# En vitacura-dashboard-api
npm run mongo:import-scenario -- --input=../vitacura-dashboard-react/generated-mongo --database=community_sos_demo_v3
npm run mongo:indexes
npm run mongo:explain
```

Si la base v3 ya fue importada antes de incorporar las etapas operacionales,
el enriquecimiento es aditivo y se ejecuta una sola vez:

```powershell
npm run mongo:enrich-operational
```

Este comando agrega latencia de IA, hitos de clasificación, despacho, llegada
y resolución, y sincroniza las referencias sintéticas de persona, dispositivo
y perfil de cuidado utilizadas por el detalle. No elimina documentos.

El importador se niega a escribir si alguna colección objetivo ya contiene documentos. Al completar la carga registra `_scenario_manifest` con la versión, semilla, estado y conteos importados.

`ANALYTICS_CUTOFF_DATE` fija el cierre temporal de la demostración. Si el cliente no envía `hasta`, los períodos de 7, 30, 90 y 365 días se calculan contra esa fecha y no contra el reloj del servidor.

## Endpoints

### Resumen

```http
GET /api/v1/dashboard/resumen
    ?dias=90
    &categoria=medica
    &zona=A-3
    &prioridad=P1,P2
    &severidad=critica,alta
    &canal=reloj_inteligente
    &requiere_revision=true
    &escalada=true
```

MongoDB ejecuta un `$match` indexado y después un `$facet` para calcular en una sola operación:

- indicadores ejecutivos;
- distribución por categoría;
- tendencia diaria;
- rendimiento por zona.

El resumen también entrega:

- `comparacion`, con el período anterior equivalente, variaciones de KPIs, categorías, zonas y tendencia;
- `hallazgos`, con evidencia, nivel, descripción y filtros que el frontend puede aplicar directamente.

Con la API local en ejecución, `npm run dashboard:verify` comprueba la fecha de corte, la equivalencia temporal y la detección de las historias médicas, territoriales, operacionales, de cuidado y clasificación.

### Analítica avanzada

```http
GET /api/v1/dashboard/analitica
    ?dias=90
    &categoria=todas
    &zona=A-14
    &prioridad=P1,P2
    &severidad=critica,alta
    &canal=reloj_inteligente
    &requiere_revision=true
    &escalada=true
```

El endpoint comparte los filtros del resumen y concentra tres lecturas:

- `ia`: salud del modelo, confianza, revisión humana, latencia y desempeño por categoría;
- `respuesta`: recorrido completo, percentiles, zonas, respondedores y notificaciones;
- `cuidado`: perfiles, dependencia, riesgos, dispositivos, demanda horaria y respuesta por vulnerabilidad.

También devuelve hallazgos accionables que el frontend combina con la lectura territorial del resumen.

### Detalle de alerta

```http
GET /api/v1/alertas/:id
```

La consulta valida el `ObjectId`, limita el documento a la municipalidad configurada y respeta la fecha de corte. Devuelve:

- identificación, ubicación pública y origen de activación;
- seis hitos desde activación hasta resolución;
- clasificación, modelo, confianza, latencia, revisión y transcripción anonimizada;
- nivel, puntaje y razones de prioridad;
- respondedor, tramos operacionales y escalamiento;
- entrega y confirmación de notificaciones;
- estado técnico del dispositivo cuando corresponde;
- contexto minimizado de cuidado, sin identificadores personales;
- resultado final y declaración explícita de datos sintéticos.

### Mapa

```http
GET /api/v1/dashboard/mapa
    ?dias=30
    &categoria=seguridad
    &prioridad=P1
    &bbox=-70.61,-33.41,-70.51,-33.35
    &limite=5000
```

`bbox` utiliza el orden `oeste,sur,este,norte`. La respuesta indica `truncado: true` cuando existen más puntos que el límite solicitado.

`prioridad`, `severidad` y `canal` aceptan uno o varios valores separados por coma. Los mismos filtros operacionales se aplican al resumen y al mapa; `bbox` solamente limita los puntos territoriales visibles.

## Rendimiento y caché

La API expone políticas `Cache-Control` diferenciadas según la volatilidad y el costo de cada lectura:

- resumen y analítica: 30 segundos, con 60 segundos de `stale-while-revalidate`;
- mapa: 10 segundos, con 20 segundos de `stale-while-revalidate`;
- detalle de alerta: 5 minutos, con 10 minutos de `stale-while-revalidate`.

Todas son cachés privadas porque el dashboard evolucionará hacia datos segmentados por municipalidad y permisos. El frontend añade una caché en memoria y redondea el `bbox` para evitar consultas equivalentes durante movimientos mínimos del mapa.

## Índices

El comando `npm run mongo:indexes` crea índices para:

- municipalidad y fecha;
- categoría y fecha;
- zona y fecha;
- prioridad y fecha;
- severidad y fecha;
- canal y fecha;
- revisión humana y fecha;
- escalamiento y fecha;
- ubicación `2dsphere`;
- usuarios activos por zona;
- dispositivos por estado y batería;
- dependencia de perfiles de cuidado.
- búsqueda de perfil de cuidado por usuario para el detalle de alerta.

No ejecutes el comando en cada arranque del backend. Se utiliza al preparar una base nueva o al cambiar el diseño de consultas.

Después de crear los índices, `npm run mongo:explain` muestra cuántos documentos y claves examina MongoDB. El objetivo es evitar un plan `COLLSCAN` y mantener `documentos_examinados` cerca de `documentos_entregados`.

## Conexión del frontend

En el proyecto React crea `.env.local`:

```dotenv
VITE_API_BASE_URL=http://localhost:3000
```

Luego ejecuta ambos proyectos en terminales separadas.

## Seguridad

- La URI de MongoDB solo vive en el backend.
- No debe existir ninguna variable `VITE_MONGODB_*`.
- En producción, reemplaza `MUNICIPALIDAD_ID` por el tenant obtenido desde el JWT.
- El usuario cotidiano del backend debe tener permisos de lectura, no administración del cluster.
- Utiliza TLS, rotación de credenciales y una lista de IPs restringida en Atlas.
