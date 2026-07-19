import test from 'node:test';
import assert from 'node:assert/strict';

import { assessReportCompletion } from '../lib/report-completion.js';
import { injectApprovedTreatmentStubs } from '../lib/drug-card-utils.js';
import { TERMS_VERSION } from '../lib/terms-consent.js';

const validation = () => ({
  status: 'passed',
  primary: {
    overallScore: 95,
    agreement: 'high',
    confirmed: [],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'Passed'
  }
});

const input = () => ({
  outputQualityVersion: '1',
  profileKey: 'parkinson-profile',
  termsVersion: TERMS_VERSION,
  sections: {
    research: {
      profileKey: 'parkinson-profile',
      text: [
        'PROVIDER: AbbVie',
        'TREATMENT: Foscarbidopa/foslevodopa',
        'REFERENCES: [FDA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc)'
      ].join('\n')
    },
    repurpose: {
      profileKey: 'parkinson-profile',
      text: [
        'CANDIDATE: Example research idea',
        'REFERENCES: [Study](https://pubmed.ncbi.nlm.nih.gov/12345678/)'
      ].join('\n')
    }
  },
  trials: { status: 'complete', profileKey: 'parkinson-profile' },
  audits: {
    validation: { research: validation(), repurpose: validation() },
    citations: { research: { status: 'passed' }, repurpose: { status: 'passed' } },
    coverage: { status: 'passed' }
  }
});

test('completion blocks manufacturer-only approved-treatment cards', () => {
  const value = input();
  value.sections.research.text = [
    'PROVIDER: Abbott / AbbVie',
    'FDA_STATUS: approved',
    'REFERENCES: [FDA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc)'
  ].join('\n');
  const result = assessReportCompletion(value, { termsAccepted: true });
  assert.equal(result.eligible, false);
  assert.ok(result.failed.includes('quality:approved-cards'));
});

test('completion blocks an empty source-supported research-ideas section', () => {
  const value = input();
  value.sections.repurpose.text = 'No ideas survived.';
  const result = assessReportCompletion(value, { termsAccepted: true });
  assert.equal(result.eligible, false);
  assert.ok(result.failed.includes('quality:repurpose-empty'));
});

test('completion blocks unsupported danger directives in markdown rows', () => {
  const value = input();
  value.sections.research.text += [
    '',
    '| Drug | Effect | Severity |',
    '|---|---|---|',
    '| Levodopa | Not established from the gathered sources. | High — avoid |'
  ].join('\n');
  const result = assessReportCompletion(value, { termsAccepted: true });
  assert.equal(result.eligible, false);
  assert.ok(result.failed.includes('quality:contradictory-rows'));
});

test('approved reference entries require an exact DailyMed label', () => {
  const drugs = [{
    name: 'Rasagiline',
    aliases: ['Azilect'],
    approvalStatus: 'approved',
    mechanism: 'MAO-B inhibitor'
  }];
  assert.equal(injectApprovedTreatmentStubs([], drugs, []).length, 0);
  const entries = injectApprovedTreatmentStubs([], drugs, [{
    drug: 'Rasagiline',
    label: {
      genericName: 'rasagiline',
      url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc-123'
    }
  }]);
  assert.equal(entries.length, 1);
  assert.match(entries[0].references, /FDA label — Rasagiline/);
  assert.equal(entries[0].provider, '');
});
