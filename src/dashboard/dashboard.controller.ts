import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import {
  DASHBOARD_ANALYTICS_READER,
  DASHBOARD_READER,
  DashboardAnalyticsReader,
  DashboardReader,
} from './dashboard-readers';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MapaQueryDto } from './dto/mapa-query.dto';
import { DashboardResponseCacheService } from './dashboard-response-cache.service';

@Controller('dashboard')
export class DashboardController {
  constructor(
    @Inject(DASHBOARD_READER)
    private readonly dashboardService: DashboardReader,
    @Inject(DASHBOARD_ANALYTICS_READER)
    private readonly dashboardAnalytics: DashboardAnalyticsReader,
    private readonly responseCache: DashboardResponseCacheService,
  ) {}

  @Get('resumen')
  @Header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60')
  obtenerResumen(@Query() filtros: DashboardQueryDto) {
    return this.responseCache.getOrLoad(
      `resumen:${JSON.stringify(filtros)}`,
      () => this.dashboardService.obtenerResumen(filtros),
    );
  }

  @Get('mapa')
  @Header('Cache-Control', 'private, max-age=10, stale-while-revalidate=20')
  obtenerAlertasMapa(@Query() filtros: MapaQueryDto) {
    return this.responseCache.getOrLoad(
      `mapa:${JSON.stringify(filtros)}`,
      () => this.dashboardService.obtenerAlertasMapa(filtros),
    );
  }

  @Get('analitica')
  @Header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60')
  obtenerAnalitica(@Query() filtros: DashboardQueryDto) {
    return this.responseCache.getOrLoad(
      `analitica:${JSON.stringify(filtros)}`,
      () => this.dashboardAnalytics.obtenerAnalitica(filtros),
    );
  }
}
