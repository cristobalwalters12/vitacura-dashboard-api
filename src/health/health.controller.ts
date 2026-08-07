import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  obtenerEstado() {
    const conectado = this.connection.readyState === 1;
    return {
      estado: conectado ? 'saludable' : 'degradado',
      mongodb: conectado ? 'conectado' : 'desconectado',
      fecha: new Date().toISOString(),
    };
  }
}
