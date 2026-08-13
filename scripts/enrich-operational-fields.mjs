import 'dotenv/config';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;
const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE;
const inputArgument = process.argv.find((argument) =>
  argument.startsWith('--input='),
);
const inputDirectory = resolve(
  inputArgument?.slice('--input='.length) || 'generated-mongo',
);
const manifest = JSON.parse(
  readFileSync(resolve(inputDirectory, 'manifest.json'), 'utf8'),
);
const batchSize = 500;

if (!uri) throw new Error('Falta MONGODB_URI en .env');
if (!databaseName) throw new Error('Falta MONGODB_DATABASE en .env');

await mongoose.connect(uri, {
  dbName: databaseName,
  serverSelectionTimeoutMS: 10_000,
});

try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB no entregó una conexión activa');
  const collection = database.collection('alertas');
  const total = await collection.countDocuments({ sintetico: true });
  if (total !== manifest.colecciones.alertas) {
    throw new Error(
      `La base ${databaseName} contiene ${total} alertas sintéticas; se esperaban ${manifest.colecciones.alertas}`,
    );
  }

  const lines = createInterface({
    input: createReadStream(resolve(inputDirectory, 'alertas.jsonl'), {
      encoding: 'utf8',
    }),
    crlfDelay: Infinity,
  });
  let operations = [];
  let matched = 0;
  let modified = 0;

  const flush = async () => {
    if (!operations.length) return;
    const result = await collection.bulkWrite(operations, { ordered: true });
    matched += result.matchedCount;
    modified += result.modifiedCount;
    operations = [];
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    const alert = EJSON.parse(line, { relaxed: false });
    operations.push({
      updateOne: {
        filter: { _id: alert._id, sintetico: true },
        update: {
          $set: {
            'clasificacion.latencia_ms': alert.clasificacion.latencia_ms,
            persona_afectada: alert.persona_afectada,
            'reportante.id_usuario': alert.reportante.id_usuario,
            'origen.id_dispositivo': alert.origen.id_dispositivo,
            'resumen_respuesta.despachado_en':
              alert.resumen_respuesta.despachado_en,
            'resumen_respuesta.llegado_en': alert.resumen_respuesta.llegado_en,
            'resumen_respuesta.resuelto_en': alert.resumen_respuesta.resuelto_en,
            'resumen_respuesta.segundos_clasificacion':
              alert.resumen_respuesta.segundos_clasificacion,
            'resumen_respuesta.segundos_despacho':
              alert.resumen_respuesta.segundos_despacho,
            'resumen_respuesta.segundos_llegada':
              alert.resumen_respuesta.segundos_llegada,
            'resumen_respuesta.segundos_resolucion':
              alert.resumen_respuesta.segundos_resolucion,
            'resumen_respuesta.segundos_confirmacion_a_despacho':
              alert.resumen_respuesta.segundos_confirmacion_a_despacho,
            'resumen_respuesta.segundos_despacho_a_llegada':
              alert.resumen_respuesta.segundos_despacho_a_llegada,
            'resumen_respuesta.segundos_llegada_a_resolucion':
              alert.resumen_respuesta.segundos_llegada_a_resolucion,
            'resumen_respuesta.tipo_respondedor':
              alert.resumen_respuesta.tipo_respondedor,
          },
        },
      },
    });
    if (operations.length >= batchSize) await flush();
  }
  await flush();

  const completos = await collection.countDocuments({
    sintetico: true,
    'clasificacion.latencia_ms': { $type: 'number' },
    'resumen_respuesta.despachado_en': { $type: 'date' },
    'resumen_respuesta.llegado_en': { $type: 'date' },
    'resumen_respuesta.segundos_resolucion': { $type: 'number' },
  });
  const alertasCuidado = await collection.countDocuments({
    sintetico: true,
    'clasificacion.categoria': 'asistencia_cuidador',
  });
  const cuidadoContextualizado = await collection.countDocuments({
    sintetico: true,
    'clasificacion.categoria': 'asistencia_cuidador',
    'persona_afectada.tipo_perfil': {
      $in: ['persona_dependiente', 'adulto_mayor'],
    },
    'persona_afectada.nivel_vulnerabilidad': { $ne: 'ninguna' },
  });
  if (
    matched !== manifest.colecciones.alertas ||
    completos !== total ||
    cuidadoContextualizado !== alertasCuidado
  ) {
    throw new Error(
      `Enriquecimiento incompleto: matched=${matched}, completos=${completos}, cuidado=${cuidadoContextualizado}/${alertasCuidado}, esperados=${total}`,
    );
  }

  await database.collection('_scenario_manifest').updateOne(
    { escenario: manifest.escenario },
    {
      $set: {
        enriquecido_en: new Date(),
        capacidades_analiticas: [
          'clasificacion_ia',
          'flujo_respuesta',
          'red_cuidado',
          'detalle_caso',
        ],
      },
    },
  );

  console.log(
    JSON.stringify(
      {
        base: databaseName,
        escenario: manifest.escenario,
        alertas_coincidentes: matched,
        alertas_modificadas: modified,
        alertas_completas: completos,
        alertas_cuidado_contextualizadas: cuidadoContextualizado,
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
