const apiBase = (process.env.DASHBOARD_API_URL || 'http://127.0.0.1:3000').replace(
  /\/$/,
  '',
);

async function requestSummary(days) {
  const response = await fetch(
    `${apiBase}/api/v1/dashboard/resumen?dias=${days}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(`Resumen ${days} días respondió ${response.status}`);
  }
  return response.json();
}

async function requestAnalytics(query = 'dias=90') {
  const response = await fetch(
    `${apiBase}/api/v1/dashboard/analitica?${query}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(`Analítica ${query} respondió ${response.status}`);
  }
  return response.json();
}

async function requestMap(query = 'dias=90&limite=100') {
  const response = await fetch(
    `${apiBase}/api/v1/dashboard/mapa?${query}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`Mapa respondió ${response.status}`);
  return response.json();
}

async function requestAlertDetail(id) {
  const response = await fetch(`${apiBase}/api/v1/alertas/${id}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Detalle ${id} respondió ${response.status}`);
  }
  return response.json();
}

const [summary90, summary7, analytics90, fireAnalytics] = await Promise.all([
  requestSummary(90),
  requestSummary(7),
  requestAnalytics(),
  requestAnalytics('dias=90&categoria=incendio'),
]);
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const insightIds90 = new Set(summary90.hallazgos.map((item) => item.id));
const medicalInsight = summary7.hallazgos.find(
  (item) => item.id === 'categoria-medica',
);
const currentStart = Date.parse(summary90.metadata.periodo.inicio);
const currentEnd = Date.parse(summary90.metadata.periodo.fin);
const previousStart = Date.parse(summary90.comparacion.periodo_anterior.inicio);
const previousEnd = Date.parse(summary90.comparacion.periodo_anterior.fin);
const analyticsInsightIds = new Set(
  analytics90.hallazgos.map((item) => item.id),
);
const map90 = await requestMap();
const detailAlertId = map90.alertas[0]?.id;
if (!detailAlertId) throw new Error('El mapa no entregó una alerta verificable');
const alertDetail = await requestAlertDetail(detailAlertId);
const careMap = await requestMap(
  'dias=90&categoria=asistencia_cuidador&canal=reloj_inteligente&limite=100',
);
const careDetailAlertId = careMap.alertas[0]?.id;
if (!careDetailAlertId) {
  throw new Error('El mapa no entregó un caso de cuidado desde smartwatch');
}
const careAlertDetail = await requestAlertDetail(careDetailAlertId);
const [invalidDetailResponse, missingDetailResponse] = await Promise.all([
  fetch(`${apiBase}/api/v1/alertas/id-invalido`),
  fetch(`${apiBase}/api/v1/alertas/ffffffffffffffffffffffff`),
]);

expect(
  summary90.metadata.fecha_corte === '2026-08-15T23:59:59.999Z',
  'La fecha de corte no coincide con el 15 de agosto de 2026',
);
expect(summary90.hallazgos.length >= 3, 'Se esperaban al menos tres hallazgos');
expect(insightIds90.has('respuesta-A-14'), 'No se detectó la presión operacional A-14');
expect(insightIds90.has('seguridad-nocturna'), 'No se detectó la seguridad nocturna');
expect(insightIds90.has('revision-clasificacion'), 'No se detectó el desafío de clasificación');
expect(insightIds90.has('red-cuidado'), 'No se detectó la concentración de cuidado');
expect(medicalInsight, 'No se detectó el aumento médico en siete días');
expect(
  (medicalInsight?.evidencia?.porcentaje ?? 0) >= 20,
  'El aumento médico detectado no supera 20%',
);
expect(previousEnd < currentStart, 'Los períodos comparados se superponen');
expect(
  Math.abs((currentEnd - currentStart) - (previousEnd - previousStart)) <= 2,
  'Los períodos comparados no tienen la misma duración',
);
expect(
  analytics90.metadata.fecha_corte === '2026-08-15T23:59:59.999Z',
  'La analítica avanzada no respeta la fecha de corte',
);
expect(
  analytics90.ia.resumen.total === summary90.metricas.total_alertas,
  'IA y resumen no cubren el mismo universo de alertas',
);
expect(
  analytics90.ia.resumen.confianza_media > 0.7 &&
    analytics90.ia.resumen.confianza_media <= 1,
  'La confianza media de IA está fuera de rango',
);
expect(
  analytics90.ia.resumen.latencia_mediana_ms > 0,
  'No se obtuvo latencia de clasificación',
);
expect(
  analytics90.respuesta.etapas.length === 5 &&
    analytics90.respuesta.etapas.every(
      (stage) => stage.mediana_segundos > 0 && stage.p90_segundos > 0,
    ),
  'El recorrido operacional no contiene cinco etapas válidas',
);
expect(
  analytics90.respuesta.zonas.length === 15,
  'La analítica operacional no cubre las 15 zonas',
);
expect(
  analytics90.respuesta.notificaciones.tasa_entrega > 0 &&
    analytics90.respuesta.notificaciones.tasa_entrega <= 1,
  'La tasa de entrega de notificaciones está fuera de rango',
);
expect(
  analytics90.cuidado.resumen.total === 900,
  'La analítica de cuidado no cubre los 900 perfiles activos',
);
expect(
  analyticsInsightIds.has('ia-revision-categoria'),
  'No se generó el hallazgo avanzado de revisión IA',
);
expect(
  analyticsInsightIds.has('cuidado-hora-punta'),
  'No se generó el hallazgo de demanda de cuidado',
);
expect(
  fireAnalytics.ia.categorias.length === 1 &&
    fireAnalytics.ia.categorias[0].categoria === 'incendio',
  'La analítica avanzada no aplicó el filtro por categoría',
);
expect(
  alertDetail.identificacion.id === detailAlertId,
  'El detalle no corresponde a la alerta solicitada',
);
expect(
  alertDetail.metadata.sintetico === true,
  'El detalle no declara su naturaleza sintética',
);
expect(
  alertDetail.operacion.etapas.length === 6 &&
    alertDetail.operacion.etapas.every(
      (stage) => stage.estado === 'completada' && stage.fecha,
    ),
  'La trazabilidad individual no contiene seis hitos completos',
);
expect(
  alertDetail.clasificacion.modelo.latencia_ms > 0 &&
    alertDetail.clasificacion.confianza > 0,
  'El detalle no entrega observabilidad de clasificación',
);
expect(
  alertDetail.prioridad.razones.length >= 2,
  'El detalle no explica las razones de prioridad',
);
expect(
  alertDetail.notificaciones.entregadas <=
    alertDetail.notificaciones.usuarios_notificados &&
    alertDetail.notificaciones.confirmadas <=
      alertDetail.notificaciones.entregadas,
  'Los conteos de notificación del detalle son incoherentes',
);
expect(
  !JSON.stringify(alertDetail).includes('id_usuario'),
  'El contrato de detalle expone identificadores de usuario',
);
expect(
  careAlertDetail.persona_afectada.cuidado?.nivel_dependencia &&
    careAlertDetail.persona_afectada.nivel_vulnerabilidad !== 'ninguna',
  'El caso de asistencia no entrega contexto de cuidado',
);
expect(
  careAlertDetail.activacion.dispositivo?.tipo === 'reloj_inteligente',
  'El caso desde smartwatch no entrega contexto del dispositivo',
);
expect(
  invalidDetailResponse.status === 400,
  'Un identificador inválido no respondió 400',
);
expect(
  missingDetailResponse.status === 404,
  'Una alerta inexistente no respondió 404',
);

console.log(
  JSON.stringify(
    {
      api: apiBase,
      fecha_corte: summary90.metadata.fecha_corte,
      hallazgos_90_dias: summary90.hallazgos.map((item) => item.id),
      aumento_medico_7_dias: medicalInsight?.evidencia?.porcentaje ?? null,
      salud_ia: analytics90.ia.salud,
      etapas_operacionales: analytics90.respuesta.etapas.length,
      perfiles_cuidado: analytics90.cuidado.resumen.total,
      hallazgos_avanzados: analytics90.hallazgos.map((item) => item.id),
      detalle_alerta: {
        id: alertDetail.identificacion.id,
        etapas: alertDetail.operacion.etapas.length,
        modelo: alertDetail.clasificacion.modelo.nombre,
        datos_personales_expuestos: JSON.stringify(alertDetail).includes(
          'id_usuario',
        ),
        caso_cuidado: Boolean(careAlertDetail.persona_afectada.cuidado),
        dispositivo: careAlertDetail.activacion.dispositivo?.tipo ?? null,
      },
      comparacion_equivalente: failures.length === 0,
      fallas: failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
