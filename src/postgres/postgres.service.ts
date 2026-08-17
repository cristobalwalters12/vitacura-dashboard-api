import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { createPostgresPoolConfig } from './postgres.config';

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);
const TRANSIENT_POSTGRES_CODES = new Set([
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);
const TRANSIENT_MESSAGES = [
  'connection terminated unexpectedly',
  'connection terminated',
  'cannot use a pool after calling end',
  'pool is draining',
  'postmaster exit',
  'server closed the connection unexpectedly',
  'the database system is starting up',
  'terminating connection due to administrator command',
];

type ErrorLike = {
  code?: string;
  message?: string;
};

export function isTransientPostgresError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as ErrorLike;
  const code = candidate.code?.toUpperCase();
  if (
    code &&
    (TRANSIENT_NETWORK_CODES.has(code) ||
      TRANSIENT_POSTGRES_CODES.has(code) ||
      code.startsWith('08'))
  ) {
    return true;
  }
  const message = candidate.message?.toLowerCase() ?? '';
  return TRANSIENT_MESSAGES.some((pattern) => message.includes(pattern));
}

function integerSetting(
  config: ConfigService,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(config.get<string>(key, String(fallback)));
  return Number.isInteger(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isReadOnlyQuery(text: string) {
  return /^\s*(select|show|with)\b/i.test(text);
}

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresService.name);
  private readonly recoveryAttempts: number;
  private readonly recoveryBaseDelayMs: number;
  private readonly circuitOpenMs: number;
  private pool?: Pool;
  private recoveryPromise?: Promise<boolean>;
  private circuitOpenUntil = 0;
  private consecutiveFailures = 0;
  private lastSuccessAt?: Date;
  private lastFailureAt?: Date;
  private lastFailureMessage?: string;

  constructor(private readonly config: ConfigService) {
    this.recoveryAttempts = integerSetting(
      config,
      'POSTGRES_RECOVERY_ATTEMPTS',
      2,
      1,
      5,
    );
    this.recoveryBaseDelayMs = integerSetting(
      config,
      'POSTGRES_RECOVERY_BASE_DELAY_MS',
      350,
      50,
      5_000,
    );
    this.circuitOpenMs = integerSetting(
      config,
      'POSTGRES_CIRCUIT_OPEN_MS',
      5_000,
      1_000,
      60_000,
    );
  }

  isConfigured() {
    return Boolean(
      this.config.get<string>('POSTGRES_HOST') &&
        this.config.get<string>('POSTGRES_PASSWORD'),
    );
  }

  getStatus() {
    const retryInMs = Math.max(0, this.circuitOpenUntil - Date.now());
    return {
      estado: retryInMs
        ? 'circuito_abierto'
        : this.recoveryPromise
          ? 'reconectando'
          : this.consecutiveFailures > 0
            ? 'degradado'
          : this.lastSuccessAt
            ? 'disponible'
            : 'sin_verificar',
      fallas_consecutivas: this.consecutiveFailures,
      ultimo_exito: this.lastSuccessAt?.toISOString() ?? null,
      ultima_falla: this.lastFailureAt?.toISOString() ?? null,
      ultimo_error: this.lastFailureMessage ?? null,
      reintento_en_ms: retryInMs,
    };
  }

  protected createPool() {
    return new Pool(createPostgresPoolConfig(this.config));
  }

  private getPool() {
    if (!this.pool) {
      const pool = this.createPool();
      this.pool = pool;
      pool.on('error', (error) => {
        this.recordFailure(error);
        this.logger.error(
          `Conexión PostgreSQL inactiva terminada: ${error.message}`,
        );
        if (isTransientPostgresError(error)) this.invalidatePool(pool);
      });
    }
    return this.pool;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (Date.now() < this.circuitOpenUntil) {
      throw this.unavailableException();
    }

    const pool = this.getPool();
    try {
      const result = await pool.query<Row>(text, values);
      this.recordSuccess();
      return result;
    } catch (error) {
      if (!isTransientPostgresError(error)) throw error;
      this.recordFailure(error);
      const recovered = await this.recover(pool);
      if (!recovered || !isReadOnlyQuery(text)) {
        throw this.unavailableException();
      }

      try {
        const result = await this.getPool().query<Row>(text, values);
        this.recordSuccess();
        return result;
      } catch (retryError) {
        if (!isTransientPostgresError(retryError)) throw retryError;
        this.recordFailure(retryError);
        this.invalidatePool(this.pool);
        this.openCircuit();
        throw this.unavailableException();
      }
    }
  }

  private recover(failedPool: Pool) {
    this.invalidatePool(failedPool);
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.probeRecovery().finally(() => {
        this.recoveryPromise = undefined;
      });
    }
    return this.recoveryPromise;
  }

  private async probeRecovery() {
    for (let attempt = 0; attempt < this.recoveryAttempts; attempt += 1) {
      const waitMs = this.recoveryBaseDelayMs * 3 ** attempt;
      await delay(waitMs);
      const pool = this.getPool();
      try {
        await pool.query('SELECT 1');
        this.recordSuccess();
        this.logger.log(
          `Conexión PostgreSQL recuperada en el intento ${attempt + 1}`,
        );
        return true;
      } catch (error) {
        if (!isTransientPostgresError(error)) throw error;
        this.recordFailure(error);
        this.invalidatePool(pool);
      }
    }
    this.openCircuit();
    return false;
  }

  private invalidatePool(pool?: Pool) {
    if (!pool || this.pool !== pool) return;
    this.pool = undefined;
    void pool.end().catch(() => undefined);
  }

  private recordSuccess() {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.lastSuccessAt = new Date();
    this.lastFailureMessage = undefined;
  }

  private recordFailure(error: unknown) {
    this.consecutiveFailures += 1;
    this.lastFailureAt = new Date();
    this.lastFailureMessage =
      error instanceof Error ? error.message : 'Error PostgreSQL desconocido';
  }

  private openCircuit() {
    this.circuitOpenUntil = Date.now() + this.circuitOpenMs;
    this.logger.warn(
      `Circuito PostgreSQL abierto por ${this.circuitOpenMs} ms para evitar saturación`,
    );
  }

  private unavailableException() {
    const retryInMs = Math.max(0, this.circuitOpenUntil - Date.now());
    return new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      codigo: 'POSTGRES_TEMPORALMENTE_NO_DISPONIBLE',
      message:
        'PostgreSQL está reiniciándose o no responde; vuelve a intentarlo en unos segundos',
      reintento_en_ms: retryInMs || this.circuitOpenMs,
    });
  }

  async onModuleDestroy() {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }
}
