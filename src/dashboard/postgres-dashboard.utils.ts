import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

const DAY_MS = 86_400_000;

export interface PostgresAlertFilter {
  where: string;
  values: unknown[];
  desde: Date;
  hasta: Date;
}

export function getPostgresSchema(config: ConfigService) {
  const schema = config.get<string>('POSTGRES_SCHEMA', 'vita');
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error('POSTGRES_SCHEMA contiene caracteres no válidos');
  }
  return `"${schema}"`;
}

export function getMunicipalityId(config: ConfigService) {
  const municipality = config.get<string>(
    'MUNICIPALIDAD_ID',
    '64f000000000000000000132',
  );
  if (!/^[a-f\d]{24}$/i.test(municipality)) {
    throw new Error('MUNICIPALIDAD_ID no es un ObjectId válido');
  }
  return municipality;
}

export function getCutoffDate(config: ConfigService) {
  const cutoff = new Date(
    config.get<string>(
      'ANALYTICS_CUTOFF_DATE',
      '2026-08-15T23:59:59.999Z',
    ),
  );
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error('ANALYTICS_CUTOFF_DATE no es una fecha válida');
  }
  return cutoff;
}

export function buildPostgresAlertFilter(
  config: ConfigService,
  filtros: DashboardQueryDto,
  alias = 'a',
  period?: { desde: Date; hasta: Date },
): PostgresAlertFilter {
  const cutoff = getCutoffDate(config);
  const requestedEnd = filtros.hasta ? new Date(filtros.hasta) : cutoff;
  const hasta = period?.hasta ?? new Date(
    Math.min(requestedEnd.getTime(), cutoff.getTime()),
  );
  const desde = period?.desde ??
    (filtros.desde
      ? new Date(filtros.desde)
      : new Date(hasta.getTime() - filtros.dias * DAY_MS));
  if (desde >= hasta) {
    throw new BadRequestException('desde debe ser anterior a hasta');
  }

  const values: unknown[] = [getMunicipalityId(config), desde, hasta];
  const clauses = [
    `${alias}.municipalidad_id = $1`,
    `${alias}.creado_en >= $2`,
    `${alias}.creado_en <= $3`,
  ];
  const addValue = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filtros.categoria && filtros.categoria !== 'todas') {
    clauses.push(`${alias}.categoria = ${addValue(filtros.categoria)}`);
  }
  if (filtros.zona) {
    clauses.push(`${alias}.codigo_zona = ${addValue(filtros.zona)}`);
  }
  const multiples: Array<[string, string | undefined]> = [
    ['prioridad', filtros.prioridad],
    ['severidad', filtros.severidad],
    ['canal', filtros.canal],
  ];
  for (const [column, value] of multiples) {
    if (value) {
      clauses.push(
        `${alias}.${column} = ANY(${addValue(value.split(','))}::text[])`,
      );
    }
  }
  if (filtros.requiere_revision !== undefined) {
    clauses.push(
      `${alias}.requiere_revision_humana = ${addValue(filtros.requiere_revision === 'true')}`,
    );
  }
  if (filtros.escalada !== undefined) {
    clauses.push(
      `${alias}.escalada_centro_emergencia = ${addValue(filtros.escalada === 'true')}`,
    );
  }
  return { where: clauses.join(' AND '), values, desde, hasta };
}

export function summarizeFilters(filtros: DashboardQueryDto) {
  return {
    categoria: filtros.categoria,
    zona: filtros.zona ?? null,
    prioridades: filtros.prioridad?.split(',') ?? [],
    severidades: filtros.severidad?.split(',') ?? [],
    canales: filtros.canal?.split(',') ?? [],
    requiere_revision:
      filtros.requiere_revision === undefined
        ? null
        : filtros.requiere_revision === 'true',
    escalada:
      filtros.escalada === undefined ? null : filtros.escalada === 'true',
  };
}

export function parseBoundingBox(value: string) {
  const coordinates = value.split(',').map(Number);
  if (
    coordinates.length !== 4 ||
    coordinates.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw new BadRequestException(
      'bbox debe tener el formato oeste,sur,este,norte',
    );
  }
  const [west, south, east, north] = coordinates;
  if (west >= east || south >= north) {
    throw new BadRequestException('bbox contiene límites inválidos');
  }
  return { west, south, east, north };
}

export function normalizeExtendedJson(value: unknown): any {
  if (Array.isArray(value)) return value.map(normalizeExtendedJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && typeof record.$oid === 'string') {
    return record.$oid;
  }
  if (keys.length === 1 && typeof record.$date === 'string') {
    return new Date(record.$date);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      normalizeExtendedJson(entry),
    ]),
  );
}
