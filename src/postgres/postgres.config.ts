import { ConfigService } from '@nestjs/config';
import type { PoolConfig } from 'pg';

function booleanSetting(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function createPostgresPoolConfig(config: ConfigService): PoolConfig {
  const port = Number(config.get<string>('POSTGRES_PORT', '5432'));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('POSTGRES_PORT debe ser un puerto válido');
  }

  const password = config.get<string>('POSTGRES_PASSWORD');
  if (!password) throw new Error('Falta POSTGRES_PASSWORD en el archivo .env');

  return {
    host: config.get<string>('POSTGRES_HOST', '127.0.0.1'),
    port,
    database: config.get<string>('POSTGRES_DATABASE', 'geodb'),
    user: config.get<string>('POSTGRES_USER', 'postgres'),
    password,
    ssl: booleanSetting(config.get<string>('POSTGRES_SSL'))
      ? { rejectUnauthorized: false }
      : false,
    application_name: 'vitacura-dashboard-api',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 60_000,
    max: 10,
  };
}
