import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../postgres/postgres.service';
import {
  CategoriaAgregada,
  FacetasDashboard,
  ResultadoResumen,
  RevisionCategoriaAgregada,
  TendenciaAgregada,
  ZonaAgregada,
  ZonaCategoriaDetalle,
} from './dashboard.service';
import { DashboardReader } from './dashboard-readers';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MapaQueryDto } from './dto/mapa-query.dto';
import {
  PostgresAlertFilter,
  buildPostgresAlertFilter,
  getCutoffDate,
  getMunicipalityId,
  getPostgresSchema,
  parseBoundingBox,
  summarizeFilters,
} from './postgres-dashboard.utils';

interface PostgresZone {
  id: string;
  codigo: string;
  nombre: string;
  geometria: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown[] };
  usuarios: number;
}

@Injectable()
export class PostgresDashboardService implements DashboardReader {
  private readonly schema: string;
  private readonly municipalityId: string;
  private readonly cutoffDate: Date;

  constructor(
    private readonly postgres: PostgresService,
    private readonly config: ConfigService,
  ) {
    this.schema = getPostgresSchema(config);
    this.municipalityId = getMunicipalityId(config);
    this.cutoffDate = getCutoffDate(config);
  }

  async obtenerResumen(filtros: DashboardQueryDto) {
    const currentFilter = buildPostgresAlertFilter(this.config, filtros);
    const duration = currentFilter.hasta.getTime() - currentFilter.desde.getTime();
    const previousEnd = new Date(currentFilter.desde.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - duration);
    const previousFilter = buildPostgresAlertFilter(
      this.config,
      filtros,
      'a',
      { desde: previousStart, hasta: previousEnd },
    );

    const [facets, previousFacets, operationalResult, zonesResult] =
      await Promise.all([
        this.queryFacets(currentFilter),
        this.queryFacets(previousFilter),
        this.postgres.query<any>(
          `SELECT
             (SELECT count(*)::int FROM ${this.schema}.usuarios
               WHERE municipalidad_id = $1) AS usuarios,
             (SELECT count(*)::int FROM ${this.schema}.usuarios
               WHERE municipalidad_id = $1 AND activo = true) AS usuarios_activos,
             (SELECT count(*)::int FROM ${this.schema}.dispositivos
               WHERE municipalidad_id = $1) AS dispositivos,
             (SELECT count(*)::int FROM ${this.schema}.dispositivos
               WHERE municipalidad_id = $1 AND estado = 'activo') AS dispositivos_activos,
             (SELECT count(*)::int FROM ${this.schema}.dispositivos
               WHERE municipalidad_id = $1 AND porcentaje_bateria <= 20) AS bateria_baja,
             (SELECT count(*)::int FROM ${this.schema}.perfiles_cuidado
               WHERE municipalidad_id = $1 AND activo = true) AS perfiles_cuidado,
             (SELECT count(*)::int FROM ${this.schema}.perfiles_cuidado
               WHERE municipalidad_id = $1 AND activo = true
                 AND nivel_dependencia = 'severa') AS dependencia_severa`,
          [this.municipalityId],
        ),
        this.postgres.query<any>(
          `SELECT z.id, z.codigo, z.nombre,
                  ST_AsGeoJSON(z.geometria)::json AS geometria,
                  count(u.id)::int AS usuarios
             FROM ${this.schema}.zonas z
             LEFT JOIN ${this.schema}.usuarios u
               ON u.zona_hogar_id = z.id
              AND u.municipalidad_id = z.municipalidad_id
            WHERE z.municipalidad_id = $1
            GROUP BY z.id, z.codigo, z.nombre, z.geometria
            ORDER BY split_part(z.codigo, '-', 2)::int`,
          [this.municipalityId],
        ),
      ]);

    const summary = facets.resumen[0] ?? this.emptySummary();
    const previousSummary = previousFacets.resumen[0] ?? this.emptySummary();
    const metricByZone = new Map(
      facets.zonas.map((item) => [item.codigo_zona, item]),
    );
    const categoryByZone = new Map(
      facets.zonasCategorias.map((item) => [item.codigo_zona, item]),
    );
    const zones = zonesResult.rows as PostgresZone[];
    const zoneStatistics = zones
      .map((zone) => {
        const statistic = metricByZone.get(zone.codigo);
        const totalAlerts = statistic?.total ?? 0;
        return {
          codigo: zone.codigo,
          nombre: zone.nombre,
          usuarios: zone.usuarios,
          alertas: totalAlerts,
          alertas_por_mil: zone.usuarios
            ? Number(((totalAlerts / zone.usuarios) * 1000).toFixed(1))
            : 0,
          criticas: statistic?.criticas ?? 0,
          respuesta_mediana: statistic?.mediana_respuesta_segundos ?? 0,
          cumplimiento_sla: statistic?.cumplimiento_sla ?? 0,
        };
      })
      .sort((left, right) => right.alertas_por_mil - left.alertas_por_mil);
    const zonesGeoJson = {
      type: 'FeatureCollection' as const,
      features: zones.map((zone) => {
        const statistic = zoneStatistics.find(
          (item) => item.codigo === zone.codigo,
        );
        return {
          type: 'Feature' as const,
          properties: {
            codigo: zone.codigo,
            nombre: zone.nombre,
            usuarios: statistic?.usuarios ?? 0,
            alertas: statistic?.alertas ?? 0,
            criticas: statistic?.criticas ?? 0,
            alertasPorMil: statistic?.alertas_por_mil ?? 0,
            respuestaMediana: statistic?.respuesta_mediana ?? 0,
            categoriaDominante:
              categoryByZone.get(zone.codigo)?.categoria ?? null,
            sla: Number(
              ((statistic?.cumplimiento_sla ?? 0) * 100).toFixed(1),
            ),
          },
          geometry: zone.geometria,
        };
      }),
    };

    return {
      metadata: {
        comuna: 'Vitacura',
        sintetico: true,
        actualizado_en: this.cutoffDate.toISOString(),
        fecha_corte: this.cutoffDate.toISOString(),
        periodo: {
          inicio: currentFilter.desde.toISOString(),
          fin: currentFilter.hasta.toISOString(),
        },
        filtros_aplicados: summarizeFilters(filtros),
      },
      resumen_operacional: operationalResult.rows[0],
      metricas: summary,
      categorias: facets.categorias,
      tendencia: facets.tendencia,
      comparacion: this.createComparison(
        summary,
        previousSummary,
        facets,
        previousFacets,
        previousStart,
        previousEnd,
      ),
      hallazgos: this.createFindings(
        summary,
        previousSummary,
        facets,
        previousFacets,
        zones,
      ),
      zonas: zonesGeoJson,
      estadisticas_zonas: zoneStatistics,
    };
  }

  async obtenerAlertasMapa(filtros: MapaQueryDto) {
    const filter = buildPostgresAlertFilter(this.config, filtros);
    const configured = Number(
      this.config.get<string>('MAPA_LIMITE_PREDETERMINADO', '5000'),
    );
    const defaultLimit = Number.isInteger(configured)
      ? Math.min(Math.max(configured, 100), 8000)
      : 5000;
    const limit = Math.min(filtros.limite ?? defaultLimit, 8000);
    const values = [...filter.values];
    let where = filter.where;
    if (filtros.bbox) {
      const box = parseBoundingBox(filtros.bbox);
      values.push(box.west, box.south, box.east, box.north);
      const offset = values.length - 3;
      const envelope = `ST_MakeEnvelope($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3}, 4326)`;
      where += ` AND a.ubicacion && ${envelope} AND ST_Covers(${envelope}, a.ubicacion)`;
    }
    const rowValues = [...values, limit];
    const [countResult, alertsResult] = await Promise.all([
      this.postgres.query<any>(
        `SELECT count(*)::int AS total
           FROM ${this.schema}.alertas a
          WHERE ${where}`,
        values,
      ),
      this.postgres.query<any>(
        `SELECT a.id,
                a.codigo_alerta AS codigo,
                ARRAY[ST_X(a.ubicacion), ST_Y(a.ubicacion)] AS coordenadas,
                a.creado_en AS fecha,
                a.categoria, a.tipo, a.severidad, a.confianza,
                a.requiere_revision_humana AS requiere_revision,
                a.prioridad, a.puntaje_prioridad,
                a.canal, a.metodo_activacion AS metodo,
                a.segundos_primera_respuesta AS respuesta_segundos,
                a.escalada_centro_emergencia AS escalada,
                a.codigo_zona AS zona,
                COALESCE(a.nombre_zona, z.nombre, a.codigo_zona) AS zona_nombre,
                a.nombre_calle AS calle,
                a.resultado
           FROM ${this.schema}.alertas a
           LEFT JOIN ${this.schema}.zonas z ON z.id = a.zona_id
          WHERE ${where}
          ORDER BY a.creado_en DESC
          LIMIT $${rowValues.length}`,
        rowValues,
      ),
    ]);
    const total = countResult.rows[0].total as number;
    return {
      metadata: {
        periodo: {
          inicio: filter.desde.toISOString(),
          fin: filter.hasta.toISOString(),
        },
        total,
        entregadas: alertsResult.rows.length,
        limite: limit,
        truncado: total > alertsResult.rows.length,
        filtros_aplicados: summarizeFilters(filtros),
      },
      alertas: alertsResult.rows,
    };
  }

  private async queryFacets(filter: PostgresAlertFilter): Promise<FacetasDashboard> {
    const securityStart = new Date(
      this.cutoffDate.getTime() - 15 * 86_400_000,
    );
    const values = [
      ...filter.values,
      securityStart,
      this.cutoffDate,
    ];
    const securityStartIndex = filter.values.length + 1;
    const result = await this.postgres.query<FacetasDashboard>(
      `WITH filtered AS MATERIALIZED (
         SELECT categoria, prioridad, segundos_primera_respuesta,
                canal, requiere_revision_humana,
                escalada_centro_emergencia, creado_en, codigo_zona
           FROM ${this.schema}.alertas a
          WHERE ${filter.where}
       ),
       summary AS (
         SELECT count(*)::int AS total_alertas,
                count(*) FILTER (WHERE prioridad = 'P1')::int AS alertas_criticas,
                COALESCE(round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int, 0) AS mediana_respuesta_segundos,
                COALESCE(round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int, 0) AS p90_respuesta_segundos,
                COALESCE(round(
                  count(*) FILTER (WHERE segundos_primera_respuesta <= 300)::numeric /
                  NULLIF(count(segundos_primera_respuesta), 0), 4), 0)::float8 AS cumplimiento_sla,
                COALESCE(round(
                  count(*) FILTER (WHERE canal = 'reloj_inteligente')::numeric /
                  NULLIF(count(*), 0), 4), 0)::float8 AS porcentaje_reloj,
                COALESCE(round(
                  count(*) FILTER (WHERE requiere_revision_humana = false)::numeric /
                  NULLIF(count(*), 0), 4), 0)::float8 AS porcentaje_automatico,
                count(*) FILTER (WHERE escalada_centro_emergencia)::int AS escaladas_emergencia
           FROM filtered
       ),
       categories AS (
         SELECT categoria, count(*)::int AS total
           FROM filtered GROUP BY categoria
       ),
       trend AS (
         SELECT
           (date_trunc('day', creado_en AT TIME ZONE 'America/Santiago')
             AT TIME ZONE 'America/Santiago') AS fecha,
           count(*)::int AS total,
           count(*) FILTER (WHERE prioridad = 'P1')::int AS criticas
           FROM filtered GROUP BY fecha
       ),
       zones AS (
         SELECT codigo_zona,
                count(*)::int AS total,
                count(*) FILTER (WHERE prioridad = 'P1')::int AS criticas,
                COALESCE(round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int, 0) AS mediana_respuesta_segundos,
                COALESCE(round(
                  count(*) FILTER (WHERE segundos_primera_respuesta <= 300)::numeric /
                  NULLIF(count(segundos_primera_respuesta), 0), 4), 0)::float8 AS cumplimiento_sla
           FROM filtered GROUP BY codigo_zona
       ),
       zone_category_details AS (
         SELECT codigo_zona, categoria, count(*)::int AS total
           FROM filtered GROUP BY codigo_zona, categoria
       ),
       dominant_categories AS (
         SELECT codigo_zona, categoria, total
           FROM (
             SELECT zone_category_details.*,
                    row_number() OVER (
                      PARTITION BY codigo_zona ORDER BY total DESC
                    ) AS position
               FROM zone_category_details
           ) ranked
          WHERE position = 1
       ),
       review_categories AS (
         SELECT categoria, count(*)::int AS total,
                count(*) FILTER (WHERE requiere_revision_humana)::int AS revisiones
           FROM filtered GROUP BY categoria
       ),
       night_security AS (
         SELECT count(*)::int AS total,
                count(*) FILTER (
                  WHERE extract(hour FROM creado_en AT TIME ZONE 'UTC') >= 20
                     OR extract(hour FROM creado_en AT TIME ZONE 'UTC') <= 3
                )::int AS nocturnas
           FROM filtered
          WHERE categoria = 'seguridad'
            AND codigo_zona = ANY(ARRAY['A-12', 'A-13'])
            AND creado_en >= $${securityStartIndex}
            AND creado_en <= $${securityStartIndex + 1}
       )
       SELECT
         jsonb_build_array(to_jsonb(summary)) AS resumen,
         (SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.total DESC), '[]'::jsonb)
            FROM categories item) AS categorias,
         (SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.fecha), '[]'::jsonb)
            FROM trend item) AS tendencia,
         (SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.total DESC), '[]'::jsonb)
            FROM zones item) AS zonas,
         (SELECT COALESCE(jsonb_agg(to_jsonb(item)), '[]'::jsonb)
            FROM dominant_categories item) AS "zonasCategorias",
         (SELECT COALESCE(jsonb_agg(to_jsonb(item)), '[]'::jsonb)
            FROM review_categories item) AS "revisionCategorias",
         (SELECT COALESCE(jsonb_agg(to_jsonb(item)), '[]'::jsonb)
            FROM zone_category_details item) AS "zonasCategoriasDetalle",
         CASE WHEN night_security.total > 0
           THEN jsonb_build_array(to_jsonb(night_security))
           ELSE '[]'::jsonb
         END AS "seguridadNocturna"
       FROM summary CROSS JOIN night_security`,
      values,
    );
    return result.rows[0];
  }

  private createVariation(current: number, previous: number) {
    const difference = current - previous;
    const percentage = previous
      ? Number(((difference / previous) * 100).toFixed(1))
      : current
        ? 100
        : 0;
    return {
      actual: current,
      anterior: previous,
      diferencia: Number(difference.toFixed(4)),
      porcentaje: percentage,
      direccion:
        Math.abs(percentage) < 1
          ? 'estable'
          : percentage > 0
            ? 'sube'
            : 'baja',
    };
  }

  private createComparison(
    current: ResultadoResumen,
    previous: ResultadoResumen,
    facets: FacetasDashboard,
    previousFacets: FacetasDashboard,
    previousStart: Date,
    previousEnd: Date,
  ) {
    const previousCategories = new Map(
      previousFacets.categorias.map((item) => [item.categoria, item.total]),
    );
    const previousZones = new Map(
      previousFacets.zonas.map((item) => [item.codigo_zona, item]),
    );
    return {
      disponible: previous.total_alertas > 0,
      periodo_anterior: {
        inicio: previousStart.toISOString(),
        fin: previousEnd.toISOString(),
      },
      tendencia_anterior: previousFacets.tendencia.map((item, index) => ({
        indice: index,
        fecha: item.fecha,
        total: item.total,
        criticas: item.criticas,
      })),
      metricas: {
        total_alertas: this.createVariation(
          current.total_alertas,
          previous.total_alertas,
        ),
        alertas_criticas: this.createVariation(
          current.alertas_criticas,
          previous.alertas_criticas,
        ),
        mediana_respuesta_segundos: this.createVariation(
          current.mediana_respuesta_segundos ?? 0,
          previous.mediana_respuesta_segundos ?? 0,
        ),
        cumplimiento_sla: this.createVariation(
          current.cumplimiento_sla,
          previous.cumplimiento_sla,
        ),
        escaladas_emergencia: this.createVariation(
          current.escaladas_emergencia,
          previous.escaladas_emergencia,
        ),
      },
      categorias: facets.categorias.map((item) => ({
        categoria: item.categoria,
        ...this.createVariation(
          item.total,
          previousCategories.get(item.categoria) ?? 0,
        ),
      })),
      zonas: facets.zonas.map((item) => {
        const previousZone = previousZones.get(item.codigo_zona);
        return {
          codigo: item.codigo_zona,
          alertas: this.createVariation(item.total, previousZone?.total ?? 0),
          criticas: this.createVariation(
            item.criticas,
            previousZone?.criticas ?? 0,
          ),
          respuesta: this.createVariation(
            item.mediana_respuesta_segundos ?? 0,
            previousZone?.mediana_respuesta_segundos ?? 0,
          ),
        };
      }),
    };
  }

  private createFindings(
    current: ResultadoResumen,
    previous: ResultadoResumen,
    facets: FacetasDashboard,
    previousFacets: FacetasDashboard,
    zones: PostgresZone[],
  ) {
    const findings: Array<Record<string, unknown> & { orden: number }> = [];
    const zoneNames = new Map(zones.map((zone) => [zone.codigo, zone.nombre]));
    const previousCategories = new Map(
      previousFacets.categorias.map((item) => [item.categoria, item.total]),
    );
    const risingCategory = facets.categorias
      .map((item) => ({
        ...item,
        variacion: this.createVariation(
          item.total,
          previousCategories.get(item.categoria) ?? 0,
        ),
      }))
      .filter(
        (item) =>
          item.variacion.anterior >= 30 &&
          item.total >= 30 &&
          item.variacion.porcentaje >= 12,
      )
      .sort((left, right) =>
        right.variacion.porcentaje - left.variacion.porcentaje)[0];
    if (risingCategory) {
      findings.push({
        id: `categoria-${risingCategory.categoria}`,
        tipo: 'variacion',
        nivel: risingCategory.variacion.porcentaje >= 30 ? 'alto' : 'medio',
        orden: risingCategory.variacion.porcentaje >= 30 ? 1 : 3,
        titulo: `La categoría ${this.categoryLabel(risingCategory.categoria)} aumenta ${risingCategory.variacion.porcentaje}%`,
        descripcion: `Registra ${risingCategory.total} alertas frente a ${risingCategory.variacion.anterior} en el período anterior equivalente.`,
        evidencia: risingCategory.variacion,
        filtros: { categoria: risingCategory.categoria },
      });
    }
    const previousZones = new Map(
      previousFacets.zonas.map((item) => [item.codigo_zona, item.total]),
    );
    const risingZone = facets.zonas
      .map((item) => ({
        ...item,
        variacion: this.createVariation(
          item.total,
          previousZones.get(item.codigo_zona) ?? 0,
        ),
      }))
      .filter(
        (item) =>
          item.variacion.anterior >= 5 && item.variacion.porcentaje >= 18,
      )
      .sort((left, right) =>
        right.variacion.porcentaje - left.variacion.porcentaje)[0];
    if (risingZone) {
      findings.push({
        id: `zona-${risingZone.codigo_zona}`,
        tipo: 'territorial',
        nivel: risingZone.variacion.porcentaje >= 35 ? 'alto' : 'medio',
        orden: risingZone.variacion.porcentaje >= 35 ? 1 : 3,
        titulo: `${zoneNames.get(risingZone.codigo_zona) ?? risingZone.codigo_zona} concentra el mayor aumento`,
        descripcion: `${risingZone.total} alertas, ${risingZone.variacion.porcentaje}% más que en el período anterior.`,
        evidencia: risingZone.variacion,
        filtros: { zona: risingZone.codigo_zona },
      });
    }
    const responseCurrent = current.mediana_respuesta_segundos ?? 0;
    const responsePrevious = previous.mediana_respuesta_segundos ?? 0;
    const responseVariation = this.createVariation(
      responseCurrent,
      responsePrevious,
    );
    if (responsePrevious && Math.abs(responseVariation.porcentaje) >= 12) {
      const worsens = responseVariation.porcentaje > 0;
      findings.push({
        id: 'respuesta-operacional',
        tipo: 'respuesta',
        nivel: worsens ? 'alto' : 'positivo',
        orden: worsens ? 1 : 4,
        titulo: worsens
          ? `La respuesta mediana sube a ${responseCurrent} segundos`
          : `La respuesta mediana mejora ${Math.abs(responseVariation.porcentaje)}%`,
        descripcion: `El período anterior registró una mediana de ${responsePrevious} segundos.`,
        evidencia: responseVariation,
        filtros: {},
      });
    }
    const atypicalZone = facets.zonas
      .filter(
        (item) =>
          (item.mediana_respuesta_segundos ?? 0) >= 120 &&
          (item.mediana_respuesta_segundos ?? 0) >= responseCurrent * 1.5,
      )
      .sort(
        (left, right) =>
          (right.mediana_respuesta_segundos ?? 0) -
          (left.mediana_respuesta_segundos ?? 0),
      )[0];
    if (atypicalZone) {
      const response = atypicalZone.mediana_respuesta_segundos ?? 0;
      const factor = responseCurrent
        ? Number((response / responseCurrent).toFixed(1))
        : 0;
      findings.push({
        id: `respuesta-${atypicalZone.codigo_zona}`,
        tipo: 'respuesta',
        nivel: 'alto',
        orden: 1,
        titulo: `${zoneNames.get(atypicalZone.codigo_zona) ?? atypicalZone.codigo_zona} presenta presión operacional`,
        descripcion: `Su respuesta mediana alcanza ${response} segundos, ${factor} veces la mediana comunal.`,
        evidencia: { actual: response, referencia: responseCurrent, factor },
        filtros: { zona: atypicalZone.codigo_zona },
      });
    }
    const volumeVariation = this.createVariation(
      current.total_alertas,
      previous.total_alertas,
    );
    if (
      previous.total_alertas >= 10 &&
      Math.abs(volumeVariation.porcentaje) >= 3
    ) {
      const decreases = volumeVariation.porcentaje < 0;
      findings.push({
        id: 'volumen-comunal',
        tipo: 'variacion',
        nivel: decreases ? 'positivo' : 'medio',
        orden: decreases ? 4 : 2,
        titulo: `El volumen comunal ${decreases ? 'disminuye' : 'aumenta'} ${Math.abs(volumeVariation.porcentaje)}%`,
        descripcion: `${current.total_alertas} alertas frente a ${previous.total_alertas} en el período anterior equivalente.`,
        evidencia: volumeVariation,
        filtros: {},
      });
    }
    const security = facets.seguridadNocturna[0];
    const nightRatio = security?.total ? security.nocturnas / security.total : 0;
    if ((security?.total ?? 0) >= 10 && nightRatio >= 0.55) {
      findings.push({
        id: 'seguridad-nocturna',
        tipo: 'patron',
        nivel: 'alto',
        orden: 1,
        titulo: `${Math.round(nightRatio * 100)}% de la seguridad en A-12 y A-13 ocurre de noche`,
        descripcion: `${security.nocturnas} de ${security.total} eventos se concentran entre las 20:00 y las 03:59.`,
        evidencia: {
          actual: Number((nightRatio * 100).toFixed(1)),
          unidad: 'porcentaje_nocturno',
        },
        filtros: { categoria: 'seguridad' },
      });
    }
    const reviewSummary = facets.revisionCategorias.reduce(
      (accumulator, item) => {
        const group = ['incendio', 'accidente'].includes(item.categoria)
          ? accumulator.dificiles
          : accumulator.regulares;
        group.total += item.total;
        group.revisiones += item.revisiones;
        return accumulator;
      },
      {
        dificiles: { total: 0, revisiones: 0 },
        regulares: { total: 0, revisiones: 0 },
      },
    );
    const difficultRate = reviewSummary.dificiles.total
      ? reviewSummary.dificiles.revisiones / reviewSummary.dificiles.total
      : 0;
    const regularRate = reviewSummary.regulares.total
      ? reviewSummary.regulares.revisiones / reviewSummary.regulares.total
      : 0;
    const reviewGap = (difficultRate - regularRate) * 100;
    if (reviewGap >= 20) {
      findings.push({
        id: 'revision-clasificacion',
        tipo: 'modelo',
        nivel: 'medio',
        orden: 2,
        titulo: `Incendios y accidentes requieren ${reviewGap.toFixed(0)} puntos más de revisión`,
        descripcion: `La tasa de revisión es ${Math.round(difficultRate * 100)}% frente a ${Math.round(regularRate * 100)}% en las demás categorías.`,
        evidencia: {
          actual: Number((difficultRate * 100).toFixed(1)),
          referencia: Number((regularRate * 100).toFixed(1)),
          diferencia: Number(reviewGap.toFixed(1)),
        },
        filtros: { requiereRevision: true },
      });
    }
    const care = facets.zonasCategoriasDetalle.reduce(
      (accumulator, item) => {
        const group = ['A-3', 'A-5'].includes(item.codigo_zona)
          ? accumulator.objetivo
          : accumulator.resto;
        group.total += item.total;
        if (item.categoria === 'asistencia_cuidador') group.cuidado += item.total;
        return accumulator;
      },
      {
        objetivo: { total: 0, cuidado: 0 },
        resto: { total: 0, cuidado: 0 },
      },
    );
    const targetRate = care.objetivo.total
      ? care.objetivo.cuidado / care.objetivo.total
      : 0;
    const otherRate = care.resto.total
      ? care.resto.cuidado / care.resto.total
      : 0;
    const careGap = (targetRate - otherRate) * 100;
    if (careGap >= 8) {
      findings.push({
        id: 'red-cuidado',
        tipo: 'cuidado',
        nivel: 'medio',
        orden: 3,
        titulo: 'A-3 y A-5 concentran demanda de cuidado',
        descripcion: `${Math.round(targetRate * 100)}% de sus alertas corresponde a cuidadores, ${careGap.toFixed(1)} puntos sobre el resto de la comuna.`,
        evidencia: {
          actual: Number((targetRate * 100).toFixed(1)),
          referencia: Number((otherRate * 100).toFixed(1)),
          diferencia: Number(careGap.toFixed(1)),
        },
        filtros: { categoria: 'asistencia_cuidador' },
      });
    }
    return findings
      .sort((left, right) => left.orden - right.orden)
      .slice(0, 5)
      .map(({ orden: _order, ...finding }) => finding);
  }

  private emptySummary(): ResultadoResumen {
    return {
      total_alertas: 0,
      alertas_criticas: 0,
      mediana_respuesta_segundos: 0,
      p90_respuesta_segundos: 0,
      cumplimiento_sla: 0,
      porcentaje_reloj: 0,
      porcentaje_automatico: 0,
      escaladas_emergencia: 0,
    };
  }

  private categoryLabel(category: string) {
    const labels: Record<string, string> = {
      medica: 'Médica',
      seguridad: 'Seguridad',
      incendio: 'Incendio',
      accidente: 'Accidente',
      asistencia_cuidador: 'Asistencia a cuidadores',
      asistencia_comunitaria: 'Asistencia comunitaria',
    };
    return labels[category] ?? category;
  }
}
