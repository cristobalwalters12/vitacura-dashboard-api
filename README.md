# Vitacura Dashboard API

Backend NestJS + Fastify + Mongoose para consultar MongoDB Atlas sin descargar las alertas completas en el frontend.

## Requisitos

- Node.js 22.12 o superior.
- Acceso de red al cluster MongoDB Atlas.
- La IP del equipo autorizada en Atlas: **Security → Network Access**.
- Un usuario de base de datos con lectura sobre `community_sos_demo` y permiso `createIndex` únicamente durante la instalación de índices.

## Configuración

```powershell
Copy-Item .env.example .env
```

Completa `.env` sin agregarlo al repositorio:

```dotenv
PORT=3000
FRONTEND_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://USUARIO:CONTRASENA@cluster.mongodb.net
MONGODB_DATABASE=community_sos_demo
MUNICIPALIDAD_ID=64f000000000000000000132
MAPA_LIMITE_PREDETERMINADO=5000
```

Si la contraseña contiene caracteres como `@`, `:`, `/`, `?`, `#` o `%`, debe codificarse como URL antes de incluirla en la URI.

## Instalar y ejecutar

```powershell
npm install
npm run mongo:indexes
npm run mongo:explain
npm run start:dev
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
```

## Endpoints

### Resumen

```http
GET /api/v1/dashboard/resumen
    ?dias=90
    &categoria=medica
    &zona=A-3
```

MongoDB ejecuta un `$match` indexado y después un `$facet` para calcular en una sola operación:

- indicadores ejecutivos;
- distribución por categoría;
- tendencia diaria;
- rendimiento por zona.

### Mapa

```http
GET /api/v1/dashboard/mapa
    ?dias=30
    &categoria=seguridad
    &bbox=-70.61,-33.41,-70.51,-33.35
    &limite=5000
```

`bbox` utiliza el orden `oeste,sur,este,norte`. La respuesta indica `truncado: true` cuando existen más puntos que el límite solicitado.

## Índices

El comando `npm run mongo:indexes` crea índices para:

- municipalidad y fecha;
- categoría y fecha;
- zona y fecha;
- prioridad, estado y fecha;
- ubicación `2dsphere`;
- usuarios activos por zona;
- dispositivos por estado y batería;
- dependencia de perfiles de cuidado.

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
