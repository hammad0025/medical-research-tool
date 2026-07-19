import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitEvidencePools,
  admitSourceRow,
  admitSourceRows
} from '../lib/source-admission-gate.js';

const condition = 'Idiopathic Pulmonary Fibrosis';
const exactSource = {
  id: 'ascend',
  source: 'PubMed',
  title: 'A phase 3 trial of pirfenidone in patients with idiopathic pulmonary fibrosis',
  pmid: '24836312',
  doi: '10.1056/NEJMoa1402582',
  url: 'https://pubmed.ncbi.nlm.nih.gov/24836312/',
  accessLevel: 'abstract',
  abstract: 'In this phase 3 trial, patients with idiopathic pulmonary fibrosis received pirfenidone or placebo. Pirfenidone reduced decline in forced vital capacity over 52 weeks.'
};

test('retrieval admission rejects a swapped PMID URL', () => {
  const result = admitSourceRow({
    ...exactSource,
    url: 'https://pubmed.ncbi.nlm.nih.gov/24836310/'
  }, { condition });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PMID_URL_MISMATCH');
});

test('retrieval admission rejects an unrelated condition', () => {
  const result = admitSourceRow({
    ...exactSource,
    title: 'A randomized treatment trial in Parkinson disease',
    abstract: 'Adults with Parkinson disease received active treatment or placebo in this randomized study. Motor outcomes and adverse events were measured over 52 weeks.'
  }, { condition });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CONDITION_MISMATCH');
});

test('retrieval admission rejects dossier-only rows', () => {
  const result = admitSourceRow({
    ...exactSource,
    accessLevel: 'dossier'
  }, { condition });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DOSSIER_ACCESS');
});

test('retrieval admission rejects rows without source text', () => {
  const result = admitSourceRow({
    ...exactSource,
    abstract: ''
  }, { condition });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INSUFFICIENT_SOURCE_TEXT');
});

test('retrieval admission accepts an exact source with auditable proof material', () => {
  const result = admitSourceRow(exactSource, { condition });
  assert.equal(result.ok, true);
  assert.equal(result.row.sourceAdmission.status, 'accepted');
  assert.equal(result.row.sourceAdmission.identity.value, '24836312');
  assert.equal(result.row.sourceAdmission.provenance.providers[0], 'PubMed');
  assert.match(result.row.sourceAdmission.excerpt, /idiopathic pulmonary fibrosis/i);
  assert.equal(result.row.admissionReason, 'ADMITTED');
});

test('retrieval admission preserves specific PMC, DOI, DailyMed, FDA, and registry identities', () => {
  const support = 'Idiopathic pulmonary fibrosis is the stated indication or study population. This source contains enough direct text for later claim-level verification.';
  const rows = [
    { id: 'pmc', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/', abstract: support },
    { id: 'doi', doi: '10.1000/example.123', url: 'https://publisher.example/articles/example.123', abstract: support },
    { id: 'label', year: 2026, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=2e8c3537-36d7-4de5-9b5c-7a624b9a9e6e', summary: support },
    { id: 'fda', year: 2026, guidanceVersion: 'ApplNo 123456', url: 'https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=123456', summary: support },
    { id: 'trial', nctId: 'NCT12345678', url: 'https://clinicaltrials.gov/study/NCT12345678', summary: support }
  ];
  const result = admitSourceRows(rows, { condition });
  assert.equal(result.audit.rejected, 0);
  assert.deepEqual(result.accepted.map((row) => row.id), rows.map((row) => row.id));
});

test('retrieval admission removes rejected rows from both synthesis pools and counts reasons', () => {
  const bad = { ...exactSource, id: 'dossier', accessLevel: 'dossier' };
  const evidence = admitEvidencePools({
    groundedForPrompt: [exactSource, bad],
    topRanked: [bad, exactSource]
  }, { condition });
  assert.deepEqual(evidence.groundedForPrompt.map((row) => row.id), ['ascend']);
  assert.deepEqual(evidence.topRanked.map((row) => row.id), ['ascend']);
  assert.equal(evidence.sourceAdmissionAudit.groundedForPrompt.rejected, 1);
  assert.equal(evidence.sourceAdmissionAudit.groundedForPrompt.reasons.DOSSIER_ACCESS, 1);

  const batch = admitSourceRows([
    exactSource,
    { ...exactSource, id: 'missing', abstract: '' }
  ], { condition });
  assert.equal(batch.audit.accepted, 1);
  assert.equal(batch.audit.rejected, 1);
  assert.equal(batch.audit.rejectedRows[0].reason, 'INSUFFICIENT_SOURCE_TEXT');
});
