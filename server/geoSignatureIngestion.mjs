import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHumanDiseaseSignature } from './transcriptomicInversion.mjs'

const gunzipAsync = promisify(gunzip)
const GEO_ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const GEO_ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'
const GEO_MAX_COMPRESSED_BYTES = 16 * 1_024 * 1_024
const GEO_MAX_DECOMPRESSED_BYTES = 80 * 1_024 * 1_024
const DEFAULT_MINIMUM_ABSOLUTE_LOG_FOLD_CHANGE = 1.5
const DEFAULT_MAXIMUM_ADJUSTED_P_VALUE = 0.05

const cleanText = (value, limit = 500) => String(value || '')
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const validGseAccession = (value) => /^GSE\d+$/i.test(cleanText(value, 40))

const normalizedHeader = (value) => cleanText(value, 120)
  .toLocaleLowerCase()
  .replace(/[_.\-()]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const numericValue = (value) => {
  const number = Number(String(value ?? '').trim())
  return Number.isFinite(number) ? number : null
}

const sourceUrlFor = (accession) => `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${encodeURIComponent(accession)}`

const geoDirectoryFor = (accession) => {
  const numericPart = accession.replace(/^GSE/i, '')
  const prefix = numericPart.length > 3 ? numericPart.slice(0, -3) : ''
  return `GSE${prefix}nnn`
}

export const geoFamilySoftUrl = (accession) => {
  const normalized = cleanText(accession, 40).toUpperCase()
  if (!validGseAccession(normalized)) throw new Error('A GEO Series accession must look like GSE12345.')
  return `https://ftp.ncbi.nlm.nih.gov/geo/series/${geoDirectoryFor(normalized)}/${normalized}/soft/${normalized}_family.soft.gz`
}

export const geoSeriesMatrixUrl = (accession) => {
  const normalized = cleanText(accession, 40).toUpperCase()
  if (!validGseAccession(normalized)) throw new Error('A GEO Series accession must look like GSE12345.')
  return `https://ftp.ncbi.nlm.nih.gov/geo/series/${geoDirectoryFor(normalized)}/${normalized}/matrix/${normalized}_series_matrix.txt.gz`
}

const readResponseBytes = async (response, maximumBytes = GEO_MAX_COMPRESSED_BYTES) => {
  const advertised = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(advertised) && advertised > maximumBytes) {
    throw new Error(`GEO file is larger than the ${Math.floor(maximumBytes / 1_024 / 1_024)} MB safety limit.`)
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumBytes) throw new Error('GEO file is larger than the safety limit.')
    return Buffer.from(bytes)
  }

  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new Error('GEO file is larger than the safety limit.')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

const downloadGeoText = async (url, { fetchImpl = fetch } = {}) => {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`GEO download returned ${response.status}.`)
  const bytes = await readResponseBytes(response)
  const decompressed = await gunzipAsync(bytes)
  if (decompressed.byteLength > GEO_MAX_DECOMPRESSED_BYTES) {
    throw new Error(`GEO file expands beyond the ${Math.floor(GEO_MAX_DECOMPRESSED_BYTES / 1_024 / 1_024)} MB safety limit.`)
  }
  return decompressed.toString('utf8')
}

const softValue = (line, prefix) => cleanText(line.slice(prefix.length), 1_500)

const uniqueText = (values) => [...new Set(values.map((value) => cleanText(value, 240)).filter(Boolean))]

// GEO family SOFT metadata is useful for choosing a cohort but cannot tell the
// worker which samples are valid case and control groups. That choice remains
// explicit curator input in the differential-expression table.
export const parseGeoFamilySoftMetadata = (contents, fallbackAccession = '') => {
  const study = { accession: cleanText(fallbackAccession, 40).toUpperCase(), title: '', summary: '', organism: [], sampleIds: [] }
  const samples = []
  let currentSample = null

  for (const rawLine of String(contents || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('^SERIES = ')) study.accession = softValue(line, '^SERIES = ').toUpperCase()
    else if (line.startsWith('!Series_title = ')) study.title = softValue(line, '!Series_title = ')
    else if (line.startsWith('!Series_summary = ')) study.summary = [study.summary, softValue(line, '!Series_summary = ')].filter(Boolean).join(' ')
    else if (line.startsWith('!Series_sample_id = ')) study.sampleIds.push(softValue(line, '!Series_sample_id = '))
    else if (line.startsWith('^SAMPLE = ')) {
      currentSample = { accession: softValue(line, '^SAMPLE = '), title: '', organism: '', sourceName: '', characteristics: [] }
      samples.push(currentSample)
    } else if (currentSample && line.startsWith('!Sample_title = ')) currentSample.title = softValue(line, '!Sample_title = ')
    else if (currentSample && line.startsWith('!Sample_organism_ch1 = ')) currentSample.organism = softValue(line, '!Sample_organism_ch1 = ')
    else if (currentSample && line.startsWith('!Sample_source_name_ch1 = ')) currentSample.sourceName = softValue(line, '!Sample_source_name_ch1 = ')
    else if (currentSample && line.startsWith('!Sample_characteristics_ch1 = ')) currentSample.characteristics.push(softValue(line, '!Sample_characteristics_ch1 = '))
  }

  const organisms = uniqueText(samples.map((sample) => sample.organism))
  const human = organisms.length === 1 && /^(?:homo sapiens|human)$/i.test(organisms[0])
  return {
    accession: study.accession,
    title: cleanText(study.title, 320),
    summary: cleanText(study.summary, 1_200),
    url: sourceUrlFor(study.accession),
    familySoftUrl: validGseAccession(study.accession) ? geoFamilySoftUrl(study.accession) : '',
    seriesMatrixUrl: validGseAccession(study.accession) ? geoSeriesMatrixUrl(study.accession) : '',
    organism: organisms.length === 1 ? organisms[0] : organisms.join('; '),
    human,
    sampleCount: Math.max(samples.length, study.sampleIds.length),
    samples: samples.map((sample) => ({
      accession: cleanText(sample.accession, 80),
      title: cleanText(sample.title, 240),
      organism: cleanText(sample.organism, 80),
      sourceName: cleanText(sample.sourceName, 240),
      characteristics: uniqueText(sample.characteristics),
    })),
  }
}

export const fetchGeoSeriesManifest = async (accession, { fetchImpl = fetch } = {}) => {
  const normalized = cleanText(accession, 40).toUpperCase()
  if (!validGseAccession(normalized)) throw new Error('A GEO Series accession must look like GSE12345.')
  const contents = await downloadGeoText(geoFamilySoftUrl(normalized), { fetchImpl })
  const metadata = parseGeoFamilySoftMetadata(contents, normalized)
  if (metadata.accession !== normalized) throw new Error('The downloaded GEO metadata does not match the requested Series accession.')
  return metadata
}

const parseDelimitedLine = (line, delimiter) => {
  const values = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === delimiter && !quoted) {
      values.push(value)
      value = ''
    } else value += character
  }
  values.push(value)
  return values.map((entry) => entry.trim())
}

const preferredHeader = (headers, aliases) => headers.find((header) => aliases.includes(normalizedHeader(header))) || ''

const GENE_HEADERS = ['gene', 'gene symbol', 'genesymbol', 'symbol', 'hgnc symbol', 'hgnc symbol id']
const EFFECT_HEADERS = ['log2foldchange', 'log fold change', 'log2 fold change', 'logfc', 'log fc']
const ADJUSTED_P_HEADERS = ['adjusted p value', 'adjusted pvalue', 'adjusted p val', 'adj p val', 'adj p value', 'padj', 'fdr', 'q value', 'qvalue']

export const parseCuratedDifferentialExpression = (contents, { sourceLabel = 'differential-expression table' } = {}) => {
  const lines = String(contents || '').split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'))
  if (lines.length < 2) throw new Error(`The ${sourceLabel} needs a header and at least one gene row.`)
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : ''
  if (!delimiter) throw new Error(`The ${sourceLabel} must be tab-separated or comma-separated.`)
  const headers = parseDelimitedLine(lines[0], delimiter)
  const geneHeader = preferredHeader(headers, GENE_HEADERS)
  const effectHeader = preferredHeader(headers, EFFECT_HEADERS)
  const adjustedPHeader = preferredHeader(headers, ADJUSTED_P_HEADERS)
  if (!geneHeader || !effectHeader || !adjustedPHeader) {
    throw new Error(`The ${sourceLabel} needs gene symbol, log fold-change, and adjusted p-value columns.`)
  }
  const indexFor = (header) => headers.indexOf(header)
  const rows = lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter)
    return {
      symbol: cleanText(values[indexFor(geneHeader)], 80),
      log2FoldChange: numericValue(values[indexFor(effectHeader)]),
      adjustedPValue: numericValue(values[indexFor(adjustedPHeader)]),
    }
  }).filter((row) => row.symbol && row.log2FoldChange !== null && row.adjustedPValue !== null)
  if (!rows.length) throw new Error(`The ${sourceLabel} did not contain usable gene rows.`)
  return { rows, columns: { gene: geneHeader, log2FoldChange: effectHeader, adjustedPValue: adjustedPHeader } }
}

export const buildDiseaseSignatureFromGeoDge = ({
  condition,
  manifest,
  differentialExpression,
  tissue,
  contrast,
  processing,
  minimumAbsoluteLogFoldChange = DEFAULT_MINIMUM_ABSOLUTE_LOG_FOLD_CHANGE,
  maximumAdjustedPValue = DEFAULT_MAXIMUM_ADJUSTED_P_VALUE,
} = {}) => {
  if (!manifest?.human) throw new Error('Only a GEO study with exactly one human organism can create a disease signature.')
  const parsed = typeof differentialExpression === 'string'
    ? parseCuratedDifferentialExpression(differentialExpression)
    : differentialExpression
  if (!Array.isArray(parsed?.rows)) throw new Error('A parsed differential-expression table is required.')
  const signature = createHumanDiseaseSignature({
    condition,
    source: {
      id: `geo-${manifest.accession.toLowerCase()}`,
      title: manifest.title,
      url: manifest.url,
      accession: manifest.accession,
      organism: manifest.organism,
      tissue: cleanText(tissue, 160),
      contrast: cleanText(contrast, 240),
      processing: cleanText(processing || `Curated from ${manifest.accession}; ${parsed.columns?.log2FoldChange || 'log fold-change'} and ${parsed.columns?.adjustedPValue || 'adjusted p-value'} columns.`, 240),
    },
    genes: parsed.rows,
    minimumAbsoluteEffect: minimumAbsoluteLogFoldChange,
    maximumAdjustedPValue,
  })
  const upGenes = signature.genes.filter((gene) => gene.effect >= minimumAbsoluteLogFoldChange)
  const downGenes = signature.genes.filter((gene) => gene.effect <= -minimumAbsoluteLogFoldChange)
  if (!upGenes.length || !downGenes.length) {
    throw new Error('The curated GEO table needs both up-regulated and down-regulated genes after filtering.')
  }
  return {
    ...signature,
    ingestion: {
      provider: 'NCBI GEO',
      manifestUrl: manifest.url,
      familySoftUrl: manifest.familySoftUrl,
      seriesMatrixUrl: manifest.seriesMatrixUrl,
      inputColumns: parsed.columns,
      usableRows: parsed.rows.length,
      filteredGenes: signature.genes.length,
      upGeneCount: upGenes.length,
      downGeneCount: downGenes.length,
      sourceSampleCount: manifest.sampleCount,
    },
  }
}

export const buildTranscriptomicJobFromGeoDge = ({
  jobId,
  condition,
  conditionSearchTerms = [],
  manifest,
  differentialExpression,
  tissue,
  contrast,
  processing,
  perturbationSignatures = [],
  ...thresholds
} = {}) => ({
  jobId: cleanText(jobId, 120),
  condition: cleanText(condition, 160),
  conditionSearchTerms: [...new Set((Array.isArray(conditionSearchTerms) ? conditionSearchTerms : [])
    .map((term) => cleanText(term, 160))
    .filter(Boolean))],
  diseaseSignature: buildDiseaseSignatureFromGeoDge({
    condition,
    manifest,
    differentialExpression,
    tissue,
    contrast,
    processing,
    ...thresholds,
  }),
  perturbationSignatures: Array.isArray(perturbationSignatures) ? perturbationSignatures : [],
})

export const searchGeoStudies = async (condition, { maximum = 20, fetchImpl = fetch, ncbiApiKey = '', tool = 'medical-research-tool', email = '' } = {}) => {
  const phrase = cleanText(condition, 160)
  if (!phrase) throw new Error('A condition is required to search GEO.')
  const searchUrl = new URL(GEO_ESEARCH_URL)
  searchUrl.searchParams.set('db', 'gds')
  searchUrl.searchParams.set('term', `"${phrase}"[All Fields] AND "Homo sapiens"[Organism]`)
  searchUrl.searchParams.set('retmode', 'json')
  searchUrl.searchParams.set('retmax', String(Math.min(Math.max(Number(maximum) || 20, 1), 50)))
  searchUrl.searchParams.set('tool', tool)
  if (email) searchUrl.searchParams.set('email', email)
  if (ncbiApiKey) searchUrl.searchParams.set('api_key', ncbiApiKey)
  const searchResponse = await fetchImpl(searchUrl)
  if (!searchResponse.ok) throw new Error(`GEO search returned ${searchResponse.status}.`)
  const searchPayload = await searchResponse.json()
  const ids = Array.isArray(searchPayload?.esearchresult?.idlist) ? searchPayload.esearchresult.idlist : []
  if (!ids.length) return []
  const summaryUrl = new URL(GEO_ESUMMARY_URL)
  summaryUrl.searchParams.set('db', 'gds')
  summaryUrl.searchParams.set('id', ids.join(','))
  summaryUrl.searchParams.set('retmode', 'json')
  summaryUrl.searchParams.set('tool', tool)
  if (email) summaryUrl.searchParams.set('email', email)
  if (ncbiApiKey) summaryUrl.searchParams.set('api_key', ncbiApiKey)
  const summaryResponse = await fetchImpl(summaryUrl)
  if (!summaryResponse.ok) throw new Error(`GEO summary returned ${summaryResponse.status}.`)
  const summaryPayload = await summaryResponse.json()
  return ids.map((id) => {
    const record = summaryPayload?.result?.[id] || {}
    const accession = cleanText(record.accession, 40).toUpperCase()
    return {
      id: cleanText(id, 40),
      accession,
      title: cleanText(record.title, 320),
      summary: cleanText(record.summary, 900),
      organism: cleanText(record.gpl || record.organism, 120),
      sampleCount: Number(record.n_samples) || 0,
      url: validGseAccession(accession) ? sourceUrlFor(accession) : '',
    }
  })
}
