CREATE INDEX zonas_geometria_gist
  ON {{schema}}.zonas USING GIST (geometria);

CREATE INDEX zonas_centroide_gist
  ON {{schema}}.zonas USING GIST (centroide);

CREATE INDEX dispositivos_ultima_ubicacion_gist
  ON {{schema}}.dispositivos USING GIST (ultima_ubicacion)
  WHERE ultima_ubicacion IS NOT NULL;

CREATE INDEX alertas_ubicacion_gist
  ON {{schema}}.alertas USING GIST (ubicacion);
