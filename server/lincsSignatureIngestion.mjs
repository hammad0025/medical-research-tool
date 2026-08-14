import { createPerturbationSignature } from './transcriptomicInversion.mjs'

const DEFAULT_MINIMUM_ABSOLUTE_Z_SCORE = 2
const DEFAULT_MINIMUM_REGULATED_GENES = 8
const DEFAULT_MINIMUM_TAS = 0.5
const CORE_TOUCHSTONE_CELL_LINES = new Set(['A375', 'A549', 'HEPG2', 'HCC515', 'HA1E', 'HT29', 'MCF7', 'PC3', 'VCAP'])

const cleanText = (value, limit = 500) => String(value || '')
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const geneKey = (value) => cleanText(value, 80).toUpperCase().replace(/[^A-Z0-9-]/g, '')
const candidateKey = (value) => cleanText(value, 160).toLocaleLowerCase()
const numericValue = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const validUrl = (value) => /^https:\/\//i.test(cleanText(value, 1_000))

const isLevelFive = (value) => /^(?:5|level[- ]?5)$/i.test(cleanText(value, 40))
const isModz = (value) => /(?:modz|moderated z[- ]?score)/i.test(cleanText(value, 160))
const normalizedPerturbationType = (value) => cleanText(value, 80).toLowerCase()
const smallMoleculePerturbation = (value) => ['trt_cp', 'compound', 'small molecule'].includes(normalizedPerturbationType(value))
const normalizedGeneSpace = (value) => {
  const normalized = cleanText(value, 80).toLowerCase().replace(/[ _-]/g, '')
  if (normalized === 'landmark' || normalized === 'lm') return 'landmark'
  if (normalized === 'bing' || normalized === 'bestinferred' || normalized === 'bestinferredgenes') return 'bing'
  return ''
}
const byRnaWellAggregation = (value) => cleanText(value, 80).toLowerCase() === 'by_rna_well'

const requiredDataset = (dataset) => {
  const id = cleanText(dataset?.id, 160)
  const title = cleanText(dataset?.title, 320)
  const url = cleanText(dataset?.url, 1_000)
  if (!id || !title || !validUrl(url)) throw new Error('A LINCS slice needs a titled, linked dataset record.')
  if (!isLevelFive(dataset?.level)) throw new Error('Only L1000 Level 5 signatures can enter the inversion worker.')
  if (!isModz(dataset?.processing)) throw new Error('Only L1000 MODZ signatures can enter the inversion worker.')
  if (!byRnaWellAggregation(dataset?.aggregationMethod)) throw new Error('Only Level 5 signatures aggregated by by_rna_well can enter the inversion worker.')
  const geneSpace = normalizedGeneSpace(dataset?.geneSpace)
  if (!geneSpace) throw new Error('A LINCS slice must declare a landmark or BING gene space.')
  return {
    id,
    title,
    url,
    level: '5',
    processing: cleanText(dataset.processing, 240),
    aggregationMethod: 'by_rna_well',
    geneSpace,
    release: cleanText(dataset.release, 120),
    localArtifact: cleanText(dataset.localArtifact, 320),
  }
}

const normalizedGenes = (genes, datasetGeneSpace) => {
  const seen = new Set()
  const output = []
  for (const gene of Array.isArray(genes) ? genes : []) {
    const symbol = geneKey(gene?.symbol || gene?.geneSymbol || gene?.id)
    const geneSpace = normalizedGeneSpace(gene?.geneSpace)
    const allowed = datasetGeneSpace === 'landmark'
      ? geneSpace === 'landmark'
      : ['landmark', 'bing'].includes(geneSpace)
    if (!symbol || !allowed || seen.has(symbol)) continue
    seen.add(symbol)
    output.push({ symbol, id: cleanText(gene?.id, 120), geneSpace })
  }
  if (output.length < DEFAULT_MINIMUM_REGULATED_GENES) {
    throw new Error(`A LINCS slice needs at least ${DEFAULT_MINIMUM_REGULATED_GENES} mapped gene symbols.`)
  }
  return output
}

const scoreRowsFor = (signature, genes) => {
  if (Array.isArray(signature?.zScores)) {
    if (signature.zScores.length !== genes.length) throw new Error('A LINCS z-score array must match the slice gene order exactly.')
    return genes.map((gene, index) => ({ symbol: gene.symbol, zScore: numericValue(signature.zScores[index]) }))
  }
  if (signature?.zScores && typeof signature.zScores === 'object') {
    const byGene = new Map(Object.entries(signature.zScores)
      .map(([symbol, score]) => [geneKey(symbol), numericValue(score)])
      .filter(([symbol, score]) => symbol && score !== null))
    return genes.map((gene) => ({ symbol: gene.symbol, zScore: byGene.get(gene.symbol) ?? null }))
  }
  throw new Error('A LINCS signature needs zScores as an ordered array or a gene-symbol map.')
}

const selectedCellLineSet = (value) => new Set((Array.isArray(value) ? value : [])
  .map((cellLine) => cleanText(cellLine, 120).toLocaleLowerCase())
  .filter(Boolean))

// This consumes a bounded, local export from a Level 5 GCTx file. The browser
// never receives a GCTx matrix, and this module does not make an API result
// look like a measured signature.
export const buildPerturbationSignaturesFromLincsSlice = ({
  dataset,
  genes,
  signatures,
  selection = {},
} = {}) => {
  const validatedDataset = requiredDataset(dataset)
  const mappedGenes = normalizedGenes(genes, validatedDataset.geneSpace)
  const allowedCellLines = selectedCellLineSet(selection.allowedCellLines)
  if (!allowedCellLines.size) throw new Error('Select one or more documented cell lines before importing a LINCS slice.')
  const minimumAbsoluteZScore = Number.isFinite(Number(selection.minimumAbsoluteZScore))
    ? Math.max(Number(selection.minimumAbsoluteZScore), 0)
    : DEFAULT_MINIMUM_ABSOLUTE_Z_SCORE
  const minimumRegulatedGenes = Number.isInteger(selection.minimumRegulatedGenes) && selection.minimumRegulatedGenes >= 4
    ? selection.minimumRegulatedGenes
    : DEFAULT_MINIMUM_REGULATED_GENES
  const minimumTas = Number.isFinite(Number(selection.minimumTas))
    ? Math.max(Number(selection.minimumTas), DEFAULT_MINIMUM_TAS)
    : DEFAULT_MINIMUM_TAS
  const restrictToCoreTouchstone = selection.restrictToCoreTouchstone === true
  if (restrictToCoreTouchstone && [...allowedCellLines].some((cellLine) => !CORE_TOUCHSTONE_CELL_LINES.has(cellLine.toUpperCase()))) {
    throw new Error('Core Touchstone restriction allows only A375, A549, HEPG2, HCC515, HA1E, HT29, MCF7, PC3, or VCAP.')
  }
  const perturbationSignatures = []
  const excluded = []
  const compoundsSeen = new Set()

  for (const rawSignature of Array.isArray(signatures) ? signatures : []) {
    const signatureId = cleanText(rawSignature?.signatureId, 180)
    const pertId = cleanText(rawSignature?.pertId, 160)
    const pertName = cleanText(rawSignature?.pertName || rawSignature?.pertIname || rawSignature?.compoundName, 160)
    const compoundName = pertName
    const cellLine = cleanText(rawSignature?.cellLine, 120)
    if (!signatureId || !pertId || !pertName || !cellLine) {
      excluded.push({ signatureId, compoundName, reason: 'The local signature is missing sig_id, pert_id, compound name, or cell line.' })
      continue
    }
    if (!smallMoleculePerturbation(rawSignature?.pertType)) {
      excluded.push({ signatureId, compoundName, reason: 'Only measured small-molecule perturbations are allowed in this slice.' })
      continue
    }
    if (!allowedCellLines.has(cellLine.toLocaleLowerCase())) {
      excluded.push({ signatureId, compoundName, reason: 'This signature is outside the documented cell-line selection.' })
      continue
    }
    if (restrictToCoreTouchstone && !CORE_TOUCHSTONE_CELL_LINES.has(cellLine.toUpperCase())) {
      excluded.push({ signatureId, compoundName, reason: 'This signature is outside the nine core Touchstone cell lines.' })
      continue
    }
    const dose = cleanText(rawSignature?.dose, 80)
    const doseUnit = cleanText(rawSignature?.doseUnit, 40)
    const doseBinned = cleanText(rawSignature?.doseBinned, 80)
    const timeHours = numericValue(rawSignature?.timeHours)
    const timeUnit = cleanText(rawSignature?.timeUnit, 40)
    const timeBinned = cleanText(rawSignature?.timeBinned, 80)
    const tas = numericValue(rawSignature?.tas)
    if (numericValue(dose) === null || numericValue(dose) <= 0 || !doseUnit || !doseBinned || timeHours === null || timeHours <= 0 || !timeUnit || !timeBinned) {
      excluded.push({ signatureId, compoundName, reason: 'The local signature is missing numeric and canonical dose or time metadata.' })
      continue
    }
    if (!byRnaWellAggregation(rawSignature?.aggregationMethod)) {
      excluded.push({ signatureId, compoundName, reason: 'The local signature does not document by_rna_well replicate aggregation.' })
      continue
    }
    if (tas === null || tas < minimumTas) {
      excluded.push({ signatureId, compoundName, reason: `The signature TAS is below the ${minimumTas} quality threshold or missing.` })
      continue
    }
    const key = candidateKey(compoundName)
    if (compoundsSeen.has(key)) {
      excluded.push({ signatureId, compoundName, reason: 'A second signature for this compound was withheld. Narrow the dataset selection or use a documented replicate-aggregation method.' })
      continue
    }
    let rows
    try {
      rows = scoreRowsFor(rawSignature, mappedGenes)
    } catch (error) {
      excluded.push({ signatureId, compoundName, reason: error instanceof Error ? error.message : 'The z-score vector could not be read.' })
      continue
    }
    const regulatedGenes = rows
      .filter((gene) => gene.zScore !== null && Math.abs(gene.zScore) >= minimumAbsoluteZScore)
      .map((gene) => ({ symbol: gene.symbol, effect: gene.zScore, zScore: gene.zScore }))
    if (regulatedGenes.length < minimumRegulatedGenes) {
      excluded.push({ signatureId, compoundName, reason: `Only ${regulatedGenes.length} genes met the absolute z-score threshold.` })
      continue
    }
    try {
      const perturbation = createPerturbationSignature({
        compoundName,
        source: {
          id: `lincs-${validatedDataset.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${signatureId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          title: `LINCS L1000 Level 5 MODZ signature: ${compoundName}`,
          url: validatedDataset.url,
          signatureId,
          cellLine,
          dose,
          doseUnit,
          doseBinned,
          timeHours,
          timeUnit,
          timeBinned,
          dataset: validatedDataset.title,
          processing: `${validatedDataset.processing}. Local slice: ${validatedDataset.localArtifact || 'documented worker export'}.`,
          pertId,
          pertName,
          tas,
          aggregationMethod: 'by_rna_well',
          geneSpace: validatedDataset.geneSpace,
        },
        genes: regulatedGenes,
      })
      compoundsSeen.add(key)
      perturbationSignatures.push(perturbation)
    } catch (error) {
      excluded.push({ signatureId, compoundName, reason: error instanceof Error ? error.message : 'The perturbation contract rejected this signature.' })
    }
  }

  return {
    schemaVersion: 'lincs-perturbation-import/v1',
    dataset: validatedDataset,
    selection: {
      allowedCellLines: [...allowedCellLines],
      minimumAbsoluteZScore,
      minimumRegulatedGenes,
      minimumTas,
      restrictToCoreTouchstone,
      coreTouchstoneCellLines: [...CORE_TOUCHSTONE_CELL_LINES],
    },
    perturbationSignatures,
    excluded,
  }
}
