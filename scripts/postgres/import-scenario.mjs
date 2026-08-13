import {
  createPostgresPool,
  postgresSchema,
  quotedSchema,
} from './config.mjs';
import {
  forEachJsonLine,
  readFirstJsonLine,
  scenarioDirectory,
  scenarioManifest,
} from './scenario-files.mjs';

const pool = createPostgresPool('vita-postgres-import');
const batchSize = 500;
const lockName = `${postgresSchema}:scenario-import`;

const inserts = {
  zonas: `
    INSERT INTO ${quotedSchema}.zonas (
      id, organizacion_id, municipalidad_id, codigo, nombre, centroide,
      geometria, fuente_geometria, nombre_capa_origen, peso_distribucion,
      precision_geometria, sintetico, detalle
    )
    SELECT
      doc #>> '{_id,$oid}',
      doc #>> '{id_organizacion,$oid}',
      doc #>> '{id_municipalidad,$oid}',
      doc ->> 'codigo',
      doc ->> 'nombre',
      ST_SetSRID(ST_GeomFromGeoJSON((doc -> 'centroide')::text), 4326),
      ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON((doc -> 'geometria')::text), 4326)),
      doc ->> 'fuente_geometria',
      doc ->> 'nombre_capa_origen',
      NULLIF(doc ->> 'peso_distribucion', '')::numeric,
      doc ->> 'precision_geometria',
      COALESCE((doc ->> 'sintetico')::boolean, true),
      doc
    FROM jsonb_array_elements($1::jsonb) AS source(doc)
  `,
  usuarios: `
    INSERT INTO ${quotedSchema}.usuarios (
      id, organizacion_id, municipalidad_id, zona_hogar_id, codigo_sintetico,
      tipo_perfil, anio_nacimiento, rango_edad, nivel_vulnerabilidad,
      consentimiento, activo, sintetico, creado_en, actualizado_en, detalle
    )
    SELECT
      doc #>> '{_id,$oid}',
      doc #>> '{id_organizacion,$oid}',
      doc #>> '{id_municipalidad,$oid}',
      doc #>> '{id_zona_hogar,$oid}',
      doc ->> 'codigo_sintetico',
      doc ->> 'tipo_perfil',
      NULLIF(doc ->> 'anio_nacimiento', '')::smallint,
      doc ->> 'rango_edad',
      doc ->> 'nivel_vulnerabilidad',
      COALESCE(doc -> 'consentimiento', '{}'::jsonb),
      COALESCE((doc ->> 'activo')::boolean, true),
      COALESCE((doc ->> 'sintetico')::boolean, true),
      NULLIF(doc #>> '{creado_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{actualizado_en,$date}', '')::timestamptz,
      doc
    FROM jsonb_array_elements($1::jsonb) AS source(doc)
  `,
  dispositivos: `
    INSERT INTO ${quotedSchema}.dispositivos (
      id, organizacion_id, municipalidad_id, usuario_asignado_id, numero_serie,
      tipo, fabricante, modelo, version_firmware, estado, capacidades,
      porcentaje_bateria, conectividad, intensidad_senal,
      visto_ultima_vez_en, ultima_ubicacion, ultimo_estado, activado_en,
      sintetico, creado_en, actualizado_en, detalle
    )
    SELECT
      doc #>> '{_id,$oid}',
      doc #>> '{id_organizacion,$oid}',
      doc #>> '{id_municipalidad,$oid}',
      doc #>> '{id_usuario_asignado,$oid}',
      doc ->> 'numero_serie',
      doc ->> 'tipo',
      doc ->> 'fabricante',
      doc ->> 'modelo',
      doc ->> 'version_firmware',
      doc ->> 'estado',
      COALESCE(doc -> 'capacidades', '{}'::jsonb),
      NULLIF(doc #>> '{ultimo_estado_conocido,porcentaje_bateria}', '')::smallint,
      doc #>> '{ultimo_estado_conocido,conectividad}',
      NULLIF(doc #>> '{ultimo_estado_conocido,intensidad_senal}', '')::smallint,
      NULLIF(doc #>> '{ultimo_estado_conocido,visto_por_ultima_vez_en,$date}', '')::timestamptz,
      CASE
        WHEN doc #> '{ultimo_estado_conocido,ubicacion}' IS NULL THEN NULL
        ELSE ST_SetSRID(
          ST_GeomFromGeoJSON((doc #> '{ultimo_estado_conocido,ubicacion}')::text),
          4326
        )
      END,
      COALESCE(doc -> 'ultimo_estado_conocido', '{}'::jsonb),
      NULLIF(doc #>> '{activado_en,$date}', '')::timestamptz,
      COALESCE((doc ->> 'sintetico')::boolean, true),
      NULLIF(doc #>> '{creado_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{actualizado_en,$date}', '')::timestamptz,
      doc
    FROM jsonb_array_elements($1::jsonb) AS source(doc)
  `,
  perfiles_cuidado: `
    INSERT INTO ${quotedSchema}.perfiles_cuidado (
      id, version_esquema, organizacion_id, municipalidad_id, usuario_id,
      nivel_dependencia, movilidad, vive_solo, limitaciones_comunicacion,
      factores_riesgo, perfil, plan_emergencia, consentimiento, activo,
      sintetico, creado_en, actualizado_en, detalle
    )
    SELECT
      doc #>> '{_id,$oid}',
      NULLIF(doc ->> 'version_esquema', '')::integer,
      doc #>> '{id_organizacion,$oid}',
      doc #>> '{id_municipalidad,$oid}',
      doc #>> '{id_usuario,$oid}',
      doc #>> '{perfil_cuidado,nivel_dependencia}',
      doc #>> '{perfil_cuidado,movilidad}',
      NULLIF(doc #>> '{perfil_cuidado,vive_solo}', '')::boolean,
      ARRAY(
        SELECT jsonb_array_elements_text(
          COALESCE(doc #> '{perfil_cuidado,limitaciones_comunicacion}', '[]'::jsonb)
        )
      ),
      ARRAY(
        SELECT jsonb_array_elements_text(
          COALESCE(doc #> '{perfil_cuidado,factores_riesgo}', '[]'::jsonb)
        )
      ),
      COALESCE(doc -> 'perfil_cuidado', '{}'::jsonb),
      COALESCE(doc -> 'plan_emergencia', '{}'::jsonb),
      COALESCE(doc -> 'consentimiento', '{}'::jsonb),
      COALESCE((doc ->> 'activo')::boolean, true),
      COALESCE((doc ->> 'sintetico')::boolean, true),
      NULLIF(doc #>> '{creado_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{actualizado_en,$date}', '')::timestamptz,
      doc
    FROM jsonb_array_elements($1::jsonb) AS source(doc)
  `,
  alertas: `
    INSERT INTO ${quotedSchema}.alertas (
      id, version_esquema, organizacion_id, municipalidad_id, comunidad_id,
      zona_id, usuario_afectado_id, dispositivo_id, codigo_alerta, creado_en,
      actualizado_en, estado, categoria, tipo, severidad, confianza,
      requiere_revision_humana, nombre_modelo, version_modelo,
      latencia_modelo_ms, clasificado_en, prioridad, puntaje_prioridad, canal,
      metodo_activacion, tipo_perfil, nivel_vulnerabilidad, ubicacion,
      precision_metros, origen_ubicacion, capturado_en, codigo_zona,
      nombre_zona, nombre_calle, primera_confirmacion_en,
      segundos_primera_respuesta, despachado_en, llegado_en, resuelto_en,
      segundos_clasificacion, segundos_despacho, segundos_llegada,
      segundos_resolucion, tipo_respondedor, escalada_centro_emergencia,
      comunidad_notificada, usuarios_notificados, notificaciones_entregadas,
      notificaciones_confirmadas, resultado, sintetico, detalle
    )
    SELECT
      doc #>> '{_id,$oid}',
      NULLIF(doc ->> 'version_esquema', '')::integer,
      doc #>> '{id_organizacion,$oid}',
      doc #>> '{id_municipalidad,$oid}',
      doc #>> '{id_comunidad,$oid}',
      doc #>> '{id_zona,$oid}',
      doc #>> '{persona_afectada,id_usuario,$oid}',
      doc #>> '{origen,id_dispositivo,$oid}',
      doc ->> 'codigo_alerta',
      (doc #>> '{creado_en,$date}')::timestamptz,
      NULLIF(doc #>> '{actualizado_en,$date}', '')::timestamptz,
      doc ->> 'estado',
      doc #>> '{clasificacion,categoria}',
      doc #>> '{clasificacion,tipo}',
      doc #>> '{clasificacion,severidad}',
      NULLIF(doc #>> '{clasificacion,confianza}', '')::double precision,
      COALESCE((doc #>> '{clasificacion,requiere_revision_humana}')::boolean, false),
      doc #>> '{clasificacion,nombre_modelo}',
      doc #>> '{clasificacion,version_modelo}',
      NULLIF(doc #>> '{clasificacion,latencia_ms}', '')::integer,
      NULLIF(doc #>> '{clasificacion,clasificado_en,$date}', '')::timestamptz,
      doc #>> '{prioridad,nivel}',
      NULLIF(doc #>> '{prioridad,puntaje}', '')::integer,
      doc #>> '{origen,canal}',
      doc #>> '{origen,metodo_activacion}',
      doc #>> '{persona_afectada,tipo_perfil}',
      doc #>> '{persona_afectada,nivel_vulnerabilidad}',
      ST_SetSRID(ST_GeomFromGeoJSON((doc -> 'ubicacion')::text), 4326),
      NULLIF(doc #>> '{ubicacion,precision_metros}', '')::numeric,
      doc #>> '{ubicacion,origen}',
      NULLIF(doc #>> '{ubicacion,capturado_en,$date}', '')::timestamptz,
      doc #>> '{ubicacion,referencia_ubicacion,codigo_zona}',
      doc #>> '{ubicacion,referencia_ubicacion,nombre_zona}',
      doc #>> '{ubicacion,referencia_ubicacion,nombre_calle}',
      NULLIF(doc #>> '{resumen_respuesta,primera_confirmacion_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{resumen_respuesta,segundos_primera_respuesta}', '')::integer,
      NULLIF(doc #>> '{resumen_respuesta,despachado_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{resumen_respuesta,llegado_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{resumen_respuesta,resuelto_en,$date}', '')::timestamptz,
      NULLIF(doc #>> '{resumen_respuesta,segundos_clasificacion}', '')::integer,
      NULLIF(doc #>> '{resumen_respuesta,segundos_despacho}', '')::integer,
      NULLIF(doc #>> '{resumen_respuesta,segundos_llegada}', '')::integer,
      NULLIF(doc #>> '{resumen_respuesta,segundos_resolucion}', '')::integer,
      doc #>> '{resumen_respuesta,tipo_respondedor}',
      COALESCE((doc #>> '{resumen_respuesta,escalada_centro_emergencia}')::boolean, false),
      NULLIF(doc #>> '{resumen_notificaciones,comunidad_notificada}', '')::boolean,
      NULLIF(doc #>> '{resumen_notificaciones,usuarios_notificados}', '')::integer,
      NULLIF(doc #>> '{resumen_notificaciones,entregadas}', '')::integer,
      NULLIF(doc #>> '{resumen_notificaciones,confirmadas}', '')::integer,
      doc #>> '{resolucion,resultado}',
      COALESCE((doc ->> 'sintetico')::boolean, true),
      doc
    FROM jsonb_array_elements($1::jsonb) AS source(doc)
  `,
};

async function tableCounts(client) {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM ${quotedSchema}.scenario_manifest) AS scenario_manifest,
      (SELECT count(*)::int FROM ${quotedSchema}.municipalidades) AS municipalidades,
      (SELECT count(*)::int FROM ${quotedSchema}.zonas) AS zonas,
      (SELECT count(*)::int FROM ${quotedSchema}.usuarios) AS usuarios,
      (SELECT count(*)::int FROM ${quotedSchema}.dispositivos) AS dispositivos,
      (SELECT count(*)::int FROM ${quotedSchema}.perfiles_cuidado) AS perfiles_cuidado,
      (SELECT count(*)::int FROM ${quotedSchema}.alertas) AS alertas
  `);
  return result.rows[0];
}

async function importCollection(client, name) {
  let batch = [];
  let imported = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await client.query(inserts[name], [JSON.stringify(batch)]);
    imported += result.rowCount ?? 0;
    batch = [];
  };

  await forEachJsonLine(name, async (document) => {
    batch.push(document);
    if (batch.length >= batchSize) await flush();
  });
  await flush();
  return imported;
}

const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
  const existing = await tableCounts(client);
  const occupied = Object.entries(existing).filter(([, count]) => count > 0);
  if (occupied.length) {
    throw new Error(
      `El esquema ${postgresSchema} ya contiene datos: ${occupied
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}`,
    );
  }

  const firstZone = await readFirstJsonLine('zonas');
  const importId = `escenario-${scenarioManifest.escenario}`;
  const importedCounts = {};

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query(
      `INSERT INTO ${quotedSchema}.scenario_manifest (
        id, escenario, semilla, municipalidad_id, estado, conteos_esperados,
        iniciado_en, metadata
      ) VALUES ($1, $2, $3, $4, 'importando', $5::jsonb, now(), $6::jsonb)`,
      [
        importId,
        scenarioManifest.escenario,
        scenarioManifest.semilla,
        scenarioManifest.id_municipalidad,
        JSON.stringify(scenarioManifest.colecciones),
        JSON.stringify(scenarioManifest),
      ],
    );
    await client.query(
      `INSERT INTO ${quotedSchema}.municipalidades (
        id, organizacion_id, codigo, nombre, activa, sintetico, metadata
      ) VALUES ($1, $2, '13132', 'Vitacura', true, true, $3::jsonb)`,
      [
        scenarioManifest.id_municipalidad,
        firstZone.id_organizacion?.$oid ?? null,
        JSON.stringify({ escenario: scenarioManifest.escenario }),
      ],
    );

    for (const name of Object.keys(scenarioManifest.colecciones)) {
      const imported = await importCollection(client, name);
      importedCounts[name] = imported;
      console.log(`${name}: ${imported} filas importadas`);
    }

    const failures = Object.entries(scenarioManifest.colecciones).filter(
      ([name, expected]) => importedCounts[name] !== expected,
    );
    if (failures.length) {
      throw new Error(
        `Conteos inesperados: ${failures
          .map(
            ([name, expected]) =>
              `${name}=${importedCounts[name]} (esperadas ${expected})`,
          )
          .join(', ')}`,
      );
    }

    await client.query(
      `UPDATE ${quotedSchema}.scenario_manifest
       SET estado = 'completo', conteos_importados = $2::jsonb,
           completado_en = now()
       WHERE id = $1`,
      [importId, JSON.stringify(importedCounts)],
    );
    await client.query(`ANALYZE ${quotedSchema}.municipalidades`);
    await client.query(`ANALYZE ${quotedSchema}.zonas`);
    await client.query(`ANALYZE ${quotedSchema}.usuarios`);
    await client.query(`ANALYZE ${quotedSchema}.dispositivos`);
    await client.query(`ANALYZE ${quotedSchema}.perfiles_cuidado`);
    await client.query(`ANALYZE ${quotedSchema}.alertas`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  console.log(
    JSON.stringify(
      {
        esquema: postgresSchema,
        directorio: scenarioDirectory,
        escenario: scenarioManifest.escenario,
        estado: 'completo',
        filas: { municipalidades: 1, ...importedCounts },
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
  } finally {
    client.release();
    await pool.end();
  }
}
