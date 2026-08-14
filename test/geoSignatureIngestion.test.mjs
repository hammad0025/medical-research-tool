import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  buildTranscriptomicJobFromGeoDge,
  fetchGeoSeriesManifest,
  geoFamilySoftUrl,
  geoSeriesMatrixUrl,
  parseCuratedDifferentialExpression,
  searchGeoStudies,
} from '../server/geoSignatureIngestion.mjs'

const familySoft = `^SERIES = GSE12345
!Series_title = Human IPF lung comparison
!Series_summary = A human tissue transcriptomic study.
!Series_sample_id = GSM1
!Series_sample_id = GSM2
^SAMPLE = GSM1
!Sample_title = IPF lung sample
!Sample_organism_ch1 = Homo sapiens
!Sample_source_name_ch1 = lung
!Sample_characteristics_ch1 = diagnosis: idiopathic pulmonary fibrosis
^SAMPLE = GSM2
!Sample_title = control lung sample
!Sample_organism_ch1 = Homo sapiens
!Sample_source_name_ch1 = lung
!Sample_characteristics_ch1 = diagnosis: control
`

const dgeTable = `gene_symbol\tlog2FoldChange\tpadj
COL1A1\t2.4\t0.001
COL3A1\t2.1\t0.001
TGFB1\t1.8\t0.001
SMAD3\t1.7\t0.001
ACTA2\t1.6\t0.001
SFTPC\t-2.1\t0.001
SFTPA1\t-1.9\t0.001
AGER\t-1.8\t0.001
CAV1\t-1.7\t0.001
NKX2-1\t-1.6\t0.001
NOISY\t2.5\t0.2
`

const response = (payload, { status = 200, headers = {} } = {}) => new Response(payload, { status, headers })

test('GEO URL helpers construct the official family and matrix paths', () => {
  assert.equal(geoFamilySoftUrl('GSE12345'), 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/soft/GSE12345_family.soft.gz')
  assert.equal(geoSeriesMatrixUrl('GSE12345'), 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/matrix/GSE12345_series_matrix.txt.gz')
  assert.throws(() => geoFamilySoftUrl('not-a-series'), /must look like/i)
})

test('a GEO family manifest confirms human metadata before a job is made', async () => {
  const manifest = await fetchGeoSeriesManifest('GSE12345', {
    fetchImpl: async () => response(gzipSync(familySoft)),
  })
  assert.equal(manifest.human, true)
  assert.equal(manifest.sampleCount, 2)
  assert.equal(manifest.samples[0].accession, 'GSM1')

  const parsed = parseCuratedDifferentialExpression(dgeTable)
  const job = buildTranscriptomicJobFromGeoDge({
    jobId: 'ipf-curated-test',
    condition: 'Idiopathic Pulmonary Fibrosis',
    conditionSearchTerms: ['Pulmonary Fibrosis'],
    manifest,
    differentialExpression: parsed,
    tissue: 'Lung',
    contrast: 'IPF lung versus control lung',
  })
  assert.equal(job.diseaseSignature.genes.length, 10)
  assert.equal(job.diseaseSignature.ingestion.upGeneCount, 5)
  assert.equal(job.diseaseSignature.ingestion.downGeneCount, 5)
  assert.equal(job.diseaseSignature.ingestion.usableRows, 11)
})

test('an ambiguous or non-human GEO source cannot be imported as a human signature', async () => {
  const nonHumanSoft = familySoft.replace(/Homo sapiens/g, 'Mus musculus')
  const manifest = await fetchGeoSeriesManifest('GSE12345', {
    fetchImpl: async () => response(gzipSync(nonHumanSoft)),
  })
  assert.equal(manifest.human, false)
  assert.throws(() => buildTranscriptomicJobFromGeoDge({
    condition: 'Idiopathic Pulmonary Fibrosis',
    manifest,
    differentialExpression: dgeTable,
    tissue: 'Lung',
    contrast: 'Disease versus control',
  }), /exactly one human organism/i)
  assert.throws(() => parseCuratedDifferentialExpression('gene\tlogFC\nCOL1A1\t2'), /adjusted p-value/i)
})

test('GEO study search returns a reviewable study list rather than a signature', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('esearch.fcgi')) return response(JSON.stringify({ esearchresult: { idlist: ['100'] } }))
    return response(JSON.stringify({ result: { 100: { accession: 'GSE12345', title: 'Human IPF study', summary: 'Study summary', n_samples: 24 } } }))
  }
  const studies = await searchGeoStudies('Idiopathic Pulmonary Fibrosis', { fetchImpl })
  assert.equal(studies.length, 1)
  assert.equal(studies[0].accession, 'GSE12345')
  assert.match(studies[0].url, /GSE12345/)
})
