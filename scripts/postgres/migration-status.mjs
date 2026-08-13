import { createPostgresPool, postgresSchema } from './config.mjs';

const pool = createPostgresPool('vita-postgres-status');
try {
  const [database, extensions, migrations, tables, indexes] = await Promise.all([
    pool.query(`
      SELECT current_database() AS database,
             current_user AS username,
             current_setting('server_version') AS postgres_version,
             current_setting('TimeZone') AS timezone
    `),
    pool.query(`
      SELECT extname, extversion
      FROM pg_extension
      WHERE extname IN ('postgis', 'postgis_topology')
      ORDER BY extname
    `),
    pool.query(`
      SELECT version, name, applied_at
      FROM ${postgresSchema}.schema_migrations
      ORDER BY version
    `),
    pool.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = $1
       ORDER BY tablename`,
      [postgresSchema],
    ),
    pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1
       ORDER BY indexname`,
      [postgresSchema],
    ),
  ]);

  console.log(
    JSON.stringify(
      {
        conexion: database.rows[0],
        extensiones: extensions.rows,
        migraciones: migrations.rows,
        tablas: tables.rows.map((row) => row.tablename),
        indices: indexes.rows.map((row) => row.indexname),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
