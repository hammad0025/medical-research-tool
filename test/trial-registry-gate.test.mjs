import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enforceTrialRegistryNarrative,
  fetchTrialRegistryFacts,
  registryFactsFromStudy,
  registryFactsFromStructuredTrial,
  sealTrialRegistryPayload,
  verifyTrialRegistryPayload,
  validateTrialRecord
} from '../lib/trial-registry-gate.js';
import {
  collectKbTrialRecords,
  validateStaticTrialRecord
} from '../scripts/audit-kb-trials.mjs';

const rawStudy = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT05321069',
      briefTitle: 'FIBRONEER-IPF'
    },
    statusModule: { overallStatus: 'COMPLETED' },
    designModule: { phases: ['PHASE3'], studyType: 'INTERVENTIONAL' },
    conditionsModule: { conditions: ['Idiopathic Pulmonary Fibrosis'] }
  }
};
const facts = registryFactsFromStudy(rawStudy);
const trials = {
  query: { condition: 'Idiopathic Pulmonary Fibrosis' },
  studies: [{
    nctId: 'NCT05321069',
    briefTitle: 'FIBRONEER-IPF',
    status: 'COMPLETED',
    phases: ['PHASE3'],
    conditions: ['Idiopathic Pulmonary Fibrosis'],
    studyType: 'INTERVENTIONAL'
  }]
};

test('matching NCT condition phase and status pass', () => {
  assert.deepEqual(validateTrialRecord({
    nctId: 'NCT05321069',
    statusText: 'Phase 3 completed trial',
    expectedConditions: ['IPF']
  }, facts), []);
});

test('wrong NCT condition phase and status mutations fail', () => {
  assert.deepEqual(validateTrialRecord({
    nctId: 'NCT05321068',
    statusText: 'Phase 2 recruiting trial',
    expectedConditions: ['Breast cancer']
  }, facts).sort(), [
    'NCT_CONDITION_MISMATCH',
    'NCT_ID_MISMATCH',
    'NCT_PHASE_MISMATCH',
    'NCT_STATUS_MISMATCH'
  ].sort());
});

test('trial admission rejects cross-subtype diabetes records', () => {
  const type2Facts = {
    nctId: 'NCT01234567',
    title: 'Type 2 diabetes trial',
    status: 'RECRUITING',
    phases: ['PHASE2'],
    conditions: ['Type 2 Diabetes Mellitus'],
    studyType: 'INTERVENTIONAL'
  };
  const issues = validateTrialRecord({
    nctId: 'NCT01234567',
    statusText: 'Phase 2 recruiting trial',
    expectedConditions: ['Type 1 diabetes', 'T1D', 'Diabetes mellitus']
  }, type2Facts);
  assert.ok(issues.includes('NCT_CONDITION_MISMATCH'));
});

test('missing registry record and URL-ID mismatch fail closed', () => {
  assert.deepEqual(validateTrialRecord({
    nctId: 'NCT05321069',
    statusText: '',
    expectedConditions: []
  }, null), ['NCT_NOT_FOUND']);
  assert.deepEqual(validateStaticTrialRecord({
    nctId: 'NCT05321069',
    url: 'https://clinicaltrials.gov/study/NCT05321068',
    hasRegistryPhase: true,
    hasRegistryStatus: true
  }), ['NCT_URL_ID_MISMATCH']);
});

test('KB trial collection carries condition and status expectations', () => {
  const records = collectKbTrialRecords({
    condition: 'Idiopathic Pulmonary Fibrosis',
    aliases: ['IPF'],
    pipelineDrugs: [{
      name: 'Nerandomilast',
      nct: 'NCT05321069',
      status: 'Phase 3 completed',
      registryPhases: ['PHASE3'],
      registryStatus: 'COMPLETED'
    }]
  }, 'ipf.json');
  assert.equal(records.length, 1);
  assert.equal(records[0].nctId, 'NCT05321069');
  assert.equal(records[0].statusText, 'PHASE3 COMPLETED');
  assert.deepEqual(records[0].expectedConditions, ['Idiopathic Pulmonary Fibrosis', 'IPF']);
});

test('ClinicalTrials.gov fetch parses authoritative structured fields', async () => {
  const result = await fetchTrialRegistryFacts('NCT05321069', {
    fetchImpl: async () => new Response(JSON.stringify(rawStudy), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.deepEqual(result, facts);
});

test('valid generated TRIAL block is preserved from structured registry facts', () => {
  assert.deepEqual(registryFactsFromStructuredTrial(trials.studies[0]), facts);
  const text = `TRIAL: FIBRONEER-IPF
NCT: NCT05321069
URL: https://clinicaltrials.gov/study/NCT05321069
PHASE: Phase 3
STATUS: completed
ACCEPTING: no`;
  const result = enforceTrialRegistryNarrative(text, trials, {
    expectedConditions: ['Idiopathic Pulmonary Fibrosis']
  });
  assert.equal(result.text, text);
  assert.deepEqual(result.issues, []);
});

test('swapped NCT identity is removed before narrative reaches users', () => {
  const registry = {
    ...trials,
    studies: [
      ...trials.studies,
      {
        ...trials.studies[0],
        nctId: 'NCT05321068',
        briefTitle: 'Different IPF Trial'
      }
    ]
  };
  const result = enforceTrialRegistryNarrative(`TRIAL: FIBRONEER-IPF
NCT: NCT05321068
URL: https://clinicaltrials.gov/study/NCT05321068
PHASE: Phase 3
STATUS: completed`, registry, {
    expectedConditions: ['Idiopathic Pulmonary Fibrosis']
  });
  assert.equal(result.text, '');
  assert.ok(result.issues.includes('NCT_TITLE_MISMATCH'));
});

test('wrong disease trial claim is removed', () => {
  const result = enforceTrialRegistryNarrative(
    'NCT05321069 is a Phase 3 completed trial.',
    trials,
    { expectedConditions: ['Breast cancer'] }
  );
  assert.equal(result.text, '');
  assert.ok(result.issues.includes('NCT_CONDITION_MISMATCH'));
});

test('wrong generated phase is removed', () => {
  const result = enforceTrialRegistryNarrative(`TRIAL: FIBRONEER-IPF
NCT: NCT05321069
URL: https://clinicaltrials.gov/study/NCT05321069
PHASE: Phase 2
STATUS: completed`, trials, {
    expectedConditions: ['Idiopathic Pulmonary Fibrosis']
  });
  assert.equal(result.text, '');
  assert.ok(result.issues.includes('NCT_PHASE_MISMATCH'));
});

test('stale recruiting status is removed', () => {
  const result = enforceTrialRegistryNarrative(`TRIAL: FIBRONEER-IPF
NCT: NCT05321069
URL: https://clinicaltrials.gov/study/NCT05321069
PHASE: Phase 3
STATUS: recruiting
ACCEPTING: yes`, trials, {
    expectedConditions: ['Idiopathic Pulmonary Fibrosis']
  });
  assert.equal(result.text, '');
  assert.ok(result.issues.includes('NCT_STATUS_MISMATCH'));
});

test('sealed registry payload rejects swapped and stale structured facts', () => {
  const now = 1_750_000_000_000;
  const secret = 'deterministic-trial-registry-test-secret';
  const payload = structuredClone(trials);
  payload.registrySeal = sealTrialRegistryPayload(payload, { secret, now });
  assert.equal(verifyTrialRegistryPayload(payload, { secret, now }).ok, true);

  const swapped = structuredClone(payload);
  swapped.studies[0].nctId = 'NCT05321068';
  assert.equal(verifyTrialRegistryPayload(swapped, { secret, now }).ok, false);

  const stale = structuredClone(payload);
  stale.studies[0].status = 'RECRUITING';
  assert.equal(verifyTrialRegistryPayload(stale, { secret, now }).ok, false);

  const forgedCoverage = structuredClone(payload);
  forgedCoverage.status = 'complete';
  forgedCoverage.degraded = false;
  assert.equal(verifyTrialRegistryPayload(forgedCoverage, { secret, now }).ok, false);
});
