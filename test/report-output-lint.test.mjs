// Regression tests for defects that reached a real reader.
//
// Every fixture below is text this product actually rendered. Each one shipped
// because the change that caused it was checked at the layer it touched rather
// than on the finished page, so these tests assert the page — not the plumbing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { lintReport, lintIdeaSections } from '../lib/report-lint.js';

const ids = (result) => result.defects.map((d) => d.id);

test('an HTML tag on a card is caught', () => {
  // Shipped verbatim on a TUDCA card.
  const shipped = '<h4>Background</h4>Tauroursodeoxycholic acid (TUDCA) is a naturally produced bile acid.';
  assert.ok(ids(lintReport(shipped)).includes('raw-html'));
});

test('a raw abstract prefix on a card is caught', () => {
  // Shipped on the DHA and N-acetylcysteine cards.
  for (const shipped of [
    'OBJECTIVE: To determine whether a therapeutic dose of docosahexaenoic acid will slow degeneration',
    "Editor's summary: Johns Hopkins open-label trial of oral N-acetylcysteine in RP patients"
  ]) {
    assert.ok(ids(lintReport(shipped)).includes('abstract-prefix'), shipped);
  }
});

test('internal field names never reach the reader', () => {
  for (const leak of [
    'REPURPOSE_SECTION: researched-not-approved',
    'The sourceSHA is abc123',
    'cacheHit was true'
  ]) {
    assert.ok(ids(lintReport(leak)).includes('internal-identifier'), leak);
  }
});

test('a table that failed to render is caught', () => {
  // The clinical-trials table collapsed into loose pipe characters.
  const shipped = [
    '## 4. Clinical Trials',
    '',
    '| Interventional Study | Phase 1/2 | Active | NCT03963154 | | UMSC Study | Phase 2 | Unknown | NCT04763369 |'
  ].join('\n');
  assert.ok(ids(lintReport(shipped)).includes('pipes-in-prose'));
});

test('a lone table row with no table around it is caught', () => {
  const shipped = ['Some prose.', '', '| Drug A | Concern | Watch |', '', 'More prose.'].join('\n');
  assert.ok(ids(lintReport(shipped)).includes('orphan-table-row'));
});

test('an empty section is caught even when it carries the honest note', () => {
  // Sections 6, 7 and 8 rendered like this for weeks.
  const shipped = [
    '## 7. This Patient\'s Interaction & Access Plan',
    '',
    'Nothing was found for this section in the sources reviewed in this search.',
    '',
    '## 8. Safety Considerations Reported in Literature',
    ''
  ].join('\n');
  const result = lintReport(shipped, { expectedSections: 2 });
  assert.ok(ids(result).includes('empty-section'));
  assert.equal(result.sections.empty.length, 2);
});

test('a stale cross-reference is caught, because exports may not have an "above"', () => {
  const shipped = '## 3. Approved Treatments\nSee the treatment cards above for the approved options.';
  assert.ok(ids(lintReport(shipped)).includes('stale-cross-reference'));
});

test('duplicated citation arrows and dead links are caught', () => {
  assert.ok(ids(lintReport('IOVS 2012 ↗ ↗')).includes('double-arrow'));
  assert.ok(ids(lintReport('[source]() and [other](#)')).includes('empty-link'));
});

test('a clean report produces no defects', () => {
  const clean = [
    '## 1. Condition Snapshot',
    '',
    'Retinitis pigmentosa is a group of inherited eye diseases ([Emerging therapies](https://pubmed.ncbi.nlm.nih.gov/1/)).',
    '',
    '## 2. Condition-Focused Centers & Experts',
    '',
    '| Center | Location | Focus |',
    '|---|---|---|',
    '| [Johns Hopkins Wilmer](https://hopkinsmedicine.org/wilmer) | Baltimore, MD | Runs the NAC Attack trial |'
  ].join('\n');
  const result = lintReport(clean, { expectedSections: 2 });
  assert.deepEqual(result.defects, [], JSON.stringify(result.defects));
  assert.ok(result.ok);
});

test('the idea sections must both be filled', () => {
  // Shipped as two ideas in one half and eight in the other.
  const shipped = {
    researched: ['Alpha-lipoic acid', 'DHA', 'NAC', 'TUDCA', 'Taurine', 'Goji', 'NACA', 'Lutein'],
    notStudied: ['Taurine', 'TUDCA']
  };
  const result = lintIdeaSections(shipped);
  assert.ok(result.defects.some((d) => d.id === 'thin-not-studied'));
});

test('an agent may not appear in both idea sections', () => {
  // TUDCA shipped in both: one card denied the study the other linked.
  const result = lintIdeaSections({
    researched: Array.from({ length: 10 }, (_, i) => `Agent ${i}`).concat('TUDCA'),
    notStudied: Array.from({ length: 10 }, (_, i) => `Other ${i}`).concat('TUDCA (tauroursodeoxycholic acid)')
  });
  assert.ok(result.defects.some((d) => d.id === 'agent-in-both-sections'));
});

test('two full sections with no overlap pass', () => {
  const result = lintIdeaSections({
    researched: Array.from({ length: 10 }, (_, i) => `Researched ${i}`),
    notStudied: Array.from({ length: 10 }, (_, i) => `Idea ${i}`)
  });
  assert.deepEqual(result.defects, []);
  assert.ok(result.ok);
});

test('an empty report fails rather than passing for lack of content', () => {
  // The audit once reported "0 of 0 sections, 0 defects — clean" on a report
  // that had failed to generate. A guard that calls nothing "clean" is worse
  // than no guard, because it converts a total failure into a green result.
  for (const nothing of ['', '   \n  ', undefined]) {
    const result = lintReport(nothing);
    assert.equal(result.ok, false, JSON.stringify(nothing));
    assert.ok(result.defects.some((d) => d.id === 'no-report'));
  }
});
