const BILL_RANGE_TO_COP = {
  bajo: 60000,      // Menos de $80.000 COP
  medio: 115000,    // Entre $80.000 y $150.000 COP
  alto: 200000,     // Entre $150.000 y $250.000 COP
  muy_alto: 320000, // Más de $250.000 COP
};

// Tarifa residencial promedio de referencia (COP/kWh) para estimación académica
const AVG_TARIFF_COP_PER_KWH = 900;

// Distancias promedio de referencia por trayecto (km) cuando se reporta número de vuelos
const AVG_DOMESTIC_FLIGHT_KM = 550;
const AVG_INTERNATIONAL_FLIGHT_KM = 3200;

function findFactor(factors, { codes = [], category = '', keywords = [] }) {
  for (const code of codes) {
    const byCode = factors.find((f) => f.factor_code === code);
    if (byCode) return byCode;
  }
  if (category) {
    const byCat = factors.filter((f) => (f.category || '').toLowerCase() === category.toLowerCase());
    if (byCat.length === 1) return byCat[0];
    if (byCat.length > 1 && keywords.length) {
      const matched = byCat.find((f) =>
        keywords.some((kw) => `${f.factor_code} ${f.factor_name}`.toLowerCase().includes(kw.toLowerCase()))
      );
      if (matched) return matched;
    }
    if (byCat.length > 0) return byCat[0];
  }
  return null;
}

export function calculateCarbonFootprint(input, activeFactors, methodologyVersion = 'MET-HV-UAN-v1.0') {
  const details = [];
  const members = Math.max(1, Number(input.householdMembers) || 1);

  // 1. ELECTRICIDAD DEL HOGAR (Per cápita = consumo hogar / personas)
  const elecFactor = findFactor(activeFactors, {
    codes: ['EL_SIN_CO', 'ELEC_SIN_CO', 'SIN_CO'],
    category: 'electricidad',
    keywords: ['sin', 'elec', 'kwh'],
  });

  let rawElecKwh = Number(input.electricityKwh) || 0;
  let elecIsEstimated = Boolean(input.electricityEstimated);
  let elecNote = 'Consumo reportado de factura';

  if (input.electricityUnknown) {
    const copEstimate = BILL_RANGE_TO_COP[input.electricityBillRange] || 115000;
    rawElecKwh = Math.round((copEstimate / AVG_TARIFF_COP_PER_KWH) * 10) / 10;
    elecIsEstimated = true;
    elecNote = `Estimado desde rango de factura (~$${copEstimate.toLocaleString('es-CO')} COP / $${AVG_TARIFF_COP_PER_KWH} COP/kWh)`;
  }

  const perCapitaElecKwh = Math.round((rawElecKwh / members) * 100) / 100;
  const elecFactorVal = elecFactor ? Number(elecFactor.factor_value) : 0.164;
  const elecEmissions = Math.round(perCapitaElecKwh * elecFactorVal * 100) / 100;

  details.push({
    category: 'electricidad',
    categoryLabel: 'Electricidad del hogar (per cápita)',
    questionCode: 'ELEC_HOGAR_KWH',
    factorId: elecFactor?.id || null,
    factorCode: elecFactor?.factor_code || 'EL_SIN_CO',
    factorValue: elecFactorVal,
    factorVersion: elecFactor?.version || 'v1.0',
    source: elecFactor?.source || 'UPME - Factor emisión SIN Colombia',
    referenceYear: elecFactor?.reference_year || 2024,
    rawActivity: rawElecKwh,
    convertedActivity: perCapitaElecKwh,
    unit: elecFactor?.unit_activity || 'kWh',
    isEstimated: elecIsEstimated,
    note: `${elecNote} · Dividido entre ${members} persona(s)`,
    emissionsKg: elecEmissions,
  });

  // 2. GAS Y COMBUSTIBLES DOMÉSTICOS (Per cápita si hay consumo)
  if (input.gasType && input.gasType !== 'ninguno' && Number(input.gasAmount) > 0) {
    const gasFactor = findFactor(activeFactors, {
      codes: [input.gasType],
      category: 'gas',
      keywords: input.gasType === 'GLP_CIL_CO' ? ['glp', 'pipeta', 'kg'] : ['natural', 'm3'],
    });

    const rawGas = Number(input.gasAmount) || 0;
    const perCapitaGas = Math.round((rawGas / members) * 100) / 100;
    const defaultGasVal = input.gasType === 'GLP_CIL_CO' ? 2.98 : 1.98;
    const gasFactorVal = gasFactor ? Number(gasFactor.factor_value) : defaultGasVal;
    const gasEmissions = Math.round(perCapitaGas * gasFactorVal * 100) / 100;

    details.push({
      category: 'gas',
      categoryLabel: input.gasType === 'GLP_CIL_CO' ? 'Gas GLP / Pipeta (per cápita)' : 'Gas Natural Residencial (per cápita)',
      questionCode: 'GAS_HOGAR',
      factorId: gasFactor?.id || null,
      factorCode: gasFactor?.factor_code || input.gasType,
      factorValue: gasFactorVal,
      factorVersion: gasFactor?.version || 'v1.0',
      source: gasFactor?.source || 'UPME - FECOC Colombia',
      referenceYear: gasFactor?.reference_year || 2024,
      rawActivity: rawGas,
      convertedActivity: perCapitaGas,
      unit: gasFactor?.unit_activity || (input.gasType === 'GLP_CIL_CO' ? 'kg' : 'm³'),
      isEstimated: Boolean(input.gasEstimated),
      note: `Consumo hogar dividido entre ${members} persona(s)`,
      emissionsKg: gasEmissions,
    });
  }

  // 3. DESPLAZAMIENTO COTIDIANO AL CAMPUS (Días * km ida y vuelta)
  const campusDays = Math.max(0, Number(input.campusDays) || 0);
  const roundTripKm = Math.max(0, Number(input.roundTripKm) || 0);
  const totalCampusKm = Math.round(campusDays * roundTripKm * 100) / 100;

  const transportFactor = findFactor(activeFactors, {
    codes: [input.transportMode],
    category: 'transporte',
    keywords: [input.transportMode.replace('TR_', '').toLowerCase()],
  });

  const fallbackTransport = {
    TR_PIE_BICI: 0,
    TR_BUS_URB: 0.089,
    TR_MOTO: 0.103,
    TR_CARRO: 0.192,
  };
  const transFactorVal = transportFactor
    ? Number(transportFactor.factor_value)
    : (fallbackTransport[input.transportMode] ?? 0.089);
  const transEmissions = Math.round(totalCampusKm * transFactorVal * 100) / 100;

  const transportLabels = {
    TR_PIE_BICI: 'Desplazamiento campus (A pie / Bicicleta)',
    TR_BUS_URB: 'Desplazamiento campus (Transporte público)',
    TR_MOTO: 'Desplazamiento campus (Motocicleta)',
    TR_CARRO: 'Desplazamiento campus (Automóvil particular)',
  };

  details.push({
    category: 'transporte',
    categoryLabel: transportLabels[input.transportMode] || 'Desplazamiento al campus',
    questionCode: 'TRANSPORTE_CAMPUS_KM',
    factorId: transportFactor?.id || null,
    factorCode: transportFactor?.factor_code || input.transportMode,
    factorValue: transFactorVal,
    factorVersion: transportFactor?.version || 'v1.0',
    source: transportFactor?.source || 'UPME / FECOC Transporte',
    referenceYear: transportFactor?.reference_year || 2024,
    rawActivity: totalCampusKm,
    convertedActivity: totalCampusKm,
    unit: transportFactor?.unit_activity || 'km',
    isEstimated: false,
    note: `${campusDays} días × ${roundTripKm} km ida y vuelta`,
    emissionsKg: transEmissions,
  });

  // 4. VIAJES AÉREOS EN EL PERIODO (Nacionales e Internacionales)
  const domFlights = Math.max(0, Number(input.domesticFlights) || 0);
  if (domFlights > 0) {
    const domFactor = findFactor(activeFactors, {
      codes: ['AER_NAC', 'VUELO_NAC'],
      category: 'aereo',
      keywords: ['nac', 'dom'],
    });
    const usesKm = (domFactor?.unit_activity || '').toLowerCase().includes('km');
    const convertedDom = usesKm ? domFlights * AVG_DOMESTIC_FLIGHT_KM : domFlights;
    const domVal = domFactor ? Number(domFactor.factor_value) : (usesKm ? 0.156 : 85.8);
    const domEmissions = Math.round(convertedDom * domVal * 100) / 100;

    details.push({
      category: 'aereo',
      categoryLabel: 'Viajes aéreos nacionales',
      questionCode: 'VUELOS_NACIONALES',
      factorId: domFactor?.id || null,
      factorCode: domFactor?.factor_code || 'AER_NAC',
      factorValue: domVal,
      factorVersion: domFactor?.version || 'v1.0',
      source: domFactor?.source || 'DEFRA / IPCC Adaptado',
      referenceYear: domFactor?.reference_year || 2024,
      rawActivity: domFlights,
      convertedActivity: convertedDom,
      unit: domFactor?.unit_activity || 'trayecto',
      isEstimated: true,
      note: `${domFlights} trayecto(s) nacional(es)`,
      emissionsKg: domEmissions,
    });
  }

  const intFlights = Math.max(0, Number(input.internationalFlights) || 0);
  if (intFlights > 0) {
    const intFactor = findFactor(activeFactors, {
      codes: ['AER_INT', 'VUELO_INT'],
      category: 'aereo',
      keywords: ['int'],
    });
    const usesKm = (intFactor?.unit_activity || '').toLowerCase().includes('km');
    const convertedInt = usesKm ? intFlights * AVG_INTERNATIONAL_FLIGHT_KM : intFlights;
    const intVal = intFactor ? Number(intFactor.factor_value) : (usesKm ? 0.148 : 473.6);
    const intEmissions = Math.round(convertedInt * intVal * 100) / 100;

    details.push({
      category: 'aereo',
      categoryLabel: 'Viajes aéreos internacionales',
      questionCode: 'VUELOS_INTERNACIONALES',
      factorId: intFactor?.id || null,
      factorCode: intFactor?.factor_code || 'AER_INT',
      factorValue: intVal,
      factorVersion: intFactor?.version || 'v1.0',
      source: intFactor?.source || 'DEFRA / IPCC Adaptado',
      referenceYear: intFactor?.reference_year || 2024,
      rawActivity: intFlights,
      convertedActivity: convertedInt,
      unit: intFactor?.unit_activity || 'trayecto',
      isEstimated: true,
      note: `${intFlights} trayecto(s) internacional(es)`,
      emissionsKg: intEmissions,
    });
  }

  const totalKgCo2e = Math.round(details.reduce((sum, d) => sum + d.emissionsKg, 0) * 100) / 100;
  const totalTonsCo2e = Math.round((totalKgCo2e / 1000) * 10000) / 10000;

  return {
    methodologyVersion,
    totalKgCo2e,
    totalTonsCo2e,
    details,
    recommendations: buildRecommendations(details, input),
  };
}

export function buildRecommendations(details, input = {}) {
  if (!details.length) return [];
  const sorted = [...details].sort((a, b) => b.emissionsKg - a.emissionsKg);
  const top = sorted[0];
  const recs = [];

  if (top && top.emissionsKg > 0) {
    recs.push(
      `Tu categoría de mayor contribución en este periodo es "${top.categoryLabel}" (${top.emissionsKg.toFixed(2)} kg CO₂e). Enfocar pequeños ajustes aquí generará el mayor impacto.`
    );
  }

  const transItem = details.find((d) => d.category === 'transporte');
  if (transItem && transItem.emissionsKg > 0) {
    if (input.transportMode === 'TR_CARRO' || input.transportMode === 'TR_MOTO') {
      recs.push(
        'Movilidad al campus: Considera compartir vehículo (carpooling) con compañeros de la UAN o alternar 1 o 2 días a la semana con transporte público o bicicleta.'
      );
    } else {
      recs.push(
        'Movilidad al campus: Ya utilizas modos de baja emisión por pasajero; combinar trayectos cortos a pie o en bici reduce aún más tu huella.'
      );
    }
  }

  const elecItem = details.find((d) => d.category === 'electricidad');
  if (elecItem && elecItem.emissionsKg > 15) {
    recs.push(
      'Energía en el hogar: Desconectar equipos en modo espera (stand-by), aprovechar iluminación natural para estudiar y optimizar el uso de electrodomésticos térmicos ayuda a reducir el consumo mensual en kWh.'
    );
  }

  const airItem = details.find((d) => d.category === 'aereo');
  if (airItem && airItem.emissionsKg > 0) {
    recs.push(
      'Viajes aéreos: Para reuniones académicas o administrativas cortas, evalúa la modalidad virtual cuando sea viable, ya que los vuelos concentran una alta intensidad de emisiones por trayecto.'
    );
  }

  if (recs.length < 2) {
    recs.push(
      'Sigue registrando tus datos mes a mes con valores reales de factura para monitorear la evolución de tus hábitos sin estimaciones.'
    );
  }

  return recs;
}