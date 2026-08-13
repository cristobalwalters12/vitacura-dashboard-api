import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || 'community_sos_demo';
const municipalityId =
  process.env.MUNICIPALIDAD_ID || '64f000000000000000000132';

if (!uri) throw new Error('Falta MONGODB_URI en .env');
if (!mongoose.Types.ObjectId.isValid(municipalityId)) {
  throw new Error('MUNICIPALIDAD_ID no es un ObjectId válido');
}

await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });

try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB no entregó una conexión activa');
  const hasta = process.env.ANALYTICS_CUTOFF_DATE
    ? new Date(process.env.ANALYTICS_CUTOFF_DATE)
    : new Date();
  const desde = new Date(hasta.getTime() - 90 * 86_400_000);
  const baseFilter = {
    id_municipalidad: new mongoose.Types.ObjectId(municipalityId),
    creado_en: { $gte: desde, $lte: hasta },
  };
  const scenarios = [
    { nombre: 'periodo', filtro: baseFilter },
    {
      nombre: 'categoria',
      filtro: { ...baseFilter, 'clasificacion.categoria': 'medica' },
    },
    {
      nombre: 'prioridad',
      filtro: { ...baseFilter, 'prioridad.nivel': 'P1' },
    },
    {
      nombre: 'canal',
      filtro: { ...baseFilter, 'origen.canal': 'reloj_inteligente' },
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    const result = await database
      .collection('alertas')
      .find(scenario.filtro)
      .sort({ creado_en: -1 })
      .limit(100)
      .explain('executionStats');
    const stats = result.executionStats;
    results.push({
      escenario: scenario.nombre,
      documentos_entregados: stats.nReturned,
      documentos_examinados: stats.totalDocsExamined,
      claves_examinadas: stats.totalKeysExamined,
      tiempo_milisegundos: stats.executionTimeMillis,
      plan: result.queryPlanner.winningPlan,
    });
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  await mongoose.disconnect();
}
