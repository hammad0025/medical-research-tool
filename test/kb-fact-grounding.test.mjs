import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditKbFacts,
  itemsGroundingIndex,
  validateFactRecord
} from '../scripts/audit-kb-facts.mjs';
import {
  buildGroundingIndex,
  quantitativeGroundingDiagnostics
} from '../lib/grounding-gate.js';
import { filterGroundedKbRecords } from '../lib/kb-fact-gate.js';

const exactItem = {
  id: 'trial',
  title: 'Nintedanib randomized trial in IPF',
  summary: 'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in IPF.',
  keyPassages: [{
    topic: 'outcome',
    quote: 'The adjusted difference in annual FVC decline was 107 mL/year versus placebo.'
  }]
};

test('canonical facts pass only when a referenced source supports the claim', () => {
  const issues = validateFactRecord({
    claim: 'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in IPF.',
    evidenceRefs: ['trial']
  }, new Map([['trial', exactItem]]));
  assert.deepEqual(issues, []);
});

test('value unit drug and comparator mutations fail canonical grounding', () => {
  const items = new Map([['trial', exactItem]]);
  for (const claim of [
    'Nintedanib reduced annual FVC decline by 115 mL/year versus placebo in IPF.',
    'Nintedanib reduced annual FVC decline by 107 mg/day versus placebo in IPF.',
    'Pirfenidone reduced annual FVC decline by 107 mL/year versus placebo in IPF.',
    'Nintedanib reduced annual FVC decline by 107 mL/year versus active control in IPF.'
  ]) {
    const issues = validateFactRecord({ claim, evidenceRefs: ['trial'] }, items);
    assert.ok(issues.some((issue) => /not grounded/i.test(issue.issue)), claim);
  }
});

test('missing and quarantined references fail explicitly', () => {
  const missing = validateFactRecord({
    claim: 'A substantive clinical claim.',
    evidenceRefs: ['missing']
  }, new Map());
  assert.ok(missing.some((issue) => /unresolved evidenceRef/i.test(issue.issue)));

  const result = auditKbFacts({
    items: [{ ...exactItem, quarantined: true }],
    canonicalFacts: [{
      claim: 'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in IPF.',
      evidenceRefs: ['trial']
    }]
  }, 'fixture.json');
  assert.equal(result.checked, 1);
  assert.equal(result.excluded, 0);
  assert.match(result.failures[0].issue, /quarantined evidenceRef trial/i);
});

test('thin source metadata cannot support a substantive canonical claim', () => {
  const item = {
    id: 'thin-review',
    title: 'Functional outcomes in a neurological condition',
    journal: 'Example Journal',
    year: '2024',
    summary: '',
    keyPassages: []
  };
  const issues = validateFactRecord({
    claim: 'Untreated adults have widespread and cumulative functional impairments.',
    evidenceRefs: ['thin-review']
  }, new Map([[item.id, item]]));
  assert.ok(issues.some((issue) => /not grounded/i.test(issue.issue)));
});

test('topically related source text cannot support a stronger mismatched claim', () => {
  const item = {
    id: 'safety-review',
    title: 'Medication safety in children',
    summary: 'A systematic review assessed adverse events of methylphenidate in children.',
    keyPassages: []
  };
  const issues = validateFactRecord({
    claim: 'Methylphenidate is the most frequently used and most effective treatment in children.',
    evidenceRefs: ['safety-review']
  }, new Map([[item.id, item]]));
  assert.ok(issues.some((issue) => /not grounded/i.test(issue.issue)));
});

test('IPF canonical quantitative paraphrases retain exact source tuples', () => {
  const item = {
    id: 'fibroneer',
    title: 'Nerandomilast in Patients with Idiopathic Pulmonary Fibrosis (FIBRONEER-IPF)',
    summary:
      'Pivotal phase 3 RCT published in 2025. Adjusted mean FVC changes at week 52 were ' +
      '−114.7 mL with nerandomilast 18 mg twice daily and −183.5 mL with placebo. ' +
      'The adjusted difference versus placebo was 68.8 mL.',
    keyPassages: [{
      quote:
        'Adjusted mean changes in FVC at week 52 were −114.7 ml in the nerandomilast ' +
        '18-mg group and −183.5 ml in the placebo group. The adjusted difference was 68.8 ml.'
    }]
  };
  const claim =
    'FIBRONEER-IPF (NEJM 2025): nerandomilast 18 mg twice daily slowed FVC decline ' +
    'vs placebo by an adjusted 68.8 mL at week 52 (mean change −114.7 mL vs −183.5 mL).';
  const claimIndex = buildGroundingIndex({ evidencePack: [{ text: claim }] });
  const sourceIndex = itemsGroundingIndex([item]);
  assert.deepEqual(
    [...claimIndex.numbers].filter((number) => !sourceIndex.items[0].numbers.has(number)),
    []
  );
  assert.deepEqual(
    quantitativeGroundingDiagnostics(claim, sourceIndex.items[0].text),
    {
      numbersAligned: true,
      comparatorAligned: true,
      interventionAligned: true,
      outcomeAligned: true,
      populationAligned: true,
      claimInterventions: ['fibroneer-ipf', 'nejm', 'nerandomilast', 'twice'],
      sourceInterventions: ['nerandomilast'],
      claimOutcomes: ['decline', 'fvc'],
      sourceOutcomes: ['fvc', 'adjusted', 'mean'],
      missingNumbers: []
    }
  );
  const issues = validateFactRecord({
    claim,
    evidenceRefs: ['fibroneer']
  }, new Map([['fibroneer', item]]));
  assert.deepEqual(issues, []);
});

test('reader-facing KB records fail closed when their exact source does not support them', () => {
  const records = [
    {
      claim: 'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in IPF.',
      evidenceRefs: ['trial']
    },
    {
      claim: 'Pirfenidone reduced annual FVC decline by 107 mL/year versus placebo in IPF.',
      evidenceRefs: ['trial']
    },
    {
      claim: 'An uncited medical recommendation.',
      evidenceRefs: []
    }
  ];
  const filtered = filterGroundedKbRecords(records, new Map([['trial', exactItem]]));
  assert.deepEqual(filtered, [records[0]]);
});
