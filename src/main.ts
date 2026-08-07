import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );
  const config = app.get(ConfigService);
  const frontendOrigin = config.get<string>(
    'FRONTEND_ORIGIN',
    'http://localhost:5173',
  );

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: frontendOrigin.split(',').map((origin) => origin.trim()),
    methods: ['GET', 'OPTIONS'],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableShutdownHooks();

  const port = Number(config.get<string>('PORT', '3000'));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT debe ser un número de puerto válido');
  }
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
