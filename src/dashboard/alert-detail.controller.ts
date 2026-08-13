import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import {
  ALERT_DETAIL_READER,
  AlertDetailReader,
} from './dashboard-readers';

@Controller('alertas')
export class AlertDetailController {
  constructor(
    @Inject(ALERT_DETAIL_READER)
    private readonly alertDetailService: AlertDetailReader,
  ) {}

  @Get(':id')
  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=600')
  obtenerDetalle(@Param('id') id: string) {
    return this.alertDetailService.obtenerDetalle(id);
  }
}
