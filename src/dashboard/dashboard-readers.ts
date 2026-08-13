import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MapaQueryDto } from './dto/mapa-query.dto';

export const DASHBOARD_READER = Symbol('DASHBOARD_READER');
export const DASHBOARD_ANALYTICS_READER = Symbol(
  'DASHBOARD_ANALYTICS_READER',
);
export const ALERT_DETAIL_READER = Symbol('ALERT_DETAIL_READER');

export interface DashboardReader {
  obtenerResumen(filtros: DashboardQueryDto): Promise<unknown>;
  obtenerAlertasMapa(filtros: MapaQueryDto): Promise<unknown>;
}

export interface DashboardAnalyticsReader {
  obtenerAnalitica(filtros: DashboardQueryDto): Promise<unknown>;
}

export interface AlertDetailReader {
  obtenerDetalle(id: string): Promise<unknown>;
}
