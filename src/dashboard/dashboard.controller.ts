import { Controller, Get, Header, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardAnalyticsService } from './dashboard-analytics.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MapaQueryDto } from './dto/mapa-query.dto';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly dashboardAnalytics: DashboardAnalyticsService,
  ) {}

  @Get('resumen')
  @Header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60')
  obtenerResumen(@Query() filtros: DashboardQueryDto) {
    return this.dashboardService.obtenerResumen(filtros);
  }

  @Get('mapa')
  @Header('Cache-Control', 'private, max-age=10, stale-while-revalidate=20')
  obtenerAlertasMapa(@Query() filtros: MapaQueryDto) {
    return this.dashboardService.obtenerAlertasMapa(filtros);
  }

  @Get('analitica')
  @Header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60')
  obtenerAnalitica(@Query() filtros: DashboardQueryDto) {
    return this.dashboardAnalytics.obtenerAnalitica(filtros);
  }
}
