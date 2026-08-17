import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../postgres/postgres.service';

type Coordinates = [number, number];

type RoutingRow = {
  origin_id: string;
  destination_id: string;
  origin_coordinates: [number, number];
  destination_coordinates: [number, number];
  origin_snap_meters: number | string;
  destination_snap_meters: number | string;
  segments: number;
  distance_meters: number | string;
  duration_seconds: number | string;
  geometry: {
    type: 'LineString';
    coordinates: Coordinates[];
  } | null;
};

const DEFAULT_ORIGIN: Coordinates = [-70.6014167, -33.3986516];
const DEFAULT_MARGIN_DEGREES = 0.05;
const DEFAULT_MAX_SNAP_METERS = 1_500;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/i;

function configuredNumber(
  config: ConfigService,
  key: string,
  fallback: number,
) {
  const value = Number(config.get(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function assertCoordinates(coordinates: Coordinates, label: string) {
  const [longitude, latitude] = coordinates;
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new ServiceUnavailableException(
      `No fue posible calcular la ruta: ${label} no tiene coordenadas válidas`,
    );
  }
}

@Injectable()
export class OperationalRoutingService {
  private readonly logger = new Logger(OperationalRoutingService.name);
  private readonly schema: string;
  private readonly origin: Coordinates;
  private readonly marginDegrees: number;
  private readonly maxSnapMeters: number;
  private readonly routeCacheTtlMs: number;
  private readonly routeStaleTtlMs: number;
  private readonly routeCache = new Map<
    string,
    { value: Record<string, any>; storedAt: number }
  >();

  constructor(
    private readonly postgres: PostgresService,
    config: ConfigService,
  ) {
    const schema = config.get('POSTGRES_ROUTING_SCHEMA', 'vita_routing');
    if (!SCHEMA_PATTERN.test(schema)) {
      throw new Error('POSTGRES_ROUTING_SCHEMA contiene un nombre inválido');
    }
    this.schema = schema;
    this.origin = [
      configuredNumber(
        config,
        'MUNICIPALIDAD_LONGITUDE',
        DEFAULT_ORIGIN[0],
      ),
      configuredNumber(config, 'MUNICIPALIDAD_LATITUDE', DEFAULT_ORIGIN[1]),
    ];
    this.marginDegrees = Math.max(
      0.01,
      configuredNumber(
        config,
        'OPERATIONAL_ROUTING_MARGIN_DEGREES',
        DEFAULT_MARGIN_DEGREES,
      ),
    );
    this.maxSnapMeters = Math.max(
      50,
      configuredNumber(
        config,
        'OPERATIONAL_ROUTING_MAX_SNAP_METERS',
        DEFAULT_MAX_SNAP_METERS,
      ),
    );
    this.routeCacheTtlMs = Math.max(
      60_000,
      configuredNumber(
        config,
        'OPERATIONAL_ROUTING_CACHE_TTL_MS',
        900_000,
      ),
    );
    this.routeStaleTtlMs = Math.max(
      this.routeCacheTtlMs,
      configuredNumber(
        config,
        'OPERATIONAL_ROUTING_STALE_CACHE_MS',
        86_400_000,
      ),
    );
  }

  async calculate(destination: Coordinates) {
    assertCoordinates(this.origin, 'el origen municipal');
    assertCoordinates(destination, 'la alerta');
    const cacheKey = destination.map((value) => value.toFixed(7)).join(',');
    const cached = this.routeCache.get(cacheKey);
    const cacheAge = cached
      ? Date.now() - cached.storedAt
      : Number.POSITIVE_INFINITY;
    if (cached && cacheAge <= this.routeCacheTtlMs) return cached.value;
    if (!this.postgres.isConfigured()) {
      throw new ServiceUnavailableException(
        'PostgreSQL no está configurado para calcular la ruta operativa',
      );
    }

    const margins = [
      this.marginDegrees,
      Math.min(this.marginDegrees * 2, 0.5),
    ];
    let completedQueries = 0;
    let lastQueryError: unknown;
    for (const margin of margins) {
      let route: RoutingRow | undefined;
      try {
        route = await this.queryRoute(destination, margin);
        completedQueries += 1;
      } catch (error) {
        lastQueryError = error;
        this.logger.warn(
          `Falló consulta pgRouting con margen ${margin}: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
        continue;
      }
      if (!route || route.segments < 1 || !route.geometry) continue;

      const originSnapMeters = Number(route.origin_snap_meters);
      const destinationSnapMeters = Number(route.destination_snap_meters);
      if (
        originSnapMeters > this.maxSnapMeters ||
        destinationSnapMeters > this.maxSnapMeters
      ) {
        throw new ServiceUnavailableException(
          'El origen o la alerta están demasiado lejos de la red vial disponible',
        );
      }

      const calculatedRoute = {
        algoritmo: 'pgr_dijkstra',
        precision: 'red_vial_postgis',
        optimizado_por: 'tiempo',
        origen: {
          nombre: 'Municipalidad de Vitacura',
          direccion: 'Av. Bicentenario 3800, Vitacura',
          coordinates: this.origin,
          coordinates_red: route.origin_coordinates,
        },
        destino: {
          coordinates: destination,
          coordinates_red: route.destination_coordinates,
        },
        distancia_estimada_metros: Math.round(Number(route.distance_meters)),
        duracion_estimada_segundos: Math.ceil(Number(route.duration_seconds)),
        segmentos: route.segments,
        ajuste_red: {
          origen_metros: Math.round(originSnapMeters),
          destino_metros: Math.round(destinationSnapMeters),
        },
        geometria: route.geometry,
        nodos: {
          origen: route.origin_id,
          destino: route.destination_id,
        },
      };
      this.storeRoute(cacheKey, calculatedRoute);
      return calculatedRoute;
    }

    if (completedQueries === 0 && lastQueryError) {
      if (cached && cacheAge <= this.routeStaleTtlMs) {
        this.logger.warn(
          `Se entrega ruta cacheada para ${destination.join(',')} durante contingencia PostgreSQL`,
        );
        return {
          ...cached.value,
          contingencia: {
            activa: true,
            motivo: 'postgres_temporalmente_no_disponible',
            datos_cacheados_en: new Date(cached.storedAt).toISOString(),
          },
        };
      }
      throw new ServiceUnavailableException(
        'La red vial de PostgreSQL no está disponible temporalmente',
      );
    }
    this.logger.warn(
      `No se encontró una ruta vial desde la Municipalidad hacia ${destination.join(',')}`,
    );
    throw new ServiceUnavailableException(
      'No se encontró una ruta conectada en la red vial para esta alerta',
    );
  }

  private storeRoute(key: string, value: Record<string, any>) {
    this.routeCache.delete(key);
    this.routeCache.set(key, { value, storedAt: Date.now() });
    while (this.routeCache.size > 100) {
      const oldestKey = this.routeCache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      this.routeCache.delete(oldestKey);
    }
  }

  private async queryRoute(destination: Coordinates, margin: number) {
    const west = Math.min(this.origin[0], destination[0]) - margin;
    const south = Math.min(this.origin[1], destination[1]) - margin;
    const east = Math.max(this.origin[0], destination[0]) + margin;
    const north = Math.max(this.origin[1], destination[1]) + margin;
    const qualifiedWays = `"${this.schema}"."ways"`;
    const qualifiedVertices = `"${this.schema}"."ways_vertices_pgr"`;
    const edgeSql = [
      'SELECT id, source, target, cost_s AS cost,',
      'reverse_cost_s AS reverse_cost',
      `FROM ${qualifiedWays}`,
      `WHERE geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`,
    ].join(' ');

    const sql = `
      WITH endpoints AS (
        SELECT
          origin.id AS origin_id,
          destination.id AS destination_id,
          origin.geom AS origin_geom,
          destination.geom AS destination_geom,
          ST_SetSRID(ST_MakePoint($1, $2), 4326) AS requested_origin,
          ST_SetSRID(ST_MakePoint($3, $4), 4326) AS requested_destination
        FROM LATERAL (
          SELECT id, geom
          FROM ${qualifiedVertices}
          ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
          LIMIT 1
        ) AS origin
        CROSS JOIN LATERAL (
          SELECT id, geom
          FROM ${qualifiedVertices}
          ORDER BY geom <-> ST_SetSRID(ST_MakePoint($3, $4), 4326)
          LIMIT 1
        ) AS destination
      ),
      path AS (
        SELECT route.*
        FROM endpoints
        CROSS JOIN LATERAL pgr_dijkstra(
          $5,
          endpoints.origin_id,
          endpoints.destination_id,
          directed := true
        ) AS route
      ),
      segments AS (
        SELECT
          path.path_seq,
          ways.length_m,
          CASE
            WHEN ways.source = path.node THEN ways.geom
            ELSE ST_Reverse(ways.geom)
          END AS geom
        FROM path
        JOIN ${qualifiedWays} AS ways ON ways.id = path.edge
        WHERE path.edge <> -1
      ),
      route_summary AS (
        SELECT
          COUNT(*)::integer AS segments,
          COALESCE(SUM(length_m), 0)::double precision AS distance_meters,
          ST_MakeLine(geom ORDER BY path_seq) AS geom
        FROM segments
      )
      SELECT
        endpoints.origin_id,
        endpoints.destination_id,
        ARRAY[ST_X(endpoints.origin_geom), ST_Y(endpoints.origin_geom)]::double precision[]
          AS origin_coordinates,
        ARRAY[ST_X(endpoints.destination_geom), ST_Y(endpoints.destination_geom)]::double precision[]
          AS destination_coordinates,
        ST_Distance(
          endpoints.requested_origin::geography,
          endpoints.origin_geom::geography
        ) AS origin_snap_meters,
        ST_Distance(
          endpoints.requested_destination::geography,
          endpoints.destination_geom::geography
        ) AS destination_snap_meters,
        route_summary.segments,
        route_summary.distance_meters,
        COALESCE((SELECT MAX(agg_cost) FROM path), 0)::double precision
          AS duration_seconds,
        ST_AsGeoJSON(route_summary.geom)::json AS geometry
      FROM endpoints
      CROSS JOIN route_summary
    `;

    const result = await this.postgres.query<RoutingRow>(sql, [
      this.origin[0],
      this.origin[1],
      destination[0],
      destination[1],
      edgeSql,
    ]);
    return result.rows[0];
  }
}
