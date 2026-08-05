import assert from 'node:assert/strict';
import test from 'node:test';

import { claimSupportedBySource } from '../lib/claim-source-proof.js';
import { finalizeReportText } from '../lib/report-polish.js';

const vyalevLabel = {
  title: 'VYALEV (foscarbidopa and foslevodopa) prescribing information',
  url: 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2024/216962s000lbl.pdf',
  accessLevel: 'full-text',
  summary:
    'VYALEV contains foscarbidopa and foslevodopa and is administered by continuous ' +
    'subcutaneous infusion over 24 hours for motor fluctuations in adults with advanced Parkinson disease.'
};
const oldLevodopaReview = {
  title: 'Pharmacological Treatment of Parkinson Disease: A Review',
  doi: '10.1001/jama.2014.3654',
  url: 'https://jamanetwork.com/journals/jama/article-abstract/1861807',
  accessLevel: 'abstract',
  summary:
    'A 2014 review of oral levodopa, dopamine agonists, motor fluctuations, dyskinesia, ' +
    'psychosis, depression, orthostatic hypotension, and other Parkinson disease treatments.'
};

test('exact product claims require the exact product source', () => {
  const claim =
    'VYALEV contains foscarbidopa and foslevodopa and uses continuous subcutaneous infusion over 24 hours for advanced Parkinson disease.';
  assert.equal(claimSupportedBySource(claim, vyalevLabel, {
    condition: 'Parkinson disease'
  }).ok, true);
  const wrong = claimSupportedBySource(claim, oldLevodopaReview, {
    condition: 'Parkinson disease'
  });
  assert.equal(wrong.ok, false);
  assert.ok(['NUMBER_MISMATCH', 'INTERVENTION_MISMATCH'].includes(wrong.reason));
});

test('dossier-only rows can never prove patient-facing medical claims', () => {
  const result = claimSupportedBySource(
    'Experimental therapy reduced symptoms in Huntington disease.',
    {
      title: 'Clinical caution — Huntington disease',
      accessLevel: 'dossier',
      summary: 'Experimental therapy reduced symptoms in Huntington disease.'
    },
    { condition: 'Huntington disease' }
  );
  assert.deepEqual(result, { ok: false, reason: 'UNVERIFIABLE_SOURCE' });
});

test('value and unit mutations fail despite matching disease and treatment words', () => {
  const source = {
    title: 'Nintedanib trial in idiopathic pulmonary fibrosis',
    pmid: '24836310',
    url: 'https://pubmed.ncbi.nlm.nih.gov/24836310/',
    accessLevel: 'abstract',
    summary: 'Nintedanib reduced annual FVC decline by 125.3 mL versus placebo in IPF.'
  };
  assert.equal(claimSupportedBySource(
    'Nintedanib reduced annual FVC decline by 125.3 mL versus placebo in IPF.',
    source,
    { condition: 'idiopathic pulmonary fibrosis' }
  ).ok, true);
  assert.equal(claimSupportedBySource(
    'Nintedanib reduced annual FVC decline by 150 mg versus placebo in IPF.',
    source,
    { condition: 'idiopathic pulmonary fibrosis' }
  ).reason, 'NUMBER_MISMATCH');
});

test('reversed clinical outcome direction cannot prove a claim', () => {
  const source = {
    title: 'Mortality outcome trial',
    pmid: '12345678',
    url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/',
    accessLevel: 'abstract',
    summary: 'The intervention increased mortality in adults with severe disease.'
  };
  const result = claimSupportedBySource(
    'The intervention reduced mortality in adults with severe disease.',
    source
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'OUTCOME_DIRECTION_MISMATCH');
});

test('nested risk direction is scoped without weakening reversal checks', () => {
  const reducedMortality = {
    title: 'Mortality risk reduction trial',
    pmid: '22345678',
    url: 'https://pubmed.ncbi.nlm.nih.gov/22345678/',
    accessLevel: 'abstract',
    summary: 'The intervention reduced mortality risk in adults with severe disease.'
  };
  const increasedMortality = {
    ...reducedMortality,
    pmid: '32345678',
    url: 'https://pubmed.ncbi.nlm.nih.gov/32345678/',
    summary: 'The intervention increased mortality in adults with severe disease.'
  };
  const scopedClaim =
    'The intervention reduced the risk of increased mortality in adults with severe disease.';

  assert.equal(claimSupportedBySource(scopedClaim, reducedMortality).ok, true);
  const reversedScoped = claimSupportedBySource(scopedClaim, increasedMortality);
  assert.equal(reversedScoped.ok, false);
  assert.equal(reversedScoped.reason, 'OUTCOME_DIRECTION_MISMATCH');

  const explicitOpposite = claimSupportedBySource(
    'The intervention reduced symptoms but increased mortality in adults with severe disease.',
    reducedMortality
  );
  assert.equal(explicitOpposite.ok, false);
  assert.equal(explicitOpposite.reason, 'OUTCOME_DIRECTION_MISMATCH');
});

test('hedging words are not intervention identities the source must name', () => {
  const source = {
    title: 'N-acetylcysteine improves retinal sensitivity in retinitis pigmentosa',
    pmid: '22222222',
    url: 'https://pubmed.ncbi.nlm.nih.gov/22222222/',
    accessLevel: 'abstract',
    summary: 'Oral NAC improved visual acuity and retinal sensitivity over 24 weeks in RP patients.'
  };
  // "suggests" stems to "suggest". When the generic-word list held only the
  // written form, the stem escaped it and became an intervention the paper had
  // to name, so every hedged sentence was deleted as unsourced.
  assert.equal(claimSupportedBySource(
    'Research suggests oral NAC improved retinal sensitivity over 24 weeks in RP.',
    source,
    { condition: 'retinitis pigmentosa' }
  ).ok, true);
  // The identity gate still rejects a claim about a drug the source never names.
  const wrongDrug = claimSupportedBySource(
    'Research suggests oral lutein improved retinal sensitivity over 24 weeks in RP.',
    source,
    { condition: 'retinitis pigmentosa' }
  );
  assert.equal(wrongDrug.ok, false);
  assert.equal(wrongDrug.reason, 'INTERVENTION_MISMATCH');
});

test('a claim matches an inflected source word (stemmed on both sides)', () => {
  const source = {
    title: 'Gene therapies for inherited retinal dystrophies',
    pmid: '33333333',
    url: 'https://pubmed.ncbi.nlm.nih.gov/33333333/',
    accessLevel: 'abstract',
    summary: 'Subretinal gene therapies improved retinal sensitivity in inherited retinal dystrophies.'
  };
  assert.equal(claimSupportedBySource(
    'Subretinal gene therapy improved retinal sensitivity in inherited retinal dystrophy.',
    source,
    { condition: 'inherited retinal dystrophy' }
  ).ok, true);
});

test('reader-facing finalization removes related-but-wrong linked papers', () => {
  const claim =
    'VYALEV contains foscarbidopa and foslevodopa and uses continuous subcutaneous ' +
    'infusion over 24 hours for advanced Parkinson disease.';
  const output = finalizeReportText(
    `${claim} ([old Parkinson review](${oldLevodopaReview.url})).`,
    {
      evidence: { groundedForPrompt: [oldLevodopaReview] },
      patient: { condition: 'Parkinson disease' },
      evidenceGrade: { tier: 'thin' }
    }
  );
  assert.doesNotMatch(output, /VYALEV|foscarbidopa|foslevodopa|1861807/i);
});

test('dossier-only evidence returns a fixed fail-closed response', () => {
  const output = finalizeReportText(
    'A generated medical claim with a related-looking source.',
    {
      evidence: {
        groundedForPrompt: [{
          title: 'Clinical intake',
          accessLevel: 'dossier',
          summary: 'A generated medical claim with a related-looking source.'
        }]
      },
      patient: { condition: 'Example condition' },
      evidenceGrade: { tier: 'dossier-only' }
    }
  );
  assert.equal(
    output,
    'We could not verify enough published research to produce a reliable report for this condition.'
  );
});
