import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { createPostgresPoolConfig } from './postgres.config';

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresService.name);
  private pool?: Pool;

  constructor(private readonly config: ConfigService) {}

  isConfigured() {
    return Boolean(
      this.config.get<string>('POSTGRES_HOST') &&
        this.config.get<string>('POSTGRES_PASSWORD'),
    );
  }

  private getPool() {
    if (!this.pool) {
      this.pool = new Pool(createPostgresPoolConfig(this.config));
      this.pool.on('error', (error) => {
        this.logger.error(
          `Conexión PostgreSQL inactiva terminada: ${error.message}`,
        );
      });
    }
    return this.pool;
  }

  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.getPool().query<Row>(text, values);
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
