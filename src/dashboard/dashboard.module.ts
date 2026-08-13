import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
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
import { DashboardAnalyticsService } from './dashboard-analytics.service';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Alerta.name, schema: AlertaSchema },
      { name: Zona.name, schema: ZonaSchema },
      { name: Usuario.name, schema: UsuarioSchema },
      { name: Dispositivo.name, schema: DispositivoSchema },
      { name: PerfilCuidado.name, schema: PerfilCuidadoSchema },
    ]),
  ],
  controllers: [DashboardController, AlertDetailController],
  providers: [
    DashboardService,
    DashboardAnalyticsService,
    AlertDetailService,
  ],
})
export class DashboardModule {}
