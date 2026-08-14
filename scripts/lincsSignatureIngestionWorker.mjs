#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildPerturbationSignaturesFromLincsSlice } from '../server/lincsSignatureIngestion.mjs'

const usage = `Usage: node scripts/lincsSignatureIngestionWorker.mjs --input level5-slice.json --cell-lines A549 --output perturbations.json

The input must be a local, documented L1000 Level 5 MODZ slice. It must include
the dataset source, documented landmark or BING gene space, by_rna_well
aggregation, signature metadata, and measured z-scores. This command will not
accept Level 3/4 data, genetic perturbations, TAS below 0.5, or an unspecified
cell-line selection.`

const argumentValue = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

const cellLines = (value) => String(value || '').split('|').flatMap((part) => part.split(','))
  .map((part) => part.trim())
  .filter(Boolean)

const inputPath = argumentValue('--input')
const outputPath = argumentValue('--output')
const allowedCellLines = cellLines(argumentValue('--cell-lines'))
const providedMinimumTas = argumentValue('--minimum-tas')
const providedMinimumAbsoluteZ = argumentValue('--minimum-absolute-z')
if (!inputPath || !outputPath || !allowedCellLines.length) {
  console.error(usage)
  process.exitCode = 2
} else {
  try {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'))
    const imported = buildPerturbationSignaturesFromLincsSlice({
      ...input,
      selection: {
        ...(input.selection || {}),
        allowedCellLines,
        minimumAbsoluteZScore: Number(providedMinimumAbsoluteZ) || input.selection?.minimumAbsoluteZScore || 2,
        minimumTas: Number(providedMinimumTas) || input.selection?.minimumTas || 0.5,
        restrictToCoreTouchstone: process.argv.includes('--core-touchstone-only') || input.selection?.restrictToCoreTouchstone === true,
      },
    })
    await writeFile(resolve(outputPath), `${JSON.stringify(imported, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ imported: imported.perturbationSignatures.length, excluded: imported.excluded.length, output: resolve(outputPath) }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The LINCS ingestion worker failed.')
    process.exitCode = 1
  }
}
