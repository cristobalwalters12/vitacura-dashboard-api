import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type CacheEntry = {
  value: unknown;
  storedAt: number;
};

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

function isUnavailable(error: unknown) {
  return error instanceof HttpException && error.getStatus() === 503;
}

@Injectable()
export class DashboardResponseCacheService {
  private readonly freshTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private staleResponses = 0;

  constructor(config: ConfigService) {
    this.freshTtlMs = integerSetting(
      config,
      'DASHBOARD_RESPONSE_CACHE_TTL_MS',
      30_000,
      1_000,
      300_000,
    );
    this.staleTtlMs = integerSetting(
      config,
      'DASHBOARD_STALE_CACHE_MS',
      3_600_000,
      60_000,
      86_400_000,
    );
    this.maxEntries = integerSetting(
      config,
      'DASHBOARD_RESPONSE_CACHE_MAX_ENTRIES',
      100,
      10,
      1_000,
    );
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    const age = cached ? Date.now() - cached.storedAt : Number.POSITIVE_INFINITY;
    if (cached && age <= this.freshTtlMs) {
      this.touch(key, cached);
      return cached.value as T;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const loadPromise = loader()
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .catch((error) => {
        if (cached && age <= this.staleTtlMs && isUnavailable(error)) {
          this.staleResponses += 1;
          this.touch(key, cached);
          return this.markAsContingency(cached, age) as T;
        }
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, loadPromise);
    return loadPromise;
  }

  getStatus() {
    return {
      entradas: this.entries.size,
      consultas_en_curso: this.inFlight.size,
      respuestas_de_contingencia: this.staleResponses,
      ttl_fresco_ms: this.freshTtlMs,
      ttl_contingencia_ms: this.staleTtlMs,
    };
  }

  private store(key: string, value: unknown) {
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  private touch(key: string, entry: CacheEntry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private markAsContingency(entry: CacheEntry, age: number) {
    if (!entry.value || typeof entry.value !== 'object') return entry.value;
    const value = entry.value as Record<string, unknown>;
    const metadata =
      value.metadata && typeof value.metadata === 'object'
        ? (value.metadata as Record<string, unknown>)
        : {};
    return {
      ...value,
      metadata: {
        ...metadata,
        contingencia: {
          activa: true,
          motivo: 'postgres_temporalmente_no_disponible',
          datos_cacheados_en: new Date(entry.storedAt).toISOString(),
          antiguedad_segundos: Math.round(age / 1_000),
        },
      },
    };
  }
}
