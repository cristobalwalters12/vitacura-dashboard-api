import { IsIn } from 'class-validator';

export class UpdateOperationalAlertStatusDto {
  @IsIn(['revisando', 'atendida', 'cerrada'])
  estado: 'revisando' | 'atendida' | 'cerrada';
}
