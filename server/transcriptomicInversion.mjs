// This module deliberately contains no disease-specific guesses and no model
// weights. It ranks measured expression signatures supplied by a curated data
// worker, then requires a separate literature gate before releasing a lead.

const DEFAULT_MINIMUM_GENE_OVERLAP = 8
const DEFAULT_MINIMUM_INVERSION_SCORE = 0.25
const DEFAULT_MINIMUM_OPPOSITE_FRACTION = 0.6

const cleanText = (value, limit = 500) => String(value || '')
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const geneKey = (value) => cleanText(value, 80)
  .toUpperCase()
  .replace(/[^A-Z0-9-]/g, '')

const numericValue = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const nonEmptyUrl = (value) => {
  const url = cleanText(value, 1_000)
  return /^https:\/\//i.test(url) ? url : ''
}

const hasSource = (source) => Boolean(
  cleanText(source?.id, 160)
  && cleanText(source?.title, 320)
  && nonEmptyUrl(source?.url),
)

const humanOrganism = (value) => /^(?:human|homo sapiens)$/i.test(cleanText(value, 80))

const normalizeGeneRows = (rows, { minimumAbsoluteEffect = 0, maximumAdjustedPValue = 1 } = {}) => {
  const byGene = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const symbol = geneKey(row?.symbol || row?.gene || row?.geneSymbol)
    const effect = numericValue(row?.effect ?? row?.log2FoldChange ?? row?.logFoldChange ?? row?.zScore ?? row?.score)
    const adjustedPValue = numericValue(row?.adjustedPValue ?? row?.padj ?? row?.fdr)
    if (!symbol || effect === null || Math.abs(effect) < minimumAbsoluteEffect) continue
    if (adjustedPValue !== null && adjustedPValue > maximumAdjustedPValue) continue

    const current = byGene.get(symbol)
    if (!current || Math.abs(effect) > Math.abs(current.effect)) {
      byGene.set(symbol, { symbol, effect, adjustedPValue })
    }
  }

  return [...byGene.values()].sort((left, right) => Math.abs(right.effect) - Math.abs(left.effect))
}

const vectorMagnitude = (values) => Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0))

const safeRatio = (numerator, denominator) => denominator > 0 ? numerator / denominator : 0

export const createHumanDiseaseSignature = ({
  condition,
  source,
  genes,
  minimumAbsoluteEffect = 0.25,
  maximumAdjustedPValue = 0.05,
} = {}) => {
  const normalizedCondition = cleanText(condition, 160)
  if (!normalizedCondition) throw new Error('A condition is required for a transcriptomic job.')
  if (!hasSource(source)) throw new Error('A disease signature needs a titled, linked source record.')
  if (!humanOrganism(source?.organism)) throw new Error('A disease signature must come from human tissue or cells.')

  const normalizedGenes = normalizeGeneRows(genes, { minimumAbsoluteEffect, maximumAdjustedPValue })
  if (normalizedGenes.length < DEFAULT_MINIMUM_GENE_OVERLAP) {
    throw new Error(`The disease signature needs at least ${DEFAULT_MINIMUM_GENE_OVERLAP} filtered human genes.`)
  }

  return {
    condition: normalizedCondition,
    source: {
      id: cleanText(source.id, 160),
      title: cleanText(source.title, 320),
      url: nonEmptyUrl(source.url),
      accession: cleanText(source.accession, 120),
      organism: cleanText(source.organism, 80),
      tissue: cleanText(source.tissue, 160),
      contrast: cleanText(source.contrast, 240),
      processing: cleanText(source.processing, 240),
    },
    thresholds: { minimumAbsoluteEffect, maximumAdjustedPValue },
    genes: normalizedGenes,
  }
}

export const createPerturbationSignature = ({ compoundName, source, genes } = {}) => {
  const name = cleanText(compoundName, 160)
  if (!name) throw new Error('A perturbation signature needs a named compound.')
  if (!hasSource(source)) throw new Error('A perturbation signature needs a titled, linked source record.')
  if (!cleanText(source?.signatureId, 160) || !cleanText(source?.cellLine, 120)) {
    throw new Error('A perturbation signature needs a signature ID and cell line.')
  }

  const normalizedGenes = normalizeGeneRows(genes)
  if (normalizedGenes.length < DEFAULT_MINIMUM_GENE_OVERLAP) {
    throw new Error(`The perturbation signature for ${name} needs at least ${DEFAULT_MINIMUM_GENE_OVERLAP} genes.`)
  }

  return {
    compoundName: name,
    source: {
      id: cleanText(source.id, 160),
      title: cleanText(source.title, 320),
      url: nonEmptyUrl(source.url),
      signatureId: cleanText(source.signatureId, 160),
      cellLine: cleanText(source.cellLine, 120),
      dose: cleanText(source.dose, 80),
      doseUnit: cleanText(source.doseUnit, 40),
      doseBinned: cleanText(source.doseBinned, 80),
      timeHours: numericValue(source.timeHours),
      timeUnit: cleanText(source.timeUnit, 40),
      timeBinned: cleanText(source.timeBinned, 80),
      dataset: cleanText(source.dataset, 120),
      processing: cleanText(source.processing, 240),
      pertId: cleanText(source.pertId, 160),
      pertName: cleanText(source.pertName, 160),
      tas: numericValue(source.tas),
      aggregationMethod: cleanText(source.aggregationMethod, 80),
      geneSpace: cleanText(source.geneSpace, 80),
    },
    genes: normalizedGenes,
  }
}

// The score is the negative cosine similarity between disease and compound
// effect vectors. Positive values mean the measured compound signature moves
// shared genes in the opposite direction from the disease signature.
export const scoreSignatureInversion = (diseaseSignature, perturbationSignature, {
  minimumGeneOverlap = DEFAULT_MINIMUM_GENE_OVERLAP,
} = {}) => {
  const diseaseByGene = new Map((diseaseSignature?.genes || []).map((gene) => [gene.symbol, gene.effect]))
  const shared = (perturbationSignature?.genes || [])
    .map((gene) => ({ symbol: gene.symbol, diseaseEffect: diseaseByGene.get(gene.symbol), compoundEffect: gene.effect }))
    .filter((gene) => Number.isFinite(gene.diseaseEffect) && Number.isFinite(gene.compoundEffect))

  if (shared.length < minimumGeneOverlap) {
    return {
      eligible: false,
      reason: `Only ${shared.length} genes overlap; at least ${minimumGeneOverlap} are required.`,
      sharedGenes: shared.length,
      inversionScore: null,
      oppositeFraction: null,
      topOppositeGenes: [],
    }
  }

  const diseaseValues = shared.map((gene) => gene.diseaseEffect)
  const compoundValues = shared.map((gene) => gene.compoundEffect)
  const denominator = vectorMagnitude(diseaseValues) * vectorMagnitude(compoundValues)
  if (!denominator) {
    return {
      eligible: false,
      reason: 'The shared expression values could not form a usable score.',
      sharedGenes: shared.length,
      inversionScore: null,
      oppositeFraction: null,
      topOppositeGenes: [],
    }
  }

  const alignment = shared.reduce((sum, gene) => sum + (gene.diseaseEffect * gene.compoundEffect), 0) / denominator
  const oppositeGenes = shared.filter((gene) => Math.sign(gene.diseaseEffect) !== Math.sign(gene.compoundEffect))
  const topOppositeGenes = oppositeGenes
    .map((gene) => ({ ...gene, contribution: Math.abs(gene.diseaseEffect * gene.compoundEffect) }))
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 12)
    .map(({ symbol, diseaseEffect, compoundEffect }) => ({ symbol, diseaseEffect, compoundEffect }))

  return {
    eligible: true,
    reason: '',
    sharedGenes: shared.length,
    inversionScore: -alignment,
    oppositeFraction: safeRatio(oppositeGenes.length, shared.length),
    topOppositeGenes,
  }
}

export const rankTranscriptomicInversionCandidates = ({ diseaseSignature, perturbationSignatures, settings = {} } = {}) => {
  const validatedDisease = createHumanDiseaseSignature(diseaseSignature)
  const minimumGeneOverlap = Number.isInteger(settings.minimumGeneOverlap) && settings.minimumGeneOverlap >= 4
    ? settings.minimumGeneOverlap
    : DEFAULT_MINIMUM_GENE_OVERLAP
  const minimumInversionScore = Number.isFinite(Number(settings.minimumInversionScore))
    ? Number(settings.minimumInversionScore)
    : DEFAULT_MINIMUM_INVERSION_SCORE
  const minimumOppositeFraction = Number.isFinite(Number(settings.minimumOppositeFraction))
    ? Number(settings.minimumOppositeFraction)
    : DEFAULT_MINIMUM_OPPOSITE_FRACTION
  const seen = new Set()
  const rejected = []
  const ranked = []

  for (const rawSignature of Array.isArray(perturbationSignatures) ? perturbationSignatures : []) {
    let signature
    try {
      signature = createPerturbationSignature(rawSignature)
    } catch (error) {
      rejected.push({ compoundName: cleanText(rawSignature?.compoundName, 160), reason: error instanceof Error ? error.message : 'Invalid perturbation signature.' })
      continue
    }
    const key = signature.compoundName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const score = scoreSignatureInversion(validatedDisease, signature, { minimumGeneOverlap })
    if (!score.eligible) {
      rejected.push({ compoundName: signature.compoundName, reason: score.reason })
      continue
    }
    if (score.inversionScore < minimumInversionScore || score.oppositeFraction < minimumOppositeFraction) {
      rejected.push({
        compoundName: signature.compoundName,
        reason: 'The measured signature did not meet the pre-set inversion thresholds.',
        inversionScore: score.inversionScore,
        oppositeFraction: score.oppositeFraction,
      })
      continue
    }
    ranked.push({
      compoundName: signature.compoundName,
      score,
      diseaseSource: validatedDisease.source,
      perturbationSource: signature.source,
      explanation: `${signature.compoundName} moved ${score.sharedGenes} shared genes in the opposite direction from the supplied ${validatedDisease.condition} signature in a ${signature.source.cellLine} cell-line experiment. This is a research signal, not proof it will help people.`,
    })
  }

  return {
    condition: validatedDisease.condition,
    generatedAt: new Date().toISOString(),
    settings: { minimumGeneOverlap, minimumInversionScore, minimumOppositeFraction },
    diseaseSignature: validatedDisease,
    candidates: ranked.sort((left, right) => right.score.inversionScore - left.score.inversionScore || right.score.oppositeFraction - left.score.oppositeFraction),
    rejected,
  }
}

// The worker never treats a missing or incomplete literature search as a clean
// result. A caller provides the search function so queues can use their own
// rate limits, retries, and database credentials without changing scoring.
export const releaseNovelTranscriptomicHypotheses = async (rankedJob, noveltyCheck, { limit = 20 } = {}) => {
  if (typeof noveltyCheck !== 'function') throw new Error('A literature novelty checker is required before releasing a hypothesis.')
  const released = []
  const withheld = []

  for (const candidate of Array.isArray(rankedJob?.candidates) ? rankedJob.candidates.slice(0, limit) : []) {
    let novelty
    try {
      novelty = await noveltyCheck({ condition: rankedJob.condition, candidate: candidate.compoundName })
    } catch {
      novelty = { complete: false, status: 'unavailable', checks: [] }
    }
    if (novelty?.complete !== true || novelty?.status !== 'not-found') {
      withheld.push({
        compoundName: candidate.compoundName,
        reason: novelty?.complete !== true
          ? 'The literature check did not finish, so this item was withheld.'
          : 'Condition-specific or close-condition research was found, so this item was not labeled new.',
        novelty,
      })
      continue
    }
    released.push({
      ...candidate,
      novelty,
      label: 'Not researched for this condition',
      caution: 'This is a computer-generated research question. It is not a treatment recommendation and must not be used to start, stop, or combine treatments.',
    })
  }

  return {
    ...rankedJob,
    released,
    withheld,
    releasePolicy: 'Only named compounds with measured signatures, linked source records, pre-set score thresholds, and complete no-match literature checks are released.',
  }
}
