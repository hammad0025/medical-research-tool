import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  stripDemographicMismatchLines,
  textWrongAgeBand
} from '../lib/demographic-gate.js';
import {
  normalizeTrialCoverage,
  trialCollectionDescription,
  trialCoverageMessage
} from '../lib/trial-coverage.js';
import {
  buildTrialsBlock,
  trimGatherPools,
  trimSynthPools
} from '../api/research.js';

const study = ({
  nctId = 'NCT00000001',
  status = 'RECRUITING',
  ole = false,
  designationKnown = true
} = {}) => ({
  nctId,
  status,
  briefTitle: `Study ${nctId}`,
  phases: ['PHASE2'],
  contacts: { locations: [] },
  interventions: [],
  url: `https://clinicaltrials.gov/study/${nctId}`,
  acceptingNewPatients: status === 'RECRUITING',
  isExpandedAccessStudy: false,
  designations: designationKnown ? { hasOpenLabelExtension: ole } : {}
});

test('inclusive pediatric/adult wording remains available to both age bands', () => {
  const inclusive = [
    'pediatric and adult trial',
    'adult/pediatric study',
    'children, adolescents, and adults may enroll',
    'not limited to pediatric-only patients; adults may enroll',
    'pediatric study for ages 12–65'
  ];
  for (const text of inclusive) {
    assert.equal(textWrongAgeBand(text, 10), false, `${text} should remain for children`);
    assert.equal(textWrongAgeBand(text, 50), false, `${text} should remain for adults`);
  }

  const retained = stripDemographicMismatchLines(
    'A pediatric and adult study is recruiting.',
    { age: 60 }
  );
  assert.equal(retained.text, 'A pediatric and adult study is recruiting.');
  assert.deepEqual(retained.removed, []);
});

test('exclusive and negated age wording still filters the opposite band', () => {
  const fixtures = [
    ['A pediatric trial is recruiting.', 50],
    ['A study in children is recruiting.', 40],
    ['An adults-only trial is recruiting.', 12],
    ['An adult trial is recruiting; children are excluded.', 12],
    ['A pediatric trial is recruiting; adults are excluded.', 45]
  ];
  for (const [text, age] of fixtures) {
    assert.equal(textWrongAgeBand(text, age), true, `${text} should filter age ${age}`);
  }
});

test('mixed-status presentation reports actual collection status without an all-open claim', () => {
  const trials = {
    studies: [
      study({ nctId: 'NCT00000011', status: 'RECRUITING' }),
      study({ nctId: 'NCT00000012', status: 'COMPLETED', ole: true })
    ]
  };
  assert.equal(
    trialCollectionDescription(trials),
    'ClinicalTrials.gov studies with mixed recruitment and access status (1 of 2 currently accepting or available).'
  );
});

test('OLE narrative uses only structured zero, one, multiple, unavailable, and unknown facts', () => {
  const zero = buildTrialsBlock({ studies: [study()] });
  assert.match(zero, /No records in this search were flagged as open-label extensions/);
  assert.doesNotMatch(zero, /most multi-year|usually|typically|planned extension/i);

  const one = buildTrialsBlock({
    studies: [study({ nctId: 'NCT00000021', ole: true })]
  });
  assert.match(one, /OPEN-LABEL EXTENSION STUDIES \(1 record/);
  assert.match(one, /NCT00000021 · PHASE2 · RECRUITING/);

  const multiple = buildTrialsBlock({
    studies: [
      study({ nctId: 'NCT00000022', ole: true }),
      study({ nctId: 'NCT00000023', ole: true })
    ]
  });
  assert.match(multiple, /OPEN-LABEL EXTENSION STUDIES \(2 record/);

  const unavailable = buildTrialsBlock({
    studies: [study({ nctId: 'NCT00000024', status: 'COMPLETED', ole: true })]
  });
  assert.match(unavailable, /NCT00000024 · PHASE2 · COMPLETED/);
  assert.doesNotMatch(unavailable, /currently available|open enrollment/i);

  const unknown = buildTrialsBlock({
    studies: [study({ nctId: 'NCT00000025', designationKnown: false })]
  });
  assert.match(unknown, /OLE status was not reported/);
  assert.match(unknown, /Do not infer whether an extension exists or is available/);
});

test('trial degradation survives normalized gather and synth round trips', () => {
  const providerFixtures = [
    [{ provider: 'ClinicalTrials.gov', query: 'primary', reason: 'timeout', error: 'secret upstream detail' }],
    [{ provider: 'ClinicalTrials.gov', query: 'expanded-access', reason: 'error' }],
    [
      { provider: 'ClinicalTrials.gov', query: 'primary', reason: 'timeout' },
      { provider: 'ClinicalTrials.gov', query: 'ole', reason: 'error' }
    ]
  ];

  for (const providerErrors of providerFixtures) {
    const trials = { studies: [study()], degraded: true, providerErrors };
    const gathered = trimGatherPools({ trials }).trials;
    const serialized = JSON.parse(JSON.stringify(gathered));
    const synthesized = trimSynthPools({ trials: serialized }).trials;
    assert.equal(synthesized.degraded, true);
    assert.equal(synthesized.providerErrors.length, providerErrors.length);
    assert.equal(synthesized.providerErrors.some((error) => 'error' in error), false);
    assert.match(trialCoverageMessage(synthesized), /coverage is incomplete/i);
    const narrative = buildTrialsBlock(synthesized);
    assert.match(narrative, /TRIAL SEARCH COVERAGE NOTICE/);
    assert.doesNotMatch(narrative, /secret upstream detail|query:|stack trace/i);
  }

  const healthy = trimGatherPools({ trials: { studies: [study()] } }).trials;
  assert.deepEqual(normalizeTrialCoverage(healthy), {
    status: 'complete',
    cancelled: false,
    degraded: false,
    providerErrors: []
  });
  assert.equal(trialCoverageMessage(healthy), '');
  assert.doesNotMatch(buildTrialsBlock(healthy), /COVERAGE NOTICE/);
});

test('trial cancellation survives coverage normalization and pool round trips', () => {
  const trials = {
    status: 'cancelled',
    cancelled: true,
    degraded: true,
    studies: [],
    providerErrors: [
      { provider: 'ClinicalTrials.gov', query: 'primary', reason: 'cancelled', error: 'caller detail' }
    ]
  };
  const gathered = trimGatherPools({ trials }).trials;
  const synthesized = trimSynthPools({ trials: JSON.parse(JSON.stringify(gathered)) }).trials;
  assert.equal(synthesized.status, 'cancelled');
  assert.equal(synthesized.cancelled, true);
  assert.equal(synthesized.providerErrors[0].reason, 'cancelled');
  assert.match(trialCoverageMessage(synthesized), /cancelled before completion/i);
  assert.doesNotMatch(trialCoverageMessage(synthesized), /caller detail/i);
});

test('screen and export share mixed-status and safe coverage presentation', async () => {
  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  assert.ok(source.match(/trialCollectionDescription\(trialsData\)/g)?.length >= 2);
  assert.ok(source.match(/trialCoverageMessage\(trialsData\)/g)?.length >= 2);
  assert.match(source, /trialsData\.status === 'cancelled'/);
  assert.match(source, /trialsData\?\.studies\?\.length > 0 \|\| trialCoverageMessage\(trialsData\)/);
  assert.match(source, /s\.overallStatus \|\| s\.status/);
  assert.match(source, /humanizeRegistryValue\(s\.status\)/);
  assert.doesNotMatch(source, /Open-enrollment studies|Studies with open enrollment|Can keep drug after/);
});
