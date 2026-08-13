import { Controller, Get, Header, Param } from '@nestjs/common';
import { AlertDetailService } from './alert-detail.service';

@Controller('alertas')
export class AlertDetailController {
  constructor(private readonly alertDetailService: AlertDetailService) {}

  @Get(':id')
  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=600')
  obtenerDetalle(@Param('id') id: string) {
    return this.alertDetailService.obtenerDetalle(id);
  }
}
