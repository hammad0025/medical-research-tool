#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  buildTranscriptomicJobFromGeoDge,
  fetchGeoSeriesManifest,
  searchGeoStudies,
} from '../server/geoSignatureIngestion.mjs'

const usage = `Usage:
  node scripts/geoSignatureIngestionWorker.mjs --find --condition "Condition" --output studies.json
  node scripts/geoSignatureIngestionWorker.mjs --condition "Condition" --gse GSE12345 --dge table.tsv --tissue "Lung" --contrast "Disease versus control" --output job.json

The import command requires a curator-provided differential-expression table with
gene symbol, log fold-change, and adjusted p-value columns. It does not infer
case/control groups or run differential-expression statistics from raw GEO data.`

const argumentValue = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

const optionalList = (value) => String(value || '').split('|').map((part) => part.trim()).filter(Boolean)
const cleanText = (value, limit = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)

const condition = argumentValue('--condition')
const output = argumentValue('--output')
const findOnly = process.argv.includes('--find')

if (!condition || !output || (!findOnly && (!argumentValue('--gse') || !argumentValue('--dge') || !argumentValue('--tissue') || !argumentValue('--contrast')))) {
  console.error(usage)
  process.exitCode = 2
} else {
  try {
    const commonOptions = {
      ncbiApiKey: process.env.NCBI_API_KEY || '',
      email: process.env.NCBI_EMAIL || '',
    }
    if (findOnly) {
      const studies = await searchGeoStudies(condition, commonOptions)
      await writeFile(resolve(output), `${JSON.stringify({ condition: cleanText(condition, 160), studies }, null, 2)}\n`, 'utf8')
      console.log(JSON.stringify({ condition: cleanText(condition, 160), studies: studies.length, output: resolve(output) }))
    } else {
      const accession = argumentValue('--gse')
      const manifest = await fetchGeoSeriesManifest(accession)
      const differentialExpression = await readFile(resolve(argumentValue('--dge')), 'utf8')
      const job = buildTranscriptomicJobFromGeoDge({
        jobId: argumentValue('--job-id') || `${manifest.accession.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`,
        condition,
        conditionSearchTerms: optionalList(argumentValue('--condition-search-terms')),
        manifest,
        differentialExpression,
        tissue: argumentValue('--tissue'),
        contrast: argumentValue('--contrast'),
        processing: argumentValue('--processing'),
        minimumAbsoluteLogFoldChange: Number(argumentValue('--minimum-absolute-logfc')) || 1.5,
        maximumAdjustedPValue: Number(argumentValue('--maximum-adjusted-p')) || 0.05,
      })
      await writeFile(resolve(output), `${JSON.stringify(job, null, 2)}\n`, 'utf8')
      console.log(JSON.stringify({ jobId: job.jobId, accession: manifest.accession, filteredGenes: job.diseaseSignature.ingestion.filteredGenes, output: resolve(output) }))
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The GEO ingestion worker failed.')
    process.exitCode = 1
  }
}
