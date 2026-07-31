import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { alertHtmlToText } from '../lib/alerts-email.js';

const appSource = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');

test('private preview startup requests are bounded and fail closed', () => {
  assert.match(appSource, /const MRT_GATE_FETCH_TIMEOUT_MS = 12_000/);
  assert.match(appSource, /fetchGateRequest\('\/api\/research'/);
  assert.match(appSource, /fetchGateRequest\('\/api\/terms-consent'/);
  assert.doesNotMatch(appSource, /Network error or non-gate failure — let the app render/);
  assert.match(appSource, /setState\(\{ status: 'blocked', reason: result\.reason/);
});

test('malformed trial payloads use an array guard before rendering', () => {
  assert.match(appSource, /const trialStudies = normalizeTrialStudies\(trialsData\?\.studies\)/);
  assert.match(appSource, /\(trialStudies\.length > 0 \|\| trialCoverageMessage\(trialsData\)\)/);
  assert.doesNotMatch(appSource, /trialsData\.returned \|\| trialsData\.studies\.length/);
});

test('direct trial links require exact NCT URL identity', () => {
  assert.match(appSource, /function exactClinicalTrialUrl\(study = \{\}\)/);
  assert.match(appSource, /supplied === expected \? expected : null/);
  assert.doesNotMatch(appSource, /href=\{trial\.url\}/);
  assert.doesNotMatch(appSource, /href=\{s\.url\}/);
  assert.doesNotMatch(appSource, /href=\{b\.url\.trim\(\)\}/);
});

test('clipboard and full text use the completion contract and canonical report body', () => {
  assert.match(appSource, /getCompletionContract\('research'\)[\s\S]*setCopyCompletion/);
  assert.match(appSource, /cachedCompletionForClipboard\(copyCompletion, 'research'\)[\s\S]*const write = navigator\.clipboard\.writeText/);
  assert.match(appSource, /navigator\.clipboard\.writeText[\s\S]{0,300}contract\.canonicalContent/);
  assert.doesNotMatch(appSource, /await getCompletionContract\('research'\);[\s\S]{0,800}navigator\.clipboard\.writeText/);
  assert.match(appSource, /const fullText = exportHtmlToPlainText\(buildFullReportBody\(\{ reportModel: props\.reportModel \}\)\)/);
  assert.match(appSource, /props\.getCompletionContract\('full'\)/);
  assert.match(appSource, /renderMarkdownForExport\(contract\.canonicalContent\)/);
  assert.doesNotMatch(appSource, /getCompletionContract\(\)/);
});

test('full exports preserve the rendered clinical-trial column set', () => {
  for (const header of [
    'Accepting inquiries',
    'Eligibility review',
    'Placebo listed',
    'Access notes',
    'Countries',
    'Monitoring',
    'Why this order'
  ]) {
    assert.match(appSource, new RegExp(`['"]${header}['"]`));
  }
  // Exports must use the same bounded row cap as the on-screen table. This
  // used to pin the literal 50, which asserted a specific number rather
  // than the policy and broke the moment the cap became a named constant.
  assert.match(appSource, /const TRIAL_ROW_DISPLAY_LIMIT = (\d+);/);
  const cap = Number(appSource.match(/const TRIAL_ROW_DISPLAY_LIMIT = (\d+);/)[1]);
  assert.ok(cap > 0 && cap <= 50, `trial row cap out of range: ${cap}`);
  assert.match(appSource, /studies\.slice\(0, TRIAL_ROW_DISPLAY_LIMIT\)/);
});

test('plain-text alerts retain source and unsubscribe destinations', () => {
  const text = alertHtmlToText(
    '<h2>New study</h2><a href="https://pubmed.ncbi.nlm.nih.gov/12345678/">Paper title</a>' +
    '<div><a href="https://example.test/unsubscribe?token=abc">Unsubscribe</a></div>'
  );
  assert.match(text, /Paper title \(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345678\/\)/);
  assert.match(text, /Unsubscribe \(https:\/\/example\.test\/unsubscribe\?token=abc\)/);
});
