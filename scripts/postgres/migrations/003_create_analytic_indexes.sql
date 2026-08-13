CREATE INDEX alertas_municipalidad_fecha_idx
  ON {{schema}}.alertas (municipalidad_id, creado_en DESC);

CREATE INDEX alertas_categoria_fecha_idx
  ON {{schema}}.alertas (municipalidad_id, categoria, creado_en DESC);

CREATE INDEX alertas_zona_fecha_idx
  ON {{schema}}.alertas (municipalidad_id, codigo_zona, creado_en DESC);

CREATE INDEX alertas_prioridad_fecha_idx
  ON {{schema}}.alertas (municipalidad_id, prioridad, creado_en DESC);

CREATE INDEX alertas_severidad_fecha_idx
  ON {{schema}}.alertas (municipalidad_id, severidad, creado_en DESC);

CREATE INDEX alertas_canal_fecha_idx
  ON {{schema}}.alertas (municipalidad_id, canal, creado_en DESC);

CREATE INDEX alertas_revision_fecha_idx
  ON {{schema}}.alertas
    (municipalidad_id, requiere_revision_humana, creado_en DESC);

CREATE INDEX alertas_escalada_fecha_idx
  ON {{schema}}.alertas
    (municipalidad_id, escalada_centro_emergencia, creado_en DESC);

CREATE INDEX usuarios_activos_zona_idx
  ON {{schema}}.usuarios (municipalidad_id, activo, zona_hogar_id);

CREATE INDEX dispositivos_estado_idx
  ON {{schema}}.dispositivos (municipalidad_id, estado);

CREATE INDEX dispositivos_bateria_idx
  ON {{schema}}.dispositivos (municipalidad_id, porcentaje_bateria)
  WHERE porcentaje_bateria IS NOT NULL;

CREATE INDEX perfiles_dependencia_idx
  ON {{schema}}.perfiles_cuidado
    (municipalidad_id, activo, nivel_dependencia);

CREATE INDEX perfiles_usuario_idx
  ON {{schema}}.perfiles_cuidado (municipalidad_id, usuario_id, activo);
