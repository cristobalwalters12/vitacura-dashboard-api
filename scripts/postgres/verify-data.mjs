import { createPostgresPool, postgresSchema, quotedSchema } from './config.mjs';
import {
  forEachJsonLine,
  scenarioDirectory,
  scenarioManifest,
} from './scenario-files.mjs';

const pool = createPostgresPool('vita-postgres-verify');
const failures = [];

function addCount(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function normalizedObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function expectEqual(label, actual, expected) {
  const normalizedActual =
    actual && typeof actual === 'object' ? normalizedObject(actual) : actual;
  const normalizedExpected =
    expected && typeof expected === 'object'
      ? normalizedObject(expected)
      : expected;
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    failures.push(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

const expected = {
  usuarios_activos: 0,
  dispositivos_activos: 0,
  bateria_baja: 0,
  perfiles_activos: 0,
  dependencia_severa: 0,
  alertas_p1: 0,
  alertas_escaladas: 0,
  alertas_reloj: 0,
  alertas_cuidado: 0,
  categorias: {},
  zonas: {},
  fecha_minima: null,
  fecha_maxima: null,
};

await forEachJsonLine('usuarios', (document) => {
  if (document.activo) expected.usuarios_activos += 1;
});
await forEachJsonLine('dispositivos', (document) => {
  if (document.estado === 'activo') expected.dispositivos_activos += 1;
  if (document.ultimo_estado_conocido?.porcentaje_bateria <= 20) {
    expected.bateria_baja += 1;
  }
});
await forEachJsonLine('perfiles_cuidado', (document) => {
  if (document.activo) expected.perfiles_activos += 1;
  if (document.perfil_cuidado?.nivel_dependencia === 'severa') {
    expected.dependencia_severa += 1;
  }
});
await forEachJsonLine('alertas', (document) => {
  const category = document.clasificacion?.categoria;
  const zone = document.ubicacion?.referencia_ubicacion?.codigo_zona;
  addCount(expected.categorias, category);
  addCount(expected.zonas, zone);
  if (document.prioridad?.nivel === 'P1') expected.alertas_p1 += 1;
  if (document.resumen_respuesta?.escalada_centro_emergencia) {
    expected.alertas_escaladas += 1;
  }
  if (document.origen?.canal === 'reloj_inteligente') {
    expected.alertas_reloj += 1;
  }
  if (category === 'asistencia_cuidador') expected.alertas_cuidado += 1;
  const date = document.creado_en?.$date;
  if (!expected.fecha_minima || date < expected.fecha_minima) {
    expected.fecha_minima = date;
  }
  if (!expected.fecha_maxima || date > expected.fecha_maxima) {
    expected.fecha_maxima = date;
  }
});

try {
  const [
    manifestResult,
    countsResult,
    summaryResult,
    categoriesResult,
    zonesResult,
    integrityResult,
    extractionResult,
  ] = await Promise.all([
    pool.query(`
      SELECT escenario, semilla, municipalidad_id, estado,
             conteos_esperados, conteos_importados
      FROM ${quotedSchema}.scenario_manifest
      WHERE id = $1
    `, [`escenario-${scenarioManifest.escenario}`]),
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM ${quotedSchema}.municipalidades) AS municipalidades,
        (SELECT count(*)::int FROM ${quotedSchema}.zonas) AS zonas,
        (SELECT count(*)::int FROM ${quotedSchema}.usuarios) AS usuarios,
        (SELECT count(*)::int FROM ${quotedSchema}.dispositivos) AS dispositivos,
        (SELECT count(*)::int FROM ${quotedSchema}.perfiles_cuidado) AS perfiles_cuidado,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas) AS alertas
    `),
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM ${quotedSchema}.usuarios WHERE activo) AS usuarios_activos,
        (SELECT count(*)::int FROM ${quotedSchema}.dispositivos WHERE estado = 'activo') AS dispositivos_activos,
        (SELECT count(*)::int FROM ${quotedSchema}.dispositivos WHERE porcentaje_bateria <= 20) AS bateria_baja,
        (SELECT count(*)::int FROM ${quotedSchema}.perfiles_cuidado WHERE activo) AS perfiles_activos,
        (SELECT count(*)::int FROM ${quotedSchema}.perfiles_cuidado WHERE nivel_dependencia = 'severa') AS dependencia_severa,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas WHERE prioridad = 'P1') AS alertas_p1,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas WHERE escalada_centro_emergencia) AS alertas_escaladas,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas WHERE canal = 'reloj_inteligente') AS alertas_reloj,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas WHERE categoria = 'asistencia_cuidador') AS alertas_cuidado,
        (SELECT min(creado_en) FROM ${quotedSchema}.alertas) AS fecha_minima,
        (SELECT max(creado_en) FROM ${quotedSchema}.alertas) AS fecha_maxima
    `),
    pool.query(`
      SELECT categoria, count(*)::int AS total
      FROM ${quotedSchema}.alertas
      GROUP BY categoria
      ORDER BY categoria
    `),
    pool.query(`
      SELECT codigo_zona, count(*)::int AS total
      FROM ${quotedSchema}.alertas
      GROUP BY codigo_zona
      ORDER BY codigo_zona
    `),
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM ${quotedSchema}.zonas
          WHERE ST_SRID(geometria) <> 4326 OR NOT ST_IsValid(geometria)) AS zonas_invalidas,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas
          WHERE ST_SRID(ubicacion) <> 4326 OR NOT ST_IsValid(ubicacion)) AS alertas_invalidas,
        (SELECT count(*)::int
          FROM ${quotedSchema}.alertas a
          JOIN ${quotedSchema}.zonas z ON z.id = a.zona_id
          WHERE NOT ST_Covers(z.geometria, a.ubicacion)) AS alertas_fuera_zona,
        (SELECT count(*)::int
          FROM ${quotedSchema}.alertas a
          JOIN ${quotedSchema}.zonas z ON z.id = a.zona_id
          WHERE a.codigo_zona IS DISTINCT FROM z.codigo) AS alertas_zona_inconsistente,
        (SELECT count(*)::int
          FROM ${quotedSchema}.alertas a
          LEFT JOIN ${quotedSchema}.perfiles_cuidado p
            ON p.usuario_id = a.usuario_afectado_id AND p.activo
          WHERE a.categoria = 'asistencia_cuidador' AND p.id IS NULL) AS cuidado_sin_perfil,
        (SELECT count(*)::int FROM ${quotedSchema}.alertas
          WHERE canal = 'reloj_inteligente' AND dispositivo_id IS NULL) AS reloj_sin_dispositivo
    `),
    pool.query(`
      SELECT count(*)::int AS inconsistencias
      FROM ${quotedSchema}.alertas
      WHERE id IS DISTINCT FROM detalle #>> '{_id,$oid}'
         OR categoria IS DISTINCT FROM detalle #>> '{clasificacion,categoria}'
         OR prioridad IS DISTINCT FROM detalle #>> '{prioridad,nivel}'
         OR codigo_zona IS DISTINCT FROM detalle #>> '{ubicacion,referencia_ubicacion,codigo_zona}'
         OR creado_en IS DISTINCT FROM (detalle #>> '{creado_en,$date}')::timestamptz
         OR ST_X(ubicacion) IS DISTINCT FROM
              (detalle #>> '{ubicacion,coordinates,0}')::double precision
         OR ST_Y(ubicacion) IS DISTINCT FROM
              (detalle #>> '{ubicacion,coordinates,1}')::double precision
    `),
  ]);

  const manifest = manifestResult.rows[0];
  if (!manifest) failures.push('No existe el manifiesto importado');
  if (manifest) {
    expectEqual('manifiesto escenario', manifest.escenario, scenarioManifest.escenario);
    expectEqual('manifiesto semilla', manifest.semilla, scenarioManifest.semilla);
    expectEqual('manifiesto municipalidad', manifest.municipalidad_id, scenarioManifest.id_municipalidad);
    expectEqual('manifiesto estado', manifest.estado, 'completo');
    expectEqual('conteos esperados', manifest.conteos_esperados, scenarioManifest.colecciones);
    expectEqual('conteos importados', manifest.conteos_importados, scenarioManifest.colecciones);
  }

  const counts = countsResult.rows[0];
  expectEqual('municipalidades', counts.municipalidades, 1);
  for (const [name, total] of Object.entries(scenarioManifest.colecciones)) {
    expectEqual(name, counts[name], total);
  }

  const summary = summaryResult.rows[0];
  for (const key of [
    'usuarios_activos',
    'dispositivos_activos',
    'bateria_baja',
    'perfiles_activos',
    'dependencia_severa',
    'alertas_p1',
    'alertas_escaladas',
    'alertas_reloj',
    'alertas_cuidado',
  ]) {
    expectEqual(key, summary[key], expected[key]);
  }
  expectEqual(
    'fecha mínima',
    summary.fecha_minima?.toISOString(),
    expected.fecha_minima,
  );
  expectEqual(
    'fecha máxima',
    summary.fecha_maxima?.toISOString(),
    expected.fecha_maxima,
  );

  expectEqual(
    'categorías',
    Object.fromEntries(categoriesResult.rows.map((row) => [row.categoria, row.total])),
    expected.categorias,
  );
  expectEqual(
    'zonas',
    Object.fromEntries(zonesResult.rows.map((row) => [row.codigo_zona, row.total])),
    expected.zonas,
  );

  const integrity = integrityResult.rows[0];
  for (const [name, total] of Object.entries(integrity)) {
    expectEqual(name, total, 0);
  }
  expectEqual(
    'columnas extraídas vs. JSONB',
    extractionResult.rows[0].inconsistencias,
    0,
  );

  console.log(
    JSON.stringify(
      {
        esquema: postgresSchema,
        directorio: scenarioDirectory,
        escenario: scenarioManifest.escenario,
        conteos: counts,
        resumen: {
          usuarios_activos: summary.usuarios_activos,
          dispositivos_activos: summary.dispositivos_activos,
          perfiles_activos: summary.perfiles_activos,
          alertas_p1: summary.alertas_p1,
          alertas_escaladas: summary.alertas_escaladas,
          periodo: [
            summary.fecha_minima?.toISOString(),
            summary.fecha_maxima?.toISOString(),
          ],
        },
        integridad: integrity,
        equivalencia_jsonb: extractionResult.rows[0].inconsistencias === 0,
        verificacion_exitosa: failures.length === 0,
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
