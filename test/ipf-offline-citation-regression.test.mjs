import assert from 'node:assert/strict';
import test from 'node:test';

import { loadKb } from '../lib/kb.js';
import { finalizeReportText } from '../lib/report-polish.js';

const kb = await loadKb('Idiopathic pulmonary fibrosis');
const evidence = {
  groundedForPrompt: kb.items,
  topRanked: kb.items,
  knowledgeBase: {
    canonicalFacts: kb.meta.canonicalFacts,
    lifestyleRecommendations: kb.meta.lifestyleRecommendations,
    redFlags: kb.meta.redFlags,
    pipelineDrugs: kb.meta.pipelineDrugs,
    excludedAgents: kb.meta.excludedAgents
  }
};
const patient = { condition: 'Idiopathic pulmonary fibrosis' };

const finalize = (text) => finalizeReportText(text, { evidence, patient });

test('IPF KB exposes corrected primary-paper identifiers', () => {
  const byId = new Map(kb.items.map((item) => [item.id, item]));
  assert.equal(byId.get('ipf-ascend-king-2014')?.pmid, '24836312');
  assert.equal(byId.get('ipf-inpulsis-richeldi-2014')?.pmid, '24836310');
  assert.equal(byId.get('ipf-panther-nac-2014')?.pmid, '24836309');
  assert.equal(byId.get('ipf-capacity-noble-2011')?.pmid, '21571362');
  assert.equal(byId.get('ipf-raghu-gerd-2006')?.pmid, '16387946');
});

test('pirfenidone efficacy cannot cite the nintedanib INPULSIS paper', () => {
  const output = finalize(
    'Pirfenidone reduced FVC decline or death by 48% ' +
    '([INPULSIS](https://pubmed.ncbi.nlm.nih.gov/24836310/)).'
  );
  assert.doesNotMatch(output, /48%/);
  assert.doesNotMatch(output, /24836310/);
});

test('rehabilitation distance cannot cite the general 2022 IPF guideline', () => {
  const output = finalize(
    'Pulmonary rehabilitation improved six-minute walk distance by 40 metres ' +
    '([ATS guideline](https://pubmed.ncbi.nlm.nih.gov/35486072/)).'
  );
  assert.doesNotMatch(output, /40 metres/i);
  assert.doesNotMatch(output, /35486072/);
});

test('GERD prevalence cannot retain the previously corrupted PubMed destination', () => {
  const output = finalize(
    'Abnormal acid reflux was found in 87% of IPF patients ' +
    '([Raghu 2006](https://pubmed.ncbi.nlm.nih.gov/16455836/)).'
  );
  assert.doesNotMatch(output, /87%/);
  assert.doesNotMatch(output, /16455836/);
});

test('unsupported valproate mechanism is removed from a repurpose card', () => {
  const output = finalize([
    'CANDIDATE: Valproic acid',
    'CLASS: Antiseizure medication',
    'WHY_IT_MIGHT_HELP: Valproic acid inhibits HDAC and may switch off lung scarring genes ' +
      '([ATS guideline](https://pubmed.ncbi.nlm.nih.gov/35486072/)).'
  ].join('\n'));
  assert.doesNotMatch(output, /inhibits HDAC|switch off lung scarring/i);
  assert.doesNotMatch(output, /35486072/);
});

test('offline IPF replay emits no generic citation-only labels', () => {
  const output = finalize(
    'Nintedanib reduced annual FVC decline by 125.3 mL ' +
    '([source](https://pubmed.ncbi.nlm.nih.gov/24836310/)).'
  );
  assert.doesNotMatch(output, /\[(?:source|citation|reference|link)\s*↗?\]/i);
});
