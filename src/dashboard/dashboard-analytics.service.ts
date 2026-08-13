import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Alerta } from '../database/schemas/alerta.schema';
import { Dispositivo } from '../database/schemas/dispositivo.schema';
import { PerfilCuidado } from '../database/schemas/perfil-cuidado.schema';
import { Zona } from '../database/schemas/zona.schema';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

const DAY_MS = 86_400_000;

@Injectable()
export class DashboardAnalyticsService {
  private readonly municipalityId: Types.ObjectId;
  private readonly cutoffDate: Date;

  constructor(
    @InjectModel(Alerta.name)
    private readonly alertModel: Model<Alerta>,
    @InjectModel(Zona.name)
    private readonly zoneModel: Model<Zona>,
    @InjectModel(PerfilCuidado.name)
    private readonly careProfileModel: Model<PerfilCuidado>,
    @InjectModel(Dispositivo.name)
    private readonly deviceModel: Model<Dispositivo>,
    private readonly config: ConfigService,
  ) {
    const municipality = this.config.get<string>(
      'MUNICIPALIDAD_ID',
      '64f000000000000000000132',
    );
    if (!Types.ObjectId.isValid(municipality)) {
      throw new Error('MUNICIPALIDAD_ID no es un ObjectId válido');
    }
    this.municipalityId = new Types.ObjectId(municipality);
    this.cutoffDate = new Date(
      this.config.get<string>(
        'ANALYTICS_CUTOFF_DATE',
        '2026-08-15T23:59:59.999Z',
      ),
    );
    if (!Number.isFinite(this.cutoffDate.getTime())) {
      throw new Error('ANALYTICS_CUTOFF_DATE no es una fecha válida');
    }
  }

  async obtenerAnalitica(filtros: DashboardQueryDto) {
    const { match, desde, hasta } = this.buildAlertFilter(filtros);
    const selectedZone = filtros.zona
      ? await this.zoneModel
          .findOne({
            id_municipalidad: this.municipalityId,
            codigo: filtros.zona,
          })
          .select({ _id: 1 })
          .lean()
          .exec()
      : null;
    const zoneId = selectedZone?._id as Types.ObjectId | undefined;

    const [alertResult, careResult, deviceResult, zones] = await Promise.all([
      this.alertModel
        .aggregate(this.buildAlertAnalyticsPipeline(match))
        .allowDiskUse(true)
        .exec(),
      this.careProfileModel
        .aggregate(this.buildCarePipeline(zoneId))
        .allowDiskUse(true)
        .exec(),
      this.deviceModel
        .aggregate(this.buildCareDevicePipeline(zoneId))
        .allowDiskUse(true)
        .exec(),
      this.zoneModel
        .find({ id_municipalidad: this.municipalityId })
        .select({ _id: 0, codigo: 1, nombre: 1 })
        .lean()
        .exec() as unknown as Promise<Array<{ codigo: string; nombre: string }>>,
    ]);

    const facets = alertResult[0] ?? {};
    const aiSummary = facets.iaResumen?.[0] ?? this.emptyAiSummary();
    const operationSummary =
      facets.operacionResumen?.[0] ?? this.emptyOperationSummary();
    const notificationSummary = facets.notificaciones?.[0] ?? {
      usuarios_notificados: 0,
      entregadas: 0,
      confirmadas: 0,
      tasa_entrega: 0,
      tasa_confirmacion: 0,
    };
    const careFacets = careResult[0] ?? {};
    const careSummary = careFacets.resumen?.[0] ?? {
      total: 0,
      dependencia_severa: 0,
      vive_solo: 0,
      movilidad_asistida: 0,
    };
    const careDevices = deviceResult[0] ?? {
      total: 0,
      activos: 0,
      bateria_baja: 0,
      sin_conexion: 0,
    };
    const zoneNames = new Map(zones.map((zone) => [zone.codigo, zone.nombre]));
    const operationZones = (facets.operacionZonas ?? []).map((item: any) => ({
      codigo: item.codigo,
      nombre: zoneNames.get(item.codigo) ?? item.codigo,
      total: item.total,
      primera_respuesta: item.primera_respuesta,
      llegada: item.llegada,
      resolucion: item.resolucion,
      cumplimiento_sla: item.cumplimiento_sla,
    }));
    const stages = this.buildStages(operationSummary);
    const aiCategories = (facets.iaCategorias ?? []).map((item: any) => ({
      categoria: item.categoria,
      total: item.total,
      confianza_media: item.confianza_media,
      tasa_revision: item.tasa_revision,
      tasa_baja_confianza: item.tasa_baja_confianza,
    }));
    const careHourly = facets.cuidadoHorario ?? [];
    const findings = this.buildFindings({
      aiSummary,
      aiCategories,
      operationSummary,
      operationZones,
      careSummary,
      careDevices,
      careHourly,
    });

    return {
      metadata: {
        fecha_corte: this.cutoffDate.toISOString(),
        periodo: { inicio: desde.toISOString(), fin: hasta.toISOString() },
        filtros_aplicados: this.summarizeFilters(filtros),
        sintetico: true,
      },
      ia: {
        salud: {
          puntaje: this.calculateAiHealth(aiSummary),
          estado: this.aiHealthLabel(aiSummary),
        },
        resumen: aiSummary,
        categorias: aiCategories,
        distribucion_confianza: facets.confianza ?? [],
      },
      respuesta: {
        resumen: operationSummary,
        etapas: stages,
        zonas: operationZones,
        respondedores: facets.respondedores ?? [],
        resultados: facets.resultados ?? [],
        notificaciones: notificationSummary,
      },
      cuidado: {
        resumen: careSummary,
        dependencia: careFacets.dependencia ?? [],
        riesgos: careFacets.riesgos ?? [],
        dispositivos: careDevices,
        demanda_horaria: careHourly,
        vulnerabilidad_respuesta: facets.vulnerabilidad ?? [],
      },
      hallazgos: findings,
    };
  }

  private buildAlertFilter(filtros: DashboardQueryDto) {
    const requestedEnd = filtros.hasta
      ? new Date(filtros.hasta)
      : new Date(this.cutoffDate);
    const hasta = new Date(
      Math.min(requestedEnd.getTime(), this.cutoffDate.getTime()),
    );
    const desde = filtros.desde
      ? new Date(filtros.desde)
      : new Date(hasta.getTime() - filtros.dias * DAY_MS);
    if (desde >= hasta) {
      throw new BadRequestException('desde debe ser anterior a hasta');
    }
    const match: Record<string, unknown> = {
      id_municipalidad: this.municipalityId,
      creado_en: { $gte: desde, $lte: hasta },
    };
    if (filtros.categoria && filtros.categoria !== 'todas') {
      match['clasificacion.categoria'] = filtros.categoria;
    }
    if (filtros.zona) {
      match['ubicacion.referencia_ubicacion.codigo_zona'] = filtros.zona;
    }
    this.addMultipleFilter(match, 'prioridad.nivel', filtros.prioridad);
    this.addMultipleFilter(
      match,
      'clasificacion.severidad',
      filtros.severidad,
    );
    this.addMultipleFilter(match, 'origen.canal', filtros.canal);
    if (filtros.requiere_revision !== undefined) {
      match['clasificacion.requiere_revision_humana'] =
        filtros.requiere_revision === 'true';
    }
    if (filtros.escalada !== undefined) {
      match['resumen_respuesta.escalada_centro_emergencia'] =
        filtros.escalada === 'true';
    }
    return { match, desde, hasta };
  }

  private buildAlertAnalyticsPipeline(
    match: Record<string, unknown>,
  ): PipelineStage[] {
    return [
      { $match: match },
      {
        $facet: {
          iaResumen: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                confianza_media: { $avg: '$clasificacion.confianza' },
                revisiones: {
                  $sum: {
                    $cond: [
                      '$clasificacion.requiere_revision_humana',
                      1,
                      0,
                    ],
                  },
                },
                baja_confianza: {
                  $sum: {
                    $cond: [
                      { $lt: ['$clasificacion.confianza', 0.78] },
                      1,
                      0,
                    ],
                  },
                },
                latencia_mediana_ms: {
                  $median: {
                    input: '$clasificacion.latencia_ms',
                    method: 'approximate',
                  },
                },
                latencia_p90: {
                  $percentile: {
                    input: '$clasificacion.latencia_ms',
                    p: [0.9],
                    method: 'approximate',
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                total: 1,
                confianza_media: { $round: ['$confianza_media', 4] },
                revisiones: 1,
                baja_confianza: 1,
                tasa_revision: {
                  $round: [{ $divide: ['$revisiones', '$total'] }, 4],
                },
                tasa_automatica: {
                  $round: [
                    {
                      $divide: [
                        { $subtract: ['$total', '$revisiones'] },
                        '$total',
                      ],
                    },
                    4,
                  ],
                },
                tasa_baja_confianza: {
                  $round: [{ $divide: ['$baja_confianza', '$total'] }, 4],
                },
                latencia_mediana_ms: {
                  $round: ['$latencia_mediana_ms', 0],
                },
                latencia_p90_ms: {
                  $round: [{ $arrayElemAt: ['$latencia_p90', 0] }, 0],
                },
              },
            },
          ],
          iaCategorias: [
            {
              $group: {
                _id: '$clasificacion.categoria',
                total: { $sum: 1 },
                confianza_media: { $avg: '$clasificacion.confianza' },
                revisiones: {
                  $sum: {
                    $cond: [
                      '$clasificacion.requiere_revision_humana',
                      1,
                      0,
                    ],
                  },
                },
                baja_confianza: {
                  $sum: {
                    $cond: [
                      { $lt: ['$clasificacion.confianza', 0.78] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                categoria: '$_id',
                total: 1,
                confianza_media: { $round: ['$confianza_media', 4] },
                tasa_revision: {
                  $round: [{ $divide: ['$revisiones', '$total'] }, 4],
                },
                tasa_baja_confianza: {
                  $round: [{ $divide: ['$baja_confianza', '$total'] }, 4],
                },
              },
            },
            { $sort: { tasa_revision: -1 } },
          ],
          confianza: [
            {
              $bucket: {
                groupBy: '$clasificacion.confianza',
                boundaries: [0, 0.6, 0.7, 0.78, 0.85, 0.92, 1.01],
                default: 'fuera_rango',
                output: { total: { $sum: 1 } },
              },
            },
            { $project: { _id: 0, desde: '$_id', total: 1 } },
          ],
          operacionResumen: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                mediana_clasificacion: this.medianExpression(
                  '$resumen_respuesta.segundos_clasificacion',
                ),
                mediana_confirmacion: this.medianExpression(
                  '$resumen_respuesta.segundos_primera_respuesta',
                ),
                mediana_despacho: this.medianExpression(
                  '$resumen_respuesta.segundos_despacho',
                ),
                mediana_llegada: this.medianExpression(
                  '$resumen_respuesta.segundos_llegada',
                ),
                mediana_resolucion: this.medianExpression(
                  '$resumen_respuesta.segundos_resolucion',
                ),
                p90_clasificacion: this.percentileExpression(
                  '$resumen_respuesta.segundos_clasificacion',
                ),
                p90_confirmacion: this.percentileExpression(
                  '$resumen_respuesta.segundos_primera_respuesta',
                ),
                p90_despacho: this.percentileExpression(
                  '$resumen_respuesta.segundos_despacho',
                ),
                p90_llegada: this.percentileExpression(
                  '$resumen_respuesta.segundos_llegada',
                ),
                p90_resolucion: this.percentileExpression(
                  '$resumen_respuesta.segundos_resolucion',
                ),
              },
            },
            {
              $project: {
                _id: 0,
                total: 1,
                mediana_clasificacion: { $round: ['$mediana_clasificacion', 0] },
                mediana_confirmacion: { $round: ['$mediana_confirmacion', 0] },
                mediana_despacho: { $round: ['$mediana_despacho', 0] },
                mediana_llegada: { $round: ['$mediana_llegada', 0] },
                mediana_resolucion: { $round: ['$mediana_resolucion', 0] },
                p90_clasificacion: this.firstRounded('$p90_clasificacion'),
                p90_confirmacion: this.firstRounded('$p90_confirmacion'),
                p90_despacho: this.firstRounded('$p90_despacho'),
                p90_llegada: this.firstRounded('$p90_llegada'),
                p90_resolucion: this.firstRounded('$p90_resolucion'),
              },
            },
          ],
          operacionZonas: [
            {
              $group: {
                _id: '$ubicacion.referencia_ubicacion.codigo_zona',
                total: { $sum: 1 },
                primera_respuesta: this.medianExpression(
                  '$resumen_respuesta.segundos_primera_respuesta',
                ),
                llegada: this.medianExpression(
                  '$resumen_respuesta.segundos_llegada',
                ),
                resolucion: this.medianExpression(
                  '$resumen_respuesta.segundos_resolucion',
                ),
                dentro_sla: {
                  $sum: {
                    $cond: [
                      {
                        $lte: [
                          '$resumen_respuesta.segundos_primera_respuesta',
                          300,
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                codigo: '$_id',
                total: 1,
                primera_respuesta: { $round: ['$primera_respuesta', 0] },
                llegada: { $round: ['$llegada', 0] },
                resolucion: { $round: ['$resolucion', 0] },
                cumplimiento_sla: {
                  $round: [{ $divide: ['$dentro_sla', '$total'] }, 4],
                },
              },
            },
            { $sort: { llegada: -1 } },
          ],
          respondedores: [
            {
              $group: {
                _id: '$resumen_respuesta.tipo_respondedor',
                total: { $sum: 1 },
                llegada: this.medianExpression(
                  '$resumen_respuesta.segundos_llegada',
                ),
              },
            },
            {
              $project: {
                _id: 0,
                tipo: '$_id',
                total: 1,
                llegada_mediana: { $round: ['$llegada', 0] },
              },
            },
            { $sort: { total: -1 } },
          ],
          resultados: [
            { $group: { _id: '$resolucion.resultado', total: { $sum: 1 } } },
            { $project: { _id: 0, resultado: '$_id', total: 1 } },
            { $sort: { total: -1 } },
          ],
          notificaciones: [
            {
              $group: {
                _id: null,
                usuarios_notificados: {
                  $sum: '$resumen_notificaciones.usuarios_notificados',
                },
                entregadas: { $sum: '$resumen_notificaciones.entregadas' },
                confirmadas: { $sum: '$resumen_notificaciones.confirmadas' },
              },
            },
            {
              $project: {
                _id: 0,
                usuarios_notificados: 1,
                entregadas: 1,
                confirmadas: 1,
                tasa_entrega: {
                  $round: [
                    { $divide: ['$entregadas', '$usuarios_notificados'] },
                    4,
                  ],
                },
                tasa_confirmacion: {
                  $round: [
                    { $divide: ['$confirmadas', '$entregadas'] },
                    4,
                  ],
                },
              },
            },
          ],
          cuidadoHorario: [
            { $match: { 'clasificacion.categoria': 'asistencia_cuidador' } },
            {
              $group: {
                _id: { $hour: { date: '$creado_en', timezone: 'UTC' } },
                total: { $sum: 1 },
                respuesta: this.medianExpression(
                  '$resumen_respuesta.segundos_primera_respuesta',
                ),
              },
            },
            {
              $project: {
                _id: 0,
                hora: '$_id',
                total: 1,
                respuesta_mediana: { $round: ['$respuesta', 0] },
              },
            },
            { $sort: { hora: 1 } },
          ],
          vulnerabilidad: [
            {
              $group: {
                _id: '$persona_afectada.nivel_vulnerabilidad',
                total: { $sum: 1 },
                respuesta: this.medianExpression(
                  '$resumen_respuesta.segundos_primera_respuesta',
                ),
                escaladas: {
                  $sum: {
                    $cond: [
                      '$resumen_respuesta.escalada_centro_emergencia',
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                nivel: '$_id',
                total: 1,
                respuesta_mediana: { $round: ['$respuesta', 0] },
                tasa_escalada: {
                  $round: [{ $divide: ['$escaladas', '$total'] }, 4],
                },
              },
            },
            { $sort: { total: -1 } },
          ],
        },
      },
    ] as PipelineStage[];
  }

  private buildCarePipeline(zoneId?: Types.ObjectId): PipelineStage[] {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          id_municipalidad: this.municipalityId,
          activo: true,
        },
      },
      {
        $lookup: {
          from: 'usuarios',
          localField: 'id_usuario',
          foreignField: '_id',
          as: 'usuario',
        },
      },
      { $unwind: '$usuario' },
    ];
    if (zoneId) pipeline.push({ $match: { 'usuario.id_zona_hogar': zoneId } });
    pipeline.push({
      $facet: {
        resumen: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              dependencia_severa: {
                $sum: {
                  $cond: [
                    { $eq: ['$perfil_cuidado.nivel_dependencia', 'severa'] },
                    1,
                    0,
                  ],
                },
              },
              vive_solo: {
                $sum: { $cond: ['$perfil_cuidado.vive_solo', 1, 0] },
              },
              movilidad_asistida: {
                $sum: {
                  $cond: [
                    { $eq: ['$perfil_cuidado.movilidad', 'asistida'] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        dependencia: [
          {
            $group: {
              _id: '$perfil_cuidado.nivel_dependencia',
              total: { $sum: 1 },
            },
          },
          { $project: { _id: 0, nivel: '$_id', total: 1 } },
          { $sort: { total: -1 } },
        ],
        riesgos: [
          { $unwind: '$perfil_cuidado.factores_riesgo' },
          {
            $group: {
              _id: '$perfil_cuidado.factores_riesgo',
              total: { $sum: 1 },
            },
          },
          { $project: { _id: 0, riesgo: '$_id', total: 1 } },
          { $sort: { total: -1 } },
        ],
      },
    });
    return pipeline;
  }

  private buildCareDevicePipeline(zoneId?: Types.ObjectId): PipelineStage[] {
    const pipeline: PipelineStage[] = [
      { $match: { id_municipalidad: this.municipalityId } },
      {
        $lookup: {
          from: 'perfiles_cuidado',
          localField: 'id_usuario_asignado',
          foreignField: 'id_usuario',
          as: 'perfil',
        },
      },
      { $unwind: '$perfil' },
      { $match: { 'perfil.activo': true } },
      {
        $lookup: {
          from: 'usuarios',
          localField: 'id_usuario_asignado',
          foreignField: '_id',
          as: 'usuario',
        },
      },
      { $unwind: '$usuario' },
    ];
    if (zoneId) pipeline.push({ $match: { 'usuario.id_zona_hogar': zoneId } });
    pipeline.push(
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          activos: {
            $sum: { $cond: [{ $eq: ['$estado', 'activo'] }, 1, 0] },
          },
          bateria_baja: {
            $sum: {
              $cond: [
                {
                  $lte: [
                    '$ultimo_estado_conocido.porcentaje_bateria',
                    20,
                  ],
                },
                1,
                0,
              ],
            },
          },
          sin_conexion: {
            $sum: { $cond: [{ $ne: ['$estado', 'activo'] }, 1, 0] },
          },
        },
      },
      { $project: { _id: 0 } },
    );
    return pipeline;
  }

  private buildStages(summary: Record<string, number>) {
    return [
      ['clasificacion', 'Clasificación', 'mediana_clasificacion', 'p90_clasificacion'],
      ['confirmacion', 'Primera confirmación', 'mediana_confirmacion', 'p90_confirmacion'],
      ['despacho', 'Despacho', 'mediana_despacho', 'p90_despacho'],
      ['llegada', 'Llegada', 'mediana_llegada', 'p90_llegada'],
      ['resolucion', 'Resolución', 'mediana_resolucion', 'p90_resolucion'],
    ].map(([id, label, medianKey, p90Key]) => ({
      id,
      nombre: label,
      mediana_segundos: summary[medianKey] ?? 0,
      p90_segundos: summary[p90Key] ?? 0,
    }));
  }

  private buildFindings(context: any) {
    const findings: Array<Record<string, unknown>> = [];
    const reviewCategory = [...context.aiCategories].sort(
      (a, b) => b.tasa_revision - a.tasa_revision,
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
    const peakCare = [...context.careHourly].sort((a, b) => b.total - a.total)[0];
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
    const latency = Math.max(
      0,
      1 - (summary.latencia_mediana_ms ?? 1500) / 1500,
    ) * 20;
    return Math.round(confidence + automation + latency);
  }

  private aiHealthLabel(summary: Record<string, number>) {
    const score = this.calculateAiHealth(summary);
    return score >= 80 ? 'saludable' : score >= 65 ? 'en_observacion' : 'requiere_atencion';
  }

  private medianExpression(field: string) {
    return { $median: { input: field, method: 'approximate' } };
  }

  private percentileExpression(field: string) {
    return { $percentile: { input: field, p: [0.9], method: 'approximate' } };
  }

  private firstRounded(field: string) {
    return { $round: [{ $arrayElemAt: [field, 0] }, 0] };
  }

  private addMultipleFilter(
    match: Record<string, unknown>,
    field: string,
    value?: string,
  ) {
    if (!value) return;
    const values = value.split(',');
    match[field] = values.length === 1 ? values[0] : { $in: values };
  }

  private summarizeFilters(filtros: DashboardQueryDto) {
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

  private emptyAiSummary() {
    return {
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
  }

  private emptyOperationSummary() {
    return {
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
