import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  PostgresService,
  isTransientPostgresError,
} from '../dist/postgres/postgres.service.js';
import { DashboardResponseCacheService } from '../dist/dashboard/dashboard-response-cache.service.js';
import { createPostgresPoolConfig } from '../dist/postgres/postgres.config.js';

class FakeConfig {
  constructor(values = {}) {
    this.values = values;
  }

  get(key, fallback) {
    return this.values[key] ?? fallback;
  }
}

class FakePool extends EventEmitter {
  constructor(query) {
    super();
    this.runQuery = query;
    this.ended = false;
  }

  query(text, values) {
    return this.runQuery(text, values);
  }

  async end() {
    this.ended = true;
  }
}

class TestPostgresService extends PostgresService {
  constructor(config, pools) {
    super(config);
    this.pools = [...pools];
  }

  createPool() {
    const pool = this.pools.shift();
    assert.ok(pool, 'La prueba solicitó más pools de los preparados');
    return pool;
  }
}

const transientError = (code = 'ECONNRESET') =>
  Object.assign(new Error('Connection terminated unexpectedly'), { code });

assert.equal(isTransientPostgresError(transientError()), true);
assert.equal(
  isTransientPostgresError(
    Object.assign(new Error('the database system is starting up'), {
      code: '57P03',
    }),
  ),
  true,
);
assert.equal(
  isTransientPostgresError(Object.assign(new Error('syntax error'), { code: '42601' })),
  false,
);

const poolConfig = createPostgresPoolConfig(
  new FakeConfig({ POSTGRES_PASSWORD: 'test' }),
);
assert.equal(poolConfig.connectionTimeoutMillis, 2_000);
assert.equal(poolConfig.max, 6);

const failedPool = new FakePool(async () => {
  throw transientError();
});
const recoveredPool = new FakePool(async (text) => ({
  rows: text === 'SELECT 1' ? [{ '?column?': 1 }] : [{ estado: 'ok' }],
  rowCount: 1,
}));
const recoveredService = new TestPostgresService(
  new FakeConfig({
    POSTGRES_RECOVERY_ATTEMPTS: '1',
    POSTGRES_RECOVERY_BASE_DELAY_MS: '50',
    POSTGRES_CIRCUIT_OPEN_MS: '1000',
  }),
  [failedPool, recoveredPool],
);
const recoveredResult = await recoveredService.query('SELECT estado');
assert.deepEqual(recoveredResult.rows, [{ estado: 'ok' }]);
assert.equal(failedPool.ended, true);
assert.equal(recoveredService.getStatus().estado, 'disponible');
await recoveredService.onModuleDestroy();

const unavailablePool = new FakePool(async () => {
  throw transientError('ECONNREFUSED');
});
const failedProbePool = new FakePool(async () => {
  throw transientError('ECONNREFUSED');
});
const unavailableService = new TestPostgresService(
  new FakeConfig({
    POSTGRES_RECOVERY_ATTEMPTS: '1',
    POSTGRES_RECOVERY_BASE_DELAY_MS: '50',
    POSTGRES_CIRCUIT_OPEN_MS: '1000',
  }),
  [unavailablePool, failedProbePool],
);
await assert.rejects(
  unavailableService.query('SELECT estado'),
  (error) => error instanceof ServiceUnavailableException && error.getStatus() === 503,
);
assert.equal(unavailableService.getStatus().estado, 'circuito_abierto');
await assert.rejects(
  unavailableService.query('SELECT estado'),
  (error) => error instanceof ServiceUnavailableException && error.getStatus() === 503,
);

const responseCache = new DashboardResponseCacheService(
  new FakeConfig({
    DASHBOARD_RESPONSE_CACHE_TTL_MS: '1000',
    DASHBOARD_STALE_CACHE_MS: '60000',
  }),
);
await responseCache.getOrLoad('resumen:test', async () => ({
  metadata: { periodo: 'prueba' },
  total: 10,
}));
responseCache.entries.get('resumen:test').storedAt -= 2_000;
const cachedResponse = await responseCache.getOrLoad('resumen:test', async () => {
  throw new ServiceUnavailableException('PostgreSQL no disponible');
});
assert.equal(cachedResponse.total, 10);
assert.equal(cachedResponse.metadata.contingencia.activa, true);
assert.equal(responseCache.getStatus().respuestas_de_contingencia, 1);

console.log('Resiliencia PostgreSQL: reintento, circuito y caché verificados.');
