#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rankTranscriptomicInversionCandidates, releaseNovelTranscriptomicHypotheses } from '../server/transcriptomicInversion.mjs'

const PUBMED_SEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const EUROPE_PMC_SEARCH_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

const usage = `Usage: node scripts/transcriptomicInversionWorker.mjs --input job.json --output result.json

The input must contain a curated human disease signature and measured CMap/LINCS
perturbation signatures. This worker does not download raw GEO or L1000 data,
generate molecules, or make treatment recommendations.`

const argumentValue = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

const cleanText = (value, limit = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)

const timeoutFetch = async (url, options = {}, timeoutMs = 20_000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const pubMedQuery = async (condition, candidate) => {
  const term = `("${condition}"[Title/Abstract]) AND ("${candidate}"[Title/Abstract])`
  const url = new URL(PUBMED_SEARCH_URL)
  url.searchParams.set('db', 'pubmed')
  url.searchParams.set('term', term)
  url.searchParams.set('retmode', 'json')
  url.searchParams.set('retmax', '5')
  if (process.env.NCBI_API_KEY) url.searchParams.set('api_key', process.env.NCBI_API_KEY)
  const response = await timeoutFetch(url, {
    headers: { 'User-Agent': process.env.NCBI_EMAIL ? `medical-research-tool (${process.env.NCBI_EMAIL})` : 'medical-research-tool transcriptomic worker' },
  })
  if (!response.ok) throw new Error(`PubMed returned ${response.status}.`)
  const payload = await response.json()
  const count = Number(payload?.esearchresult?.count) || 0
  return { database: 'PubMed', status: count ? 'found' : 'not-found', records: count, url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(term)}` }
}

const europePmcQuery = async (condition, candidate) => {
  const query = `(TITLE_ABS:"${condition.replace(/"/g, ' ')}") AND TITLE_ABS:"${candidate.replace(/"/g, ' ')}"`
  const url = new URL(EUROPE_PMC_SEARCH_URL)
  url.searchParams.set('query', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('pageSize', '5')
  const response = await timeoutFetch(url)
  if (!response.ok) throw new Error(`Europe PMC returned ${response.status}.`)
  const payload = await response.json()
  const count = Number(payload?.hitCount) || 0
  return { database: 'Europe PMC', status: count ? 'found' : 'not-found', records: count, url: `https://europepmc.org/search?query=${encodeURIComponent(query)}` }
}

const completeNoveltyCheck = async ({ condition, candidate, conditionSearchTerms = [] }) => {
  const terms = [...new Set([condition, ...conditionSearchTerms].map((term) => cleanText(term, 160)).filter(Boolean))]
  const checks = []
  for (const term of terms) {
    const [pubmed, europePmc] = await Promise.allSettled([
      pubMedQuery(term, candidate),
      europePmcQuery(term, candidate),
    ])
    if (pubmed.status !== 'fulfilled' || europePmc.status !== 'fulfilled') {
      return { complete: false, status: 'unavailable', checks }
    }
    checks.push({ conditionTerm: term, pubmed: pubmed.value, europePmc: europePmc.value })
  }
  const found = checks.some((check) => check.pubmed.status === 'found' || check.europePmc.status === 'found')
  return { complete: true, status: found ? 'found' : 'not-found', checks }
}

const inputPath = argumentValue('--input')
const outputPath = argumentValue('--output')
if (!inputPath || !outputPath) {
  console.error(usage)
  process.exitCode = 2
} else {
  try {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'))
    const ranked = rankTranscriptomicInversionCandidates(input)
    const released = await releaseNovelTranscriptomicHypotheses(
      ranked,
      ({ condition, candidate }) => completeNoveltyCheck({ condition, candidate, conditionSearchTerms: input.conditionSearchTerms }),
      { limit: Number(input.maximumCandidates) || 20 },
    )
    const artifact = {
      schemaVersion: 'transcriptomic-inversion-job/v1',
      jobId: cleanText(input.jobId, 120),
      completedAt: new Date().toISOString(),
      ...released,
    }
    await writeFile(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ jobId: artifact.jobId, released: artifact.released.length, withheld: artifact.withheld.length, output: resolve(outputPath) }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The transcriptomic worker failed.')
    process.exitCode = 1
  }
}
