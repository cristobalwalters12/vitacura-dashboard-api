import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  createPostgresPool,
  postgresSchema,
  quotedSchema,
} from './config.mjs';

const migrationsDirectory = resolve('scripts/postgres/migrations');
const pool = createPostgresPool('vita-postgres-migrate');
const lockName = `${postgresSchema}:schema-migrations`;

function migrationMetadata(fileName, source) {
  const match = fileName.match(/^(\d+)_([a-z0-9_]+)\.sql$/);
  if (!match) throw new Error(`Nombre de migración inválido: ${fileName}`);
  return {
    version: match[1],
    name: match[2],
    checksum: createHash('sha256').update(source).digest('hex'),
  };
}

const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${quotedSchema}.schema_migrations (
      version varchar(32) PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedResult = await client.query(
    `SELECT version, checksum FROM ${quotedSchema}.schema_migrations`,
  );
  const applied = new Map(
    appliedResult.rows.map((row) => [row.version, row.checksum]),
  );
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const source = await readFile(resolve(migrationsDirectory, file), 'utf8');
    const migration = migrationMetadata(basename(file), source);
    const previousChecksum = applied.get(migration.version);
    if (previousChecksum) {
      if (previousChecksum !== migration.checksum) {
        throw new Error(
          `La migración aplicada ${migration.version} fue modificada`,
        );
      }
      console.log(`${migration.version}_${migration.name}: ya aplicada`);
      continue;
    }

    const sql = source.replaceAll('{{schema}}', quotedSchema);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO ${quotedSchema}.schema_migrations
          (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      await client.query('COMMIT');
      console.log(`${migration.version}_${migration.name}: aplicada`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
  } finally {
    client.release();
    await pool.end();
  }
}
