import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
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

export const PRIORIDADES = ['P1', 'P2', 'P3', 'P4'] as const;
export const SEVERIDADES = ['baja', 'media', 'alta', 'critica'] as const;
export const CANALES = ['reloj_inteligente', 'movil', 'cuidador'] as const;

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

  @IsOptional()
  @Matches(/^(P1|P2|P3|P4)(,(P1|P2|P3|P4))*$/)
  prioridad?: string;

  @IsOptional()
  @Matches(/^(baja|media|alta|critica)(,(baja|media|alta|critica))*$/)
  severidad?: string;

  @IsOptional()
  @Matches(
    /^(reloj_inteligente|movil|cuidador)(,(reloj_inteligente|movil|cuidador))*$/,
  )
  canal?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  requiere_revision?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  escalada?: 'true' | 'false';
}
