import { Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DispositivoDocument = HydratedDocument<Dispositivo>;

@Schema({ collection: 'dispositivos', strict: false })
export class Dispositivo {}

export const DispositivoSchema = SchemaFactory.createForClass(Dispositivo);
