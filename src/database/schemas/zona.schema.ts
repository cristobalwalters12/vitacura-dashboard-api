import { Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ZonaDocument = HydratedDocument<Zona>;

@Schema({ collection: 'zonas', strict: false })
export class Zona {}

export const ZonaSchema = SchemaFactory.createForClass(Zona);
