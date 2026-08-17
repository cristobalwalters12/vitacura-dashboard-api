import { Schema } from 'mongoose';

export const OPERATIONAL_MONGO_CONNECTION = 'operational-alerts';
export const OPERATIONAL_ALERT_MODEL = 'OperationalAlert';

export const OperationalAlertSchema = new Schema(
  {
    version: { type: Number, required: true },
    codigo: { type: String, required: true },
    estado: {
      type: String,
      enum: ['nueva', 'revisando', 'atendida', 'cerrada'],
      required: true,
    },
    categoria: { type: String, required: true },
    criticidad: { type: String, required: true },
    persona: {
      id: { type: String, required: true },
      nombre: { type: String, required: true },
    },
    ubicacion: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    direccion_referencia: { type: String, required: true },
    transcripcion: {
      texto: { type: String, required: true },
      idioma: { type: String, required: true },
    },
    origen: {
      canal: { type: String, required: true },
      dispositivo_id: { type: String, default: null },
    },
    camara: { type: Boolean, required: true },
    generada_en: { type: Date, required: true },
    recibida_en: { type: Date, required: true },
    sintetica: { type: Boolean, required: true },
  },
  {
    collection: 'alertas_entrantes',
    strict: true,
    versionKey: false,
  },
);

OperationalAlertSchema.index({ codigo: 1 }, { unique: true });
OperationalAlertSchema.index({ estado: 1, recibida_en: -1 });
OperationalAlertSchema.index({ ubicacion: '2dsphere' });
