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

export interface CategoriaZonaAgregada {
  codigo_zona: string;
  categoria: string;
  total: number;
}

export interface RevisionCategoriaAgregada {
  categoria: string;
  total: number;
  revisiones: number;
}

export interface ZonaCategoriaDetalle {
  codigo_zona: string;
  categoria: string;
  total: number;
}

export interface FacetasDashboard {
  resumen: ResultadoResumen[];
  categorias: CategoriaAgregada[];
  tendencia: TendenciaAgregada[];
  zonas: ZonaAgregada[];
  zonasCategorias: CategoriaZonaAgregada[];
  revisionCategorias: RevisionCategoriaAgregada[];
  zonasCategoriasDetalle: ZonaCategoriaDetalle[];
  seguridadNocturna: Array<{ total: number; nocturnas: number }>;
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
  private readonly fechaCorte: Date;

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
    const cutoff = this.config.get<string>(
      'ANALYTICS_CUTOFF_DATE',
      '2026-08-15T23:59:59.999Z',
    );
    this.fechaCorte = new Date(cutoff);
    if (!Number.isFinite(this.fechaCorte.getTime())) {
      throw new Error('ANALYTICS_CUTOFF_DATE no es una fecha válida');
    }
  }

  async obtenerResumen(filtros: DashboardQueryDto) {
    const { match, desde, hasta } = this.construirFiltro(filtros);
    const pipeline = this.crearPipelineResumen(match);
    const duracionPeriodo = hasta.getTime() - desde.getTime();
    const anteriorHasta = new Date(desde.getTime() - 1);
    const anteriorDesde = new Date(
      anteriorHasta.getTime() - duracionPeriodo,
    );
    const matchAnterior = {
      ...match,
      creado_en: { $gte: anteriorDesde, $lte: anteriorHasta },
    };

    const [
      resultadoFacetas,
      resultadoFacetasAnterior,
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
      this.alertaModel
        .aggregate<FacetasDashboard>(
          this.crearPipelineResumen(matchAnterior),
        )
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
      zonasCategorias: [],
      revisionCategorias: [],
      zonasCategoriasDetalle: [],
      seguridadNocturna: [],
    };
    const facetasAnteriores = resultadoFacetasAnterior[0] ?? {
      resumen: [],
      categorias: [],
      tendencia: [],
      zonas: [],
      zonasCategorias: [],
      revisionCategorias: [],
      zonasCategoriasDetalle: [],
      seguridadNocturna: [],
    };
    const resumen = facetas.resumen[0] ?? this.resumenVacio();
    const resumenAnterior =
      facetasAnteriores.resumen[0] ?? this.resumenVacio();
    const usuariosZona = new Map(
      usuariosPorZona.map((item) => [String(item._id), item.usuarios]),
    );
    const metricasZona = new Map(
      facetas.zonas.map((item) => [item.codigo_zona, item]),
    );
    const categoriaZona = new Map(
      facetas.zonasCategorias.map((item) => [item.codigo_zona, item]),
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
            respuestaMediana: estadistica?.respuesta_mediana ?? 0,
            categoriaDominante:
              categoriaZona.get(zona.codigo)?.categoria ?? null,
            sla: Number(
              ((estadistica?.cumplimiento_sla ?? 0) * 100).toFixed(1),
            ),
          },
          geometry: zona.geometria,
        };
      }),
    };
    const comparacion = this.crearComparacion(
      resumen,
      resumenAnterior,
      facetas,
      facetasAnteriores,
      anteriorDesde,
      anteriorHasta,
    );
    const hallazgos = this.crearHallazgos(
      resumen,
      resumenAnterior,
      facetas,
      facetasAnteriores,
      zonasMongo,
    );

    return {
      metadata: {
        comuna: 'Vitacura',
        sintetico: true,
        actualizado_en: this.fechaCorte.toISOString(),
        fecha_corte: this.fechaCorte.toISOString(),
        periodo: {
          inicio: desde.toISOString(),
          fin: hasta.toISOString(),
        },
        filtros_aplicados: this.resumirFiltros(filtros),
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
      comparacion,
      hallazgos,
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

    const [total, alertas, zonasMapa] = await Promise.all([
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
                '$ubicacion.referencia_ubicacion.nombre_zona',
              calle: '$ubicacion.referencia_ubicacion.nombre_calle',
              resultado: '$resolucion.resultado',
            },
          },
        ])
        .allowDiskUse(true)
        .exec(),
      this.zonaModel
        .find({ id_municipalidad: this.idMunicipalidad })
        .select({ _id: 0, codigo: 1, nombre: 1 })
        .lean()
        .exec() as unknown as Promise<Array<{ codigo: string; nombre: string }>>,
    ]);
    const nombreZona = new Map(
      zonasMapa.map((zona) => [zona.codigo, zona.nombre]),
    );
    const alertasNormalizadas = alertas.map((alerta) => ({
      ...alerta,
      zona_nombre:
        alerta.zona_nombre || nombreZona.get(alerta.zona) || alerta.zona,
    }));

    return {
      metadata: {
        periodo: {
          inicio: desde.toISOString(),
          fin: hasta.toISOString(),
        },
        total,
        entregadas: alertasNormalizadas.length,
        limite,
        truncado: total > alertasNormalizadas.length,
        filtros_aplicados: this.resumirFiltros(filtros),
      },
      alertas: alertasNormalizadas,
    };
  }

  private crearVariacion(actual: number, anterior: number) {
    const diferencia = actual - anterior;
    const porcentaje = anterior
      ? Number(((diferencia / anterior) * 100).toFixed(1))
      : actual
        ? 100
        : 0;
    return {
      actual,
      anterior,
      diferencia: Number(diferencia.toFixed(4)),
      porcentaje,
      direccion:
        Math.abs(porcentaje) < 1 ? 'estable' : porcentaje > 0 ? 'sube' : 'baja',
    };
  }

  private crearComparacion(
    actual: ResultadoResumen,
    anterior: ResultadoResumen,
    facetas: FacetasDashboard,
    facetasAnteriores: FacetasDashboard,
    anteriorDesde: Date,
    anteriorHasta: Date,
  ) {
    const categoriasAnteriores = new Map(
      facetasAnteriores.categorias.map((item) => [item.categoria, item.total]),
    );
    const zonasAnteriores = new Map(
      facetasAnteriores.zonas.map((item) => [item.codigo_zona, item]),
    );
    return {
      disponible: anterior.total_alertas > 0,
      periodo_anterior: {
        inicio: anteriorDesde.toISOString(),
        fin: anteriorHasta.toISOString(),
      },
      tendencia_anterior: facetasAnteriores.tendencia.map((item, index) => ({
        indice: index,
        fecha: item.fecha,
        total: item.total,
        criticas: item.criticas,
      })),
      metricas: {
        total_alertas: this.crearVariacion(
          actual.total_alertas,
          anterior.total_alertas,
        ),
        alertas_criticas: this.crearVariacion(
          actual.alertas_criticas,
          anterior.alertas_criticas,
        ),
        mediana_respuesta_segundos: this.crearVariacion(
          actual.mediana_respuesta_segundos ?? 0,
          anterior.mediana_respuesta_segundos ?? 0,
        ),
        cumplimiento_sla: this.crearVariacion(
          actual.cumplimiento_sla,
          anterior.cumplimiento_sla,
        ),
        escaladas_emergencia: this.crearVariacion(
          actual.escaladas_emergencia,
          anterior.escaladas_emergencia,
        ),
      },
      categorias: facetas.categorias.map((item) => ({
        categoria: item.categoria,
        ...this.crearVariacion(
          item.total,
          categoriasAnteriores.get(item.categoria) ?? 0,
        ),
      })),
      zonas: facetas.zonas.map((item) => {
        const previa = zonasAnteriores.get(item.codigo_zona);
        return {
          codigo: item.codigo_zona,
          alertas: this.crearVariacion(item.total, previa?.total ?? 0),
          criticas: this.crearVariacion(item.criticas, previa?.criticas ?? 0),
          respuesta: this.crearVariacion(
            item.mediana_respuesta_segundos ?? 0,
            previa?.mediana_respuesta_segundos ?? 0,
          ),
        };
      }),
    };
  }

  private crearHallazgos(
    actual: ResultadoResumen,
    anterior: ResultadoResumen,
    facetas: FacetasDashboard,
    facetasAnteriores: FacetasDashboard,
    zonas: ZonaMongo[],
  ) {
    const hallazgos: Array<Record<string, unknown> & { orden: number }> = [];
    const nombresZona = new Map(zonas.map((zona) => [zona.codigo, zona.nombre]));
    const categoriasAnteriores = new Map(
      facetasAnteriores.categorias.map((item) => [item.categoria, item.total]),
    );
    const categoriaEnAlza = facetas.categorias
      .map((item) => ({
        ...item,
        variacion: this.crearVariacion(
          item.total,
          categoriasAnteriores.get(item.categoria) ?? 0,
        ),
      }))
      .filter(
        (item) =>
          item.variacion.anterior >= 30 &&
          item.total >= 30 &&
          item.variacion.porcentaje >= 12,
      )
      .sort((a, b) => b.variacion.porcentaje - a.variacion.porcentaje)[0];
    if (categoriaEnAlza) {
      hallazgos.push({
        id: `categoria-${categoriaEnAlza.categoria}`,
        tipo: 'variacion',
        nivel: categoriaEnAlza.variacion.porcentaje >= 30 ? 'alto' : 'medio',
        orden: categoriaEnAlza.variacion.porcentaje >= 30 ? 1 : 3,
        titulo: `La categoría ${this.etiquetaCategoria(categoriaEnAlza.categoria)} aumenta ${categoriaEnAlza.variacion.porcentaje}%`,
        descripcion: `Registra ${categoriaEnAlza.total} alertas frente a ${categoriaEnAlza.variacion.anterior} en el período anterior equivalente.`,
        evidencia: categoriaEnAlza.variacion,
        filtros: { categoria: categoriaEnAlza.categoria },
      });
    }

    const zonasAnteriores = new Map(
      facetasAnteriores.zonas.map((item) => [item.codigo_zona, item.total]),
    );
    const zonaEnAlza = facetas.zonas
      .map((item) => ({
        ...item,
        variacion: this.crearVariacion(
          item.total,
          zonasAnteriores.get(item.codigo_zona) ?? 0,
        ),
      }))
      .filter(
        (item) =>
          item.variacion.anterior >= 5 && item.variacion.porcentaje >= 18,
      )
      .sort((a, b) => b.variacion.porcentaje - a.variacion.porcentaje)[0];
    if (zonaEnAlza) {
      hallazgos.push({
        id: `zona-${zonaEnAlza.codigo_zona}`,
        tipo: 'territorial',
        nivel: zonaEnAlza.variacion.porcentaje >= 35 ? 'alto' : 'medio',
        orden: zonaEnAlza.variacion.porcentaje >= 35 ? 1 : 3,
        titulo: `${nombresZona.get(zonaEnAlza.codigo_zona) ?? zonaEnAlza.codigo_zona} concentra el mayor aumento`,
        descripcion: `${zonaEnAlza.total} alertas, ${zonaEnAlza.variacion.porcentaje}% más que en el período anterior.`,
        evidencia: zonaEnAlza.variacion,
        filtros: { zona: zonaEnAlza.codigo_zona },
      });
    }

    const respuestaActual = actual.mediana_respuesta_segundos ?? 0;
    const respuestaAnterior = anterior.mediana_respuesta_segundos ?? 0;
    const variacionRespuesta = this.crearVariacion(
      respuestaActual,
      respuestaAnterior,
    );
    if (respuestaAnterior && Math.abs(variacionRespuesta.porcentaje) >= 12) {
      const empeora = variacionRespuesta.porcentaje > 0;
      hallazgos.push({
        id: 'respuesta-operacional',
        tipo: 'respuesta',
        nivel: empeora ? 'alto' : 'positivo',
        orden: empeora ? 1 : 4,
        titulo: empeora
          ? `La respuesta mediana sube a ${respuestaActual} segundos`
          : `La respuesta mediana mejora ${Math.abs(variacionRespuesta.porcentaje)}%`,
        descripcion: `El período anterior registró una mediana de ${respuestaAnterior} segundos.`,
        evidencia: variacionRespuesta,
        filtros: {},
      });
    }

    const zonaRespuestaAtipica = facetas.zonas
      .filter(
        (item) =>
          (item.mediana_respuesta_segundos ?? 0) >= 120 &&
          (item.mediana_respuesta_segundos ?? 0) >= respuestaActual * 1.5,
      )
      .sort(
        (a, b) =>
          (b.mediana_respuesta_segundos ?? 0) -
          (a.mediana_respuesta_segundos ?? 0),
      )[0];
    if (zonaRespuestaAtipica) {
      const respuestaZona = zonaRespuestaAtipica.mediana_respuesta_segundos ?? 0;
      const factor = respuestaActual
        ? Number((respuestaZona / respuestaActual).toFixed(1))
        : 0;
      hallazgos.push({
        id: `respuesta-${zonaRespuestaAtipica.codigo_zona}`,
        tipo: 'respuesta',
        nivel: 'alto',
        orden: 1,
        titulo: `${nombresZona.get(zonaRespuestaAtipica.codigo_zona) ?? zonaRespuestaAtipica.codigo_zona} presenta presión operacional`,
        descripcion: `Su respuesta mediana alcanza ${respuestaZona} segundos, ${factor} veces la mediana comunal.`,
        evidencia: {
          actual: respuestaZona,
          referencia: respuestaActual,
          factor,
        },
        filtros: { zona: zonaRespuestaAtipica.codigo_zona },
      });
    }

    const variacionVolumen = this.crearVariacion(
      actual.total_alertas,
      anterior.total_alertas,
    );
    if (
      anterior.total_alertas >= 10 &&
      Math.abs(variacionVolumen.porcentaje) >= 3
    ) {
      const disminuye = variacionVolumen.porcentaje < 0;
      hallazgos.push({
        id: 'volumen-comunal',
        tipo: 'variacion',
        nivel: disminuye ? 'positivo' : 'medio',
        orden: disminuye ? 4 : 2,
        titulo: `El volumen comunal ${disminuye ? 'disminuye' : 'aumenta'} ${Math.abs(variacionVolumen.porcentaje)}%`,
        descripcion: `${actual.total_alertas} alertas frente a ${anterior.total_alertas} en el período anterior equivalente.`,
        evidencia: variacionVolumen,
        filtros: {},
      });
    }

    const seguridad = facetas.seguridadNocturna[0];
    const proporcionNocturna = seguridad?.total
      ? seguridad.nocturnas / seguridad.total
      : 0;
    if ((seguridad?.total ?? 0) >= 10 && proporcionNocturna >= 0.55) {
      hallazgos.push({
        id: 'seguridad-nocturna',
        tipo: 'patron',
        nivel: 'alto',
        orden: 1,
        titulo: `${Math.round(proporcionNocturna * 100)}% de la seguridad en A-12 y A-13 ocurre de noche`,
        descripcion: `${seguridad.nocturnas} de ${seguridad.total} eventos se concentran entre las 20:00 y las 03:59.`,
        evidencia: {
          actual: Number((proporcionNocturna * 100).toFixed(1)),
          unidad: 'porcentaje_nocturno',
        },
        filtros: { categoria: 'seguridad' },
      });
    }

    const resumenRevision = facetas.revisionCategorias.reduce(
      (acumulado, item) => {
        const dificil = ['incendio', 'accidente'].includes(item.categoria);
        const grupo = dificil ? acumulado.dificiles : acumulado.regulares;
        grupo.total += item.total;
        grupo.revisiones += item.revisiones;
        return acumulado;
      },
      {
        dificiles: { total: 0, revisiones: 0 },
        regulares: { total: 0, revisiones: 0 },
      },
    );
    const tasaDificil = resumenRevision.dificiles.total
      ? resumenRevision.dificiles.revisiones / resumenRevision.dificiles.total
      : 0;
    const tasaRegular = resumenRevision.regulares.total
      ? resumenRevision.regulares.revisiones / resumenRevision.regulares.total
      : 0;
    const brechaRevision = (tasaDificil - tasaRegular) * 100;
    if (brechaRevision >= 20) {
      hallazgos.push({
        id: 'revision-clasificacion',
        tipo: 'modelo',
        nivel: 'medio',
        orden: 2,
        titulo: `Incendios y accidentes requieren ${brechaRevision.toFixed(0)} puntos más de revisión`,
        descripcion: `La tasa de revisión es ${Math.round(tasaDificil * 100)}% frente a ${Math.round(tasaRegular * 100)}% en las demás categorías.`,
        evidencia: {
          actual: Number((tasaDificil * 100).toFixed(1)),
          referencia: Number((tasaRegular * 100).toFixed(1)),
          diferencia: Number(brechaRevision.toFixed(1)),
        },
        filtros: { requiereRevision: true },
      });
    }

    const cuidado = facetas.zonasCategoriasDetalle.reduce(
      (acumulado, item) => {
        const objetivo = ['A-3', 'A-5'].includes(item.codigo_zona);
        const grupo = objetivo ? acumulado.objetivo : acumulado.resto;
        grupo.total += item.total;
        if (item.categoria === 'asistencia_cuidador') grupo.cuidado += item.total;
        return acumulado;
      },
      {
        objetivo: { total: 0, cuidado: 0 },
        resto: { total: 0, cuidado: 0 },
      },
    );
    const tasaObjetivo = cuidado.objetivo.total
      ? cuidado.objetivo.cuidado / cuidado.objetivo.total
      : 0;
    const tasaResto = cuidado.resto.total
      ? cuidado.resto.cuidado / cuidado.resto.total
      : 0;
    const brechaCuidado = (tasaObjetivo - tasaResto) * 100;
    if (brechaCuidado >= 8) {
      hallazgos.push({
        id: 'red-cuidado',
        tipo: 'cuidado',
        nivel: 'medio',
        orden: 3,
        titulo: `A-3 y A-5 concentran demanda de cuidado`,
        descripcion: `${Math.round(tasaObjetivo * 100)}% de sus alertas corresponde a cuidadores, ${brechaCuidado.toFixed(1)} puntos sobre el resto de la comuna.`,
        evidencia: {
          actual: Number((tasaObjetivo * 100).toFixed(1)),
          referencia: Number((tasaResto * 100).toFixed(1)),
          diferencia: Number(brechaCuidado.toFixed(1)),
        },
        filtros: { categoria: 'asistencia_cuidador' },
      });
    }

    return hallazgos
      .sort((a, b) => a.orden - b.orden)
      .slice(0, 5)
      .map(({ orden: _orden, ...hallazgo }) => hallazgo);
  }

  private etiquetaCategoria(categoria: string) {
    const etiquetas: Record<string, string> = {
      medica: 'Médica',
      seguridad: 'Seguridad',
      incendio: 'Incendio',
      accidente: 'Accidente',
      asistencia_cuidador: 'Asistencia a cuidadores',
      asistencia_comunitaria: 'Asistencia comunitaria',
    };
    return etiquetas[categoria] ?? categoria;
  }

  private construirFiltro(filtros: DashboardQueryDto) {
    const hastaSolicitado = filtros.hasta
      ? new Date(filtros.hasta)
      : new Date(this.fechaCorte);
    const hasta = new Date(
      Math.min(hastaSolicitado.getTime(), this.fechaCorte.getTime()),
    );
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
    this.agregarFiltroMultiple(
      match,
      'prioridad.nivel',
      filtros.prioridad,
    );
    this.agregarFiltroMultiple(
      match,
      'clasificacion.severidad',
      filtros.severidad,
    );
    this.agregarFiltroMultiple(match, 'origen.canal', filtros.canal);
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

  private agregarFiltroMultiple(
    match: Record<string, unknown>,
    campo: string,
    value?: string,
  ) {
    if (!value) return;
    const values = value.split(',');
    match[campo] = values.length === 1 ? values[0] : { $in: values };
  }

  private resumirFiltros(filtros: DashboardQueryDto) {
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
        filtros.escalada === undefined
          ? null
          : filtros.escalada === 'true',
    };
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
    const seguridadDesde = new Date(
      this.fechaCorte.getTime() - 15 * 86_400_000,
    );
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
          zonasCategorias: [
            {
              $group: {
                _id: {
                  codigo_zona:
                    '$ubicacion.referencia_ubicacion.codigo_zona',
                  categoria: '$clasificacion.categoria',
                },
                total: { $sum: 1 },
              },
            },
            { $sort: { total: -1 } },
            {
              $group: {
                _id: '$_id.codigo_zona',
                categoria: { $first: '$_id.categoria' },
                total: { $first: '$total' },
              },
            },
            {
              $project: {
                _id: 0,
                codigo_zona: '$_id',
                categoria: 1,
                total: 1,
              },
            },
          ],
          revisionCategorias: [
            {
              $group: {
                _id: '$clasificacion.categoria',
                total: { $sum: 1 },
                revisiones: {
                  $sum: {
                    $cond: [
                      '$clasificacion.requiere_revision_humana',
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
                revisiones: 1,
              },
            },
          ],
          zonasCategoriasDetalle: [
            {
              $group: {
                _id: {
                  codigo_zona:
                    '$ubicacion.referencia_ubicacion.codigo_zona',
                  categoria: '$clasificacion.categoria',
                },
                total: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                codigo_zona: '$_id.codigo_zona',
                categoria: '$_id.categoria',
                total: 1,
              },
            },
          ],
          seguridadNocturna: [
            {
              $match: {
                'clasificacion.categoria': 'seguridad',
                'ubicacion.referencia_ubicacion.codigo_zona': {
                  $in: ['A-12', 'A-13'],
                },
                creado_en: {
                  $gte: seguridadDesde,
                  $lte: this.fechaCorte,
                },
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                nocturnas: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          {
                            $gte: [
                              {
                                $hour: {
                                  date: '$creado_en',
                                  timezone: 'UTC',
                                },
                              },
                              20,
                            ],
                          },
                          {
                            $lte: [
                              {
                                $hour: {
                                  date: '$creado_en',
                                  timezone: 'UTC',
                                },
                              },
                              3,
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            { $project: { _id: 0, total: 1, nocturnas: 1 } },
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
