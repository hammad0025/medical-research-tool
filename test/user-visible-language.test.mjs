import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assessReportCompletion } from '../lib/report-completion.js';
import { TERMS_VERSION } from '../lib/terms-consent.js';

const [app, builtApp, index, terms, saved] = await Promise.all([
  readFile(new URL('../src/app.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../terms.html', import.meta.url), 'utf8'),
  readFile(new URL('../data/demo/saved-verified-report.json', import.meta.url), 'utf8').then(JSON.parse)
]);

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

const validInput = () => ({
  profileKey: 'language-regression',
  termsVersion: TERMS_VERSION,
  sections: {
    research: { text: 'Condition report.', profileKey: 'language-regression' },
    repurpose: { text: 'Drug and supplement ideas.', profileKey: 'language-regression' }
  },
  trials: { status: 'complete', profileKey: 'language-regression' },
  audits: {
    validation: {
      research: passingValidation(),
      repurpose: passingValidation()
    },
    citations: { research: { status: 'passed' }, repurpose: { status: 'passed' } },
    coverage: { status: 'passed', finalMissed: [] }
  }
});

test('completion API keeps enforcement codes but supplies human-facing labels and notices', () => {
  const full = assessReportCompletion(validInput(), { termsAccepted: true });
  assert.equal(full.label, 'Complete report');

  const partialInput = validInput();
  partialInput.trials.status = 'degraded';
  partialInput.evidenceDegraded = true;
  const partial = assessReportCompletion(partialInput, { termsAccepted: true });
  assert.equal(partial.label, 'Report with partial source coverage');
  assert.ok(partial.degraded.includes('trials:degraded'));
  assert.ok(partial.coverageMessages.every((message) => /[.!?]$/.test(message)));
  assert.doesNotMatch(partial.coverageMessages.join(' '), /trials:|evidence:|degraded/i);

  const blockedInput = validInput();
  blockedInput.sections.repurpose.text = '';
  const blocked = assessReportCompletion(blockedInput, { termsAccepted: true });
  assert.equal(blocked.label, 'Report not ready to export');
  assert.equal(blocked.missing[0], 'section:repurpose');
  assert.equal(blocked.missingMessages[0], 'The drug and supplement ideas review is not finished.');
});

test('exports hide verification secrets and raw completion codes from visible report text', () => {
  const exportBlock = app.slice(
    app.indexOf('const buildExportDocument ='),
    app.indexOf('const FullReportExportButton =')
  );
  assert.match(exportBlock, /meta name="mrt-report-verification"/);
  assert.match(exportBlock, /What may be missing:/);
  assert.doesNotMatch(exportBlock, /Server seal:|Degraded coverage:|contract\.degraded\.join/);
  assert.match(exportBlock, /contract\.coverageMessages/);
});

test('saved example body is sentence case, not live, and contains no visible source hash', () => {
  assert.equal(saved.label, 'Saved demo — not live');
  assert.match(saved.researchText, /^# Saved demo — not live/);
  assert.match(saved.researchText, /not medical advice/i);
  assert.match(saved.repurposeText, /No live treatment or supportive-care result is claimed/);
  assert.doesNotMatch(`${saved.researchText}\n${saved.repurposeText}`, /\b[a-f0-9]{40}\b|source SHA|placeholder/i);
  assert.doesNotMatch(`${saved.researchText}\n${saved.repurposeText}`, /^(?:PROVIDER|FDA_STATUS|REPURPOSE_SECTION|EVIDENCE_STRENGTH):/m);
  assert.match(saved.reviewedGitSha, /^[a-f0-9]{40}$/);
});

test('UI wording covers errors, report style, evidence badges, and doctor discussion', () => {
  assert.match(index, /<title>Researching My Condition<\/title>/);
  for (const expected of [
    'Report style',
    'Plain language (default)',
    'Clinical detail',
    'Prepare a doctor-discussion question',
    'No condition-specific study identified in this search',
    'Lab or animal research',
    'randomized controlled trial',
    'Current access and study stage',
    'Sources & exports',
    'The service returned an unexpected response. Please try again.'
  ]) {
    assert.ok(app.includes(expected), `missing user-facing wording: ${expected}`);
  }
  for (const forbidden of [
    'Ask AI why it missed X',
    'However, our research suggests it may help',
    'Hard-to-check site',
    'Translate error:',
    'Contact admin for Pro/Max activation code',
    'dev placeholder'
  ]) {
    assert.ok(!app.includes(forbidden), `obsolete user-facing wording remains: ${forbidden}`);
  }
  for (const expected of ['Prepare a doctor-discussion question', 'What may be missing:']) {
    assert.ok(builtApp.includes(expected), `built frontend is missing wording: ${expected}`);
  }
  assert.doesNotMatch(builtApp, /Ask AI why it missed X|Server seal:|Hard-to-check site/);
});

test('Terms keep required cautions while explaining storage and providers plainly', () => {
  assert.match(terms, /not HIPAA compliant/i);
  assert.match(terms, /not medical advice/i);
  assert.match(terms, /outside services control how long they keep data/i);
  assert.match(terms, /private link stored in your browser can download or delete your subscription/i);
  assert.doesNotMatch(terms, /Upstash|allowlisted|ownership token|provider retention|subprocessors|repository/i);
});
