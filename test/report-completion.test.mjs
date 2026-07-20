import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assessReportCompletion,
  bindReportContent,
  sealReportCompletion,
  verifyReportContentBinding
} from '../lib/report-completion.js';
import { TERMS_VERSION } from '../lib/terms-consent.js';
import {
  allowedReportUrl,
  filterAllowedReportLinks,
  sanitizeReportHtml
} from '../lib/report-links.js';

const passingValidation = () => ({
  status: 'passed',
  primary: {
    overallScore: 96,
    agreement: 'high',
    confirmed: [{ claim: 'Reviewed claim', evidenceRef: 'fixture source' }],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'The report passed validation.'
  }
});

const validInput = () => ({
  profileKey: 'condition|female|moderate|54',
  termsVersion: TERMS_VERSION,
  sections: {
    research: { text: 'Complete research section.', profileKey: 'condition|female|moderate|54' },
    repurpose: { text: 'Complete repurpose section.', profileKey: 'condition|female|moderate|54' }
  },
  trials: { status: 'complete', profileKey: 'condition|female|moderate|54' },
  audits: {
    validation: {
      research: passingValidation(),
      repurpose: passingValidation()
    },
    citations: {
      research: { status: 'passed' },
      repurpose: { status: 'passed' }
    },
    coverage: { finalMissed: [] }
  }
});

test('complete report receives the full server contract classification', () => {
  const contract = assessReportCompletion(validInput(), { termsAccepted: true });
  assert.equal(contract.eligible, true);
  assert.equal(contract.classification, 'full');
});

test('empty or incomplete reports cannot be classified as full', () => {
  const input = validInput();
  input.sections.repurpose.text = '';
  input.trials.status = 'missing';
  const contract = assessReportCompletion(input, { termsAccepted: true });
  assert.equal(contract.eligible, false);
  assert.equal(contract.classification, 'blocked');
  assert.deepEqual(contract.missing.sort(), ['section:repurpose', 'trials:state']);
});

test('stale profile and stale Terms consent block every export', () => {
  const input = validInput();
  input.sections.research.profileKey = 'old-profile';
  input.termsVersion = 'old-terms';
  const contract = assessReportCompletion(input, { termsAccepted: false });
  assert.equal(contract.eligible, false);
  assert.ok(contract.failed.includes('stale:research'));
  assert.ok(contract.failed.includes('terms:stale'));
});

test('failed validation, citation, or coverage audits block full labeling', () => {
  const input = validInput();
  input.audits.validation.repurpose = { error: 'validator unavailable' };
  input.audits.citations.research = { status: 'failed' };
  input.audits.coverage = { finalMissed: ['Required agent'] };
  const contract = assessReportCompletion(input, { termsAccepted: true });
  assert.equal(contract.eligible, false);
  assert.deepEqual(
    contract.failed.filter((item) => /validation|citations|coverage/.test(item)).sort(),
    ['citations:research', 'coverage', 'validation:repurpose']
  );
});

test('coverage fails closed for stale or malformed missing arrays', () => {
  for (const coverage of [
    { initialMissed: [] },
    { status: 'passed' },
    { finalMissed: 'none' },
    { finalMissed: null },
    { finalMissed: ['Required agent'] }
  ]) {
    const input = validInput();
    input.audits.coverage = coverage;
    const contract = assessReportCompletion(input, { termsAccepted: true });
    assert.equal(contract.eligible, false, JSON.stringify(coverage));
    assert.ok(contract.failed.includes('coverage'));
  }
});

test('report seal is bound to canonical exported content', () => {
  const now = 1_750_000_000_000;
  const secret = 'deterministic-report-content-binding-secret';
  const content = 'Report heading\r\nEvidence-backed finding.  \n';
  const contract = bindReportContent(
    assessReportCompletion(validInput(), { termsAccepted: true }),
    content
  );
  const seal = sealReportCompletion(contract, {
    now,
    secret,
    nonce: 'abcdefghijklmnopqrstuv'
  });
  assert.equal(verifyReportContentBinding({
    contract,
    seal,
    reportContent: 'Report heading\nEvidence-backed finding.',
    now,
    secret
  }).ok, true);
  assert.deepEqual(verifyReportContentBinding({
    contract,
    seal,
    reportContent: 'Report heading\nEvidence-backed opposite finding.',
    now,
    secret
  }), { ok: false, code: 'REPORT_CONTENT_MISMATCH' });
});

test('low, disputed, unsupported, malformed, and partial validation blocks export', () => {
  const mutations = [
    { primary: { ...passingValidation().primary, overallScore: 40 } },
    { primary: { ...passingValidation().primary, disputed: [{ claim: 'Wrong' }] } },
    { primary: { ...passingValidation().primary, unsupported: [{ claim: 'Unproven' }] } },
    { primary: { ...passingValidation().primary, hallucinatedCitations: [{ url: 'bad' }] } },
    { primary: { agreement: 'high' } },
    { status: 'passed', primary: null },
    { status: 'passed', fixture: true },
    { status: 'failed', primary: passingValidation().primary }
  ];
  for (const validation of mutations) {
    const input = validInput();
    input.audits.validation.research = validation;
    const contract = assessReportCompletion(input, { termsAccepted: true });
    assert.equal(contract.classification, 'blocked', JSON.stringify(validation));
    assert.ok(contract.failed.includes('validation:research'));
  }
});

test('explicitly degraded retrieval is exportable only with degraded labeling', () => {
  const input = validInput();
  input.trials.status = 'degraded';
  input.audits.citations.research = { status: 'degraded' };
  const contract = assessReportCompletion(input, { termsAccepted: true });
  assert.equal(contract.eligible, true);
  assert.equal(contract.classification, 'degraded');
  assert.equal(contract.label, 'Report with partial source coverage');
  assert.deepEqual(contract.coverageMessages, [
    'Some clinical-trial searches were unavailable, so the trial list may be incomplete.',
    'Some condition-report sources could not be checked.'
  ]);
});

test('all four report link surfaces reject unsafe and non-allowlisted URLs', async () => {
  const allowed = new Set(['https://pubmed.ncbi.nlm.nih.gov/12345678/']);
  const candidates = [
    { url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/', label: 'allowed' },
    { url: 'javascript:alert(1)', label: 'script' },
    { url: 'data:text/html,unsafe', label: 'data' },
    { url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/foreign', label: 'invented child' }
  ];
  for (const surface of ['TreatmentCard', 'CandidateCard', 'ComboCard', 'RefsTab']) {
    const filtered = filterAllowedReportLinks(candidates, allowed);
    assert.deepEqual(filtered.map((item) => item.label), ['allowed'], surface);
    assert.equal(allowedReportUrl('javascript:alert(1)', allowed), null, surface);
  }

  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  for (const component of ['TreatmentCard', 'CandidateCard', 'ComboCard', 'RefsTab']) {
    const start = source.indexOf(`const ${component} =`);
    assert.notEqual(start, -1, `${component} exists`);
    const block = source.slice(start, start + 5000);
    assert.match(block, /filterAllowedReportLinks|allowedReportUrl/, `${component} uses the exact allowlist`);
  }
});

test('report-derived HTML cannot execute script or event-handler markup', () => {
  const unsafe = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)" onclick="alert(4)">open</a>';
  const sanitized = sanitizeReportHtml(unsafe, new Set());
  assert.doesNotMatch(sanitized, /<(?:script|img|a)\b/i);
  assert.match(sanitized, /&lt;img/);
});
