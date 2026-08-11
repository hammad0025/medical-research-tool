import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientNetworkError, RESEARCH_REPORT_TIMEOUT_MS } from '../src/lib/researchApi.js'

test('live reports allow six minutes for the multi-source research pipeline', () => {
  assert.equal(RESEARCH_REPORT_TIMEOUT_MS, 360_000)
})

test('only connection failures qualify for one automatic research retry', () => {
  assert.equal(isTransientNetworkError(new TypeError('Failed to fetch')), true)
  assert.equal(isTransientNetworkError(new Error('Network request failed')), true)
  assert.equal(isTransientNetworkError(Object.assign(new Error('Research unavailable'), { status: 503 })), false)
  assert.equal(isTransientNetworkError(Object.assign(new Error('Research was canceled.'), { name: 'AbortError' })), false)
})
