import { supabase, isConfigured } from './supabaseclient.js';
import { calculateCarbonFootprint, buildRecommendations } from './calculator.js';

let currentUser = null;
let currentProfile = null;
let isAdminUser = false;
let activeConsentVersion = null;
let activePeriod = null;
let allPeriods = [];
let activeFactors = [];
let lastDashboardRows = [];
let authMode = 'login';

const $ = (id) => document.getElementById(id);

const CATEGORY_COLORS = {
  electricidad: '#eab308',
  gas: '#f97316',
  transporte: '#0284c7',
  aereo: '#6366f1',
};

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function incrementVersion(ver) {
  const match = String(ver || 'v1.0').match(/^v?(\d+)\.(\d+)$/i);
  if (!match) return `${ver || 'v1.0'}.1`;
  return `v${match[1]}.${Number(match[2]) + 1}`;
}

function updateStepper(stage) {
  const s1 = $('step1Badge');
  const s2 = $('step2Badge');
  const s3 = $('step3Badge');
  if (!s1 || !s2 || !s3) return;

  [s1, s2, s3].forEach((el) => el.classList.remove('active', 'done'));
  if (stage === 1) {
    s1.classList.add('active');
  } else if (stage === 2) {
    s1.classList.add('done');
    s2.classList.add('active');
  } else if (stage === 3) {
    s1.classList.add('done');
    s2.classList.add('done');
    s3.classList.add('active');
  }
}

function updateLiveFormPreviews() {
  const members = Math.max(1, Number($('householdMembers')?.value) || 1);
  const unknownElec = $('electricityUnknown')?.checked;
  const billMap = { bajo: 66.7, medio: 127.8, alto: 222.2, muy_alto: 355.6 };
  const totalKwh = unknownElec
    ? (billMap[$('electricityBillRange')?.value] || 127.8)
    : (Number($('electricityKwh')?.value) || 0);
  const perCapitaKwh = (totalKwh / members).toFixed(1);
  if ($('liveElecPreview')) {
    $('liveElecPreview').textContent = `~${perCapitaKwh} kWh / persona`;
  }

  const gasType = $('gasType')?.value;
  const gasAmount = Number($('gasAmount')?.value) || 0;
  if ($('liveGasPreview')) {
    if (gasType === 'ninguno' || gasAmount <= 0) {
      $('liveGasPreview').textContent = 'Sin consumo de gas';
    } else {
      const unit = gasType === 'GLP_CIL_CO' ? 'kg' : 'm³';
      $('liveGasPreview').textContent = `~${(gasAmount / members).toFixed(2)} ${unit} / persona`;
    }
  }

  const days = Math.max(0, Number($('campusDays')?.value) || 0);
  const km = Math.max(0, Number($('roundTripKm')?.value) || 0);
  const totalKm = (days * km).toFixed(0);
  if ($('liveTransportPreview')) {
    $('liveTransportPreview').textContent = `${totalKm} km / mes`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!isConfigured) {
    $('configWarning').classList.remove('hidden');
    return;
  }

  bindUIEvents();
  updateLiveFormPreviews();

  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    await initAuthenticatedSession(session.user);
  }
});

function bindUIEvents() {
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.authTab;
      document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const isRegister = authMode === 'register';
      $('registerFields').classList.toggle('hidden', !isRegister);
      $('authPasswordConfirm').required = isRegister;
      if (!isRegister) $('authPasswordConfirm').value = '';
      $('authFeedback').textContent = '';
      $('btnAuthSubmit').textContent = isRegister ? 'Crear cuenta y entrar' : 'Ingresar';
    });
  });

  $('authForm').addEventListener('submit', handleAuthSubmit);
  $('btnLogout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ['participantView', 'arcoView', 'adminView'].forEach((v) => $(v).classList.add('hidden'));
      $(btn.dataset.view).classList.remove('hidden');
    });
  });

  ['householdMembers', 'electricityKwh', 'electricityBillRange', 'gasAmount', 'campusDays', 'roundTripKm'].forEach((id) => {
    $(id)?.addEventListener('input', updateLiveFormPreviews);
    $(id)?.addEventListener('change', updateLiveFormPreviews);
  });

  $('electricityUnknown').addEventListener('change', (e) => {
    const unknown = e.target.checked;
    $('electricityKwhWrapper').classList.toggle('hidden', unknown);
    $('electricityEstWrapper').classList.toggle('hidden', unknown);
    $('electricityBillWrapper').classList.toggle('hidden', !unknown);
    $('electricityKwh').required = !unknown;
    updateLiveFormPreviews();
  });

  $('gasType').addEventListener('change', (e) => {
    const isNone = e.target.value === 'ninguno';
    $('gasAmount').disabled = isNone;
    if (isNone) $('gasAmount').value = 0;
    updateLiveFormPreviews();
  });

  $('btnAcceptConsent').addEventListener('click', handleAcceptConsent);
  $('surveyForm').addEventListener('submit', handleSurveySubmit);
  $('arcoForm').addEventListener('submit', handleArcoSubmit);
  $('btnDeleteAccount').addEventListener('click', handleDeleteAccount);
  $('btnRefreshDashboard').addEventListener('click', loadAdminDashboard);
  $('btnExportCsv').addEventListener('click', exportDashboardCsv);
  $('newPeriodForm').addEventListener('submit', handleCreatePeriod);
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  $('authFeedback').textContent = 'Procesando...';
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;

  if (authMode === 'register') {
    const confirmPassword = $('authPasswordConfirm').value;
    if (password !== confirmPassword) {
      $('authFeedback').textContent = 'Error: Las contraseñas no coinciden.';
      return;
    }

    const tipoUsuario = $('regTipoUsuario').value;
    const campus = $('regCampus').value;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          tipo_usuario: tipoUsuario,
          campus: campus,
        },
      },
    });

    if (error) {
      $('authFeedback').textContent = `Error: ${error.message}`;
      return;
    }

    if (data.user) {
      if (data.session) {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          tipo_usuario: tipoUsuario,
          campus: campus,
        });
        await initAuthenticatedSession(data.user);
      } else {
        $('authFeedback').textContent = 'Cuenta creada. Revisa tu correo para confirmar o inicia sesión.';
      }
    }
  } else {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      $('authFeedback').textContent = `Error de acceso: ${error.message}`;
      return;
    }
    await initAuthenticatedSession(data.user);
  }
}

async function initAuthenticatedSession(user) {
  currentUser = user;
  $('authSection').classList.add('hidden');
  $('userSessionBox').classList.remove('hidden');
  $('appNav').classList.remove('hidden');
  $('participantView').classList.remove('hidden');
  updateStepper(1);

  const metaTipo = user.user_metadata?.tipo_usuario;
  const metaCampus = user.user_metadata?.campus;

  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    const fallbackTipo = metaTipo || 'estudiante';
    const fallbackCampus = metaCampus || 'Bogotá - Sede Principal';
    const { data: created } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        tipo_usuario: fallbackTipo,
        campus: fallbackCampus,
      })
      .select()
      .maybeSingle();

    profile = created || {
      id: user.id,
      tipo_usuario: fallbackTipo,
      campus: fallbackCampus,
      is_admin: false,
    };
  }

  currentProfile = profile;
  isAdminUser = Boolean(profile?.is_admin);

  const roleLabel = (profile?.tipo_usuario || 'estudiante').toUpperCase();
  const campusLabel = profile?.campus || 'Bogotá - Sede Principal';

  $('userRoleBadge').textContent = isAdminUser
    ? `ADMINISTRADOR · ${campusLabel}`
    : `${roleLabel} · ${campusLabel}`;

  if (isAdminUser) {
    $('navAdminBtn').classList.remove('hidden');
  }

  await loadCatalogs();
  await checkConsentAndPreviousSurvey();
  await loadArcoRequests();

  if (isAdminUser) {
    await loadAdminPeriods();
    await loadAdminDashboard();
    await loadAdminFactors();
    await loadAdminArcoRequests();
  }
}

async function loadCatalogs() {
  const { data: cvList, error: cvErr } = await supabase
    .from('consent_versions')
    .select('*')
    .eq('active', true)
    .limit(1);

  if (cvErr) {
    $('consentTextBox').textContent = `Error cargando aviso de privacidad: ${cvErr.message}`;
  } else if (cvList && cvList.length > 0) {
    activeConsentVersion = cvList[0];
    $('consentVersionTag').textContent = `Versión ${activeConsentVersion.version}`;
    $('consentTextBox').textContent = activeConsentVersion.texto || activeConsentVersion.text || '';
  } else {
    $('consentTextBox').textContent = 'No hay una versión activa en consent_versions.';
  }

  const { data: periods } = await supabase
    .from('survey_periods')
    .select('*')
    .order('start_date', { ascending: false });

  allPeriods = periods || [];
  activePeriod = allPeriods.find((p) => p.status === 'activo') || null;

  if (activePeriod) {
    $('activePeriodLabel').textContent = `Periodo activo: ${activePeriod.name} (${activePeriod.start_date} a ${activePeriod.end_date})`;
  } else {
    $('activePeriodLabel').textContent = 'No hay un periodo de encuesta activo.';
  }

  const { data: factors } = await supabase
    .from('emission_factors')
    .select('*')
    .eq('is_active', true);

  activeFactors = factors || [];
}

async function checkConsentAndPreviousSurvey() {
  if (!activeConsentVersion) return;
  const { data: consent } = await supabase
    .from('consents')
    .select('*')
    .eq('profile_id', currentUser.id)
    .eq('consent_version_id', activeConsentVersion.id)
    .is('revoked_at', null)
    .maybeSingle();

  if (consent) {
    $('consentCard').classList.add('hidden');
    $('surveyCard').classList.remove('hidden');
    updateStepper(2);
    await loadExistingCalculation();
  }
}

async function handleAcceptConsent() {
  if (!$('chkConsent').checked) {
    alert('Debes aceptar el aviso de privacidad para continuar.');
    return;
  }

  if (!activeConsentVersion) {
    alert('No se ha cargado la versión del consentimiento desde Supabase.');
    return;
  }

  const { data: existing } = await supabase
    .from('consents')
    .select('id')
    .eq('profile_id', currentUser.id)
    .eq('consent_version_id', activeConsentVersion.id)
    .maybeSingle();

  let error = null;
  if (existing) {
    const res = await supabase
      .from('consents')
      .update({ accepted_at: new Date().toISOString(), revoked_at: null })
      .eq('id', existing.id);
    error = res.error;
  } else {
    const res = await supabase.from('consents').insert({
      profile_id: currentUser.id,
      consent_version_id: activeConsentVersion.id,
      accepted_at: new Date().toISOString(),
    });
    error = res.error;
  }

  if (error) {
    alert(`No se pudo registrar el consentimiento: ${error.message}`);
    return;
  }

  $('consentCard').classList.add('hidden');
  $('surveyCard').classList.remove('hidden');
  updateStepper(2);
}

async function handleSurveySubmit(e) {
  e.preventDefault();
  if (!activePeriod) {
    $('surveyFeedback').textContent = 'No hay un periodo de encuesta activo.';
    return;
  }

  const input = {
    householdMembers: Number($('householdMembers').value),
    electricityKwh: Number($('electricityKwh').value),
    electricityUnknown: $('electricityUnknown').checked,
    electricityBillRange: $('electricityBillRange').value,
    electricityEstimated: $('electricityEstimated').checked,
    gasType: $('gasType').value,
    gasAmount: Number($('gasAmount').value),
    gasEstimated: $('gasEstimated').checked,
    campusDays: Number($('campusDays').value),
    roundTripKm: Number($('roundTripKm').value),
    transportMode: $('transportMode').value,
    domesticFlights: Number($('domesticFlights').value),
    internationalFlights: Number($('internationalFlights').value),
  };

  const result = calculateCarbonFootprint(
    input,
    activeFactors,
    activePeriod.methodology_version || 'MET-HV-UAN-v1.0'
  );
  $('surveyFeedback').textContent = 'Guardando respuestas y cálculo...';

  const { data: survey, error: sErr } = await supabase
    .from('surveys')
    .upsert(
      {
        profile_id: currentUser.id,
        period_id: activePeriod.id,
        status: 'enviada',
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'profile_id,period_id' }
    )
    .select()
    .single();

  if (sErr) {
    $('surveyFeedback').textContent = `Error guardando encuesta: ${sErr.message}`;
    return;
  }

  await supabase.from('activity_answers').delete().eq('survey_id', survey.id);
  const answersPayload = [
    {
      survey_id: survey.id,
      category: 'hogar',
      question_code: 'HOGAR_PERSONAS',
      numeric_value: input.householdMembers,
      text_value: JSON.stringify({
        campusDays: input.campusDays,
        roundTripKm: input.roundTripKm,
        electricityUnknown: input.electricityUnknown,
        electricityBillRange: input.electricityBillRange,
      }),
      unit: 'personas',
      is_estimated: false,
    },
    ...result.details.map((d) => ({
      survey_id: survey.id,
      category: d.category,
      question_code: d.questionCode,
      numeric_value: d.convertedActivity,
      text_value: d.factorCode,
      unit: d.unit,
      is_estimated: d.isEstimated,
    })),
  ];

  const { data: savedAnswers, error: ansErr } = await supabase
    .from('activity_answers')
    .insert(answersPayload)
    .select();

  if (ansErr) {
    $('surveyFeedback').textContent = `Error guardando respuestas: ${ansErr.message}`;
    return;
  }

  await supabase.from('calculations').delete().eq('survey_id', survey.id);
  const { data: calc, error: cErr } = await supabase
    .from('calculations')
    .insert({
      survey_id: survey.id,
      methodology_version: result.methodologyVersion,
      total_kgco2e: result.totalKgCo2e,
    })
    .select()
    .single();

  if (cErr) {
    $('surveyFeedback').textContent = `Error guardando cálculo: ${cErr.message}`;
    return;
  }

  const detailsPayload = result.details.map((d) => {
    const matchedAns = savedAnswers?.find((a) => a.question_code === d.questionCode);
    return {
      calculation_id: calc.id,
      answer_id: matchedAns?.id || null,
      factor_id: d.factorId,
      category: d.category,
      activity_value: d.rawActivity,
      converted_value: d.convertedActivity,
      emissions_kgco2e: d.emissionsKg,
    };
  });

  const { error: detErr } = await supabase.from('calculation_details').insert(detailsPayload);
  if (detErr) {
    $('surveyFeedback').textContent = `Error guardando desglose: ${detErr.message}`;
    return;
  }

  $('surveyFeedback').textContent = '✓ Encuesta, respuestas y cálculo guardados correctamente.';
  renderIndividualReport(result, new Date().toLocaleString('es-CO'));
  $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadExistingCalculation() {
  if (!activePeriod) return;
  const { data: survey } = await supabase
    .from('surveys')
    .select('id')
    .eq('profile_id', currentUser.id)
    .eq('period_id', activePeriod.id)
    .maybeSingle();

  if (!survey) return;

  const { data: answers } = await supabase.from('activity_answers').select('*').eq('survey_id', survey.id);
  const { data: calc } = await supabase.from('calculations').select('*').eq('survey_id', survey.id).maybeSingle();
  if (!calc) return;

  const { data: dets } = await supabase
    .from('calculation_details')
    .select('*, emission_factors(*)')
    .eq('calculation_id', calc.id);

  const answersByCode = Object.fromEntries((answers || []).map((a) => [a.question_code, a]));
  const hogarAns = answersByCode['HOGAR_PERSONAS'];
  if (hogarAns) {
    $('householdMembers').value = hogarAns.numeric_value || 1;
    try {
      const meta = JSON.parse(hogarAns.text_value || '{}');
      if (meta.campusDays != null) $('campusDays').value = meta.campusDays;
      if (meta.roundTripKm != null) $('roundTripKm').value = meta.roundTripKm;
      if (meta.electricityUnknown) {
        $('electricityUnknown').checked = true;
        $('electricityBillRange').value = meta.electricityBillRange || 'medio';
        $('electricityUnknown').dispatchEvent(new Event('change'));
      }
    } catch (_) { /* ignore */ }
  }

  const elecDet = (dets || []).find((d) => d.category === 'electricidad');
  if (elecDet) {
    $('electricityKwh').value = elecDet.activity_value;
    $('electricityEstimated').checked = Boolean(answersByCode['ELEC_HOGAR_KWH']?.is_estimated);
  }

  const gasDet = (dets || []).find((d) => d.category === 'gas');
  if (gasDet) {
    $('gasType').value = answersByCode['GAS_HOGAR']?.text_value || 'GAS_NAT_CO';
    $('gasAmount').value = gasDet.activity_value;
    $('gasEstimated').checked = Boolean(answersByCode['GAS_HOGAR']?.is_estimated);
  } else if (answers?.length) {
    $('gasType').value = 'ninguno';
    $('gasAmount').value = 0;
    $('gasAmount').disabled = true;
  }

  const transAns = answersByCode['TRANSPORTE_CAMPUS_KM'];
  if (transAns?.text_value) {
    $('transportMode').value = transAns.text_value;
  }

  const domDet = (dets || []).find((d) => d.answer_id === answersByCode['VUELOS_NACIONALES']?.id);
  if (domDet) $('domesticFlights').value = domDet.activity_value;

  const intDet = (dets || []).find((d) => d.answer_id === answersByCode['VUELOS_INTERNACIONALES']?.id);
  if (intDet) $('internationalFlights').value = intDet.activity_value;

  updateLiveFormPreviews();

  if (dets?.length) {
    const reconstructedDetails = dets.map((d) => {
      const matchedAns = (answers || []).find((a) => a.id === d.answer_id);
      return {
        category: d.category,
        categoryLabel: d.emission_factors?.factor_name || d.category,
        convertedActivity: d.converted_value,
        unit: d.emission_factors?.unit_activity || matchedAns?.unit || '',
        isEstimated: Boolean(matchedAns?.is_estimated),
        factorValue: d.emission_factors?.factor_value,
        factorVersion: d.emission_factors?.version,
        source: d.emission_factors?.source,
        referenceYear: d.emission_factors?.reference_year,
        emissionsKg: Number(d.emissions_kgco2e),
      };
    });

    const reconstructed = {
      methodologyVersion: calc.methodology_version,
      totalKgCo2e: Number(calc.total_kgco2e),
      totalTonsCo2e: Math.round((Number(calc.total_kgco2e) / 1000) * 10000) / 10000,
      details: reconstructedDetails,
      recommendations: buildRecommendations(reconstructedDetails, {
        transportMode: $('transportMode').value,
      }),
    };
    renderIndividualReport(reconstructed, new Date(calc.calculated_at).toLocaleString('es-CO'));
  }
}

function renderIndividualReport(result, dateLabel) {
  updateStepper(3);
  $('reportCard').classList.remove('hidden');
  $('repTotalKg').textContent = `${result.totalKgCo2e.toFixed(2)} kg CO₂e`;
  $('repTotalTons').textContent = `${result.totalTonsCo2e.toFixed(4)} toneladas CO₂e`;
  $('repMethodVersion').textContent = result.methodologyVersion;
  $('repCalcDate').textContent = `Calculado el ${dateLabel}`;

  const sorted = [...result.details].sort((a, b) => b.emissionsKg - a.emissionsKg);
  const top = sorted[0];
  if (top && result.totalKgCo2e > 0) {
    const pct = ((top.emissionsKg / result.totalKgCo2e) * 100).toFixed(1);
    $('repTopCategory').textContent = top.categoryLabel;
    $('repTopShare').textContent = `${top.emissionsKg.toFixed(2)} kg CO₂e (${pct}% de tu huella)`;
  } else {
    $('repTopCategory').textContent = 'Sin emisiones registradas';
    $('repTopShare').textContent = '0%';
  }

  const total = result.totalKgCo2e;
  if (total > 0) {
    let accPct = 0;
    const stops = [];
    const legendHtml = [];

    for (const d of sorted) {
      const pct = (Number(d.emissionsKg) / total) * 100;
      const color = CATEGORY_COLORS[d.category] || '#16a34a';
      const start = accPct;
      accPct += pct;
      stops.push(`${color} ${start.toFixed(1)}% ${accPct.toFixed(1)}%`);

      legendHtml.push(`
        <div class="legend-item">
          <span class="legend-left">
            <span class="legend-dot" style="background:${color}"></span>
            ${escapeHtml(d.categoryLabel)}
          </span>
          <span><strong>${Number(d.emissionsKg).toFixed(2)} kg</strong> (${pct.toFixed(1)}%)</span>
        </div>
      `);
    }

    $('repDonutChart').style.background = `conic-gradient(${stops.join(', ')})`;
    $('repDonutLegend').innerHTML = legendHtml.join('');
  } else {
    $('repDonutChart').style.background = '#e2e8f0';
    $('repDonutLegend').innerHTML = '<p class="muted">Sin emisiones en el periodo.</p>';
  }

  $('repDetailsBody').innerHTML = result.details
    .map((d) => {
      const color = CATEGORY_COLORS[d.category] || '#16a34a';
      return `
      <tr>
        <td>
          <span class="legend-dot" style="background:${color}; display:inline-block; margin-right:6px;"></span>
          <strong>${escapeHtml(d.categoryLabel)}</strong>
        </td>
        <td>
          <span class="math-formula">${d.convertedActivity} ${escapeHtml(d.unit)} × ${d.factorValue}</span>
          <div class="field-help">Factor ${escapeHtml(d.factorVersion)}</div>
        </td>
        <td><span class="pill ${d.isEstimated ? 'pill-warn' : 'pill-green'}">${d.isEstimated ? 'Estimado' : 'Reportado'}</span></td>
        <td>${escapeHtml(d.source)} (${escapeHtml(d.referenceYear)})</td>
        <td><strong>${Number(d.emissionsKg).toFixed(2)}</strong></td>
      </tr>`;
    })
    .join('');

  $('repRecommendations').innerHTML = result.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
}

async function handleArcoSubmit(e) {
  e.preventDefault();
  const type = $('arcoType').value;
  const desc = $('arcoDesc').value.trim();

  const { error } = await supabase.from('data_requests').insert({
    profile_id: currentUser.id,
    request_type: type,
    description: desc,
  });
  if (error) {
    $('arcoFeedback').textContent = `Error: ${error.message}`;
    return;
  }

  if (type === 'supresion' && activeConsentVersion) {
    await supabase
      .from('consents')
      .update({ revoked_at: new Date().toISOString() })
      .eq('profile_id', currentUser.id)
      .eq('consent_version_id', activeConsentVersion.id);
  }

  $('arcoDesc').value = '';
  $('arcoFeedback').textContent = '✓ Solicitud registrada correctamente.';
  await loadArcoRequests();
  if (isAdminUser) await loadAdminArcoRequests();
}

async function handleDeleteAccount() {
  const confirmed = window.confirm(
    '¿Seguro que deseas eliminar tu perfil y cuenta por completo?\n\nSe borrarán tus encuestas, cálculos y datos de acceso. Luego podrás volver a registrarte.'
  );
  if (!confirmed) return;

  const btn = $('btnDeleteAccount');
  btn.disabled = true;
  btn.textContent = 'Eliminando perfil...';

  const { error } = await supabase.rpc('delete_my_account');
  if (error) {
    btn.disabled = false;
    btn.textContent = '🗑️ Eliminar perfil definitivamente';
    alert(`No se pudo eliminar el perfil: ${error.message}`);
    return;
  }

  await supabase.auth.signOut();
  alert('Tu perfil y cuenta han sido eliminados. Ahora puedes volver a registrarte.');
  location.reload();
}

async function loadArcoRequests() {
  const { data } = await supabase
    .from('data_requests')
    .select('*')
    .eq('profile_id', currentUser.id)
    .order('created_at', { ascending: false });

  $('arcoListBody').innerHTML = (data || [])
    .map(
      (r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleDateString('es-CO')}</td>
        <td>${escapeHtml(r.request_type)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td><span class="pill pill-blue">${escapeHtml(r.status)}</span></td>
      </tr>`
    )
    .join('');
}

async function loadAdminPeriods() {
  const { data } = await supabase.from('survey_periods').select('*').order('start_date', { ascending: false });
  allPeriods = data || [];

  const filterSelect = $('filterPeriod');
  const currentFilterVal = filterSelect.value;
  filterSelect.innerHTML = `<option value="TODOS">Todos los periodos</option>` +
    allPeriods.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.status)})</option>`).join('');
  if (currentFilterVal) filterSelect.value = currentFilterVal;

  $('adminPeriodsBody').innerHTML = allPeriods
    .map(
      (p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${escapeHtml(p.start_date)} a ${escapeHtml(p.end_date)}</td>
        <td>${escapeHtml(p.methodology_version)}</td>
        <td><span class="pill ${p.status === 'activo' ? 'pill-green' : ''}">${escapeHtml(p.status)}</span></td>
        <td>
          <button type="button" class="btn btn-outline btn-sm" onclick="window.togglePeriodStatus('${p.id}', '${p.status}')">
            ${p.status === 'activo' ? 'Cerrar' : 'Activar'}
          </button>
        </td>
      </tr>`
    )
    .join('');
}

async function handleCreatePeriod(e) {
  e.preventDefault();
  const name = $('newPeriodName').value.trim();
  const startDate = $('newPeriodStart').value;
  const endDate = $('newPeriodEnd').value;

  const { error } = await supabase.from('survey_periods').insert({
    name,
    start_date: startDate,
    end_date: endDate,
    methodology_version: activePeriod?.methodology_version || 'MET-HV-UAN-v1.0',
    status: 'activo',
  });

  if (error) {
    alert(`Error creando periodo: ${error.message}`);
    return;
  }
  $('newPeriodForm').reset();
  await loadCatalogs();
  await loadAdminPeriods();
}

window.togglePeriodStatus = async (periodId, currentStatus) => {
  const nextStatus = currentStatus === 'activo' ? 'cerrado' : 'activo';
  const { error } = await supabase.from('survey_periods').update({ status: nextStatus }).eq('id', periodId);
  if (error) {
    alert(`Error actualizando periodo: ${error.message}`);
    return;
  }
  await loadCatalogs();
  await loadAdminPeriods();
};

async function loadAdminDashboard() {
  const selectedPeriod = $('filterPeriod').value;
  const { data, error } = await supabase.rpc('get_aggregated_dashboard', {
    p_period_id: selectedPeriod === 'TODOS' ? null : selectedPeriod,
    p_campus: $('filterCampus').value,
    p_tipo_usuario: $('filterTipo').value,
  });

  if (error) {
    alert(`Error cargando dashboard: ${error.message}`);
    return;
  }

  lastDashboardRows = data || [];
  const totalSample = lastDashboardRows.reduce((acc, r) => acc + Number(r.sample_size), 0);
  const protectedCount = lastDashboardRows.filter((r) => r.privacy_protected).length;
  const visibleRows = lastDashboardRows.filter((r) => !r.privacy_protected);
  const visibleSample = visibleRows.reduce((acc, r) => acc + Number(r.sample_size), 0);
  const weightedSum = visibleRows.reduce((acc, r) => acc + Number(r.avg_total_kgco2e) * Number(r.sample_size), 0);
  const weightedAvg = visibleSample > 0 ? (weightedSum / visibleSample).toFixed(2) : '0.00';

  $('admSampleSize').textContent = totalSample;
  $('admGroupsInfo').textContent = `${visibleRows.length} / ${protectedCount}`;
  $('admWeightedAvg').textContent = `${weightedAvg} kg`;

  if (!lastDashboardRows.length) {
    $('adminDashboardBody').innerHTML = `<tr><td colspan="9" class="muted">No hay respuestas registradas para los filtros seleccionados.</td></tr>`;
    return;
  }

  $('adminDashboardBody').innerHTML = lastDashboardRows
    .map((r) => {
      if (r.privacy_protected) {
        return `
          <tr>
            <td>${escapeHtml(r.period_name)}</td>
            <td>${escapeHtml(r.campus)}</td>
            <td>${escapeHtml(r.tipo_usuario)}</td>
            <td>${r.sample_size}</td>
            <td colspan="5"><span class="pill pill-warn">🛡️ Protegido por privacidad (n &lt; 10)</span></td>
          </tr>`;
      }
      return `
        <tr>
          <td>${escapeHtml(r.period_name)}</td>
          <td>${escapeHtml(r.campus)}</td>
          <td>${escapeHtml(r.tipo_usuario)}</td>
          <td><strong>${r.sample_size}</strong></td>
          <td><strong>${r.avg_total_kgco2e}</strong></td>
          <td>${r.avg_electricidad}</td>
          <td>${r.avg_gas}</td>
          <td>${r.avg_transporte}</td>
          <td>${r.avg_aereo}</td>
        </tr>`;
    })
    .join('');
}

async function loadAdminFactors() {
  const { data } = await supabase
    .from('emission_factors')
    .select('*')
    .eq('is_active', true)
    .order('category');

  $('adminFactorsBody').innerHTML = (data || [])
    .map(
      (f) => `
      <tr>
        <td><code>${escapeHtml(f.factor_code)}</code></td>
        <td>${escapeHtml(f.factor_name)}</td>
        <td><input type="number" step="0.000001" value="${f.factor_value}" id="fv_${f.id}" style="width:115px" /></td>
        <td>${escapeHtml(f.unit_emission)}/${escapeHtml(f.unit_activity)}</td>
        <td>${escapeHtml(f.source)} (${escapeHtml(f.reference_year)})</td>
        <td><span class="pill pill-blue">${escapeHtml(f.version)}</span></td>
        <td><button type="button" class="btn btn-outline btn-sm" onclick="window.versionFactor('${f.id}')">Versionar</button></td>
      </tr>`
    )
    .join('');
}

window.versionFactor = async (factorId) => {
  const newVal = Number(document.getElementById(`fv_${factorId}`).value);
  if (Number.isNaN(newVal) || newVal < 0) {
    alert('Ingresa un valor numérico válido mayor o igual a 0.');
    return;
  }

  const { data: oldFactor, error: fetchErr } = await supabase
    .from('emission_factors')
    .select('*')
    .eq('id', factorId)
    .single();

  if (fetchErr || !oldFactor) {
    alert('No se encontró el factor original.');
    return;
  }

  if (Number(oldFactor.factor_value) === newVal) {
    alert('El valor ingresado es igual al vigente; no se generó una nueva versión.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextVersion = incrementVersion(oldFactor.version);

  const { error: deactErr } = await supabase
    .from('emission_factors')
    .update({ is_active: false, valid_to: today })
    .eq('id', factorId);

  if (deactErr) {
    alert(`Error desactivando versión anterior: ${deactErr.message}`);
    return;
  }

  const { error: insErr } = await supabase.from('emission_factors').insert({
    factor_code: oldFactor.factor_code,
    factor_name: oldFactor.factor_name,
    category: oldFactor.category,
    factor_value: newVal,
    unit_activity: oldFactor.unit_activity,
    unit_emission: oldFactor.unit_emission,
    geography: oldFactor.geography,
    source: oldFactor.source,
    source_url: oldFactor.source_url,
    reference_year: oldFactor.reference_year,
    valid_from: today,
    version: nextVersion,
    is_active: true,
  });

  if (insErr) {
    alert(`Error creando nueva versión del factor: ${insErr.message}`);
    return;
  }

  alert(`Factor ${oldFactor.factor_code} actualizado a ${nextVersion}.`);
  await loadCatalogs();
  await loadAdminFactors();
};

async function loadAdminArcoRequests() {
  const { data } = await supabase
    .from('data_requests')
    .select('*')
    .order('created_at', { ascending: false });

  $('adminArcoBody').innerHTML = (data || [])
    .map(
      (r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleDateString('es-CO')}</td>
        <td>${escapeHtml(r.request_type)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td><span class="pill pill-blue">${escapeHtml(r.status)}</span></td>
        <td>
          <select onchange="window.updateArcoStatus('${r.id}', this.value)">
            <option value="pendiente" ${r.status === 'pendiente' ? 'selected' : ''}>Pendiente</option>
            <option value="en_revision" ${r.status === 'en_revision' ? 'selected' : ''}>En revisión</option>
            <option value="atendida" ${r.status === 'atendida' ? 'selected' : ''}>Atendida</option>
          </select>
        </td>
      </tr>`
    )
    .join('');
}

window.updateArcoStatus = async (reqId, newStatus) => {
  const { error } = await supabase.from('data_requests').update({ status: newStatus }).eq('id', reqId);
  if (error) {
    alert(`Error actualizando solicitud: ${error.message}`);
  } else {
    await loadAdminArcoRequests();
    await loadArcoRequests();
  }
};

function exportDashboardCsv() {
  if (!lastDashboardRows.length) return;
  const headers = [
    'periodo',
    'campus',
    'estamento',
    'muestra_n',
    'protegido_privacidad',
    'promedio_total_kgco2e',
    'promedio_electricidad',
    'promedio_gas',
    'promedio_transporte',
    'promedio_aereo',
  ];
  const lines = [headers.join(',')];

  for (const r of lastDashboardRows) {
    lines.push([
      `"${r.period_name}"`,
      `"${r.campus}"`,
      `"${r.tipo_usuario}"`,
      r.sample_size,
      r.privacy_protected,
      r.privacy_protected ? 'OCULTO_N_MENOR_10' : r.avg_total_kgco2e,
      r.privacy_protected ? 'OCULTO_N_MENOR_10' : r.avg_electricidad,
      r.privacy_protected ? 'OCULTO_N_MENOR_10' : r.avg_gas,
      r.privacy_protected ? 'OCULTO_N_MENOR_10' : r.avg_transporte,
      r.privacy_protected ? 'OCULTO_N_MENOR_10' : r.avg_aereo,
    ].join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `huellaviva_uan_agregado_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}