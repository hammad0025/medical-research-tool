import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectKbMetadataRecords,
  fetchCrossrefMetadata,
  fetchPubMedMetadata,
  resolveDoisToPmids,
  titleCoverage,
  validateAuthoritativeMetadata,
  validateCrossrefMetadata,
  validateStaticMetadataRecord
} from '../scripts/audit-kb-metadata.mjs';

const authoritative = {
  title: 'A phase 3 trial of pirfenidone in patients with idiopathic pulmonary fibrosis',
  doi: '10.1056/NEJMoa1402582'
};

test('matching PMID DOI URL and title pass metadata integrity', () => {
  const record = {
    file: 'ipf.json',
    location: 'items[0]',
    id: 'ascend',
    title: authoritative.title,
    pmid: '24836312',
    doi: '10.1056/nejmoa1402582',
    url: 'https://pubmed.ncbi.nlm.nih.gov/24836312/'
  };
  assert.deepEqual(validateStaticMetadataRecord(record), []);
  assert.deepEqual(validateAuthoritativeMetadata(record, authoritative), []);
});

test('a valid but swapped PubMed URL is rejected', () => {
  const issues = validateStaticMetadataRecord({
    title: authoritative.title,
    pmid: '24836312',
    doi: authoritative.doi.toLowerCase(),
    url: 'https://pubmed.ncbi.nlm.nih.gov/24836310/'
  });
  assert.ok(issues.some((issue) => /disagrees with PubMed URL/i.test(issue)));
});

test('a valid but wrong DOI is rejected against PubMed metadata', () => {
  const issues = validateAuthoritativeMetadata({
    title: authoritative.title,
    pmid: '24836312',
    doi: '10.1056/NEJMoa1402584'
  }, authoritative);
  assert.ok(issues.some((issue) => /DOI mismatch/i.test(issue)));
});

test('a valid but unrelated paper title is rejected', () => {
  const issues = validateAuthoritativeMetadata({
    title: 'Mental health in patients with diabetes during COVID-19',
    pmid: '24836312',
    doi: authoritative.doi.toLowerCase()
  }, authoritative);
  assert.ok(issues.some((issue) => /title mismatch/i.test(issue)));
  assert.ok(titleCoverage(
    'Mental health in patients with diabetes during COVID-19',
    authoritative.title
  ) < 0.55);
});

test('quarantined evidence is excluded from metadata checks', () => {
  const records = collectKbMetadataRecords({
    items: [
      {
        id: 'bad',
        quarantined: true,
        title: 'Invented paper',
        pmid: '12345678',
        doi: '10.1000/invented',
        url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
      },
      {
        id: 'good',
        title: authoritative.title,
        pmid: '24836312',
        doi: authoritative.doi,
        url: 'https://pubmed.ncbi.nlm.nih.gov/24836312/'
      }
    ]
  }, 'ipf.json');
  assert.deepEqual(records.map((record) => record.id), ['good']);
});

test('batched PubMed lookup parses authoritative DOI and title', async () => {
  const observed = [];
  const metadata = await fetchPubMedMetadata(['24836312'], {
    fetchImpl: async (url) => {
      observed.push(String(url));
      return new Response(JSON.stringify({
        result: {
          uids: ['24836312'],
          24836312: {
            title: authoritative.title,
            articleids: [{ idtype: 'doi', value: authoritative.doi }]
          }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(observed.length, 1);
  assert.deepEqual(metadata.get('24836312'), authoritative);
});

test('DOI lookup resolves the authoritative PMID without AI providers', async () => {
  const resolved = await resolveDoisToPmids([authoritative.doi], {
    delayMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      esearchresult: { idlist: ['24836312'] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  });
  assert.deepEqual(resolved.get(authoritative.doi.toLowerCase()), ['24836312']);
});

test('DOI-only publisher records are checked against Crossref metadata', async () => {
  const doi = '10.1176/appi.books.9780890424841';
  const title = 'The American Psychiatric Association Practice Guideline for the Treatment of Patients With Schizophrenia, Third Edition';
  const metadata = await fetchCrossrefMetadata([doi], {
    delayMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      message: { DOI: doi, title: [title], URL: `https://doi.org/${doi}` }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  });
  assert.deepEqual(
    validateCrossrefMetadata({ doi, title }, metadata.get(doi)),
    []
  );
  assert.ok(validateCrossrefMetadata(
    { doi, title: 'Unrelated clinical paper' },
    metadata.get(doi)
  ).some((issue) => /title mismatch/i.test(issue)));
});
