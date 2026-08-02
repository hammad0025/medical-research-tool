// The .txt export shipped raw markdown: a downloaded report carried
// "|---|---|" separator rows, "[label](url)" syntax and "##" markers. It is
// the export most likely to be pasted into an email or handed to a clinician,
// so it has to read as text.

import test from 'node:test';
import assert from 'node:assert/strict';

import { markdownToPlainText } from '../lib/markdown-to-text.js';

const REPORT = [
  '## 2. Condition-Focused Centers & Experts',
  'Centers identified for specialized expertise.',
  '',
  '| Center | Location | Focus |',
  '|---|---|---|',
  '| [Johns Hopkins Wilmer](https://hopkinsmedicine.org/wilmer) | Baltimore, MD | Runs the **NAC Attack** trial |',
  '',
  '### Patient Advocacy',
  '',
  '- [Foundation Fighting Blindness](https://www.fightingblindness.org) — Funds research',
  '',
  '---'
].join('\n');

test('no markdown syntax survives into the text export', () => {
  const text = markdownToPlainText(REPORT);
  assert.doesNotMatch(text, /^\s*\|?[-\s:|]+\|/m, 'table separator rows must be gone');
  assert.doesNotMatch(text, /\]\(https?:/, 'link syntax must be flattened');
  assert.doesNotMatch(text, /^#{1,6}\s/m, 'heading markers must be gone');
  assert.doesNotMatch(text, /\*\*/, 'bold markers must be gone');
});

test('every URL survives, because the links are the point', () => {
  const text = markdownToPlainText(REPORT);
  assert.match(text, /https:\/\/hopkinsmedicine\.org\/wilmer/);
  assert.match(text, /https:\/\/www\.fightingblindness\.org/);
});

test('a table row still reads on its own, with its column labels', () => {
  const text = markdownToPlainText(REPORT);
  assert.match(text, /Center: Johns Hopkins Wilmer/);
  assert.match(text, /Location: Baltimore, MD/);
  // The header row itself is not printed as a data row.
  assert.doesNotMatch(text, /^Center \| Location \| Focus$/m);
});

test('headings stay recognisable as headings', () => {
  const text = markdownToPlainText(REPORT);
  assert.match(text, /2\. Condition-Focused Centers & Experts\n={5,}/);
  assert.match(text, /Patient Advocacy\n-{5,}/);
});

test('empty input and plain prose are handled without damage', () => {
  assert.equal(markdownToPlainText(''), '');
  assert.equal(markdownToPlainText(undefined), '');
  assert.equal(
    markdownToPlainText('Retinitis pigmentosa affects the retina.'),
    'Retinitis pigmentosa affects the retina.'
  );
});
