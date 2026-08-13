# Validación de pre-corte PostgreSQL/PostGIS

Fecha: 13 de agosto de 2026  
Motor persistente al finalizar: `DATA_BACKEND=mongo`

## Resultado

PostgreSQL está listo para un corte controlado. El backend arrancó de forma
aislada, sin cargar Mongoose, y el frontend consumió los cuatro contratos sin
cambios de rutas ni de modelo de respuesta.

## Cobertura funcional

- carga inicial del tablero y health check;
- períodos de 7, 30 y 90 días;
- categoría, zona, prioridad y filtros operacionales combinados;
- limpieza de filtros;
- mapa en modos calor, grupos y zonas;
- consulta espacial mediante `bbox`;
- hallazgos y comparación con período anterior;
- tendencias y composición por categoría;
- recorrido operacional;
- analítica de IA y cuidado;
- detalle completo y trazabilidad de una alerta.

La matriz automatizada `npm run postgres:verify-api-parity` aprobó 14 casos.
Los conteos y campos deterministas son exactos; medianas y p90 aceptan las
tolerancias declaradas por la diferencia entre los acumuladores aproximados de
MongoDB y los percentiles continuos de PostgreSQL.

## Integridad

- 1 municipalidad;
- 15 zonas;
- 5.000 usuarios;
- 2.500 dispositivos;
- 900 perfiles de cuidado;
- 20.000 alertas;
- cero geometrías inválidas;
- cero alertas fuera de zona o con zona inconsistente;
- equivalencia completa entre columnas extraídas y JSONB.

## Rendimiento representativo

Cinco muestras calientes por ruta contra las bases remotas del POC. Los
resultados dependen de la red y no sustituyen una prueba de carga concurrente.

| Ruta | Mongo p50 | PostgreSQL p50 | Mongo p95 | PostgreSQL p95 |
|---|---:|---:|---:|---:|
| Resumen 90 días | 717 ms | 413 ms | 764 ms | 471 ms |
| Mapa, 5.000 alertas | 855 ms | 135 ms | 878 ms | 374 ms |
| Analítica 90 días | 1.129 ms | 903 ms | 1.209 ms | 1.102 ms |
| Detalle de alerta | 236 ms | 10 ms | 243 ms | 63 ms |

La consulta del resumen PostgreSQL se consolidó en un conjunto materializado
por período para evitar múltiples lecturas de las mismas alertas. El mapa sigue
siendo la respuesta más grande, aproximadamente 2,25 MB para 5.000 puntos; el
filtro por `bbox` reduce ese volumen durante la exploración territorial.

## Validación del frontend

- auditoría del escenario y cinco historias analíticas aprobadas;
- build de producción aprobado;
- presupuesto de bundle aprobado: 71,8 KiB de JavaScript inicial gzip y
  9,4 KiB de CSS inicial gzip;
- navegación visual sin errores de aplicación;
- estilo cartográfico OpenFreeMap Liberty sin advertencias de glifos;
- proxy Vite opcional disponible para pruebas locales de la API.

## Procedimiento de corte

1. Ejecutar `npm run postgres:verify-data`.
2. Ejecutar ambos motores y `npm run postgres:verify-api-parity`.
3. Cambiar `DATA_BACKEND=postgres`.
4. Reiniciar la API y comprobar `/api/v1/health`.
5. Validar resumen, mapa, analítica y detalle desde el frontend.

Rollback: restablecer `DATA_BACKEND=mongo` y reiniciar. Ningún paso del corte
elimina o modifica los datos de MongoDB.
