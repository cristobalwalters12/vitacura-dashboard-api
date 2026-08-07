import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Alerta } from '../database/schemas/alerta.schema';
import { Dispositivo } from '../database/schemas/dispositivo.schema';
import { PerfilCuidado } from '../database/schemas/perfil-cuidado.schema';
import { Usuario } from '../database/schemas/usuario.schema';
import { Zona } from '../database/schemas/zona.schema';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MapaQueryDto } from './dto/mapa-query.dto';

export interface ResultadoResumen {
  total_alertas: number;
  alertas_criticas: number;
  mediana_respuesta_segundos: number | null;
  p90_respuesta_segundos: number | null;
  cumplimiento_sla: number;
  porcentaje_reloj: number;
  porcentaje_automatico: number;
  escaladas_emergencia: number;
}

export interface CategoriaAgregada {
  categoria: string;
  total: number;
}

export interface TendenciaAgregada {
  fecha: Date;
  total: number;
  criticas: number;
}

export interface ZonaAgregada {
  codigo_zona: string;
  total: number;
  criticas: number;
  mediana_respuesta_segundos: number | null;
  cumplimiento_sla: number;
}

export interface FacetasDashboard {
  resumen: ResultadoResumen[];
  categorias: CategoriaAgregada[];
  tendencia: TendenciaAgregada[];
  zonas: ZonaAgregada[];
}

export interface ZonaMongo {
  _id: Types.ObjectId;
  codigo: string;
  nombre: string;
  geometria: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown[];
  };
}

export interface AlertaMapa {
  id: string;
  codigo: string;
  coordenadas: [number, number];
  fecha: Date;
  categoria: string;
  tipo: string;
  severidad: string;
  confianza: number | null;
  requiere_revision: boolean;
  prioridad: string;
  puntaje_prioridad: number;
  canal: string;
  metodo: string;
  respuesta_segundos: number | null;
  escalada: boolean;
  zona: string;
  zona_nombre: string;
  calle: string;
  resultado: string | null;
}

@Injectable()
export class DashboardService {
  private readonly idMunicipalidad: Types.ObjectId;

  constructor(
    @InjectModel(Alerta.name)
    private readonly alertaModel: Model<Alerta>,
    @InjectModel(Zona.name)
    private readonly zonaModel: Model<Zona>,
    @InjectModel(Usuario.name)
    private readonly usuarioModel: Model<Usuario>,
    @InjectModel(Dispositivo.name)
    private readonly dispositivoModel: Model<Dispositivo>,
    @InjectModel(PerfilCuidado.name)
    private readonly perfilCuidadoModel: Model<PerfilCuidado>,
    private readonly config: ConfigService,
  ) {
    const value = this.config.get<string>(
      'MUNICIPALIDAD_ID',
      '64f000000000000000000132',
    );
    if (!Types.ObjectId.isValid(value)) {
      throw new Error('MUNICIPALIDAD_ID no es un ObjectId válido');
    }
    this.idMunicipalidad = new Types.ObjectId(value);
  }

  async obtenerResumen(filtros: DashboardQueryDto) {
    const { match, desde, hasta } = this.construirFiltro(filtros);
    const pipeline = this.crearPipelineResumen(match);

    const [
      resultadoFacetas,
      usuarios,
      usuariosActivos,
      dispositivos,
      dispositivosActivos,
      bateriaBaja,
      perfilesCuidado,
      dependenciaSevera,
      zonasMongo,
      usuariosPorZona,
    ] = await Promise.all([
      this.alertaModel
        .aggregate<FacetasDashboard>(pipeline)
        .allowDiskUse(true)
        .exec(),
      this.usuarioModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
      }),
      this.usuarioModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
        activo: true,
      }),
      this.dispositivoModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
      }),
      this.dispositivoModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
        estado: 'activo',
      }),
      this.dispositivoModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
        'ultimo_estado_conocido.porcentaje_bateria': { $lte: 20 },
      }),
      this.perfilCuidadoModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
        activo: true,
      }),
      this.perfilCuidadoModel.countDocuments({
        id_municipalidad: this.idMunicipalidad,
        activo: true,
        'perfil_cuidado.nivel_dependencia': 'severa',
      }),
      this.zonaModel
        .find({ id_municipalidad: this.idMunicipalidad })
        .select({ codigo: 1, nombre: 1, geometria: 1 })
        .lean()
        .exec() as unknown as Promise<ZonaMongo[]>,
      this.usuarioModel
        .aggregate<{ _id: Types.ObjectId; usuarios: number }>([
          {
            $match: {
              id_municipalidad: this.idMunicipalidad,
              activo: true,
            },
          },
          { $group: { _id: '$id_zona_hogar', usuarios: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const facetas = resultadoFacetas[0] ?? {
      resumen: [],
      categorias: [],
      tendencia: [],
      zonas: [],
    };
    const resumen = facetas.resumen[0] ?? this.resumenVacio();
    const usuariosZona = new Map(
      usuariosPorZona.map((item) => [String(item._id), item.usuarios]),
    );
    const metricasZona = new Map(
      facetas.zonas.map((item) => [item.codigo_zona, item]),
    );

    const estadisticasZonas = zonasMongo
      .map((zona) => {
        const estadistica = metricasZona.get(zona.codigo);
        const cantidadUsuarios = usuariosZona.get(String(zona._id)) ?? 0;
        const totalAlertas = estadistica?.total ?? 0;
        return {
          codigo: zona.codigo,
          nombre: zona.nombre,
          usuarios: cantidadUsuarios,
          alertas: totalAlertas,
          alertas_por_mil: cantidadUsuarios
            ? Number(((totalAlertas / cantidadUsuarios) * 1000).toFixed(1))
            : 0,
          criticas: estadistica?.criticas ?? 0,
          respuesta_mediana: estadistica?.mediana_respuesta_segundos ?? 0,
          cumplimiento_sla: estadistica?.cumplimiento_sla ?? 0,
        };
      })
      .sort((a, b) => b.alertas_por_mil - a.alertas_por_mil);

    const zonasGeoJson = {
      type: 'FeatureCollection' as const,
      features: zonasMongo.map((zona) => {
        const estadistica = estadisticasZonas.find(
          (item) => item.codigo === zona.codigo,
        );
        return {
          type: 'Feature' as const,
          properties: {
            codigo: zona.codigo,
            nombre: zona.nombre,
            usuarios: estadistica?.usuarios ?? 0,
            alertas: estadistica?.alertas ?? 0,
            criticas: estadistica?.criticas ?? 0,
            alertasPorMil: estadistica?.alertas_por_mil ?? 0,
            sla: Number(
              ((estadistica?.cumplimiento_sla ?? 0) * 100).toFixed(1),
            ),
          },
          geometry: zona.geometria,
        };
      }),
    };

    return {
      metadata: {
        comuna: 'Vitacura',
        sintetico: true,
        actualizado_en: new Date().toISOString(),
        periodo: {
          inicio: desde.toISOString(),
          fin: hasta.toISOString(),
        },
      },
      resumen_operacional: {
        usuarios,
        usuarios_activos: usuariosActivos,
        dispositivos,
        dispositivos_activos: dispositivosActivos,
        bateria_baja: bateriaBaja,
        perfiles_cuidado: perfilesCuidado,
        dependencia_severa: dependenciaSevera,
      },
      metricas: resumen,
      categorias: facetas.categorias,
      tendencia: facetas.tendencia,
      zonas: zonasGeoJson,
      estadisticas_zonas: estadisticasZonas,
    };
  }

  async obtenerAlertasMapa(filtros: MapaQueryDto) {
    const { match, desde, hasta } = this.construirFiltro(filtros);
    const limiteConfigurado = Number(
      this.config.get<string>('MAPA_LIMITE_PREDETERMINADO', '5000'),
    );
    const limitePredeterminado = Number.isInteger(limiteConfigurado)
      ? Math.min(Math.max(limiteConfigurado, 100), 8000)
      : 5000;
    const limite = Math.min(filtros.limite ?? limitePredeterminado, 8000);

    if (filtros.bbox) {
      match.ubicacion = this.construirFiltroGeografico(filtros.bbox);
    }

    const [total, alertas] = await Promise.all([
      this.alertaModel.countDocuments(match),
      this.alertaModel
        .aggregate<AlertaMapa>([
          { $match: match },
          { $sort: { creado_en: -1 } },
          { $limit: limite },
          {
            $project: {
              _id: 0,
              id: { $toString: '$_id' },
              codigo: '$codigo_alerta',
              coordenadas: '$ubicacion.coordinates',
              fecha: '$creado_en',
              categoria: '$clasificacion.categoria',
              tipo: '$clasificacion.tipo',
              severidad: '$clasificacion.severidad',
              confianza: '$clasificacion.confianza',
              requiere_revision:
                '$clasificacion.requiere_revision_humana',
              prioridad: '$prioridad.nivel',
              puntaje_prioridad: '$prioridad.puntaje',
              canal: '$origen.canal',
              metodo: '$origen.metodo_activacion',
              respuesta_segundos:
                '$resumen_respuesta.segundos_primera_respuesta',
              escalada:
                '$resumen_respuesta.escalada_centro_emergencia',
              zona:
                '$ubicacion.referencia_ubicacion.codigo_zona',
              zona_nombre:
                '$ubicacion.referencia_ubicacion.codigo_zona',
              calle: '$ubicacion.referencia_ubicacion.nombre_calle',
              resultado: '$resolucion.resultado',
            },
          },
        ])
        .allowDiskUse(true)
        .exec(),
    ]);

    return {
      metadata: {
        periodo: {
          inicio: desde.toISOString(),
          fin: hasta.toISOString(),
        },
        total,
        entregadas: alertas.length,
        limite,
        truncado: total > alertas.length,
      },
      alertas,
    };
  }

  private construirFiltro(filtros: DashboardQueryDto) {
    const hasta = filtros.hasta ? new Date(filtros.hasta) : new Date();
    const desde = filtros.desde
      ? new Date(filtros.desde)
      : new Date(hasta.getTime() - filtros.dias * 86_400_000);
    if (desde >= hasta) {
      throw new BadRequestException('desde debe ser anterior a hasta');
    }

    const match: Record<string, unknown> = {
      id_municipalidad: this.idMunicipalidad,
      creado_en: { $gte: desde, $lte: hasta },
    };
    if (filtros.categoria && filtros.categoria !== 'todas') {
      match['clasificacion.categoria'] = filtros.categoria;
    }
    if (filtros.zona) {
      match['ubicacion.referencia_ubicacion.codigo_zona'] = filtros.zona;
    }
    return { match, desde, hasta };
  }

  private construirFiltroGeografico(bbox: string) {
    const values = bbox.split(',').map(Number);
    if (
      values.length !== 4 ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new BadRequestException(
        'bbox debe tener el formato oeste,sur,este,norte',
      );
    }
    const [oeste, sur, este, norte] = values;
    if (oeste >= este || sur >= norte) {
      throw new BadRequestException('bbox contiene límites inválidos');
    }
    return {
      $geoWithin: {
        $geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [oeste, sur],
              [este, sur],
              [este, norte],
              [oeste, norte],
              [oeste, sur],
            ],
          ],
        },
      },
    };
  }

  private crearPipelineResumen(
    match: Record<string, unknown>,
  ): PipelineStage[] {
    return [
      { $match: match },
      {
        $facet: {
          resumen: [
            {
              $group: {
                _id: null,
                total_alertas: { $sum: 1 },
                alertas_criticas: {
                  $sum: {
                    $cond: [{ $eq: ['$prioridad.nivel', 'P1'] }, 1, 0],
                  },
                },
                con_respuesta: {
                  $sum: {
                    $cond: [
                      {
                        $isNumber:
                          '$resumen_respuesta.segundos_primera_respuesta',
                      },
                      1,
                      0,
                    ],
                  },
                },
                dentro_sla: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $isNumber:
                              '$resumen_respuesta.segundos_primera_respuesta',
                          },
                          {
                            $lte: [
                              '$resumen_respuesta.segundos_primera_respuesta',
                              300,
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                mediana_respuesta_segundos: {
                  $median: {
                    input:
                      '$resumen_respuesta.segundos_primera_respuesta',
                    method: 'approximate',
                  },
                },
                p90_respuesta: {
                  $percentile: {
                    input:
                      '$resumen_respuesta.segundos_primera_respuesta',
                    p: [0.9],
                    method: 'approximate',
                  },
                },
                activaciones_reloj: {
                  $sum: {
                    $cond: [
                      { $eq: ['$origen.canal', 'reloj_inteligente'] },
                      1,
                      0,
                    ],
                  },
                },
                escaladas_emergencia: {
                  $sum: {
                    $cond: [
                      '$resumen_respuesta.escalada_centro_emergencia',
                      1,
                      0,
                    ],
                  },
                },
                clasificaciones_automaticas: {
                  $sum: {
                    $cond: [
                      {
                        $eq: [
                          '$clasificacion.requiere_revision_humana',
                          false,
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
                total_alertas: 1,
                alertas_criticas: 1,
                mediana_respuesta_segundos: {
                  $round: ['$mediana_respuesta_segundos', 0],
                },
                p90_respuesta_segundos: {
                  $round: [{ $arrayElemAt: ['$p90_respuesta', 0] }, 0],
                },
                escaladas_emergencia: 1,
                cumplimiento_sla: {
                  $cond: [
                    { $gt: ['$con_respuesta', 0] },
                    {
                      $round: [
                        { $divide: ['$dentro_sla', '$con_respuesta'] },
                        4,
                      ],
                    },
                    0,
                  ],
                },
                porcentaje_reloj: {
                  $cond: [
                    { $gt: ['$total_alertas', 0] },
                    {
                      $round: [
                        {
                          $divide: [
                            '$activaciones_reloj',
                            '$total_alertas',
                          ],
                        },
                        4,
                      ],
                    },
                    0,
                  ],
                },
                porcentaje_automatico: {
                  $cond: [
                    { $gt: ['$total_alertas', 0] },
                    {
                      $round: [
                        {
                          $divide: [
                            '$clasificaciones_automaticas',
                            '$total_alertas',
                          ],
                        },
                        4,
                      ],
                    },
                    0,
                  ],
                },
              },
            },
          ],
          categorias: [
            {
              $group: {
                _id: '$clasificacion.categoria',
                total: { $sum: 1 },
              },
            },
            { $project: { _id: 0, categoria: '$_id', total: 1 } },
            { $sort: { total: -1 } },
          ],
          tendencia: [
            {
              $group: {
                _id: {
                  $dateTrunc: {
                    date: '$creado_en',
                    unit: 'day',
                    timezone: 'America/Santiago',
                  },
                },
                total: { $sum: 1 },
                criticas: {
                  $sum: {
                    $cond: [{ $eq: ['$prioridad.nivel', 'P1'] }, 1, 0],
                  },
                },
              },
            },
            { $project: { _id: 0, fecha: '$_id', total: 1, criticas: 1 } },
            { $sort: { fecha: 1 } },
          ],
          zonas: [
            {
              $group: {
                _id: '$ubicacion.referencia_ubicacion.codigo_zona',
                total: { $sum: 1 },
                criticas: {
                  $sum: {
                    $cond: [{ $eq: ['$prioridad.nivel', 'P1'] }, 1, 0],
                  },
                },
                con_respuesta: {
                  $sum: {
                    $cond: [
                      {
                        $isNumber:
                          '$resumen_respuesta.segundos_primera_respuesta',
                      },
                      1,
                      0,
                    ],
                  },
                },
                dentro_sla: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $isNumber:
                              '$resumen_respuesta.segundos_primera_respuesta',
                          },
                          {
                            $lte: [
                              '$resumen_respuesta.segundos_primera_respuesta',
                              300,
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                mediana_respuesta_segundos: {
                  $median: {
                    input:
                      '$resumen_respuesta.segundos_primera_respuesta',
                    method: 'approximate',
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                codigo_zona: '$_id',
                total: 1,
                criticas: 1,
                mediana_respuesta_segundos: {
                  $round: ['$mediana_respuesta_segundos', 0],
                },
                cumplimiento_sla: {
                  $cond: [
                    { $gt: ['$con_respuesta', 0] },
                    {
                      $round: [
                        { $divide: ['$dentro_sla', '$con_respuesta'] },
                        4,
                      ],
                    },
                    0,
                  ],
                },
              },
            },
            { $sort: { total: -1 } },
          ],
        },
      },
    ] as PipelineStage[];
  }

  private resumenVacio(): ResultadoResumen {
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
}
