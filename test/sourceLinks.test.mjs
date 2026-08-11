import assert from 'node:assert/strict'
import test from 'node:test'
import { citationText, citationsFor, citationsForClaim, citationsForItem, verificationLinks } from '../src/lib/sourceLinks.js'

const result = {
  sources: [{ id: 'pmid-1001', title: 'Retina treatment review', url: 'https://pubmed.ncbi.nlm.nih.gov/1001/' }],
  trials: [{ id: 'NCT00000001', title: 'Retina study', url: 'https://clinicaltrials.gov/study/NCT00000001' }],
}

test('claim citations resolve exact packet IDs and keep direct source URLs', () => {
  const citations = citationsFor(result, ['pmid-1001', 'NCT00000001'])

  assert.deepEqual(citations.map((item) => item.url), [
    'https://pubmed.ncbi.nlm.nih.gov/1001/',
    'https://clinicaltrials.gov/study/NCT00000001',
  ])
  assert.match(citationText(citations), /Retina treatment review \(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/1001\/\)/)
  assert.match(citationText(citations), /Retina study \(https:\/\/clinicaltrials\.gov\/study\/NCT00000001\)/)
})

test('AI-only ideas receive official verification links instead of an untraceable citation', () => {
  const links = citationsForClaim({
    result,
    sourceIds: [],
    condition: 'Retinitis Pigmentosa',
    searchTerms: ['USH2A retinitis pigmentosa treatment research'],
    verifyWhenEmpty: true,
  })

  assert.deepEqual(links, verificationLinks({
    condition: 'Retinitis Pigmentosa',
    searchTerms: ['USH2A retinitis pigmentosa treatment research'],
  }))
  assert.match(links[0].url, /pubmed\.ncbi\.nlm\.nih\.gov/)
  assert.match(links[1].url, /clinicaltrials\.gov\/search\?cond=Retinitis%20Pigmentosa/)
})

test('direct source links take priority over incidental trial links on a report card', () => {
  const citations = citationsForItem({
    result,
    sourceIds: ['pmid-1001'],
    trials: result.trials,
    condition: 'Retinitis Pigmentosa',
  })

  assert.deepEqual(citations.map((item) => item.url), ['https://pubmed.ncbi.nlm.nih.gov/1001/'])
})
