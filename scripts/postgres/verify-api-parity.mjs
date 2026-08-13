import assert from 'node:assert/strict';

const mongoBaseUrl = process.env.MONGO_API_URL ?? 'http://127.0.0.1:3000/api/v1';
const postgresBaseUrl =
  process.env.POSTGRES_API_URL ?? 'http://127.0.0.1:3001/api/v1';

async function request(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} respondió ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function both(path) {
  const [mongo, postgres] = await Promise.all([
    request(mongoBaseUrl, path),
    request(postgresBaseUrl, path),
  ]);
  return { mongo, postgres };
}

function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs((actual ?? 0) - (expected ?? 0)) <= tolerance,
    `${label}: Mongo=${actual}, PostgreSQL=${expected}, tolerancia=${tolerance}`,
  );
}

function keyed(rows, key) {
  return Object.fromEntries(rows.map((row) => [row[key], row]));
}

function compareSummary(mongo, postgres, label) {
  equal(mongo.metadata.periodo, postgres.metadata.periodo, `${label}.periodo`);
  equal(
    mongo.metadata.filtros_aplicados,
    postgres.metadata.filtros_aplicados,
    `${label}.filtros`,
  );
  equal(
    mongo.resumen_operacional,
    postgres.resumen_operacional,
    `${label}.operacional`,
  );
  const exactMetrics = [
    'total_alertas',
    'alertas_criticas',
    'escaladas_emergencia',
  ];
  const approximateMetrics = [
    ['mediana_respuesta_segundos', 2],
    ['p90_respuesta_segundos', 4],
    ['cumplimiento_sla', 0.0001],
    ['porcentaje_reloj', 0.0001],
    ['porcentaje_automatico', 0.0001],
  ];
  for (const key of exactMetrics) {
    equal(mongo.metricas[key], postgres.metricas[key], `${label}.${key}`);
  }
  for (const [key, tolerance] of approximateMetrics) {
    near(mongo.metricas[key], postgres.metricas[key], tolerance, `${label}.${key}`);
  }
  equal(keyed(mongo.categorias, 'categoria'), keyed(postgres.categorias, 'categoria'), `${label}.categorias`);
  equal(
    mongo.tendencia.map(({ fecha, ...row }) => ({ fecha: fecha.slice(0, 10), ...row })),
    postgres.tendencia.map(({ fecha, ...row }) => ({ fecha: fecha.slice(0, 10), ...row })),
    `${label}.tendencia`,
  );
  const mongoZones = keyed(mongo.estadisticas_zonas, 'codigo');
  const postgresZones = keyed(postgres.estadisticas_zonas, 'codigo');
  equal(Object.keys(mongoZones).sort(), Object.keys(postgresZones).sort(), `${label}.zonas`);
  for (const code of Object.keys(mongoZones)) {
    for (const key of ['usuarios', 'alertas', 'criticas']) {
      equal(mongoZones[code][key], postgresZones[code][key], `${label}.${code}.${key}`);
    }
    near(
      mongoZones[code].respuesta_mediana,
      postgresZones[code].respuesta_mediana,
      10,
      `${label}.${code}.respuesta`,
    );
  }
  equal(
    mongo.hallazgos.map((finding) => finding.id),
    postgres.hallazgos.map((finding) => finding.id),
    `${label}.hallazgos`,
  );
}

function compareMap(mongo, postgres, label) {
  equal(mongo.metadata, postgres.metadata, `${label}.metadata`);
  equal(
    mongo.alertas.map((alert) => alert.id),
    postgres.alertas.map((alert) => alert.id),
    `${label}.ids`,
  );
  for (let index = 0; index < mongo.alertas.length; index += 1) {
    equal(mongo.alertas[index], postgres.alertas[index], `${label}.alerta.${index}`);
  }
}

function compareAnalytics(mongo, postgres, label) {
  equal(mongo.metadata, postgres.metadata, `${label}.metadata`);
  const exactAi = ['total', 'revisiones', 'baja_confianza'];
  for (const key of exactAi) {
    equal(mongo.ia.resumen[key], postgres.ia.resumen[key], `${label}.ia.${key}`);
  }
  for (const key of [
    'confianza_media',
    'tasa_revision',
    'tasa_automatica',
    'tasa_baja_confianza',
  ]) {
    near(mongo.ia.resumen[key], postgres.ia.resumen[key], 0.0001, `${label}.ia.${key}`);
  }
  near(
    mongo.ia.resumen.latencia_mediana_ms,
    postgres.ia.resumen.latencia_mediana_ms,
    3,
    `${label}.ia.latencia_mediana`,
  );
  near(
    mongo.ia.resumen.latencia_p90_ms,
    postgres.ia.resumen.latencia_p90_ms,
    5,
    `${label}.ia.latencia_p90`,
  );
  equal(mongo.ia.salud, postgres.ia.salud, `${label}.ia.salud`);
  equal(
    mongo.respuesta.resumen.total,
    postgres.respuesta.resumen.total,
    `${label}.respuesta.total`,
  );
  for (const key of Object.keys(mongo.respuesta.resumen).filter((key) => key !== 'total')) {
    near(
      mongo.respuesta.resumen[key],
      postgres.respuesta.resumen[key],
      key.startsWith('p90_') ? 25 : 5,
      `${label}.respuesta.${key}`,
    );
  }
  equal(mongo.respuesta.notificaciones, postgres.respuesta.notificaciones, `${label}.notificaciones`);
  equal(mongo.cuidado.resumen, postgres.cuidado.resumen, `${label}.cuidado.resumen`);
  equal(mongo.cuidado.dispositivos, postgres.cuidado.dispositivos, `${label}.cuidado.dispositivos`);
  equal(keyed(mongo.cuidado.dependencia, 'nivel'), keyed(postgres.cuidado.dependencia, 'nivel'), `${label}.cuidado.dependencia`);
  equal(keyed(mongo.cuidado.riesgos, 'riesgo'), keyed(postgres.cuidado.riesgos, 'riesgo'), `${label}.cuidado.riesgos`);
  equal(
    mongo.hallazgos.map((finding) => finding.id),
    postgres.hallazgos.map((finding) => finding.id),
    `${label}.hallazgos`,
  );
}

const checks = [];
for (const query of [
  'dias=7',
  'dias=30',
  'dias=90',
  'dias=90&categoria=seguridad',
  'dias=90&zona=A-3',
  'dias=90&prioridad=P1,P2&canal=movil',
]) {
  const label = `resumen:${query}`;
  const result = await both(`/dashboard/resumen?${query}`);
  compareSummary(result.mongo, result.postgres, label);
  checks.push(label);
}

for (const query of [
  'dias=30&limite=100',
  'dias=90&categoria=medica&limite=100',
  'dias=90&bbox=-70.62,-33.42,-70.54,-33.36&limite=100',
]) {
  const label = `mapa:${query}`;
  const result = await both(`/dashboard/mapa?${query}`);
  compareMap(result.mongo, result.postgres, label);
  checks.push(label);
}

for (const query of [
  'dias=30',
  'dias=90',
  'dias=90&categoria=asistencia_cuidador',
  'dias=90&zona=A-5',
]) {
  const label = `analitica:${query}`;
  const result = await both(`/dashboard/analitica?${query}`);
  compareAnalytics(result.mongo, result.postgres, label);
  checks.push(label);
}

const map = await request(mongoBaseUrl, '/dashboard/mapa?dias=90&limite=100');
const alertId = map.alertas[0]?.id;
assert.ok(alertId, 'No se encontró una alerta para validar el detalle');
const detail = await both(`/alertas/${alertId}`);
equal(detail.mongo, detail.postgres, `detalle:${alertId}`);
checks.push(`detalle:${alertId}`);

console.log(
  JSON.stringify(
    {
      estado: 'paridad_aprobada',
      motores: { mongo: mongoBaseUrl, postgres: postgresBaseUrl },
      verificaciones: checks.length,
      casos: checks,
    },
    null,
    2,
  ),
);
