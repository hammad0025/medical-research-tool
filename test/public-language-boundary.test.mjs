import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PublicLanguageBoundaryError,
  findProhibitedPublicLanguage,
  installPublicJsonBoundary,
  normalizePublicLanguageForDetection,
  sanitizePublicHtml,
  sanitizePublicPayload,
  sanitizePublicText
} from '../lib/public-language.js';
import { polishReportForDisplay } from '../lib/report-polish.js';

test('Unicode confusables, zero-width characters, and dash variants cannot bypass detection', () => {
  const disguised = 'The ｅｖｉｄｅｎｃｅ\u200b—pack and K\u2060–8 were used.';
  assert.match(normalizePublicLanguageForDetection(disguised), /evidence-pack and K-8/i);
  const clean = sanitizePublicText(disguised);
  assert.equal(clean, 'the sources we reviewed and quality review were used.');
  assert.deepEqual(findProhibitedPublicLanguage(clean), []);
});

test('known raw labels and status codes become natural reader language', () => {
  const clean = sanitizePublicText([
    'PROVIDER: Specialist care',
    'FDA_STATUS: Approved',
    'REPURPOSE_SECTION: SUPPORTIVE',
    'EVIDENCE_STRENGTH: MODERATE',
    'Trial status: NOT_YET_RECRUITING'
  ].join('\n'));
  assert.match(clean, /^Treatment type:/m);
  assert.match(clean, /^FDA status:/m);
  assert.match(clean, /^Research category:/m);
  assert.match(clean, /^Strength of research:/m);
  assert.match(clean, /Trial status: Not yet recruiting/);
});

test('rewriting is followed by a fail-closed prohibited-language check', () => {
  assert.throws(
    () => sanitizePublicText('schemaVersion should be shown to the reader'),
    (error) => error instanceof PublicLanguageBoundaryError && error.code === 'PUBLIC_LANGUAGE_REJECTED'
  );
});

test('public payloads clean visible text while retaining machine metadata', () => {
  const payload = sanitizePublicPayload({
    code: 'INTERNAL_SERVER_ERROR',
    status: 'degraded',
    model: 'internal-model-id',
    message: 'Internal server error',
    content: [{ type: 'text', text: 'The citation audit used an evidence pack.' }]
  });
  assert.equal(payload.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.model, 'internal-model-id');
  assert.equal(payload.message, 'The service encountered an unexpected problem');
  assert.equal(payload.content[0].text, 'The source check used the sources we reviewed.');
});

test('source titles and legitimate clinical terms are negative fixtures', () => {
  const title = 'Model output for schema validation in clinical pharmacology';
  assert.equal(sanitizePublicText(title, { sourceTitle: true }), title);
  for (const clinicalText of [
    'A clinical audit measured adherence to the sepsis bundle.',
    'The disease model used human induced pluripotent stem cells.',
    'Security of medication supply was a secondary outcome.',
    'The patient had a model-of-end-stage liver disease score recorded.'
  ]) {
    assert.equal(sanitizePublicText(clinicalText), clinicalText);
  }
});

test('mixed-case trial phase tokens are rewritten before the boundary check, not just fully-uppercase ones', () => {
  // The rewrite rule for PHASE1..4 lacked the case-insensitive flag every
  // other rule here has, so "Phase2" (the exact casing the UI's own
  // registry-value humanizer produces, and a plausible model echo of trial
  // phase data) reached the case-insensitive prohibited-language check
  // unrewritten and threw on every retry — a real production outage.
  assert.equal(sanitizePublicText('Phase2 trial'), 'Phase 2 trial');
  assert.equal(sanitizePublicText('phase3 status'), 'Phase 3 status');
  assert.equal(sanitizePublicText('PHASE1 complete'), 'Phase 1 complete');
  assert.deepEqual(findProhibitedPublicLanguage('Phase2 trial, phase3 status'), ['Phase2']);
});

test('PARK8 biomedical text does not trigger the standalone K8 wording rule', () => {
  const registryDescription = 'The intervention studies PARK8-associated Parkinson disease.';
  assert.equal(sanitizePublicText(registryDescription), registryDescription);
  assert.equal(sanitizePublicPayload({ description: registryDescription }).description, registryDescription);
  assert.equal(sanitizePublicText('K8 quality wording'), 'quality review quality wording');
});

test('email HTML protects marked source titles but cleans other reader text', () => {
  const html = sanitizePublicHtml(
    '<div data-mrt-source-title="1">Model output and schema validation</div>' +
    '<p>The evidence—pack had degraded coverage.</p>'
  );
  assert.match(html, />Model output and schema validation</);
  assert.match(html, /the sources we reviewed had partial source coverage/);
});

test('response wrapper applies the boundary to every JSON response', () => {
  let captured;
  const res = {
    json(body) { captured = body; return this; }
  };
  installPublicJsonBoundary(res);
  res.json({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  assert.deepEqual(captured, {
    error: 'The service encountered an unexpected problem',
    code: 'INTERNAL_SERVER_ERROR'
  });
});

test('existing report polish delegates to the centralized boundary', () => {
  const clean = polishReportForDisplay('The challenge\u200b—suite reviewed the result.\nPROVIDER: care.');
  assert.doesNotMatch(clean, /challenge|PROVIDER/);
  assert.match(clean, /safety checks/);
});

