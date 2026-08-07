import { Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AlertaDocument = HydratedDocument<Alerta>;

@Schema({ collection: 'alertas', strict: false })
export class Alerta {}

export const AlertaSchema = SchemaFactory.createForClass(Alerta);
