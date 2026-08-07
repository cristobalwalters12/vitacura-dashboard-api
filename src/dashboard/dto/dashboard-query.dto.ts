import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const CATEGORIAS = [
  'todas',
  'medica',
  'seguridad',
  'incendio',
  'accidente',
  'asistencia_cuidador',
  'asistencia_comunitaria',
] as const;

export class DashboardQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  dias = 90;

  @IsOptional()
  @IsISO8601()
  desde?: string;

  @IsOptional()
  @IsISO8601()
  hasta?: string;

  @IsOptional()
  @IsIn(CATEGORIAS)
  categoria = 'todas';

  @IsOptional()
  @IsString()
  zona?: string;
}
