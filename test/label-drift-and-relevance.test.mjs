// Regressions for the failures that produced an RP report with 4 drug ideas
// (all "unclear"), empty numbered sections, and a relapsing-polychondritis
// trial ranked second. Each test below fails against the previous behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';

import { finalizeReportText, dropEmptyStructure } from '../lib/report-polish.js';
import { resolveRepurposeSection } from '../lib/repurpose-quality.js';
import { claimSupportedBySource } from '../lib/claim-source-proof.js';
import { buildSupplementDiscoveryBlock } from '../lib/supplement-discovery.js';

const PUBMED = 'https://pubmed.ncbi.nlm.nih.gov/22815921/';

const tudcaEvidence = {
  groundedForPrompt: [{
    title: 'TUDCA Slows Retinal Degeneration in Two Different Mouse Models of Retinitis Pigmentosa',
    url: PUBMED,
    year: 2012,
    accessLevel: 'open',
    text: 'Tauroursodeoxycholic acid TUDCA slowed photoreceptor death in two different mouse models of retinitis pigmentosa.'
  }]
};

const candidateBlock = [
  'CANDIDATE: TUDCA (tauroursodeoxycholic acid)',
  'ITEM_KIND: MEDICATION',
  'CLASS: Bile acid — neuroprotective agent',
  'REPURPOSE_SECTION: researched-not-approved',
  'EVIDENCE_STRENGTH: PRECLINICAL',
  `SUPPORTING_EVIDENCE: TUDCA slowed photoreceptor death in two mouse models of retinitis pigmentosa ([TUDCA slows retinal degeneration](${PUBMED})).`,
  `REFERENCES: [TUDCA Slows Retinal Degeneration in Two Different Mouse Models](${PUBMED})`,
  ''
].join('\n');

test('polished candidates keep the tags that decide their research category', () => {
  const polished = finalizeReportText(candidateBlock, {
    evidence: tudcaEvidence,
    patient: {},
    condition: 'Retinitis Pigmentosa'
  });
  // The reader-facing spellings must survive: they are the only input to the
  // section classifier, and deleting them collapsed every idea to "unclear".
  assert.match(polished, /Research category:/);
  assert.match(polished, /Strength of research:/);
  assert.equal(resolveRepurposeSection(polished), 'researched-not-approved');
  assert.equal(
    resolveRepurposeSection(candidateBlock),
    resolveRepurposeSection(polished),
    'polishing must not change how a candidate is classified'
  );
});

test('a sourced evidence line survives polishing with its citation', () => {
  const polished = finalizeReportText(candidateBlock, {
    evidence: tudcaEvidence,
    patient: {},
    condition: 'Retinitis Pigmentosa'
  });
  assert.match(polished, /What the research says:/);
  assert.match(polished, /pubmed\.ncbi\.nlm\.nih\.gov\/22815921/);
});

test('a paraphrased population still matches its source, a different one does not', () => {
  const item = { url: PUBMED, accessLevel: 'open', text: tudcaEvidence.groundedForPrompt[0].text };
  assert.equal(
    claimSupportedBySource(
      'TUDCA slowed photoreceptor death in two mouse models of retinitis pigmentosa.',
      item,
      { condition: 'Retinitis Pigmentosa' }
    ).ok,
    true,
    'one inserted adjective must not invalidate a real citation'
  );
  assert.equal(
    claimSupportedBySource(
      'Metformin slowed vision loss in adults with retinitis pigmentosa.',
      { url: PUBMED, accessLevel: 'open', text: 'Metformin slowed progression in adults with type 2 diabetes.' },
      { condition: 'Retinitis Pigmentosa' }
    ).ok,
    false,
    'a genuinely different population must still be rejected'
  );
});

test('a curated knowledge-base reference can support a claim', () => {
  const curated = {
    accessLevel: 'kb',
    kbCategory: 'safety',
    pmid: '8512476',
    url: 'https://pubmed.ncbi.nlm.nih.gov/8512476/',
    text: 'Vitamin A palmitate slowed the decline of retinal function in retinitis pigmentosa.'
  };
  assert.equal(
    claimSupportedBySource(
      'Vitamin A palmitate slowed the decline of retinal function in retinitis pigmentosa.',
      curated,
      { condition: 'Retinitis Pigmentosa' }
    ).ok,
    true,
    'curated references carry a real document and must be citable'
  );
});

test('curated OTC options seed the supplement lane', () => {
  const block = buildSupplementDiscoveryBlock({
    groundedForPrompt: [],
    pipelineDrugs: [
      {
        name: 'Vitamin A palmitate 15,000 IU/day (Berson protocol)',
        aliases: ['vitamin A palmitate'],
        mechanism: 'Dietary retinoid supplement',
        pmid: '8512476'
      },
      { name: 'OCU400', mechanism: 'modifier gene therapy' }
    ]
  });
  assert.match(block, /Vitamin A palmitate/);
  assert.match(block, /pubmed\.ncbi\.nlm\.nih\.gov\/8512476/);
  assert.doesNotMatch(block, /OCU400/, 'gene therapy is not an OTC supplement');
});

test('headings and table headers do not survive the loss of their content', () => {
  const cleaned = dropEmptyStructure([
    '## 4. Clinical Trials',
    '',
    '|---|',
    '',
    '## 7. Interaction Plan',
    '',
    '| Drug A | Drug B | Interaction | Severity |',
    '|---|---|---|---|',
    '',
    '## 8. Safety Considerations'
  ].join('\n'));
  assert.doesNotMatch(cleaned, /^\|---\|$/m, 'a bare separator must not reach the reader');
  assert.doesNotMatch(cleaned, /Drug A \| Drug B/, 'a table with no rows must be removed');
  assert.match(cleaned, /## 8\. Safety Considerations\n\nNothing was found/);
});

test('populated tables and sections are left alone', () => {
  const intact = [
    '## 2. Centers',
    '',
    '| Center | City |',
    '|---|---|',
    '| Bascom Palmer | Miami |'
  ].join('\n');
  assert.equal(dropEmptyStructure(intact), intact);
});
