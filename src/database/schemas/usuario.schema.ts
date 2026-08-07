import { Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UsuarioDocument = HydratedDocument<Usuario>;

@Schema({ collection: 'usuarios', strict: false })
export class Usuario {}

export const UsuarioSchema = SchemaFactory.createForClass(Usuario);
