import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE;
const collectionName = 'alertas_entrantes';

if (!uri) throw new Error('Falta MONGODB_URI en .env');
if (!dbName) throw new Error('Falta MONGODB_DATABASE en .env');

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    title: 'Alerta entrante de Lyngus Halo',
    required: [
      'version',
      'codigo',
      'estado',
      'categoria',
      'criticidad',
      'persona',
      'ubicacion',
      'direccion_referencia',
      'transcripcion',
      'origen',
      'camara',
      'generada_en',
      'recibida_en',
      'sintetica',
    ],
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'objectId' },
      version: { bsonType: 'int', minimum: 1 },
      codigo: {
        bsonType: 'string',
        pattern: '^HALO-[0-9]{8}-[0-9]{6}$',
      },
      estado: { enum: ['nueva', 'revisando', 'atendida', 'cerrada'] },
      categoria: {
        enum: [
          'medica',
          'seguridad',
          'incendio',
          'accidente',
          'asistencia_cuidador',
          'asistencia_comunitaria',
        ],
      },
      criticidad: { enum: ['critica', 'alta', 'media', 'baja'] },
      persona: {
        bsonType: 'object',
        required: ['id', 'nombre'],
        additionalProperties: false,
        properties: {
          id: { bsonType: 'string', minLength: 1 },
          nombre: { bsonType: 'string', minLength: 1, maxLength: 120 },
        },
      },
      ubicacion: {
        bsonType: 'object',
        required: ['type', 'coordinates'],
        additionalProperties: false,
        properties: {
          type: { enum: ['Point'] },
          coordinates: {
            bsonType: 'array',
            minItems: 2,
            maxItems: 2,
            items: {
              bsonType: ['double', 'int', 'long', 'decimal'],
            },
          },
        },
      },
      direccion_referencia: {
        bsonType: 'string',
        minLength: 1,
        maxLength: 300,
      },
      transcripcion: {
        bsonType: 'object',
        required: ['texto', 'idioma'],
        additionalProperties: false,
        properties: {
          texto: { bsonType: 'string', minLength: 1, maxLength: 5000 },
          idioma: { enum: ['es-CL'] },
        },
      },
      origen: {
        bsonType: 'object',
        required: ['canal'],
        additionalProperties: false,
        properties: {
          canal: { enum: ['smartwatch', 'movil', 'manual'] },
          dispositivo_id: { bsonType: ['string', 'null'] },
        },
      },
      camara: { bsonType: 'bool' },
      generada_en: { bsonType: 'date' },
      recibida_en: { bsonType: 'date' },
      sintetica: { bsonType: 'bool' },
    },
  },
};

const sampleAlert = {
  version: 1,
  codigo: 'HALO-20260815-000001',
  estado: 'nueva',
  categoria: 'medica',
  criticidad: 'critica',
  persona: {
    id: 'USR-001',
    nombre: 'María González',
  },
  ubicacion: {
    type: 'Point',
    coordinates: [-70.575123, -33.391234],
  },
  direccion_referencia: 'Av. Vitacura 3400, Vitacura',
  transcripcion: {
    texto: 'Necesito ayuda, me caí y no puedo levantarme.',
    idioma: 'es-CL',
  },
  origen: {
    canal: 'smartwatch',
    dispositivo_id: 'WATCH-001',
  },
  camara: true,
  generada_en: new Date('2026-08-15T14:20:10.000Z'),
  recibida_en: new Date('2026-08-15T14:20:12.000Z'),
  sintetica: false,
};

await mongoose.connect(uri, {
  dbName,
  serverSelectionTimeoutMS: 15_000,
});

try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB no entregó una conexión activa');

  const exists = await database
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();

  if (exists) {
    await database.command({
      collMod: collectionName,
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    console.log(`Validador actualizado: ${dbName}.${collectionName}`);
  } else {
    await database.createCollection(collectionName, {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    console.log(`Colección creada: ${dbName}.${collectionName}`);
  }

  const collection = database.collection(collectionName);

  const indexNames = await Promise.all([
    collection.createIndex(
      { codigo: 1 },
      { unique: true, name: 'codigo_unico' },
    ),
    collection.createIndex(
      { estado: 1, recibida_en: -1 },
      { name: 'cola_alertas_por_estado' },
    ),
    collection.createIndex(
      { ubicacion: '2dsphere' },
      { name: 'ubicacion_geoespacial' },
    ),
  ]);

  console.log(`Índices confirmados: ${indexNames.join(', ')}`);

  const existingAlert = await collection.findOne({ codigo: sampleAlert.codigo });
  if (existingAlert) {
    await collection.updateOne(
      { codigo: sampleAlert.codigo },
      { $set: { camara: sampleAlert.camara } },
    );
    console.log(`Alerta de prueba actualizada: ${sampleAlert.codigo}`);
  } else {
    const result = await collection.insertOne(sampleAlert);
    console.log(`Alerta insertada: ${sampleAlert.codigo} (${result.insertedId})`);
  }

  const storedAlert = await collection.findOne(
    { codigo: sampleAlert.codigo },
    {
      projection: {
        codigo: 1,
        estado: 1,
        categoria: 1,
        criticidad: 1,
        'persona.nombre': 1,
        ubicacion: 1,
        camara: 1,
        recibida_en: 1,
      },
    },
  );
  const indexes = await collection.indexes();
  const nearby = await collection
    .find({
      ubicacion: {
        $near: {
          $geometry: sampleAlert.ubicacion,
          $maxDistance: 10,
        },
      },
    })
    .limit(1)
    .toArray();

  if (!storedAlert) throw new Error('No se encontró la alerta de verificación');
  if (nearby.length !== 1) {
    throw new Error('El índice geoespacial no devolvió la alerta esperada');
  }

  console.log('Documento verificado:', JSON.stringify(storedAlert, null, 2));
  console.log(
    'Índices verificados:',
    indexes.map(({ name, key, unique }) => ({ name, key, unique })),
  );
  console.log('Validación final correcta.');
} finally {
  await mongoose.disconnect();
}
