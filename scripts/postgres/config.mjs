import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const schema = process.env.POSTGRES_SCHEMA || 'vita';

if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error('POSTGRES_SCHEMA contiene un identificador inválido');
}
if (!process.env.POSTGRES_PASSWORD) {
  throw new Error('Falta POSTGRES_PASSWORD en el archivo .env');
}

const port = Number(process.env.POSTGRES_PORT || 5432);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error('POSTGRES_PORT debe ser un puerto válido');
}

export const postgresSchema = schema;
export const quotedSchema = `"${schema}"`;

export function createPostgresPool(applicationName) {
  return new Pool({
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port,
    database: process.env.POSTGRES_DATABASE || 'geodb',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD,
    ssl:
      process.env.POSTGRES_SSL?.toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : false,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    max: 4,
  });
}
