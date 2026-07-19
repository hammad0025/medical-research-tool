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
