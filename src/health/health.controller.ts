import { Controller, Get, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { PostgresService } from '../postgres/postgres.service';
import { DashboardResponseCacheService } from '../dashboard/dashboard-response-cache.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly postgres: PostgresService,
    private readonly dashboardCache: DashboardResponseCacheService,
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
  ) {}

  @Get()
  async obtenerEstado() {
    if (this.config.get<string>('DATA_BACKEND', 'mongo') === 'postgres') {
      try {
        await this.postgres.query('SELECT 1');
        return {
          estado: 'saludable',
          backend: 'postgres',
          postgresql: 'conectado',
          postgres_detalle: this.postgres.getStatus(),
          cache_dashboard: this.dashboardCache.getStatus(),
          fecha: new Date().toISOString(),
        };
      } catch {
        return {
          estado: 'degradado',
          backend: 'postgres',
          postgresql: 'desconectado',
          postgres_detalle: this.postgres.getStatus(),
          cache_dashboard: this.dashboardCache.getStatus(),
          fecha: new Date().toISOString(),
        };
      }
    }
    const conectado = this.connection?.readyState === 1;
    return {
      estado: conectado ? 'saludable' : 'degradado',
      backend: 'mongo',
      mongodb: conectado ? 'conectado' : 'desconectado',
      fecha: new Date().toISOString(),
    };
  }
}
