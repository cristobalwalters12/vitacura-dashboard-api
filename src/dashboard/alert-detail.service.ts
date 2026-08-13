import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Alerta } from '../database/schemas/alerta.schema';
import { Dispositivo } from '../database/schemas/dispositivo.schema';
import { PerfilCuidado } from '../database/schemas/perfil-cuidado.schema';

type MongoRecord = Record<string, any> & { _id: Types.ObjectId };

@Injectable()
export class AlertDetailService {
  private readonly municipalityId: Types.ObjectId;
  private readonly cutoffDate: Date;

  constructor(
    @InjectModel(Alerta.name)
    private readonly alertModel: Model<Alerta>,
    @InjectModel(Dispositivo.name)
    private readonly deviceModel: Model<Dispositivo>,
    @InjectModel(PerfilCuidado.name)
    private readonly careProfileModel: Model<PerfilCuidado>,
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
  }

  async obtenerDetalle(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('El identificador de alerta no es válido');
    }

    const alert = (await this.alertModel
      .findOne({
        _id: new Types.ObjectId(id),
        id_municipalidad: this.municipalityId,
        creado_en: { $lte: this.cutoffDate },
      })
      .lean()
      .exec()) as MongoRecord | null;

    if (!alert) {
      throw new NotFoundException('Alerta no encontrada');
    }

    const affectedUserId = alert.persona_afectada?.id_usuario;
    const deviceId = alert.origen?.id_dispositivo;
    const [careProfile, device] = await Promise.all([
      affectedUserId
        ? (this.careProfileModel
            .findOne({
              id_municipalidad: this.municipalityId,
              id_usuario: affectedUserId,
              activo: true,
            })
            .lean()
            .exec() as Promise<MongoRecord | null>)
        : null,
      deviceId
        ? (this.deviceModel
            .findOne({
              _id: deviceId,
              id_municipalidad: this.municipalityId,
            })
            .lean()
            .exec() as Promise<MongoRecord | null>)
        : null,
    ]);

    const response = alert.resumen_respuesta ?? {};
    const notifications = alert.resumen_notificaciones ?? {};
    const classification = alert.clasificacion ?? {};
    const care = careProfile?.perfil_cuidado;
    const emergencyPlan = careProfile?.plan_emergencia;
    const delivered = notifications.entregadas ?? 0;
    const notified = notifications.usuarios_notificados ?? 0;
    const confirmed = notifications.confirmadas ?? 0;

    return {
      metadata: {
        sintetico: alert.sintetico === true,
        fecha_corte: this.cutoffDate.toISOString(),
        version_detalle: '1.0',
        privacidad:
          'Evento sintético sin datos personales; ubicación referida a la red vial pública.',
      },
      identificacion: {
        id: alert._id.toString(),
        codigo: alert.codigo_alerta,
        estado: alert.estado,
        creado_en: alert.creado_en,
        actualizado_en: alert.actualizado_en,
      },
      ubicacion: {
        coordenadas: alert.ubicacion?.coordinates ?? null,
        precision_metros: alert.ubicacion?.precision_metros ?? null,
        origen: alert.ubicacion?.origen ?? null,
        calle:
          alert.ubicacion?.referencia_ubicacion?.nombre_calle ??
          'Sin referencia',
        zona: alert.ubicacion?.referencia_ubicacion?.codigo_zona ?? null,
        zona_nombre:
          alert.ubicacion?.referencia_ubicacion?.nombre_zona ?? null,
        fuente:
          alert.ubicacion?.referencia_ubicacion?.origen ?? 'OpenStreetMap',
      },
      activacion: {
        canal: alert.origen?.canal ?? null,
        metodo: alert.origen?.metodo_activacion ?? null,
        version_aplicacion: alert.origen?.version_aplicacion ?? null,
        dispositivo: device
          ? {
              tipo: device.tipo,
              estado: device.estado,
              fabricante: device.fabricante,
              modelo: device.modelo,
              version_firmware: device.version_firmware,
              bateria: device.ultimo_estado_conocido?.porcentaje_bateria,
              conectividad: device.ultimo_estado_conocido?.conectividad,
              intensidad_senal:
                device.ultimo_estado_conocido?.intensidad_senal,
            }
          : null,
        evidencia: {
          audio_simulado: Boolean(alert.multimedia?.clave_objeto_audio),
          duracion_segundos: alert.multimedia?.duracion_segundos ?? null,
          tipo_mime: alert.multimedia?.tipo_mime ?? null,
          cifrado: alert.multimedia?.cifrado === true,
          solo_simulado: alert.multimedia?.solo_simulado === true,
        },
      },
      clasificacion: {
        categoria: classification.categoria,
        tipo: classification.tipo,
        severidad: classification.severidad,
        confianza: classification.confianza ?? null,
        nivel_confianza: this.confidenceLevel(classification.confianza),
        requiere_revision: classification.requiere_revision_humana === true,
        modo_decision: classification.requiere_revision_humana
          ? 'revision_humana'
          : 'automatica',
        modelo: {
          nombre: classification.nombre_modelo ?? null,
          version: classification.version_modelo ?? null,
          latencia_ms: classification.latencia_ms ?? null,
        },
        clasificado_en: classification.clasificado_en ?? null,
        transcripcion: {
          texto_anonimizado:
            alert.transcripcion?.texto_anonimizado ?? 'Sin transcripción',
          idioma: alert.transcripcion?.idioma ?? null,
          confianza: alert.transcripcion?.confianza ?? null,
          contiene_datos_sensibles:
            alert.transcripcion?.contiene_datos_sensibles === true,
          generado_en: alert.transcripcion?.generado_en ?? null,
        },
      },
      prioridad: {
        nivel: alert.prioridad?.nivel ?? null,
        puntaje: alert.prioridad?.puntaje ?? null,
        razones: alert.prioridad?.razones ?? [],
      },
      persona_afectada: {
        tipo_perfil: alert.persona_afectada?.tipo_perfil ?? 'estandar',
        nivel_vulnerabilidad:
          alert.persona_afectada?.nivel_vulnerabilidad ?? 'ninguna',
        cuidado: care
          ? {
              nivel_dependencia: care.nivel_dependencia,
              movilidad: care.movilidad,
              vive_solo: care.vive_solo === true,
              limitaciones_comunicacion:
                care.limitaciones_comunicacion ?? [],
              factores_riesgo: care.factores_riesgo ?? [],
              orden_escalamiento:
                emergencyPlan?.orden_escalamiento ?? [],
              cuidadores_respaldo:
                emergencyPlan?.ids_cuidadores_respaldo?.length ?? 0,
            }
          : null,
      },
      operacion: {
        tipo_respondedor: response.tipo_respondedor ?? null,
        escalada_centro_emergencia:
          response.escalada_centro_emergencia === true,
        etapas: this.buildTimeline(alert),
        segmentos: {
          confirmacion_a_despacho:
            response.segundos_confirmacion_a_despacho ?? null,
          despacho_a_llegada:
            response.segundos_despacho_a_llegada ?? null,
          llegada_a_resolucion:
            response.segundos_llegada_a_resolucion ?? null,
        },
      },
      notificaciones: {
        comunidad_notificada:
          notifications.comunidad_notificada === true,
        usuarios_notificados: notified,
        entregadas: delivered,
        confirmadas: confirmed,
        tasa_entrega: notified
          ? Number((delivered / notified).toFixed(4))
          : 0,
        tasa_confirmacion: delivered
          ? Number((confirmed / delivered).toFixed(4))
          : 0,
      },
      resolucion: {
        resultado: alert.resolucion?.resultado ?? null,
        resuelto_en: alert.resolucion?.resuelto_en ?? null,
        codigo_notas: alert.resolucion?.codigo_notas ?? null,
      },
    };
  }

  private buildTimeline(alert: MongoRecord) {
    const response = alert.resumen_respuesta ?? {};
    const classification = alert.clasificacion ?? {};
    const items = [
      {
        id: 'activacion',
        nombre: 'Activación',
        fecha: alert.creado_en,
        segundos_acumulados: 0,
      },
      {
        id: 'clasificacion',
        nombre: 'Clasificación IA',
        fecha: classification.clasificado_en,
        segundos_acumulados: response.segundos_clasificacion,
      },
      {
        id: 'confirmacion',
        nombre: 'Primera confirmación',
        fecha: response.primera_confirmacion_en,
        segundos_acumulados: response.segundos_primera_respuesta,
      },
      {
        id: 'despacho',
        nombre: 'Despacho',
        fecha: response.despachado_en,
        segundos_acumulados: response.segundos_despacho,
      },
      {
        id: 'llegada',
        nombre: 'Llegada',
        fecha: response.llegado_en,
        segundos_acumulados: response.segundos_llegada,
      },
      {
        id: 'resolucion',
        nombre: 'Resolución',
        fecha: response.resuelto_en ?? alert.resolucion?.resuelto_en,
        segundos_acumulados: response.segundos_resolucion,
      },
    ];
    return items.map((item) => ({
      ...item,
      estado: item.fecha ? 'completada' : 'sin_registro',
    }));
  }

  private confidenceLevel(value?: number) {
    if (!Number.isFinite(value)) return 'sin_datos';
    if ((value ?? 0) >= 0.9) return 'alta';
    if ((value ?? 0) >= 0.78) return 'media';
    return 'baja';
  }
}
