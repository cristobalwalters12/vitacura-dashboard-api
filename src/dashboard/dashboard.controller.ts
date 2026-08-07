import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MapaQueryDto } from './dto/mapa-query.dto';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('resumen')
  obtenerResumen(@Query() filtros: DashboardQueryDto) {
    return this.dashboardService.obtenerResumen(filtros);
  }

  @Get('mapa')
  obtenerAlertasMapa(@Query() filtros: MapaQueryDto) {
    return this.dashboardService.obtenerAlertasMapa(filtros);
  }
}
