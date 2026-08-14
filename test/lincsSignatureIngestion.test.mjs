import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPerturbationSignaturesFromLincsSlice } from '../server/lincsSignatureIngestion.mjs'
import { rankTranscriptomicInversionCandidates } from '../server/transcriptomicInversion.mjs'

const genes = ['COL1A1', 'COL3A1', 'TGFB1', 'SMAD3', 'ACTA2', 'SFTPC', 'SFTPA1', 'AGER', 'CAV1', 'NKX2-1']
  .map((symbol, index) => ({ id: String(index + 1), symbol, geneSpace: 'landmark' }))

const dataset = {
  id: 'cmap-gse-test-level-5',
  title: 'Authorized CMap L1000 Level 5 release',
  url: 'https://clue.io/data',
  level: '5',
  processing: 'MODZ moderated z-score signatures',
  aggregationMethod: 'by_rna_well',
  geneSpace: 'landmark',
  release: 'test release',
  localArtifact: 'authorized-level5.gctx',
}

const scoreMap = Object.fromEntries(genes.map((gene, index) => [gene.symbol, index < 5 ? -2.5 : 2.5]))
const measuredSignature = (signatureId, compoundName, overrides = {}) => ({
  signatureId,
  pertId: `BRD-${signatureId}`,
  pertName: compoundName,
  pertType: 'trt_cp',
  cellLine: 'A549',
  dose: '10',
  doseUnit: 'uM',
  doseBinned: '10 uM',
  timeHours: 24,
  timeUnit: 'h',
  timeBinned: '24 h',
  tas: 0.75,
  aggregationMethod: 'by_rna_well',
  zScores: scoreMap,
  ...overrides,
})

test('a documented Level 5 MODZ slice creates a measured perturbation record', () => {
  const result = buildPerturbationSignaturesFromLincsSlice({
    dataset,
    genes,
    signatures: [measuredSignature('A549_24H:TEST', 'Measured test compound')],
    selection: { allowedCellLines: ['A549'] },
  })
  assert.equal(result.perturbationSignatures.length, 1)
  assert.equal(result.perturbationSignatures[0].source.signatureId, 'A549_24H:TEST')
  assert.equal(result.perturbationSignatures[0].source.cellLine, 'A549')
  assert.equal(result.perturbationSignatures[0].source.pertId, 'BRD-A549_24H:TEST')
  assert.equal(result.perturbationSignatures[0].source.tas, 0.75)
  assert.equal(result.perturbationSignatures[0].source.geneSpace, 'landmark')
  assert.equal(result.perturbationSignatures[0].genes.length, 10)
  assert.ok(Number.isFinite(result.perturbationSignatures[0].genes[0].effect))
  assert.match(result.perturbationSignatures[0].source.processing, /MODZ/i)
})

test('imported LINCS records survive the inversion ranking contract', () => {
  const imported = buildPerturbationSignaturesFromLincsSlice({
    dataset,
    genes,
    signatures: [measuredSignature('A549_24H:INVERSE', 'Measured inverse compound')],
    selection: { allowedCellLines: ['A549'] },
  })

  const diseaseSignature = {
    condition: 'Synthetic Smoke Condition',
    source: {
      id: 'synthetic-smoke',
      title: 'Synthetic smoke test only',
      url: 'https://example.org/smoke',
      organism: 'Homo sapiens',
      tissue: 'Synthetic human lung cell smoke test',
      contrast: 'Synthetic disease-like signature versus synthetic control',
      processing: 'Synthetic smoke test only; not real research data',
    },
    genes: genes.map((gene, index) => ({
      symbol: gene.symbol,
      effect: index < 5 ? 2.5 : -2.5,
      adjustedPValue: 0.01,
    })),
  }

  const ranked = rankTranscriptomicInversionCandidates({
    diseaseSignature,
    perturbationSignatures: imported.perturbationSignatures,
  })

  assert.equal(ranked.candidates.length, 1)
  assert.equal(ranked.candidates[0].compoundName, 'Measured inverse compound')
  assert.equal(ranked.candidates[0].score.sharedGenes, 10)
  assert.equal(ranked.rejected.length, 0)
})

test('the local importer rejects non-Level 5 data and an unspecified cell-line choice', () => {
  assert.throws(() => buildPerturbationSignaturesFromLincsSlice({
    dataset: { ...dataset, level: '4' },
    genes,
    signatures: [],
    selection: { allowedCellLines: ['A549'] },
  }), /Level 5/i)
  assert.throws(() => buildPerturbationSignaturesFromLincsSlice({ dataset, genes, signatures: [] }), /cell lines/i)
  assert.throws(() => buildPerturbationSignaturesFromLincsSlice({
    dataset: { ...dataset, aggregationMethod: 'by_plate' },
    genes,
    signatures: [],
    selection: { allowedCellLines: ['A549'] },
  }), /by_rna_well/i)
})

test('the importer withholds genetic, low-signal, wrong-cell, and duplicate records', () => {
  const result = buildPerturbationSignaturesFromLincsSlice({
    dataset,
    genes,
    signatures: [
      measuredSignature('GENETIC', 'Target knockdown', { pertType: 'trt_sh' }),
      measuredSignature('LOW', 'Low signal compound', { zScores: Object.fromEntries(genes.map((gene) => [gene.symbol, 1.5])) }),
      measuredSignature('OTHER-CELL', 'Other cell compound', { cellLine: 'PC3' }),
      measuredSignature('FIRST', 'Duplicate compound'),
      measuredSignature('SECOND', 'Duplicate compound'),
    ],
    selection: { allowedCellLines: ['A549'] },
  })
  assert.equal(result.perturbationSignatures.length, 1)
  assert.equal(result.excluded.length, 4)
  assert.ok(result.excluded.some((entry) => /small-molecule/i.test(entry.reason)))
  assert.ok(result.excluded.some((entry) => /z-score threshold/i.test(entry.reason)))
  assert.ok(result.excluded.some((entry) => /cell-line selection/i.test(entry.reason)))
  assert.ok(result.excluded.some((entry) => /second signature/i.test(entry.reason)))
})

test('the local importer withholds incomplete, low-quality, or incompatible source metadata', () => {
  const result = buildPerturbationSignaturesFromLincsSlice({
    dataset,
    genes,
    signatures: [
      measuredSignature('NO-PERT-ID', 'Missing perturbagen ID', { pertId: '' }),
      measuredSignature('NO-BINNED-DOSE', 'Missing binned dose', { doseBinned: '' }),
      measuredSignature('BAD-AGGREGATION', 'Wrong aggregation', { aggregationMethod: 'by_plate' }),
      measuredSignature('LOW-TAS', 'Low quality', { tas: 0.49 }),
    ],
    selection: { allowedCellLines: ['A549'], minimumTas: 0 },
  })
  assert.equal(result.perturbationSignatures.length, 0)
  assert.equal(result.selection.minimumTas, 0.5)
  assert.ok(result.excluded.some((entry) => /pert_id/i.test(entry.reason)))
  assert.ok(result.excluded.some((entry) => /canonical dose/i.test(entry.reason)))
  assert.ok(result.excluded.some((entry) => /by_rna_well/i.test(entry.reason)))
  assert.ok(result.excluded.some((entry) => /TAS/i.test(entry.reason)))
})

test('the importer enforces a declared gene space and can restrict an import to core Touchstone cell lines', () => {
  assert.throws(() => buildPerturbationSignaturesFromLincsSlice({
    dataset: { ...dataset, geneSpace: 'landmark' },
    genes: genes.map((gene) => ({ ...gene, geneSpace: 'bing' })),
    signatures: [],
    selection: { allowedCellLines: ['A549'] },
  }), /mapped gene symbols/i)

  assert.throws(() => buildPerturbationSignaturesFromLincsSlice({
    dataset,
    genes,
    signatures: [],
    selection: { allowedCellLines: ['HeLa'], restrictToCoreTouchstone: true },
  }), /Core Touchstone/i)

  const result = buildPerturbationSignaturesFromLincsSlice({
    dataset,
    genes,
    signatures: [measuredSignature('A549-CORE', 'Core line compound')],
    selection: { allowedCellLines: ['A549'], restrictToCoreTouchstone: true },
  })
  assert.equal(result.perturbationSignatures.length, 1)
  assert.equal(result.selection.restrictToCoreTouchstone, true)
})
