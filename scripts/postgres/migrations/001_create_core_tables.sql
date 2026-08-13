CREATE TABLE {{schema}}.scenario_manifest (
  id text PRIMARY KEY,
  escenario text NOT NULL,
  semilla integer NOT NULL,
  municipalidad_id varchar(24) NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente',
  conteos_esperados jsonb NOT NULL DEFAULT '{}'::jsonb,
  conteos_importados jsonb NOT NULL DEFAULT '{}'::jsonb,
  iniciado_en timestamptz,
  completado_en timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT scenario_manifest_estado_check
    CHECK (estado IN ('pendiente', 'importando', 'completo', 'fallido'))
);

CREATE TABLE {{schema}}.municipalidades (
  id varchar(24) PRIMARY KEY,
  organizacion_id varchar(24),
  codigo varchar(32),
  nombre text NOT NULL,
  activa boolean NOT NULL DEFAULT true,
  sintetico boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en timestamptz,
  actualizado_en timestamptz
);

CREATE TABLE {{schema}}.zonas (
  id varchar(24) PRIMARY KEY,
  organizacion_id varchar(24),
  municipalidad_id varchar(24) NOT NULL
    REFERENCES {{schema}}.municipalidades(id),
  codigo varchar(32) NOT NULL,
  nombre text NOT NULL,
  centroide geometry(Point, 4326),
  geometria geometry(MultiPolygon, 4326) NOT NULL,
  fuente_geometria text,
  nombre_capa_origen text,
  peso_distribucion numeric(10, 4),
  precision_geometria text,
  sintetico boolean NOT NULL DEFAULT true,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT zonas_municipalidad_codigo_unique
    UNIQUE (municipalidad_id, codigo)
);

CREATE TABLE {{schema}}.usuarios (
  id varchar(24) PRIMARY KEY,
  organizacion_id varchar(24),
  municipalidad_id varchar(24) NOT NULL
    REFERENCES {{schema}}.municipalidades(id),
  zona_hogar_id varchar(24)
    REFERENCES {{schema}}.zonas(id),
  codigo_sintetico varchar(64) NOT NULL,
  tipo_perfil text,
  anio_nacimiento smallint,
  rango_edad varchar(32),
  nivel_vulnerabilidad text,
  consentimiento jsonb NOT NULL DEFAULT '{}'::jsonb,
  activo boolean NOT NULL DEFAULT true,
  sintetico boolean NOT NULL DEFAULT true,
  creado_en timestamptz,
  actualizado_en timestamptz,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT usuarios_municipalidad_codigo_unique
    UNIQUE (municipalidad_id, codigo_sintetico)
);

CREATE TABLE {{schema}}.dispositivos (
  id varchar(24) PRIMARY KEY,
  organizacion_id varchar(24),
  municipalidad_id varchar(24) NOT NULL
    REFERENCES {{schema}}.municipalidades(id),
  usuario_asignado_id varchar(24)
    REFERENCES {{schema}}.usuarios(id),
  numero_serie varchar(96) NOT NULL,
  tipo text NOT NULL,
  fabricante text,
  modelo text,
  version_firmware text,
  estado text NOT NULL,
  capacidades jsonb NOT NULL DEFAULT '{}'::jsonb,
  porcentaje_bateria smallint,
  conectividad text,
  intensidad_senal smallint,
  visto_ultima_vez_en timestamptz,
  ultima_ubicacion geometry(Point, 4326),
  ultimo_estado jsonb NOT NULL DEFAULT '{}'::jsonb,
  activado_en timestamptz,
  sintetico boolean NOT NULL DEFAULT true,
  creado_en timestamptz,
  actualizado_en timestamptz,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT dispositivos_bateria_check
    CHECK (porcentaje_bateria IS NULL OR porcentaje_bateria BETWEEN 0 AND 100),
  CONSTRAINT dispositivos_senal_check
    CHECK (intensidad_senal IS NULL OR intensidad_senal BETWEEN 0 AND 100),
  CONSTRAINT dispositivos_municipalidad_serie_unique
    UNIQUE (municipalidad_id, numero_serie)
);

CREATE TABLE {{schema}}.perfiles_cuidado (
  id varchar(24) PRIMARY KEY,
  version_esquema integer,
  organizacion_id varchar(24),
  municipalidad_id varchar(24) NOT NULL
    REFERENCES {{schema}}.municipalidades(id),
  usuario_id varchar(24) NOT NULL
    REFERENCES {{schema}}.usuarios(id),
  nivel_dependencia text,
  movilidad text,
  vive_solo boolean,
  limitaciones_comunicacion text[] NOT NULL DEFAULT '{}',
  factores_riesgo text[] NOT NULL DEFAULT '{}',
  perfil jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_emergencia jsonb NOT NULL DEFAULT '{}'::jsonb,
  consentimiento jsonb NOT NULL DEFAULT '{}'::jsonb,
  activo boolean NOT NULL DEFAULT true,
  sintetico boolean NOT NULL DEFAULT true,
  creado_en timestamptz,
  actualizado_en timestamptz,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT perfiles_municipalidad_usuario_unique
    UNIQUE (municipalidad_id, usuario_id)
);

CREATE TABLE {{schema}}.alertas (
  id varchar(24) PRIMARY KEY,
  version_esquema integer,
  organizacion_id varchar(24),
  municipalidad_id varchar(24) NOT NULL
    REFERENCES {{schema}}.municipalidades(id),
  comunidad_id varchar(24),
  zona_id varchar(24)
    REFERENCES {{schema}}.zonas(id),
  usuario_afectado_id varchar(24)
    REFERENCES {{schema}}.usuarios(id),
  dispositivo_id varchar(24)
    REFERENCES {{schema}}.dispositivos(id),
  codigo_alerta varchar(64) NOT NULL,
  creado_en timestamptz NOT NULL,
  actualizado_en timestamptz,
  estado text,
  categoria text NOT NULL,
  tipo text,
  severidad text,
  confianza double precision,
  requiere_revision_humana boolean NOT NULL DEFAULT false,
  nombre_modelo text,
  version_modelo text,
  latencia_modelo_ms integer,
  clasificado_en timestamptz,
  prioridad varchar(8) NOT NULL,
  puntaje_prioridad integer,
  canal text,
  metodo_activacion text,
  tipo_perfil text,
  nivel_vulnerabilidad text,
  ubicacion geometry(Point, 4326) NOT NULL,
  precision_metros numeric(10, 2),
  origen_ubicacion text,
  capturado_en timestamptz,
  codigo_zona varchar(32),
  nombre_zona text,
  nombre_calle text,
  primera_confirmacion_en timestamptz,
  segundos_primera_respuesta integer,
  despachado_en timestamptz,
  llegado_en timestamptz,
  resuelto_en timestamptz,
  segundos_clasificacion integer,
  segundos_despacho integer,
  segundos_llegada integer,
  segundos_resolucion integer,
  tipo_respondedor text,
  escalada_centro_emergencia boolean NOT NULL DEFAULT false,
  comunidad_notificada boolean,
  usuarios_notificados integer,
  notificaciones_entregadas integer,
  notificaciones_confirmadas integer,
  resultado text,
  sintetico boolean NOT NULL DEFAULT true,
  detalle jsonb NOT NULL,
  CONSTRAINT alertas_municipalidad_codigo_unique
    UNIQUE (municipalidad_id, codigo_alerta),
  CONSTRAINT alertas_confianza_check
    CHECK (confianza IS NULL OR confianza BETWEEN 0 AND 1),
  CONSTRAINT alertas_prioridad_check
    CHECK (prioridad IN ('P1', 'P2', 'P3', 'P4')),
  CONSTRAINT alertas_puntaje_check
    CHECK (puntaje_prioridad IS NULL OR puntaje_prioridad BETWEEN 0 AND 100),
  CONSTRAINT alertas_tiempos_check
    CHECK (
      (segundos_primera_respuesta IS NULL OR segundos_primera_respuesta >= 0)
      AND (segundos_despacho IS NULL OR segundos_despacho >= 0)
      AND (segundos_llegada IS NULL OR segundos_llegada >= 0)
      AND (segundos_resolucion IS NULL OR segundos_resolucion >= 0)
    )
);
