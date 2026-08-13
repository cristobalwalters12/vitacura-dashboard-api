import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.API_URL ?? 'http://127.0.0.1:3000/api/v1').replace(
  /\/$/,
  '',
);
const samples = Number(process.env.PERFORMANCE_SAMPLES ?? 5);
if (!Number.isInteger(samples) || samples < 2 || samples > 30) {
  throw new Error('PERFORMANCE_SAMPLES debe estar entre 2 y 30');
}

async function fetchTimed(path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await response.text();
  const duration = performance.now() - started;
  if (!response.ok) {
    throw new Error(`${path} respondió ${response.status}: ${body.slice(0, 300)}`);
  }
  return { duration, bytes: Buffer.byteLength(body), body };
}

function percentile(values, position) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(position * sorted.length) - 1];
}

async function benchmark(name, path) {
  await fetchTimed(path);
  const results = [];
  for (let index = 0; index < samples; index += 1) {
    results.push(await fetchTimed(path));
  }
  const durations = results.map((result) => result.duration);
  return {
    nombre: name,
    ruta: path,
    muestras: samples,
    promedio_ms: Number(
      (durations.reduce((sum, value) => sum + value, 0) / samples).toFixed(1),
    ),
    p50_ms: Number(percentile(durations, 0.5).toFixed(1)),
    p95_ms: Number(percentile(durations, 0.95).toFixed(1)),
    maximo_ms: Number(Math.max(...durations).toFixed(1)),
    respuesta_kb: Number((results[0].bytes / 1024).toFixed(1)),
  };
}

const health = await fetchTimed('/health');
const healthBody = JSON.parse(health.body);
const map = await fetchTimed('/dashboard/mapa?dias=90&limite=100');
const alertId = JSON.parse(map.body).alertas?.[0]?.id;
if (!alertId) throw new Error('No se encontró una alerta para medir el detalle');

const cases = [
  ['resumen_90_dias', '/dashboard/resumen?dias=90'],
  ['mapa_5000_alertas', '/dashboard/mapa?dias=90&limite=5000'],
  ['analitica_90_dias', '/dashboard/analitica?dias=90'],
  ['detalle_alerta', `/alertas/${alertId}`],
];
const results = [];
for (const [name, path] of cases) {
  results.push(await benchmark(name, path));
}

console.log(
  JSON.stringify(
    {
      api: baseUrl,
      backend: healthBody.backend ?? 'desconocido',
      estado: healthBody.estado,
      resultados: results,
    },
    null,
    2,
  ),
);
