import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostgresModule } from '../postgres/postgres.module';
import {
  Alerta,
  AlertaSchema,
} from '../database/schemas/alerta.schema';
import {
  Dispositivo,
  DispositivoSchema,
} from '../database/schemas/dispositivo.schema';
import {
  PerfilCuidado,
  PerfilCuidadoSchema,
} from '../database/schemas/perfil-cuidado.schema';
import {
  Usuario,
  UsuarioSchema,
} from '../database/schemas/usuario.schema';
import { Zona, ZonaSchema } from '../database/schemas/zona.schema';
import { AlertDetailController } from './alert-detail.controller';
import { AlertDetailService } from './alert-detail.service';
import { DashboardController } from './dashboard.controller';
import { DashboardResponseCacheService } from './dashboard-response-cache.service';
import { DashboardAnalyticsService } from './dashboard-analytics.service';
import {
  ALERT_DETAIL_READER,
  DASHBOARD_ANALYTICS_READER,
  DASHBOARD_READER,
} from './dashboard-readers';
import { DashboardService } from './dashboard.service';
import { PostgresAlertDetailService } from './postgres-alert-detail.service';
import { PostgresDashboardAnalyticsService } from './postgres-dashboard-analytics.service';
import { PostgresDashboardService } from './postgres-dashboard.service';

const dataBackend = (process.env.DATA_BACKEND ?? 'mongo').toLowerCase();
const usePostgres = dataBackend === 'postgres';
const mongoFeature = usePostgres
  ? []
  : [
      MongooseModule.forFeature([
        { name: Alerta.name, schema: AlertaSchema },
        { name: Zona.name, schema: ZonaSchema },
        { name: Usuario.name, schema: UsuarioSchema },
        { name: Dispositivo.name, schema: DispositivoSchema },
        { name: PerfilCuidado.name, schema: PerfilCuidadoSchema },
      ]),
    ];
const mongoProviders = usePostgres
  ? []
  : [DashboardService, DashboardAnalyticsService, AlertDetailService];
const postgresProviders = usePostgres
  ? [
      PostgresDashboardService,
      PostgresDashboardAnalyticsService,
      PostgresAlertDetailService,
    ]
  : [];
const readerProviders = [
  {
    provide: DASHBOARD_READER,
    useExisting: usePostgres
      ? PostgresDashboardService
      : DashboardService,
  },
  {
    provide: DASHBOARD_ANALYTICS_READER,
    useExisting: usePostgres
      ? PostgresDashboardAnalyticsService
      : DashboardAnalyticsService,
  },
  {
    provide: ALERT_DETAIL_READER,
    useExisting: usePostgres
      ? PostgresAlertDetailService
      : AlertDetailService,
  },
];

@Module({
  imports: [
    PostgresModule,
    ...mongoFeature,
  ],
  controllers: [DashboardController, AlertDetailController],
  providers: [
    ...mongoProviders,
    ...postgresProviders,
    ...readerProviders,
    DashboardResponseCacheService,
  ],
  exports: [DashboardResponseCacheService],
})
export class DashboardModule {}
