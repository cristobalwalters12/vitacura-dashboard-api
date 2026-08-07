import { Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PerfilCuidadoDocument = HydratedDocument<PerfilCuidado>;

@Schema({ collection: 'perfiles_cuidado', strict: false })
export class PerfilCuidado {}

export const PerfilCuidadoSchema =
  SchemaFactory.createForClass(PerfilCuidado);
