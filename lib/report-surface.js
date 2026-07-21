const canonicalizeReportContent = (value) =>
  String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();

const line = (label, value) => {
  const text = String(value == null ? '' : value).trim();
  return text ? `${label}: ${text}` : '';
};

const patientBlock = (patient = {}) => [
  '# Patient context',
  line('Condition', patient.condition),
  line('Stage/severity', patient.stage),
  line('Age', patient.age),
  line('Gender/sex', patient.gender || patient.sex),
  line('Current diagnoses', patient.diagnoses),
  line('Current medicines and supplements', patient.medications),
  line('Prior treatments', patient.medicationHistory),
  line('Allergies', patient.allergies),
  line('Current symptoms', patient.symptoms),
  line('Lab and test results', patient.labWork),
  line('Recent imaging', patient.scans),
  line('Pregnancy/breastfeeding status', patient.pregnancyStatus),
  line('Kidney/renal function', patient.renalFunction),
  line('Liver/hepatic function', patient.hepaticFunction),
  line('Gene test result', patient.geneticVariant),
  line('Caregiver context', patient.caregiverContext)
].filter(Boolean).join('\n');

const trialBlock = (trials = {}) => {
  const studies = Array.isArray(trials.studies) ? trials.studies : [];
  const rows = studies.slice(0, 25).map((study) => [
    `## ${study.briefTitle || study.officialTitle || study.title || study.nctId || 'Clinical trial'}`,
    line('NCT', study.nctId),
    line('Status', study.status || study.overallStatus),
    line('Phase', Array.isArray(study.phases) ? study.phases.join(', ') : study.phase),
    line('Conditions', Array.isArray(study.conditions) ? study.conditions.join(', ') : ''),
    line('Accepting inquiries', study.acceptingNewPatients === true ? 'Yes' : 'No'),
    line('URL', study.url)
  ].filter(Boolean).join('\n'));
  return [
    '# Clinical trials',
    line('Search status', trials.status || (studies.length ? 'complete' : 'empty')),
    ...rows
  ].filter(Boolean).join('\n\n');
};

export const buildCanonicalReportSurface = ({
  surface = 'full',
  patient = {},
  researchText = '',
  repurposeText = '',
  trials = {}
} = {}) => {
  if (surface === 'research') return canonicalizeReportContent(researchText);
  if (surface === 'repurpose') return canonicalizeReportContent(repurposeText);
  if (surface !== 'full') return '';
  return canonicalizeReportContent([
    '# Complete medical research report',
    patientBlock(patient),
    '# Condition research',
    researchText,
    trialBlock(trials),
    '# Treatment and supportive-care research ideas',
    repurposeText
  ].filter(Boolean).join('\n\n'));
};
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const scalarText = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};

const safeTextList = (value) =>
  (Array.isArray(value) ? value : [])
    .map(scalarText)
    .map((item) => item.trim())
    .filter(Boolean);

const safeRecord = (value) => isRecord(value) ? value : {};

const normalizeTrialStudy = (value) => {
  const study = safeRecord(value);
  const assessment = safeRecord(study.eligibilityAssessment);
  return {
    ...study,
    nctId: scalarText(study.nctId),
    nct: scalarText(study.nct),
    url: scalarText(study.url),
    title: scalarText(study.title),
    briefTitle: scalarText(study.briefTitle),
    officialTitle: scalarText(study.officialTitle),
    sponsor: scalarText(study.sponsor),
    status: scalarText(study.status),
    overallStatus: scalarText(study.overallStatus),
    relevanceLabel: scalarText(study.relevanceLabel),
    relevanceReason: scalarText(study.relevanceReason),
    caution: scalarText(study.caution),
    phases: safeTextList(study.phases),
    countries: safeTextList(study.countries),
    contacts: Array.isArray(study.contacts)
      ? study.contacts.filter(isRecord)
      : [],
    designations: safeRecord(study.designations),
    oversight: safeRecord(study.oversight),
    eligibilityAssessment: {
      ...assessment,
      status: scalarText(assessment.status),
      caution: scalarText(assessment.caution),
      checks: Array.isArray(assessment.checks)
        ? assessment.checks.filter(isRecord)
        : []
    },
    acceptingNewPatients: typeof study.acceptingNewPatients === 'boolean'
      ? study.acceptingNewPatients
      : null,
    hasPlacebo: typeof study.hasPlacebo === 'boolean'
      ? study.hasPlacebo
      : null
  };
};

export const normalizeTrialStudies = (value) =>
  (Array.isArray(value) ? value : []).map(normalizeTrialStudy);

export const trialBooleanLabel = (value, {
  unknown = 'Unknown',
  falseLabel = 'No'
} = {}) => value === true ? 'Yes' : value === false ? falseLabel : unknown;

export const cachedCompletionForClipboard = (cached, reportContent, now = Date.now()) => {
  if (!cached || cached.reportContent !== reportContent) return null;
  const contract = cached.contract;
  const expiresAt = Number(String(contract?.seal || '').split('.')[2]);
  if (
    contract?.eligible !== true ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Number(now)
  ) return null;
  return contract;
};
