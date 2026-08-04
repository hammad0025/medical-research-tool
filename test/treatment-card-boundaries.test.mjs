// Fixtures are the exact text from a shipped Parkinson disease report.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadProductionReportParsers } from '../scripts/test-helpers/production-report-parsers.mjs';

const { parseTreatments } = await loadProductionReportParsers();

const link = '[MDS EBM Guidelines](https://pubmed.ncbi.nlm.nih.gov/29570866/)';

test('a card field does not swallow the next card heading', () => {
  const text = [
    '### 💊 Levodopa/Carbidopa (Sinemet / Rytary / Inbrija)',
    'Treatment type: Multiple manufacturers',
    'Treatment: Carbidopa/levodopa — the most widely used PD medicine.',
    'FDA status: approved',
    `Medication interactions: MAO-B inhibitors are often combined with levodopa (${link}).`,
    '',
    '---',
    '',
    '### 💊 Levodopa-Carbidopa Intestinal Gel — Duopa / Duodopa (LCIG)',
    'Treatment type: AbbVie (Duopa)',
    'Treatment: A gel delivered into the small intestine through a PEG-J tube.',
    'FDA status: approved',
    `Sources: ${link}`
  ].join('\n');

  const cards = parseTreatments(text);
  const first = cards.find((c) => /most widely used/i.test(c.treatment || ''));
  assert.ok(first, 'the levodopa card should parse');
  // The shipped report ended this field with the literal text
  // "--- ### 💊 Levodopa-Carbidopa Intestinal Gel — Duopa / Duodopa (LCIG)".
  const spill = String(first.interactions || '');
  assert.ok(!spill.includes('###'), `field swallowed a heading: ${spill}`);
  assert.ok(!/Duodopa/i.test(spill), `field swallowed the next card's name: ${spill}`);
  // And the swallowed card must exist in its own right.
  assert.equal(cards.length, 2, 'both cards should parse, not one');
  assert.ok(
    cards.some((c) => /gel delivered/i.test(c.treatment || '')),
    'the following card should parse as its own card'
  );
});

test('a card named only by its heading is kept, not dropped', () => {
  const text = [
    '### 💊 Rasagiline (Azilect)',
    'Treatment type: Teva Pharmaceuticals (Azilect)',
    'FDA status: approved',
    `Sources: ${link}`
  ].join('\n');

  const cards = parseTreatments(text);
  assert.equal(cards.length, 1, 'heading-named card should survive');
  assert.match(cards[0].treatment, /Rasagiline/);
});

test('a numbered section heading is never used as a drug name', () => {
  const text = [
    '### 3. Approved Treatments (Backed by Research)',
    'Treatment type: Some Manufacturer',
    'FDA status: approved',
    `Sources: ${link}`
  ].join('\n');

  const cards = parseTreatments(text);
  assert.equal(cards.length, 0, 'a section heading must not become a treatment identity');
});

test('a provider is still never promoted to a treatment identity', () => {
  const text = [
    'Treatment type: Teva Pharmaceuticals',
    'FDA status: approved',
    `Sources: ${link}`
  ].join('\n');

  assert.equal(parseTreatments(text).length, 0, 'manufacturer alone must not name a card');
});
