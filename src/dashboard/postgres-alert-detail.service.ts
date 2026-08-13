import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../postgres/postgres.service';
import { AlertDetailReader } from './dashboard-readers';
import {
  getCutoffDate,
  getMunicipalityId,
  getPostgresSchema,
  normalizeExtendedJson,
} from './postgres-dashboard.utils';

type DocumentRecord = Record<string, any>;

@Injectable()
export class PostgresAlertDetailService implements AlertDetailReader {
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

  async obtenerDetalle(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id)) {
      throw new BadRequestException('El identificador de alerta no es válido');
    }
    const result = await this.postgres.query<{
      alerta: DocumentRecord;
      dispositivo: DocumentRecord | null;
      perfil_cuidado: DocumentRecord | null;
    }>(
      `SELECT
         a.detalle AS alerta,
         d.detalle AS dispositivo,
         p.detalle AS perfil_cuidado
       FROM ${this.schema}.alertas a
       LEFT JOIN ${this.schema}.dispositivos d
         ON d.id = a.dispositivo_id AND d.municipalidad_id = a.municipalidad_id
       LEFT JOIN ${this.schema}.perfiles_cuidado p
         ON p.usuario_id = a.usuario_afectado_id
        AND p.municipalidad_id = a.municipalidad_id
        AND p.activo = true
       WHERE a.id = $1
         AND a.municipalidad_id = $2
         AND a.creado_en <= $3`,
      [id, this.municipalityId, this.cutoffDate],
    );
    if (!result.rowCount) throw new NotFoundException('Alerta no encontrada');

    const alert = normalizeExtendedJson(result.rows[0].alerta) as DocumentRecord;
    const device = result.rows[0].dispositivo
      ? (normalizeExtendedJson(result.rows[0].dispositivo) as DocumentRecord)
      : null;
    const careProfile = result.rows[0].perfil_cuidado
      ? (normalizeExtendedJson(result.rows[0].perfil_cuidado) as DocumentRecord)
      : null;
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
        id: alert._id,
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
        comunidad_notificada: notifications.comunidad_notificada === true,
        usuarios_notificados: notified,
        entregadas: delivered,
        confirmadas: confirmed,
        tasa_entrega: notified ? Number((delivered / notified).toFixed(4)) : 0,
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

  private buildTimeline(alert: DocumentRecord) {
    const response = alert.resumen_respuesta ?? {};
    const classification = alert.clasificacion ?? {};
    return [
      ['activacion', 'Activación', alert.creado_en, 0],
      [
        'clasificacion',
        'Clasificación IA',
        classification.clasificado_en,
        response.segundos_clasificacion,
      ],
      [
        'confirmacion',
        'Primera confirmación',
        response.primera_confirmacion_en,
        response.segundos_primera_respuesta,
      ],
      [
        'despacho',
        'Despacho',
        response.despachado_en,
        response.segundos_despacho,
      ],
      [
        'llegada',
        'Llegada',
        response.llegado_en,
        response.segundos_llegada,
      ],
      [
        'resolucion',
        'Resolución',
        response.resuelto_en ?? alert.resolucion?.resuelto_en,
        response.segundos_resolucion,
      ],
    ].map(([id, nombre, fecha, segundos_acumulados]) => ({
      id,
      nombre,
      fecha,
      segundos_acumulados,
      estado: fecha ? 'completada' : 'sin_registro',
    }));
  }

  private confidenceLevel(value?: number) {
    if (!Number.isFinite(value)) return 'sin_datos';
    if ((value ?? 0) >= 0.9) return 'alta';
    if ((value ?? 0) >= 0.78) return 'media';
    return 'baja';
  }
}
