import { createPostgresPool, quotedSchema } from './config.mjs';
import { scenarioManifest } from './scenario-files.mjs';

const pool = createPostgresPool('vita-postgres-explain');

function inspectPlan(node, summary) {
  summary.nodes.push(node['Node Type']);
  if (node['Index Name']) summary.indexes.push(node['Index Name']);
  summary.sharedHits += node['Shared Hit Blocks'] ?? 0;
  summary.sharedReads += node['Shared Read Blocks'] ?? 0;
  for (const child of node.Plans ?? []) inspectPlan(child, summary);
}

async function explain(name, sql, values, expectedIndex) {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    values,
  );
  const report = result.rows[0]['QUERY PLAN'][0];
  const summary = {
    name,
    executionMs: report['Execution Time'],
    planningMs: report['Planning Time'],
    actualRows: report.Plan['Actual Rows'],
    nodes: [],
    indexes: [],
    sharedHits: 0,
    sharedReads: 0,
  };
  inspectPlan(report.Plan, summary);
  summary.usesExpectedIndex = summary.indexes.includes(expectedIndex);
  return summary;
}

try {
  const sample = await pool.query(
    `SELECT id FROM ${quotedSchema}.alertas ORDER BY creado_en DESC LIMIT 1`,
  );
  const reports = await Promise.all([
    explain(
      'resumen_categoria_90_dias',
      `SELECT categoria, count(*),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY segundos_primera_respuesta)
       FROM ${quotedSchema}.alertas
       WHERE municipalidad_id = $1
         AND categoria = 'medica'
         AND creado_en >= timestamptz '2026-05-18T00:00:00Z'
         AND creado_en <= timestamptz '2026-08-15T23:59:59.999Z'
       GROUP BY categoria`,
      [scenarioManifest.id_municipalidad],
      'alertas_categoria_fecha_idx',
    ),
    explain(
      'mapa_bbox',
      `SELECT id, codigo_alerta, ST_X(ubicacion), ST_Y(ubicacion)
       FROM ${quotedSchema}.alertas
       WHERE municipalidad_id = $1
         AND ubicacion && ST_MakeEnvelope(-70.575, -33.400, -70.565, -33.390, 4326)
       LIMIT 500`,
      [scenarioManifest.id_municipalidad],
      'alertas_ubicacion_gist',
    ),
    explain(
      'detalle_alerta',
      `SELECT * FROM ${quotedSchema}.alertas
       WHERE id = $1 AND municipalidad_id = $2`,
      [sample.rows[0].id, scenarioManifest.id_municipalidad],
      'alertas_pkey',
    ),
  ]);

  const failures = reports
    .filter((report) => !report.usesExpectedIndex)
    .map((report) => `${report.name}: no utilizó el índice esperado`);
  console.log(
    JSON.stringify(
      {
        consultas: reports,
        indices_verificados: failures.length === 0,
        fallas: failures,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  await pool.end();
}
