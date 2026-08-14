import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDeploymentUrl, REPORT_TIMEOUT_MS, verifyDeployment } from '../scripts/deploymentVerifier.mjs'

const jsonResponse = (body, status = 200, headers = {}) => ({
  status,
  headers: {
    get(name) {
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
      return entry ? entry[1] : null
    },
  },
  text: async () => JSON.stringify(body),
})

const textResponse = (body, status = 200) => ({
  status,
  headers: { get: () => null },
  text: async () => body,
})

const report = {
  status: 'exploration',
  patient: { condition: 'Retinitis Pigmentosa' },
  sources: [],
  trials: [],
  centers: [],
  review: {
    treatmentIdeas: [],
    lifestyle: [],
    safety: [],
    hypotheses: [],
  },
  exploration: {
    treatmentPaths: [{ title: 'Gene-specific retina research' }],
    lifestyle: [{ title: 'Low-vision support' }],
    safety: [{ title: 'Review all treatment claims' }],
    connections: [{ title: 'Gene result can guide the search' }],
  },
}

test('full deployment report checks allow six minutes', () => {
  assert.equal(REPORT_TIMEOUT_MS, 360_000)
})

const createDeploymentFetch = ({ badReport = false, setupRequired = false } = {}) => {
  const calls = []
  let loggedIn = false

  const fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const path = url.pathname
    const method = options.method || 'GET'
    const headers = options.headers || {}
    const cookie = headers.Cookie || headers.cookie || ''
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ path, method, body, cookie })

    if (path === '/' && method === 'GET') return textResponse('<!doctype html><html><body><div id="root"></div></body></html>')
    if (path === '/api/access/status') {
      return jsonResponse({ ok: true, protection: setupRequired ? 'setup-required' : 'enabled', access: setupRequired ? 'setup-required' : 'locked' })
    }
    if (path === '/api/access/login') {
      if (body.passcode === 'correct-test-passcode') {
        loggedIn = true
        return jsonResponse(
          { ok: true, access: 'granted' },
          200,
          { 'Set-Cookie': 'rmc_demo_access=session-token; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200' },
        )
      }
      return jsonResponse({ error: 'That passcode is not correct.' }, 401)
    }
    if (path === '/api/health') {
      if (loggedIn && cookie === 'rmc_demo_access=session-token') return jsonResponse({ ok: true })
      return jsonResponse({ error: 'Enter the demo passcode first.', code: 'access_required' }, 401)
    }
    if (path === '/api/research-run') {
      if (!loggedIn || cookie !== 'rmc_demo_access=session-token') {
        return jsonResponse({ error: 'Enter the demo passcode first.', code: 'access_required' }, 401)
      }
      if (body.privacyAcknowledged !== true) {
        return jsonResponse({ error: 'Please confirm the privacy and safety notice before starting research.' }, 400)
      }
      return jsonResponse(badReport ? { ...report, exploration: { ...report.exploration, treatmentPaths: [] } } : report)
    }
    if (path === '/api/access/logout') {
      loggedIn = false
      return jsonResponse(
        { ok: true, access: 'locked' },
        200,
        { 'Set-Cookie': 'rmc_demo_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' },
      )
    }
    throw new Error(`Unexpected test route: ${method} ${path}`)
  }

  return { calls, fetch }
}

test('normalizes only safe deployment URLs', () => {
  assert.equal(normalizeDeploymentUrl('https://demo.example/'), 'https://demo.example')
  assert.equal(normalizeDeploymentUrl('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173')
  assert.throws(() => normalizeDeploymentUrl('http://demo.example'), /HTTPS URLs/)
  assert.throws(() => normalizeDeploymentUrl('https://demo.example/?preview=1'), /query string/)
})

test('locked-only deployment verification proves the public API is protected', async () => {
  const mock = createDeploymentFetch()
  const result = await verifyDeployment({
    baseUrl: 'https://demo.example',
    fetchImpl: mock.fetch,
    timeoutMs: 100,
  })

  assert.equal(result.mode, 'locked-only')
  assert.equal(result.checks.length, 4)
  assert.match(result.note, /DEPLOYMENT_TEST_PASSCODE/)
  assert.deepEqual(
    mock.calls.map((call) => `${call.method} ${call.path}`),
    ['GET /', 'GET /api/access/status', 'GET /api/health', 'POST /api/research-run', 'POST /api/access/login'],
  )
})

test('full deployment verification checks a secure session, privacy, report cards, and logout', async () => {
  const mock = createDeploymentFetch()
  const result = await verifyDeployment({
    baseUrl: 'https://demo.example',
    testPasscode: 'correct-test-passcode',
    fetchImpl: mock.fetch,
    timeoutMs: 100,
    reportTimeoutMs: 100,
  })

  assert.equal(result.mode, 'full')
  assert.deepEqual(result.report.cards, {
    treatmentIdeas: 1,
    lifestyle: 1,
    safety: 1,
    researchConnections: 1,
  })
  assert.equal(result.checks.length, 9)
  assert.equal(mock.calls.filter((call) => call.path === '/api/research-run').length, 3)
  assert.equal(mock.calls.at(-1).path, '/api/health')
  assert.equal(mock.calls.at(-1).cookie, '')
})

test('deployment verification fails instead of accepting an unconfigured passcode or blank report', async () => {
  const missingGate = createDeploymentFetch({ setupRequired: true })
  await assert.rejects(
    () => verifyDeployment({ baseUrl: 'https://demo.example', fetchImpl: missingGate.fetch, timeoutMs: 100 }),
    /passcode is not configured/i,
  )

  const blankReport = createDeploymentFetch({ badReport: true })
  await assert.rejects(
    () => verifyDeployment({
      baseUrl: 'https://demo.example',
      testPasscode: 'correct-test-passcode',
      fetchImpl: blankReport.fetch,
      timeoutMs: 100,
      reportTimeoutMs: 100,
    }),
    /required treatmentIdeas section/i,
  )
})
