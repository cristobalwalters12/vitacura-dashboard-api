import {
  BadRequestException,
  ConflictException,
  Injectable,
  MessageEvent,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { merge, Observable, of, Subject } from 'rxjs';
import { OperationalAlertQueryDto } from './dto/operational-alert-query.dto';
import {
  OPERATIONAL_ALERT_MODEL,
  OPERATIONAL_MONGO_CONNECTION,
} from './operational-alert.schema';
import { OperationalRoutingService } from './operational-routing.service';

type AlertRecord = Record<string, any> & { _id: Types.ObjectId };
type OperationalChangeStream = {
  close(): Promise<void>;
  on(event: 'change', listener: (change: any) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

const NEXT_STATUS: Record<string, string | undefined> = {
  nueva: 'revisando',
  revisando: 'atendida',
  atendida: 'cerrada',
  cerrada: undefined,
};

@Injectable()
export class OperationalAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly events = new Subject<MessageEvent>();
  private changeStream?: OperationalChangeStream;

  constructor(
    @InjectModel(OPERATIONAL_ALERT_MODEL, OPERATIONAL_MONGO_CONNECTION)
    private readonly alertModel: Model<AlertRecord>,
    @InjectConnection(OPERATIONAL_MONGO_CONNECTION)
    private readonly connection: Connection,
    private readonly routing: OperationalRoutingService,
  ) {}

  async onModuleInit() {
    this.changeStream = this.connection.collection('alertas_entrantes').watch(
      [
        {
          $match: {
            operationType: { $in: ['insert', 'update', 'replace'] },
          },
        },
      ],
      { fullDocument: 'updateLookup' },
    );
    this.changeStream.on('change', (change: any) => {
      if (!change.fullDocument) return;
      const alert = this.normalizeBase(change.fullDocument as AlertRecord);
      this.events.next({
        id: alert.id,
        type:
          change.operationType === 'insert'
            ? 'alerta_nueva'
            : 'alerta_actualizada',
        data: alert,
        retry: 5_000,
      });
    });
    this.changeStream.on('error', (error: Error) => {
      console.error('Change Stream de alertas operativas:', error.message);
    });
  }

  async onModuleDestroy() {
    await this.changeStream?.close();
    this.events.complete();
  }

  stream(): Observable<MessageEvent> {
    return merge(
      of({ type: 'conectado', data: { estado: 'conectado' }, retry: 5_000 }),
      this.events.asObservable(),
    );
  }

  async list(query: OperationalAlertQueryDto) {
    const filter = query.estado ? { estado: query.estado } : {};
    const alerts = (await this.alertModel
      .find(filter)
      .sort({ recibida_en: -1 })
      .limit(query.limite)
      .lean()
      .exec()) as AlertRecord[];
    return {
      total: await this.alertModel.countDocuments(filter).exec(),
      alertas: alerts.map((alert) => this.normalizeBase(alert)),
    };
  }

  async findOne(identifier: string) {
    if (!identifier.trim()) {
      throw new BadRequestException('El identificador no puede estar vacío');
    }
    const filter = this.identifierFilter(identifier);
    const alert = (await this.alertModel.findOne(filter).lean().exec()) as
      | AlertRecord
      | null;
    if (!alert) throw new NotFoundException('Alerta operativa no encontrada');
    return this.normalizeWithRoute(alert);
  }

  async updateStatus(identifier: string, requestedStatus: string) {
    if (!identifier.trim()) {
      throw new BadRequestException('El identificador no puede estar vacío');
    }
    const filter = this.identifierFilter(identifier);
    const current = (await this.alertModel.findOne(filter).lean().exec()) as
      | AlertRecord
      | null;
    if (!current) {
      throw new NotFoundException('Alerta operativa no encontrada');
    }
    if (current.estado === requestedStatus) {
      return this.normalizeWithRoute(current);
    }

    const nextStatus = NEXT_STATUS[current.estado];
    if (nextStatus !== requestedStatus) {
      throw new ConflictException(
        nextStatus
          ? `La siguiente transición válida es ${current.estado} → ${nextStatus}`
          : 'La alerta ya está cerrada y no admite nuevas transiciones',
      );
    }

    const updated = (await this.alertModel
      .findOneAndUpdate(
        { _id: current._id, estado: current.estado },
        { $set: { estado: requestedStatus } },
        { new: true, runValidators: true },
      )
      .lean()
      .exec()) as AlertRecord | null;
    if (!updated) {
      throw new ConflictException(
        'La alerta cambió mientras era actualizada; vuelve a intentarlo',
      );
    }
    return this.normalizeWithRoute(updated);
  }

  private identifierFilter(identifier: string) {
    return Types.ObjectId.isValid(identifier)
      ? { _id: new Types.ObjectId(identifier) }
      : { codigo: identifier };
  }

  private normalizeBase(alert: AlertRecord) {
    const coordinates = alert.ubicacion?.coordinates as
      | [number, number]
      | undefined;
    if (!coordinates || coordinates.length !== 2) {
      throw new Error(`Alerta ${alert.codigo} sin coordenadas válidas`);
    }
    return {
      id: alert._id.toString(),
      version: alert.version,
      codigo: alert.codigo,
      estado: alert.estado,
      categoria: alert.categoria,
      criticidad: alert.criticidad,
      persona: alert.persona,
      ubicacion: {
        type: 'Point',
        coordinates,
        direccion_referencia: alert.direccion_referencia,
      },
      transcripcion: alert.transcripcion,
      origen: alert.origen,
      camara: alert.camara === true,
      generada_en: alert.generada_en,
      recibida_en: alert.recibida_en,
      sintetica: alert.sintetica === true,
    };
  }

  private async normalizeWithRoute(alert: AlertRecord) {
    const normalized = this.normalizeBase(alert);
    return {
      ...normalized,
      ruta: await this.routing.calculate(normalized.ubicacion.coordinates),
    };
  }
}
