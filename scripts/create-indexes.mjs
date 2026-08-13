import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || 'community_sos_demo';

if (!uri) {
  throw new Error('Falta MONGODB_URI en .env');
}

const indexes = {
  alertas: [
    {
      keys: { id_municipalidad: 1, creado_en: -1 },
      options: { name: 'dashboard_municipalidad_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'clasificacion.categoria': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_categoria_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'ubicacion.referencia_ubicacion.codigo_zona': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_zona_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'prioridad.nivel': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_prioridad_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'clasificacion.severidad': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_severidad_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'origen.canal': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_canal_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'clasificacion.requiere_revision_humana': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_revision_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'resumen_respuesta.escalada_centro_emergencia': 1,
        creado_en: -1,
      },
      options: { name: 'dashboard_escalada_fecha' },
    },
    {
      keys: {
        id_municipalidad: 1,
        ubicacion: '2dsphere',
        creado_en: -1,
      },
      options: { name: 'mapa_ubicacion_fecha' },
    },
  ],
  usuarios: [
    {
      keys: { id_municipalidad: 1, activo: 1, id_zona_hogar: 1 },
      options: { name: 'dashboard_usuarios_activos_zona' },
    },
  ],
  dispositivos: [
    {
      keys: { id_municipalidad: 1, estado: 1 },
      options: { name: 'dashboard_dispositivos_estado' },
    },
    {
      keys: {
        id_municipalidad: 1,
        'ultimo_estado_conocido.porcentaje_bateria': 1,
      },
      options: { name: 'dashboard_dispositivos_bateria' },
    },
  ],
  perfiles_cuidado: [
    {
      keys: {
        id_municipalidad: 1,
        activo: 1,
        'perfil_cuidado.nivel_dependencia': 1,
      },
      options: { name: 'dashboard_perfiles_dependencia' },
    },
    {
      keys: { id_municipalidad: 1, id_usuario: 1, activo: 1 },
      options: { name: 'detalle_perfil_usuario' },
    },
  ],
  zonas: [
    {
      keys: { id_municipalidad: 1, codigo: 1 },
      options: { name: 'municipalidad_codigo_zona', unique: true },
    },
  ],
};

await mongoose.connect(uri, {
  dbName,
  serverSelectionTimeoutMS: 10_000,
});

try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB no entregó una conexión activa');

  for (const [collectionName, definitions] of Object.entries(indexes)) {
    const collection = database.collection(collectionName);
    for (const definition of definitions) {
      const name = await collection.createIndex(
        definition.keys,
        definition.options,
      );
      console.log(`${collectionName}: ${name}`);
    }
  }
  console.log('Índices creados o confirmados correctamente.');
} finally {
  await mongoose.disconnect();
}
