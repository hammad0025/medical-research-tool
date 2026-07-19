import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGroundingIndex, isClaimGrounded } from '../lib/grounding-gate.js';
import {
  GATHER_PATIENT_FIELDS,
  buildGatherFingerprintFromPatient
} from '../lib/gather-fingerprint.js';
import {
  sealTranslationSource,
  validateSealedTranslation,
  validateTranslatedOutput
} from '../lib/translation-gate.js';

const falseNumericMatches = [
  ['Therapy reduced decline by 12.5 mL/year.', 'Unrelated marker measured 12.5 mL/year.'],
  ['Treatment used 40 mcg/week.', 'Unrelated marker measured 40 mcg/week.'],
  ['Infusion delivered 500 mg/month.', 'Unrelated marker measured 500 mg/month.'],
  ['Patients received 100 units/day.', 'Unrelated marker measured 100 units/day.'],
  ['Solution volume was 30 mL/week.', 'Unrelated marker measured 30 mL/week.'],
  ['Exposure was 75 mg/year.', 'Unrelated marker measured 75 mg/year.'],
  ['Annual decline was 18.2 mL/year.', 'Unrelated marker measured 18.2 mL/year.']
];

test('RC-SAFE-002 rejects all reported generic-word numeric false matches', () => {
  for (const [fact, mutation] of falseNumericMatches) {
    const index = buildGroundingIndex({ canonicalFacts: [fact] });
    assert.equal(isClaimGrounded(fact, index), true, `exact fact should survive: ${fact}`);
    assert.equal(isClaimGrounded(mutation, index), false, `must reject: ${mutation}`);
  }
});

test('RC-SAFE-002 keeps aligned numeric paraphrases and comparator context', () => {
  const index = buildGroundingIndex({
    canonicalFacts: [
      'Therapy reduced decline by 12.5 mL/year compared with placebo.',
      'Participants received a dose of 25 mg/day.'
    ]
  });
  assert.equal(
    isClaimGrounded('The treatment slowed loss by 12.5 mL/year versus placebo.', index),
    true
  );
  assert.equal(isClaimGrounded('A daily dose of 25 mg/day was administered.', index), true);
  assert.equal(
    isClaimGrounded('The treatment slowed loss by 12.5 mL/year versus active control.', index),
    false
  );
});

const basePatient = {
  condition: 'Example disease',
  gender: 'Female',
  stage: 'II',
  age: '52',
  weight: '70 kg',
  smoking: 'Never',
  exercise: 'Walks daily',
  diagnoses: 'Hypertension; diabetes',
  medications: 'Metformin, lisinopril',
  medicationHistory: 'Prior aspirin',
  allergies: 'Penicillin',
  symptoms: 'Fatigue; cough',
  labWork: 'eGFR 58; A1c 7.1%',
  scans: 'CT stable; MRI normal',
  pregnancyStatus: 'Not pregnant',
  renalFunction: 'CKD stage 3a',
  hepaticFunction: 'Normal',
  geneticVariant: 'BRCA1 positive',
  caregiverContext: 'Daughter assists'
};

test('RC-SAFE-003 fingerprints every retrieval, synthesis, and safety patient field', () => {
  assert.deepEqual(Object.keys(basePatient), [...GATHER_PATIENT_FIELDS]);
  const baseline = buildGatherFingerprintFromPatient(basePatient);
  for (const field of GATHER_PATIENT_FIELDS) {
    const changed = { ...basePatient, [field]: `${basePatient[field]} changed` };
    assert.notEqual(
      buildGatherFingerprintFromPatient(changed),
      baseline,
      `${field} must invalidate gathered pools`
    );
  }
});

test('RC-SAFE-003 normalizes order-insensitive collections deterministically', () => {
  const reordered = {
    ...basePatient,
    diagnoses: 'diabetes, hypertension',
    medications: ['lisinopril', 'metformin'],
    symptoms: 'cough; fatigue',
    labWork: 'A1c 7.1%; eGFR 58',
    scans: 'MRI normal; CT stable'
  };
  assert.equal(
    buildGatherFingerprintFromPatient(reordered),
    buildGatherFingerprintFromPatient(basePatient)
  );
});

const sourceReport = [
  '# Treatment status',
  '- Exampledrug is not approved at 25 mg/day [#2](https://pubmed.ncbi.nlm.nih.gov/12345678/).',
  '- Trial NCT12345678 is recruiting, with no placebo exposure.'
].join('\n');

test('RC-SAFE-004 accepts a structurally faithful sealed translation', () => {
  const sealed = sealTranslationSource(sourceReport);
  const translatedModelText = sealed.sealedText
    .replace('# Treatment status', '# Estado del tratamiento')
    .replace('Exampledrug is', 'Exampledrug está')
    .replace('at', 'a')
    .replace('Trial', 'El ensayo')
    .replace('is', 'está')
    .replace('with', 'con');
  const checked = validateSealedTranslation(sourceReport, translatedModelText, sealed.atoms);
  assert.equal(checked.ok, true, checked.reasons?.join('; '));
  assert.match(checked.text, /25 mg\/day/);
  assert.match(checked.text, /NCT12345678/);
});

test('RC-SAFE-004 rejects dose, negation, status, citation, and unsupported-claim mutations', () => {
  const mutations = [
    sourceReport.replace('25 mg/day', '50 mg/day'),
    sourceReport.replace('not approved', 'approved'),
    sourceReport.replace('recruiting', 'terminated'),
    sourceReport.replace('[#2]', '[#9]'),
    `${sourceReport}\n- Exampledrug cures the disease.`
  ];
  for (const mutation of mutations) {
    const checked = validateTranslatedOutput(sourceReport, mutation);
    assert.equal(checked.ok, false, `must reject mutation: ${mutation}`);
  }
});

test('RC-SAFE-004 rejects missing or duplicated sealed medical atoms', () => {
  const sealed = sealTranslationSource(sourceReport);
  const missing = sealed.sealedText.replace('⟦MRT-0⟧', '');
  const duplicated = `${sealed.sealedText} ⟦MRT-0⟧`;
  assert.equal(validateSealedTranslation(sourceReport, missing, sealed.atoms).ok, false);
  assert.equal(validateSealedTranslation(sourceReport, duplicated, sealed.atoms).ok, false);
});

test('RC-SAFE-004 seals named clinical entities and rejects substitutions', () => {
  const source = [
    'CONDITION: Idiopathic pulmonary fibrosis',
    'TREATMENT: Nintedanib',
    'GENE: MUC5B',
    'INTERVENTION: Pulmonary rehabilitation',
    'COMPARATOR: Standard supportive care',
    'OUTCOME: Forced vital capacity decline',
    '- Nintedanib was compared with placebo.'
  ].join('\n');
  const sealed = sealTranslationSource(source);
  for (const entity of [
    'Idiopathic pulmonary fibrosis',
    'Nintedanib',
    'MUC5B',
    'Pulmonary rehabilitation',
    'Standard supportive care',
    'Forced vital capacity decline',
    'placebo'
  ]) {
    assert.ok(sealed.atoms.some((atom) => atom.includes(entity)), entity);
  }

  const translated = sealed.sealedText
    .replace('CONDITION', 'ENFERMEDAD')
    .replace('TREATMENT', 'TRATAMIENTO')
    .replace('GENE', 'GEN')
    .replace('INTERVENTION', 'INTERVENCIÓN')
    .replace('COMPARATOR', 'COMPARADOR')
    .replace('OUTCOME', 'RESULTADO')
    .replace('was compared with', 'se comparó con');
  assert.equal(validateSealedTranslation(source, translated, sealed.atoms).ok, true);

  const substituted = source.replace('Nintedanib', 'Pirfenidone');
  assert.equal(validateTranslatedOutput(source, substituted).ok, false);
});
