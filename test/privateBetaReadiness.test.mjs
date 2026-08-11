import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { findDirectIdentifier } from '../src/lib/privacy.js'

test('privacy guard catches additional direct identifiers before a report run', () => {
  assert.equal(findDirectIdentifier('DOB: January 3, 1965'), 'a date of birth')
  assert.equal(findDirectIdentifier('Insurance member number: XZ-49020'), 'an insurance policy or member number')
  assert.equal(findDirectIdentifier('Patient address: 21 Main Street'), 'a street address')
})

test('the private beta exposes readable terms and a truthful privacy notice', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

  assert.match(app, /function LegalPage/)
  assert.match(app, /Privacy notice/)
  assert.match(app, /Terms of use/)
  assert.match(app, /does not create patient accounts or save profiles/i)
  assert.match(app, /sent to the research sources and AI providers/i)
  assert.doesNotMatch(app, /Unlimited runs/)
})
