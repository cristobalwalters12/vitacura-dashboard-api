import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class OperationalAlertQueryDto {
  @IsOptional()
  @IsIn(['nueva', 'revisando', 'atendida', 'cerrada'])
  estado?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limite = 50;
}
