import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DashboardQueryDto } from './dashboard-query.dto';

export class MapaQueryDto extends DashboardQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(8000)
  limite?: number;

  // oeste,sur,este,norte
  @IsOptional()
  @IsString()
  bbox?: string;
}
