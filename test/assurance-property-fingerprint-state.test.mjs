import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATHER_PATIENT_FIELDS,
  buildGatherFingerprint,
  buildGatherFingerprintFromPatient,
  fingerprintsMatch,
  gatherFingerprintAccepted,
  poolBoundSynthValid
} from '../lib/gather-fingerprint.js';
import {
  assessReportCompletion,
  sealReportCompletion,
  verifyReportCompletionSeal
} from '../lib/report-completion.js';
import { TERMS_VERSION } from '../lib/terms-consent.js';

const seeded = (seed = 0xf17e) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

const basePatient = Object.fromEntries(
  GATHER_PATIENT_FIELDS.map((field, index) => [field, `${field}-${index}`])
);
basePatient.condition = 'Parkinson disease';
basePatient.diagnoses = 'hypertension; asthma; diabetes';
basePatient.medications = 'levodopa, aspirin, metformin';
basePatient.labWork = 'A1c 7.1%, fasting; eGFR 58';
basePatient.scans = 'MRI brain, stable; CT chest, clear';

const passingValidation = () => ({
  primary: {
    overallScore: 100,
    agreement: 'high',
    confirmed: [],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'Fixture validation passed.'
  }
});

const validCompletion = () => ({
  profileKey: 'profile-v1',
  termsVersion: TERMS_VERSION,
  sections: {
    research: { text: 'Research.', profileKey: 'profile-v1' },
    repurpose: { text: 'Repurpose.', profileKey: 'profile-v1' }
  },
  trials: { status: 'complete', profileKey: 'profile-v1' },
  audits: {
    validation: {
      research: passingValidation(),
      repurpose: passingValidation()
    },
    citations: {
      research: { status: 'passed' },
      repurpose: { status: 'passed' }
    },
    coverage: { status: 'passed', finalMissed: [] }
  }
});

test('fingerprint changes for every contract field and ignores unconsumed fields', () => {
  const baseline = buildGatherFingerprintFromPatient(basePatient);
  for (const field of GATHER_PATIENT_FIELDS) {
    const changed = { ...basePatient, [field]: `${basePatient[field]}-mutation` };
    assert.notEqual(buildGatherFingerprintFromPatient(changed), baseline, `${field} mutation escaped`);
  }
  assert.equal(
    buildGatherFingerprintFromPatient({ ...basePatient, uiTheme: 'dark' }),
    baseline,
    'unconsumed presentation state must not invalidate retrieval'
  );
});

test('seeded collection permutations, duplicates, case, and whitespace are fingerprint-invariant', () => {
  const random = seeded();
  const values = ['Aspirin', 'Metformin', 'Levodopa'];
  const canonical = buildGatherFingerprint({
    condition: 'Parkinson Disease',
    medications: values
  });
  for (let i = 0; i < 80; i += 1) {
    const shuffled = [...values].sort(() => random() - 0.5);
    if (random() < 0.5) shuffled.push(shuffled[0]);
    const noisy = shuffled.map((value) =>
      `${random() < 0.5 ? value.toUpperCase() : value.toLowerCase()} ${random() < 0.5 ? ' ' : ''}`
    );
    assert.equal(buildGatherFingerprint({
      condition: '  PARKINSON   disease ',
      medications: noisy
    }), canonical);
  }
});

test('lab commas preserve test/value identity while semicolon clauses are reorderable', () => {
  const first = buildGatherFingerprint({
    condition: 'x',
    labWork: 'A1c 7.1%, fasting; eGFR 58'
  });
  assert.equal(first, buildGatherFingerprint({
    condition: 'x',
    labWork: 'eGFR 58; A1c 7.1%, fasting'
  }));
  assert.notEqual(first, buildGatherFingerprint({
    condition: 'x',
    labWork: 'A1c 7.1%; fasting, eGFR 58'
  }));
});

test('condition resolution and renal/hepatic aliases obey stable precedence', () => {
  const direct = buildGatherFingerprintFromPatient({
    condition: 'Display condition',
    renalStatus: 'moderate',
    liverStatus: 'normal'
  }, { resolvedSlug: 'canonical-slug' });
  assert.match(direct, /^condition=canonical-slug\|/);
  assert.match(direct, /\|renalFunction=moderate\|hepaticFunction=normal\|/);

  const precedence = buildGatherFingerprintFromPatient({
    condition: 'Display condition',
    renalFunction: 'primary',
    renalStatus: 'secondary',
    hepaticFunction: 'primary',
    liverStatus: 'secondary'
  });
  assert.match(precedence, /\|renalFunction=primary\|hepaticFunction=primary\|/);
  assert.equal(buildGatherFingerprint({}), 'unknown');
});

test('fingerprint acceptance truth table never accepts missing or unrelated state', () => {
  for (const value of [null, undefined, '', 0, false]) {
    assert.equal(fingerprintsMatch(value, value), false);
    assert.equal(poolBoundSynthValid(value, value), false);
  }
  assert.equal(gatherFingerprintAccepted('a', 'a'), true);
  assert.equal(gatherFingerprintAccepted('a', 'b', 'a'), true);
  assert.equal(gatherFingerprintAccepted('a', 'b', 'c'), false);
  assert.equal(gatherFingerprintAccepted('a', '', ''), false);
  assert.equal(poolBoundSynthValid('a', 'a'), true);
  assert.equal(poolBoundSynthValid('a', 'b'), false);
});

test('report completion is monotonic: every required-state mutation blocks or degrades', () => {
  const full = assessReportCompletion(validCompletion(), { termsAccepted: true });
  assert.equal(full.classification, 'full');

  const blockers = [
    (x) => { x.sections.research.text = '   '; },
    (x) => { x.sections.repurpose.profileKey = 'stale'; },
    (x) => { x.trials.status = 'loading'; },
    (x) => { x.trials.profileKey = 'stale'; },
    (x) => { x.termsVersion = 'stale'; },
    (x) => { x.audits.validation.research = { status: 'failed' }; },
    (x) => { x.audits.citations.repurpose = { status: 'failed' }; },
    (x) => { x.audits.coverage = { finalMissed: ['required source'] }; }
  ];
  for (const mutate of blockers) {
    const input = structuredClone(validCompletion());
    mutate(input);
    const result = assessReportCompletion(input, { termsAccepted: true });
    assert.equal(result.classification, 'blocked', JSON.stringify(result));
    assert.equal(result.eligible, false);
  }

  const degraded = structuredClone(validCompletion());
  degraded.evidenceDegraded = true;
  assert.equal(
    assessReportCompletion(degraded, { termsAccepted: true }).classification,
    'degraded'
  );
});

test('report contract sealing is deterministic and mutation-sensitive', () => {
  const contract = assessReportCompletion(validCompletion(), { termsAccepted: true });
  const options = {
    now: 1_700_000_000_000,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    secret: 'property-test-report-seal-key'
  };
  const seal = sealReportCompletion(contract, options);
  assert.equal(sealReportCompletion(structuredClone(contract), options), seal);
  assert.equal(verifyReportCompletionSeal({
    contract,
    seal,
    now: options.now + 1,
    secret: options.secret
  }).ok, true);

  for (const [field, value] of [
    ['profileKey', 'profile-v2'],
    ['eligible', false],
    ['classification', 'degraded'],
    ['label', 'MUTATED']
  ]) {
    assert.notDeepEqual(contract[field], value, `${field} mutation must change the field`);
    assert.notEqual(
      sealReportCompletion({ ...contract, [field]: value }, options),
      seal,
      `${field} was not sealed`
    );
  }
});
