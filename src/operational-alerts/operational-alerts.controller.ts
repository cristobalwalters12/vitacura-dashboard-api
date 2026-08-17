import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { OperationalAlertQueryDto } from './dto/operational-alert-query.dto';
import { UpdateOperationalAlertStatusDto } from './dto/update-operational-alert-status.dto';
import { OperationalAlertsService } from './operational-alerts.service';

@Controller('alertas-operativas')
export class OperationalAlertsController {
  constructor(private readonly alerts: OperationalAlertsService) {}

  @Sse('eventos')
  events(): Observable<MessageEvent> {
    return this.alerts.stream();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: OperationalAlertQueryDto) {
    return this.alerts.list(query);
  }

  @Get(':identifier')
  @Header('Cache-Control', 'no-store')
  findOne(@Param('identifier') identifier: string) {
    return this.alerts.findOne(identifier);
  }

  @Patch(':identifier/estado')
  @Header('Cache-Control', 'no-store')
  updateStatus(
    @Param('identifier') identifier: string,
    @Body() body: UpdateOperationalAlertStatusDto,
  ) {
    return this.alerts.updateStatus(identifier, body.estado);
  }
}
