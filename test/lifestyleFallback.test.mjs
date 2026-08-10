import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLifestyleFallbackTopics } from '../src/lib/lifestyleFallback.js'

test('lifestyle fallback gives every condition useful topics with direct verification queries', () => {
  const topics = buildLifestyleFallbackTopics('Retinitis Pigmentosa - USH2A')

  assert.equal(topics.length, 5)
  assert.deepEqual(topics.map((topic) => topic.title), [
    'Daily function and independence',
    'Activity and rehabilitation',
    'Sleep, fatigue, and emotional support',
    'Food, weight, and swallowing',
    'Home, work, and environmental planning',
  ])
  for (const topic of topics) {
    assert.equal(topic.needsVerification, true)
    assert.equal(topic.generatedFallback, true)
    assert.match(topic.summary, /Retinitis Pigmentosa - USH2A/)
    assert.match(topic.providerQuestion, /\?$/)
    assert.match(topic.verificationQuery, /Retinitis Pigmentosa - USH2A/)
  }
})
