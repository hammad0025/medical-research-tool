const normalized = (value) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const matches = (condition, pattern) => pattern.test(normalized(condition));

export const profileClinicalPlaceholders = (patient = {}) => {
  const condition = patient.condition || '';

  if (matches(condition, /\b(parkinson|parkinsons)\b/)) {
    return {
      stage: 'e.g. Hoehn and Yahr stage 2, if your clinician gave you a stage',
      labWork: 'e.g. neurological, movement, memory, blood-pressure, or other relevant test results',
      scans: 'e.g. brain MRI or DaTscan result and date, if one was performed',
      geneticVariant: 'e.g. LRRK2 or GBA1 result, a negative genetic test, or “Not tested”'
    };
  }

  if (matches(condition, /\b(ipf|pulmonary fibrosis|copd|asthma|interstitial lung)\b/)) {
    return {
      stage: 'e.g. GAP Stage II, if your clinician gave you a stage',
      labWork: 'e.g. FVC 58% predicted, DLCO 42%, or 6-minute walk result',
      scans: 'e.g. chest CT result and date',
      geneticVariant: 'e.g. a specific result, a negative genetic test, or “Not tested”'
    };
  }

  if (matches(condition, /\b(retinitis pigmentosa|leber congenital|macular degeneration|glaucoma)\b/)) {
    return {
      stage: 'Enter a stage only if your eye specialist gave you one',
      labWork: 'e.g. visual-field, ERG, visual-acuity, or other eye-test results',
      scans: 'e.g. OCT or retinal imaging result and date',
      geneticVariant: 'e.g. the gene and variant, a negative genetic test, or “Not tested”'
    };
  }

  return {
    stage: 'Enter a stage only if a clinician gave you one',
    labWork: 'Paste relevant test results and dates, if known',
    scans: 'e.g. MRI, CT, X-ray, ultrasound, or other imaging result and date',
    geneticVariant: 'e.g. a specific gene result, a negative genetic test, or “Not tested”'
  };
};

export const profileSafetyFields = (patient = {}) => {
  const hasMedicationSafetyContext = Boolean(
    String(patient.medications || '').trim() ||
    String(patient.diagnoses || '').trim() ||
    String(patient.renalFunction || '').trim() ||
    String(patient.hepaticFunction || '').trim()
  );
  const fields = [];

  if (hasMedicationSafetyContext) {
    fields.push(
      {
        k: 'renalFunction',
        l: 'Kidney function, if known',
        ta: true,
        ph: 'Optional — used only to check medicine safety and dosing'
      },
      {
        k: 'hepaticFunction',
        l: 'Liver function, if known',
        ta: true,
        ph: 'Optional — used only to check medicine safety and dosing'
      }
    );
  }

  if (
    normalized(patient.gender) !== 'male' ||
    String(patient.pregnancyStatus || '').trim()
  ) {
    fields.push({
      k: 'pregnancyStatus',
      l: 'Pregnancy or breastfeeding status, if relevant',
      ta: false,
      ph: 'Optional — pregnant, breastfeeding, not pregnant, or unknown'
    });
  }

  return fields;
};
