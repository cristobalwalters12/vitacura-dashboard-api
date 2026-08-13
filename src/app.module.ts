import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health/health.controller';
import { PostgresModule } from './postgres/postgres.module';

const dataBackend = (process.env.DATA_BACKEND ?? 'mongo').toLowerCase();
if (!['mongo', 'postgres'].includes(dataBackend)) {
  throw new Error('DATA_BACKEND debe ser mongo o postgres');
}

const mongoConnection =
  dataBackend === 'mongo'
    ? [
        MongooseModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const uri = config.get<string>('MONGODB_URI');
            if (!uri) {
              throw new Error('Falta MONGODB_URI en el archivo .env');
            }
            return {
              uri,
              dbName: config.get<string>(
                'MONGODB_DATABASE',
                'community_sos_demo',
              ),
              maxPoolSize: 20,
              minPoolSize: 2,
              serverSelectionTimeoutMS: 10_000,
              connectTimeoutMS: 10_000,
              retryWrites: true,
            };
          },
        }),
      ]
    : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PostgresModule,
    ...mongoConnection,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
