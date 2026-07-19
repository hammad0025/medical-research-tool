// Stable gather fingerprint — ties dossier/evidence/trials pools to a specific
// patient identity so synthesize cannot reuse stale data after profile edits.

const norm = (s) => String(s ?? '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const listParts = (value, { comma = true } = {}) => {
  const values = Array.isArray(value) ? value : [value];
  const splitter = comma ? /[,;\n]+/ : /[;\n]+/;
  return [...new Set(values.flatMap((entry) => String(entry ?? '').split(splitter))
    .map(norm)
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
};

const collection = (value, options) => listParts(value, options).join(';');

// Explicit contract: every patient field read by retrieval, eligibility,
// safety scoring, or synthesis belongs here. Labels prevent delimiter
// collisions and make future field additions reviewable.
export const GATHER_PATIENT_FIELDS = Object.freeze([
  'condition', 'gender', 'stage', 'age', 'weight', 'smoking', 'exercise',
  'diagnoses', 'medications', 'medicationHistory', 'allergies', 'symptoms',
  'labWork', 'scans', 'pregnancyStatus', 'renalFunction', 'hepaticFunction',
  'geneticVariant', 'caregiverContext'
]);

export const buildGatherFingerprint = ({
  condition = '',
  resolvedSlug = '',
  gender = '',
  stage = '',
  age = '',
  weight = '',
  smoking = '',
  exercise = '',
  diagnoses = '',
  medications = '',
  medicationHistory = '',
  allergies = '',
  symptoms = '',
  labWork = '',
  scans = '',
  pregnancyStatus = '',
  renalFunction = '',
  hepaticFunction = '',
  geneticVariant = '',
  caregiverContext = ''
} = {}) => {
  const fields = {
    condition: norm(resolvedSlug || condition),
    gender: norm(gender),
    stage: norm(stage),
    age: norm(age),
    weight: norm(weight),
    smoking: norm(smoking),
    exercise: norm(exercise),
    diagnoses: collection(diagnoses),
    medications: collection(medications),
    medicationHistory: collection(medicationHistory),
    allergies: collection(allergies),
    symptoms: collection(symptoms),
    // Commas often separate a test name from its value, so only independent
    // semicolon/newline clauses are order-insensitive for labs and scans.
    labWork: collection(labWork, { comma: false }),
    scans: collection(scans, { comma: false }),
    pregnancyStatus: norm(pregnancyStatus),
    renalFunction: norm(renalFunction),
    hepaticFunction: norm(hepaticFunction),
    geneticVariant: collection(geneticVariant),
    caregiverContext: norm(caregiverContext)
  };
  const parts = GATHER_PATIENT_FIELDS.map((key) => `${key}=${fields[key]}`);
  return fields.condition ? parts.join('|') : 'unknown';
};

export const buildGatherFingerprintFromPatient = (patient = {}, resolution = null) =>
  buildGatherFingerprint({
    condition: patient.condition,
    resolvedSlug: resolution?.resolvedSlug || resolution?.kbSlug || resolution?.resolved,
    gender: patient.gender,
    stage: patient.stage,
    age: patient.age,
    weight: patient.weight,
    smoking: patient.smoking,
    exercise: patient.exercise,
    diagnoses: patient.diagnoses,
    medications: patient.medications,
    medicationHistory: patient.medicationHistory,
    allergies: patient.allergies,
    symptoms: patient.symptoms,
    labWork: patient.labWork,
    scans: patient.scans,
    pregnancyStatus: patient.pregnancyStatus,
    renalFunction: patient.renalFunction || patient.renalStatus ||
      patient.kidneyFunction || patient.kidneyStatus || patient.renal,
    hepaticFunction: patient.hepaticFunction || patient.hepaticStatus ||
      patient.liverFunction || patient.liverStatus || patient.hepatic,
    geneticVariant: patient.geneticVariant,
    caregiverContext: patient.caregiverContext
  });

export const fingerprintsMatch = (a, b) =>
  !!a && !!b && String(a) === String(b);

/** Synth may accept pools gathered under clientFp even if live profile re-resolve drifted. */
export const gatherFingerprintAccepted = (clientFp, serverFp, poolFp = null) =>
  fingerprintsMatch(clientFp, serverFp) ||
  (!!poolFp && fingerprintsMatch(clientFp, poolFp));

/** Same-session synth with client-provided pools — only the gather stamp matters. */
export const poolBoundSynthValid = (clientFp, poolFp) =>
  fingerprintsMatch(clientFp, poolFp);
