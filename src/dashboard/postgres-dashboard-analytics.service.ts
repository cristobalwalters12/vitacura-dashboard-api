import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../postgres/postgres.service';
import { DashboardAnalyticsReader } from './dashboard-readers';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import {
  buildPostgresAlertFilter,
  getCutoffDate,
  getMunicipalityId,
  getPostgresSchema,
  summarizeFilters,
} from './postgres-dashboard.utils';

@Injectable()
export class PostgresDashboardAnalyticsService
  implements DashboardAnalyticsReader
{
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

  async obtenerAnalitica(filtros: DashboardQueryDto) {
    const filter = buildPostgresAlertFilter(this.config, filtros);
    const zone = filtros.zona ?? null;
    const [
      aiSummaryResult,
      aiCategoriesResult,
      confidenceResult,
      operationSummaryResult,
      operationZonesResult,
      respondersResult,
      outcomesResult,
      notificationsResult,
      careHourlyResult,
      vulnerabilityResult,
      careSummaryResult,
      dependenceResult,
      risksResult,
      careDevicesResult,
    ] = await Promise.all([
      this.postgres.query<any>(
        `SELECT count(*)::int AS total,
                COALESCE(round(avg(confianza)::numeric, 4), 0)::float8 AS confianza_media,
                count(*) FILTER (WHERE requiere_revision_humana)::int AS revisiones,
                count(*) FILTER (WHERE confianza < 0.78)::int AS baja_confianza,
                COALESCE(round(
                  count(*) FILTER (WHERE requiere_revision_humana)::numeric /
                  NULLIF(count(*), 0), 4), 0)::float8 AS tasa_revision,
                COALESCE(round(
                  count(*) FILTER (WHERE requiere_revision_humana = false)::numeric /
                  NULLIF(count(*), 0), 4), 0)::float8 AS tasa_automatica,
                COALESCE(round(
                  count(*) FILTER (WHERE confianza < 0.78)::numeric /
                  NULLIF(count(*), 0), 4), 0)::float8 AS tasa_baja_confianza,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY latencia_modelo_ms))::int AS latencia_mediana_ms,
                round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY latencia_modelo_ms))::int AS latencia_p90_ms
           FROM ${this.schema}.alertas a WHERE ${filter.where}`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT categoria, count(*)::int AS total,
                round(avg(confianza)::numeric, 4)::float8 AS confianza_media,
                round(
                  count(*) FILTER (WHERE requiere_revision_humana)::numeric /
                  count(*), 4)::float8 AS tasa_revision,
                round(
                  count(*) FILTER (WHERE confianza < 0.78)::numeric /
                  count(*), 4)::float8 AS tasa_baja_confianza
           FROM ${this.schema}.alertas a WHERE ${filter.where}
          GROUP BY categoria ORDER BY tasa_revision DESC`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT desde, count(*)::int AS total
           FROM (
             SELECT CASE
               WHEN confianza < 0.60 THEN 0.0
               WHEN confianza < 0.70 THEN 0.6
               WHEN confianza < 0.78 THEN 0.7
               WHEN confianza < 0.85 THEN 0.78
               WHEN confianza < 0.92 THEN 0.85
               WHEN confianza < 1.01 THEN 0.92
               ELSE 1.01
             END::float8 AS desde
             FROM ${this.schema}.alertas a WHERE ${filter.where}
           ) buckets
          GROUP BY desde ORDER BY desde`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT count(*)::int AS total,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_clasificacion))::int AS mediana_clasificacion,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int AS mediana_confirmacion,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_despacho))::int AS mediana_despacho,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_llegada))::int AS mediana_llegada,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_resolucion))::int AS mediana_resolucion,
                round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY segundos_clasificacion))::int AS p90_clasificacion,
                round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int AS p90_confirmacion,
                round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY segundos_despacho))::int AS p90_despacho,
                round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY segundos_llegada))::int AS p90_llegada,
                round(percentile_cont(0.9) WITHIN GROUP
                  (ORDER BY segundos_resolucion))::int AS p90_resolucion
           FROM ${this.schema}.alertas a WHERE ${filter.where}`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT codigo_zona AS codigo, count(*)::int AS total,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int AS primera_respuesta,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_llegada))::int AS llegada,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_resolucion))::int AS resolucion,
                round(
                  count(*) FILTER (WHERE segundos_primera_respuesta <= 300)::numeric /
                  count(*), 4)::float8 AS cumplimiento_sla
           FROM ${this.schema}.alertas a WHERE ${filter.where}
          GROUP BY codigo_zona ORDER BY llegada DESC`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT tipo_respondedor AS tipo, count(*)::int AS total,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_llegada))::int AS llegada_mediana
           FROM ${this.schema}.alertas a WHERE ${filter.where}
          GROUP BY tipo_respondedor ORDER BY total DESC`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT resultado, count(*)::int AS total
           FROM ${this.schema}.alertas a WHERE ${filter.where}
          GROUP BY resultado ORDER BY total DESC`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT COALESCE(sum(usuarios_notificados), 0)::int AS usuarios_notificados,
                COALESCE(sum(notificaciones_entregadas), 0)::int AS entregadas,
                COALESCE(sum(notificaciones_confirmadas), 0)::int AS confirmadas,
                COALESCE(round(
                  sum(notificaciones_entregadas)::numeric /
                  NULLIF(sum(usuarios_notificados), 0), 4), 0)::float8 AS tasa_entrega,
                COALESCE(round(
                  sum(notificaciones_confirmadas)::numeric /
                  NULLIF(sum(notificaciones_entregadas), 0), 4), 0)::float8 AS tasa_confirmacion
           FROM ${this.schema}.alertas a WHERE ${filter.where}`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT extract(hour FROM creado_en AT TIME ZONE 'UTC')::int AS hora,
                count(*)::int AS total,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int AS respuesta_mediana
           FROM ${this.schema}.alertas a
          WHERE ${filter.where} AND categoria = 'asistencia_cuidador'
          GROUP BY hora ORDER BY hora`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT nivel_vulnerabilidad AS nivel, count(*)::int AS total,
                round(percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY segundos_primera_respuesta))::int AS respuesta_mediana,
                round(
                  count(*) FILTER (WHERE escalada_centro_emergencia)::numeric /
                  count(*), 4)::float8 AS tasa_escalada
           FROM ${this.schema}.alertas a WHERE ${filter.where}
          GROUP BY nivel_vulnerabilidad ORDER BY total DESC`,
        filter.values,
      ),
      this.postgres.query<any>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE p.nivel_dependencia = 'severa')::int AS dependencia_severa,
                count(*) FILTER (WHERE p.vive_solo)::int AS vive_solo,
                count(*) FILTER (WHERE p.movilidad = 'asistida')::int AS movilidad_asistida
           FROM ${this.schema}.perfiles_cuidado p
           JOIN ${this.schema}.usuarios u ON u.id = p.usuario_id
           LEFT JOIN ${this.schema}.zonas z ON z.id = u.zona_hogar_id
          WHERE p.municipalidad_id = $1 AND p.activo = true
            AND ($2::text IS NULL OR z.codigo = $2)`,
        [this.municipalityId, zone],
      ),
      this.postgres.query<any>(
        `SELECT p.nivel_dependencia AS nivel, count(*)::int AS total
           FROM ${this.schema}.perfiles_cuidado p
           JOIN ${this.schema}.usuarios u ON u.id = p.usuario_id
           LEFT JOIN ${this.schema}.zonas z ON z.id = u.zona_hogar_id
          WHERE p.municipalidad_id = $1 AND p.activo = true
            AND ($2::text IS NULL OR z.codigo = $2)
          GROUP BY p.nivel_dependencia ORDER BY total DESC`,
        [this.municipalityId, zone],
      ),
      this.postgres.query<any>(
        `SELECT risk.riesgo, count(*)::int AS total
           FROM ${this.schema}.perfiles_cuidado p
           JOIN ${this.schema}.usuarios u ON u.id = p.usuario_id
           LEFT JOIN ${this.schema}.zonas z ON z.id = u.zona_hogar_id
           CROSS JOIN LATERAL jsonb_array_elements(
             COALESCE(p.detalle #> '{perfil_cuidado,factores_riesgo}', '[]'::jsonb)
           ) outer_risk(value)
           CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(outer_risk.value) = 'array'
               THEN outer_risk.value ELSE jsonb_build_array(outer_risk.value) END
           ) risk(riesgo)
          WHERE p.municipalidad_id = $1 AND p.activo = true
            AND ($2::text IS NULL OR z.codigo = $2)
          GROUP BY risk.riesgo ORDER BY total DESC`,
        [this.municipalityId, zone],
      ),
      this.postgres.query<any>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE d.estado = 'activo')::int AS activos,
                count(*) FILTER (WHERE d.porcentaje_bateria <= 20)::int AS bateria_baja,
                count(*) FILTER (WHERE d.estado <> 'activo')::int AS sin_conexion
           FROM ${this.schema}.dispositivos d
           JOIN ${this.schema}.perfiles_cuidado p
             ON p.usuario_id = d.usuario_asignado_id AND p.activo = true
           JOIN ${this.schema}.usuarios u ON u.id = d.usuario_asignado_id
           LEFT JOIN ${this.schema}.zonas z ON z.id = u.zona_hogar_id
          WHERE d.municipalidad_id = $1
            AND ($2::text IS NULL OR z.codigo = $2)`,
        [this.municipalityId, zone],
      ),
    ]);

    const aiSummary = this.normalizeAiSummary(aiSummaryResult.rows[0]);
    const operationSummary = this.normalizeOperationSummary(
      operationSummaryResult.rows[0],
    );
    const careSummary = careSummaryResult.rows[0] ?? {
      total: 0,
      dependencia_severa: 0,
      vive_solo: 0,
      movilidad_asistida: 0,
    };
    const careDevices = careDevicesResult.rows[0] ?? {
      total: 0,
      activos: 0,
      bateria_baja: 0,
      sin_conexion: 0,
    };
    const operationZones = operationZonesResult.rows.map((item: any) => ({
      ...item,
      nombre: item.nombre ?? item.codigo,
    }));
    if (operationZones.length) {
      const names = await this.postgres.query<any>(
        `SELECT codigo, nombre FROM ${this.schema}.zonas
          WHERE municipalidad_id = $1`,
        [this.municipalityId],
      );
      const zoneNames = new Map(
        names.rows.map((item: any) => [item.codigo, item.nombre]),
      );
      for (const item of operationZones) {
        item.nombre = zoneNames.get(item.codigo) ?? item.codigo;
      }
    }
    const aiCategories = aiCategoriesResult.rows;
    const careHourly = careHourlyResult.rows;

    return {
      metadata: {
        fecha_corte: this.cutoffDate.toISOString(),
        periodo: {
          inicio: filter.desde.toISOString(),
          fin: filter.hasta.toISOString(),
        },
        filtros_aplicados: summarizeFilters(filtros),
        sintetico: true,
      },
      ia: {
        salud: {
          puntaje: this.calculateAiHealth(aiSummary),
          estado: this.aiHealthLabel(aiSummary),
        },
        resumen: aiSummary,
        categorias: aiCategories,
        distribucion_confianza: confidenceResult.rows,
      },
      respuesta: {
        resumen: operationSummary,
        etapas: this.buildStages(operationSummary),
        zonas: operationZones,
        respondedores: respondersResult.rows,
        resultados: outcomesResult.rows,
        notificaciones: notificationsResult.rows[0],
      },
      cuidado: {
        resumen: careSummary,
        dependencia: dependenceResult.rows,
        riesgos: risksResult.rows,
        dispositivos: careDevices,
        demanda_horaria: careHourly,
        vulnerabilidad_respuesta: vulnerabilityResult.rows,
      },
      hallazgos: this.buildFindings({
        aiSummary,
        aiCategories,
        operationSummary,
        operationZones,
        careSummary,
        careDevices,
        careHourly,
      }),
    };
  }

  private normalizeAiSummary(value: Record<string, number | null>) {
    const empty = {
      total: 0,
      confianza_media: 0,
      revisiones: 0,
      baja_confianza: 0,
      tasa_revision: 0,
      tasa_automatica: 0,
      tasa_baja_confianza: 0,
      latencia_mediana_ms: 0,
      latencia_p90_ms: 0,
    };
    return Object.fromEntries(
      Object.entries(empty).map(([key, fallback]) => [
        key,
        value?.[key] ?? fallback,
      ]),
    ) as Record<string, number>;
  }

  private normalizeOperationSummary(value: Record<string, number | null>) {
    const empty = {
      total: 0,
      mediana_clasificacion: 0,
      mediana_confirmacion: 0,
      mediana_despacho: 0,
      mediana_llegada: 0,
      mediana_resolucion: 0,
      p90_clasificacion: 0,
      p90_confirmacion: 0,
      p90_despacho: 0,
      p90_llegada: 0,
      p90_resolucion: 0,
    };
    return Object.fromEntries(
      Object.entries(empty).map(([key, fallback]) => [
        key,
        value?.[key] ?? fallback,
      ]),
    ) as Record<string, number>;
  }

  private buildStages(summary: Record<string, number>) {
    return [
      ['clasificacion', 'Clasificación', 'mediana_clasificacion', 'p90_clasificacion'],
      ['confirmacion', 'Primera confirmación', 'mediana_confirmacion', 'p90_confirmacion'],
      ['despacho', 'Despacho', 'mediana_despacho', 'p90_despacho'],
      ['llegada', 'Llegada', 'mediana_llegada', 'p90_llegada'],
      ['resolucion', 'Resolución', 'mediana_resolucion', 'p90_resolucion'],
    ].map(([id, name, medianKey, p90Key]) => ({
      id,
      nombre: name,
      mediana_segundos: summary[medianKey] ?? 0,
      p90_segundos: summary[p90Key] ?? 0,
    }));
  }

  private buildFindings(context: any) {
    const findings: Array<Record<string, unknown>> = [];
    const reviewCategory = [...context.aiCategories].sort(
      (left, right) => right.tasa_revision - left.tasa_revision,
    )[0];
    if (reviewCategory?.tasa_revision >= 0.35) {
      findings.push({
        id: 'ia-revision-categoria',
        tipo: 'modelo',
        nivel: 'medio',
        titulo: `${this.categoryLabel(reviewCategory.categoria)} concentra revisión humana`,
        descripcion: `${Math.round(reviewCategory.tasa_revision * 100)}% de sus casos requiere validación; confianza media ${Math.round(reviewCategory.confianza_media * 100)}%.`,
        filtros: { categoria: reviewCategory.categoria },
      });
    }
    const slowZone = context.operationZones[0];
    if (
      slowZone &&
      slowZone.llegada >= context.operationSummary.mediana_llegada * 1.35
    ) {
      findings.push({
        id: 'operacion-cuello-botella',
        tipo: 'respuesta',
        nivel: 'alto',
        titulo: `${slowZone.nombre} presenta la llegada más lenta`,
        descripcion: `Mediana de ${this.formatDuration(slowZone.llegada)}, frente a ${this.formatDuration(context.operationSummary.mediana_llegada)} para la comuna.`,
        filtros: { zona: slowZone.codigo },
      });
    }
    const peakCare = [...context.careHourly].sort(
      (left, right) => right.total - left.total,
    )[0];
    if (peakCare) {
      findings.push({
        id: 'cuidado-hora-punta',
        tipo: 'cuidado',
        nivel: 'medio',
        titulo: `La demanda de cuidado alcanza su máximo a las ${String(peakCare.hora).padStart(2, '0')}:00`,
        descripcion: `${peakCare.total} solicitudes en la hora de mayor actividad del período seleccionado.`,
        filtros: { categoria: 'asistencia_cuidador' },
      });
    }
    if (context.careDevices.bateria_baja > 0) {
      findings.push({
        id: 'cuidado-bateria',
        tipo: 'cuidado',
        nivel: 'medio',
        titulo: `${context.careDevices.bateria_baja} dispositivos de cuidado tienen batería baja`,
        descripcion: `${context.careDevices.sin_conexion} dispositivos asociados a perfiles de cuidado se encuentran sin conexión.`,
        filtros: { categoria: 'asistencia_cuidador' },
      });
    }
    return findings.slice(0, 4);
  }

  private calculateAiHealth(summary: Record<string, number>) {
    if (!summary.total) return 0;
    const confidence = (summary.confianza_media ?? 0) * 50;
    const automation = (summary.tasa_automatica ?? 0) * 30;
    const latency =
      Math.max(0, 1 - (summary.latencia_mediana_ms ?? 1500) / 1500) * 20;
    return Math.round(confidence + automation + latency);
  }

  private aiHealthLabel(summary: Record<string, number>) {
    const score = this.calculateAiHealth(summary);
    return score >= 80
      ? 'saludable'
      : score >= 65
        ? 'en_observacion'
        : 'requiere_atencion';
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

  private formatDuration(seconds: number) {
    if (seconds < 60) return `${Math.round(seconds)} s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} h`;
  }
}
