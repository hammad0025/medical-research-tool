export const REPORT_PATIENT_FIELD_POLICY = Object.freeze({
  condition: { label: 'Condition', include: true },
  stage: { label: 'Stage/severity', include: true },
  age: { label: 'Age', include: true },
  gender: { label: 'Gender/sex', include: true },
  weight: { label: 'Weight', include: true },
  smoking: { label: 'Smoking history', include: true },
  exercise: { label: 'Activity', include: true },
  diagnoses: { label: 'Current diagnoses', include: true },
  medications: { label: 'Current medicines and supplements', include: true },
  medicationHistory: { label: 'Prior treatments', include: true },
  allergies: { label: 'Allergies', include: true },
  symptoms: { label: 'Current symptoms', include: true },
  labWork: { label: 'Lab and test results', include: true },
  scans: { label: 'Recent imaging', include: true },
  pregnancyStatus: { label: 'Pregnancy/breastfeeding status', include: true },
  renalFunction: { label: 'Kidney/renal function', include: true },
  hepaticFunction: { label: 'Liver/hepatic function', include: true },
  geneticVariant: { label: 'Gene test result', include: true },
  caregiverContext: { label: 'Caregiver context', include: true }
});

export const buildCanonicalReportModel = ({
  patient = {},
  researchText = '',
  repurposeText = '',
  treatments = [],
  candidates = [],
  combos = [],
  trialsData = null,
  trialsText = '',
  references = [],
  evidenceSummary = null,
  evidencePack = []
} = {}) => {
  const patientFields = Object.entries(REPORT_PATIENT_FIELD_POLICY).map(([key, policy]) => ({
    key,
    label: policy.label,
    included: policy.include,
    value: policy.include ? String(patient[key] || '').trim() : '',
    omissionReason: policy.include
      ? (String(patient[key] || '').trim() ? null : 'Not provided by the user')
      : 'Excluded by the published report field policy'
  }));
  return Object.freeze({
    schemaVersion: 1,
    patient: Object.freeze({ ...patient }),
    patientFields: Object.freeze(patientFields),
    sections: Object.freeze({
      researchText: String(researchText || ''),
      repurposeText: String(repurposeText || ''),
      treatments: Object.freeze([...(treatments || [])]),
      candidates: Object.freeze([...(candidates || [])]),
      combos: Object.freeze([...(combos || [])]),
      trialsData,
      trialsText: String(trialsText || ''),
      references: Object.freeze([...(references || [])]),
      evidenceSummary,
      evidencePack: Object.freeze([...(evidencePack || [])])
    })
  });
};
