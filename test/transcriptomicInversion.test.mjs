import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createHumanDiseaseSignature,
  rankTranscriptomicInversionCandidates,
  releaseNovelTranscriptomicHypotheses,
  scoreSignatureInversion,
} from '../server/transcriptomicInversion.mjs'

const humanSource = {
  id: 'geo-gse-test',
  title: 'Human lung transcriptome comparison',
  url: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSETEST',
  accession: 'GSETEST',
  organism: 'Homo sapiens',
  tissue: 'Lung',
  contrast: 'Idiopathic pulmonary fibrosis versus control lung',
  processing: 'Curated log2 fold-change and adjusted p-value table.',
}

const genes = [
  ['COL1A1', 2.4], ['COL3A1', 2.1], ['TGFB1', 1.8], ['SMAD3', 1.5],
  ['ACTA2', 1.4], ['MMP7', 1.2], ['CXCL12', -1.8], ['SFTPA1', -1.6],
  ['SFTPC', -1.5], ['AGER', -1.2],
].map(([symbol, log2FoldChange]) => ({ symbol, log2FoldChange, adjustedPValue: 0.01 }))

const diseaseSignature = {
  condition: 'Idiopathic Pulmonary Fibrosis',
  source: humanSource,
  genes,
}

const perturbation = (compoundName, effectMultiplier, signatureId) => ({
  compoundName,
  source: {
    id: `cmap-${signatureId}`,
    title: `CMap L1000 signature for ${compoundName}`,
    url: `https://clue.io/`,
    signatureId,
    cellLine: 'A549',
    dose: '10',
    doseUnit: 'uM',
    timeHours: 24,
    dataset: 'L1000',
    processing: 'Level 5 replicate-collapsed z-score signature.',
  },
  genes: genes.map((gene) => ({ symbol: gene.symbol, zScore: gene.log2FoldChange * effectMultiplier })),
})

test('a measured opposite signature ranks above a same-direction signature', () => {
  const result = rankTranscriptomicInversionCandidates({
    diseaseSignature,
    perturbationSignatures: [
      perturbation('Opposite compound', -1, 'SIG-OPPOSITE'),
      perturbation('Same direction compound', 1, 'SIG-SAME'),
    ],
  })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].compoundName, 'Opposite compound')
  assert.equal(result.candidates[0].score.sharedGenes, 10)
  assert.ok(Math.abs(result.candidates[0].score.inversionScore - 1) < 1e-12)
  assert.equal(result.candidates[0].score.oppositeFraction, 1)
  assert.match(result.rejected[0].reason, /pre-set inversion thresholds/i)
})

test('a disease signature requires a human, linked, filtered source record', () => {
  assert.throws(() => createHumanDiseaseSignature({
    condition: 'Test condition',
    source: { ...humanSource, organism: 'Mus musculus' },
    genes,
  }), /human tissue or cells/i)

  assert.throws(() => createHumanDiseaseSignature({
    condition: 'Test condition',
    source: { ...humanSource, url: '' },
    genes,
  }), /titled, linked source/i)
})

test('the release gate withholds a rank when the literature search is incomplete or finds a match', async () => {
  const ranked = rankTranscriptomicInversionCandidates({
    diseaseSignature,
    perturbationSignatures: [perturbation('Opposite compound', -1, 'SIG-OPPOSITE')],
  })
  const held = await releaseNovelTranscriptomicHypotheses(ranked, async () => ({ complete: false, status: 'unavailable', checks: [] }))
  assert.equal(held.released.length, 0)
  assert.match(held.withheld[0].reason, /did not finish/i)

  const released = await releaseNovelTranscriptomicHypotheses(ranked, async () => ({ complete: true, status: 'not-found', checks: [{ conditionTerm: 'Idiopathic Pulmonary Fibrosis' }] }))
  assert.equal(released.released.length, 1)
  assert.equal(released.released[0].label, 'Not researched for this condition')
})

test('scoring with too little overlap cannot create a candidate', () => {
  const disease = createHumanDiseaseSignature({ condition: 'Test', source: humanSource, genes })
  const score = scoreSignatureInversion(disease, { genes: [{ symbol: 'COL1A1', effect: -2 }] })
  assert.equal(score.eligible, false)
  assert.match(score.reason, /Only 1 genes overlap/i)
})
