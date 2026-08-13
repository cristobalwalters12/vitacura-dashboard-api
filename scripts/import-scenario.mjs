import 'dotenv/config';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

const uri = process.env.MONGODB_URI;
const inputArgument = process.argv.find((argument) =>
  argument.startsWith('--input='),
);
const databaseArgument = process.argv.find((argument) =>
  argument.startsWith('--database='),
);
const inputDirectory = resolve(
  inputArgument?.slice('--input='.length) || 'generated-mongo',
);
const manifest = JSON.parse(
  readFileSync(resolve(inputDirectory, 'manifest.json'), 'utf8'),
);
const databaseName =
  databaseArgument?.slice('--database='.length) || manifest.base_sugerida;
const collectionNames = Object.keys(manifest.colecciones);
const batchSize = 500;

if (!uri) throw new Error('Falta MONGODB_URI en .env');
if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) {
  throw new Error('El nombre de la base de destino no es válido');
}
async function insertJsonLines(collection, filePath) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let batch = [];
  let imported = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    batch.push(EJSON.parse(line, { relaxed: false }));
    if (batch.length < batchSize) continue;
    const result = await collection.insertMany(batch, { ordered: true });
    imported += result.insertedCount;
    batch = [];
  }

  if (batch.length) {
    const result = await collection.insertMany(batch, { ordered: true });
    imported += result.insertedCount;
  }
  return imported;
}

await mongoose.connect(uri, {
  dbName: databaseName,
  serverSelectionTimeoutMS: 10_000,
});

try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB no entregó una conexión activa');

  const existingCounts = {};
  for (const name of [...collectionNames, '_scenario_manifest']) {
    existingCounts[name] = await database.collection(name).estimatedDocumentCount();
  }
  const occupied = Object.entries(existingCounts).filter(([, count]) => count > 0);
  if (occupied.length) {
    throw new Error(
      `La base ${databaseName} no está vacía: ${occupied
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}`,
    );
  }

  const importId = `escenario-${manifest.escenario}`;
  await database.collection('_scenario_manifest').insertOne({
    _id: importId,
    estado: 'importando',
    escenario: manifest.escenario,
    semilla: manifest.semilla,
    id_municipalidad: new mongoose.Types.ObjectId(manifest.id_municipalidad),
    iniciado_en: new Date(),
    colecciones_esperadas: manifest.colecciones,
  });

  const importedCounts = {};
  for (const name of collectionNames) {
    const imported = await insertJsonLines(
      database.collection(name),
      resolve(inputDirectory, `${name}.jsonl`),
    );
    importedCounts[name] = imported;
    console.log(`${name}: ${imported} documentos importados`);
  }

  const failures = Object.entries(manifest.colecciones).filter(
    ([name, expected]) => importedCounts[name] !== expected,
  );
  if (failures.length) {
    throw new Error(
      `Conteos inesperados: ${failures
        .map(
          ([name, expected]) =>
            `${name}=${importedCounts[name]} (esperados ${expected})`,
        )
        .join(', ')}`,
    );
  }

  await database.collection('_scenario_manifest').updateOne(
    { _id: importId },
    {
      $set: {
        estado: 'completo',
        completado_en: new Date(),
        colecciones_importadas: importedCounts,
      },
    },
  );

  console.log(
    JSON.stringify(
      {
        base: databaseName,
        escenario: manifest.escenario,
        estado: 'completo',
        documentos: importedCounts,
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
