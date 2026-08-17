import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostgresModule } from '../postgres/postgres.module';
import {
  OPERATIONAL_ALERT_MODEL,
  OPERATIONAL_MONGO_CONNECTION,
  OperationalAlertSchema,
} from './operational-alert.schema';
import { OperationalAlertsController } from './operational-alerts.controller';
import { OperationalAlertsService } from './operational-alerts.service';
import { OperationalRoutingService } from './operational-routing.service';

@Module({
  imports: [
    PostgresModule,
    MongooseModule.forFeature(
      [{ name: OPERATIONAL_ALERT_MODEL, schema: OperationalAlertSchema }],
      OPERATIONAL_MONGO_CONNECTION,
    ),
  ],
  controllers: [OperationalAlertsController],
  providers: [OperationalAlertsService, OperationalRoutingService],
})
export class OperationalAlertsModule {}
