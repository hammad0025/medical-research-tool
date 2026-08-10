import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfDocument, createWordDocument, reportFilename } from '../src/lib/reportExports.js'

const sampleReport = `Researching My Condition - Retinitis Pigmentosa

Research context
Location: Cleveland, OH

Treatment ideas to discuss
- AAV-RP therapy: A research direction that needs source verification.

Sources
- PubMed: Retina research & treatment question (https://pubmed.ncbi.nlm.nih.gov/1001/)

Research support, not medical advice.`

test('PDF export is a self-contained, validly indexed PDF document', () => {
  const pdf = createPdfDocument('Researching My Condition - Retinitis Pigmentosa', sampleReport)
  const text = new TextDecoder().decode(pdf)
  const startxref = text.lastIndexOf('startxref\n')
  const xrefOffset = Number(text.slice(startxref + 'startxref\n'.length).split('\n', 1)[0])

  assert.ok(pdf instanceof Uint8Array)
  assert.match(text, /^%PDF-1\.4/)
  assert.match(text, /Researching My Condition - Retinitis Pigmentosa/)
  assert.ok(startxref > 0)
  assert.equal(text.slice(xrefOffset, xrefOffset + 4), 'xref')
  assert.match(text, /%%EOF$/)
})

test('Word export is a real Office Open XML package with the report content', () => {
  const document = createWordDocument('Researching My Condition - Retinitis Pigmentosa', sampleReport)
  const text = new TextDecoder().decode(document)
  const tail = new DataView(document.buffer, document.byteOffset + document.byteLength - 22)

  assert.ok(document instanceof Uint8Array)
  assert.deepEqual([...document.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.equal(tail.getUint32(0, true), 0x06054b50)
  assert.match(text, /\[Content_Types\]\.xml/)
  assert.match(text, /word\/document\.xml/)
  assert.match(text, /word\/styles\.xml/)
  assert.match(text, /word\/numbering\.xml/)
  assert.match(text, /w:numPr/)
  assert.match(text, /Retinitis Pigmentosa/)
  assert.match(text, /research &amp; treatment question/)
})

test('export filenames stay readable and safe', () => {
  assert.equal(reportFilename('Retinitis Pigmentosa - USH2A', 'pdf'), 'research-report-retinitis-pigmentosa-ush2a.pdf')
  assert.equal(reportFilename('', 'docx'), 'research-report-condition.docx')
})
