import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enforceQuantitativeCitationSupport,
  finalizeReportText
} from '../lib/report-polish.js';

const sources = [
  {
    id: 'nintedanib',
    title: 'INPULSIS nintedanib trial',
    summary: 'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in idiopathic pulmonary fibrosis.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/24836310/'
  },
  {
    id: 'pirfenidone',
    title: 'ASCEND pirfenidone trial',
    summary: 'Pirfenidone reduced the risk of FVC decline of 10% or death by 48% versus placebo in idiopathic pulmonary fibrosis.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/24836312/'
  },
  {
    id: 'guideline',
    title: '2022 IPF clinical practice guideline',
    summary: 'Guideline recommendations for idiopathic pulmonary fibrosis diagnosis and treatment.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/35486072/'
  },
  {
    id: 'unrelated',
    title: 'Diabetes mental health study',
    summary: 'Psychological distress among people with diabetes during the COVID-19 pandemic.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/32879637/'
  }
];

const evidence = { groundedForPrompt: sources };
const claims = [
  {
    source: 'nintedanib',
    text: 'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in idiopathic pulmonary fibrosis.'
  },
  {
    source: 'pirfenidone',
    text: 'Pirfenidone reduced the risk of FVC decline of 10% or death by 48% versus placebo in idiopathic pulmonary fibrosis.'
  }
];

const linked = (claim, source) =>
  `${String(claim).replace(/[.]\s*$/, '')} ([${source.title}](${source.url})).`;

test('every valid-but-wrong source permutation is rejected', () => {
  let checked = 0;
  for (const claim of claims) {
    for (const source of sources) {
      const output = enforceQuantitativeCitationSupport(linked(claim.text, source), evidence);
      if (source.id === claim.source) {
        assert.match(output.text, new RegExp(source.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      } else {
        assert.equal(output.text, '', `${claim.source} claim incorrectly survived ${source.id} source`);
        assert.equal(output.stripped, 1);
      }
      checked += 1;
    }
  }
  assert.equal(checked, claims.length * sources.length);
});

test('value unit intervention comparator and population mutations fail closed', () => {
  const source = sources[0];
  const mutations = [
    'Nintedanib reduced annual FVC decline by 115 mL/year versus placebo in idiopathic pulmonary fibrosis.',
    'Nintedanib reduced annual FVC decline by 107 mg/day versus placebo in idiopathic pulmonary fibrosis.',
    'Pirfenidone reduced annual FVC decline by 107 mL/year versus placebo in idiopathic pulmonary fibrosis.',
    'Nintedanib reduced annual FVC decline by 107 mL/year versus active control in idiopathic pulmonary fibrosis.',
    'Nintedanib reduced annual FVC decline by 107 mL/year versus placebo in lung cancer.'
  ];
  for (const mutation of mutations) {
    const output = enforceQuantitativeCitationSupport(linked(mutation, source), evidence);
    assert.equal(output.text, '', mutation);
    assert.equal(output.stripped, 1, mutation);
  }
});

test('full report finalization rejects wrong-source labels and URLs together', () => {
  let checked = 0;
  for (const claim of claims) {
    for (const source of sources.filter((candidate) => candidate.id !== claim.source)) {
      const output = finalizeReportText(linked(claim.text, source), {
        evidence,
        patient: { condition: 'Idiopathic pulmonary fibrosis' }
      });
      assert.doesNotMatch(output, new RegExp(source.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(output, /\b(?:107\s*mL\/year|48%)\b/i);
      checked += 1;
    }
  }
  assert.equal(checked, claims.length * (sources.length - 1));
});
