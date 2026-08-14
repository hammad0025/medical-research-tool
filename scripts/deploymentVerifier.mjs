const DEFAULT_TIMEOUT_MS = 25_000
export const REPORT_TIMEOUT_MS = 360_000

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const cleanText = (value, limit = 280) => String(value || '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const asArray = (value) => Array.isArray(value) ? value : []

const isLocalHost = (hostname) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase())

export const normalizeDeploymentUrl = (value) => {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new Error('DEPLOYMENT_URL must be a complete URL, such as https://your-site.example.')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('DEPLOYMENT_URL must start with http:// or https://.')
  }
  if (url.protocol !== 'https:' && !isLocalHost(url.hostname)) {
    throw new Error('Deployment verification only allows HTTPS URLs outside localhost.')
  }
  if (url.search || url.hash) {
    throw new Error('DEPLOYMENT_URL must not include a query string or hash.')
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.href.replace(/\/$/, '')
}

const endpointUrl = (baseUrl, path) => `${baseUrl}${path}`

const headerValue = (headers, name) => {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match ? String(match[1] || '') : ''
}

const responseMessage = (payload) => {
  if (!isRecord(payload)) return ''
  return cleanText(payload.error || payload.detail || payload.code, 180)
}

const fetchResponse = async ({ fetchImpl, url, method = 'GET', headers = {}, body, timeoutMs, label }) => {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for deployment verification.')

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      // The landing page is HTML. API checks below require an object explicitly.
    }
    return { response, status: response.status, text, json }
  } catch (error) {
    const detail = error instanceof Error ? cleanText(error.message, 220) : 'Unknown network error.'
    throw new Error(`${label} could not be reached: ${detail}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const requireStatus = (result, expected, label) => {
  const accepted = Array.isArray(expected) ? expected : [expected]
  if (accepted.includes(result.status)) return
  const detail = responseMessage(result.json)
  throw new Error(`${label} returned HTTP ${result.status}; expected ${accepted.join(' or ')}.${detail ? ` ${detail}` : ''}`)
}

const requireJsonObject = (result, label) => {
  if (isRecord(result.json)) return result.json
  throw new Error(`${label} did not return a JSON object.`)
}

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const cookieFromLogin = (response) => {
  const values = typeof response?.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [headerValue(response?.headers, 'set-cookie')]
  const cookie = values.find((value) => /^rmc_demo_access=[^;]+/i.test(String(value || '')))
  return cleanText(cookie, 8_000).split(';')[0]
}

const cardCount = (value) => asArray(value).filter(isRecord).length
const sourceCautionCount = (value) => asArray(value)
  .filter((source) => isRecord(source) && cleanText(source.caution, 220)).length

const summarizeReport = (report) => {
  const review = isRecord(report.review) ? report.review : {}
  const exploration = isRecord(report.exploration) ? report.exploration : {}
  const cards = {
    treatmentIdeas: cardCount(review.treatmentIdeas) + cardCount(report.curatedDiscussionLeads) + cardCount(exploration.treatmentPaths),
    lifestyle: cardCount(review.lifestyle) + cardCount(report.curatedLifestyleIdeas) + cardCount(exploration.lifestyle),
    safety: cardCount(review.safety) + cardCount(report.excludedTreatments) + sourceCautionCount(report.sources) + cardCount(exploration.safety),
    researchConnections: cardCount(review.hypotheses) + cardCount(review.theoryIdeas) + cardCount(report.curatedTheoryIdeas) + cardCount(report.trials) + cardCount(exploration.connections),
  }

  return {
    status: cleanText(report.status, 40),
    sources: cardCount(report.sources),
    currentTrials: cardCount(report.trials),
    studySites: cardCount(report.centers),
    cards,
  }
}

const requireCompleteReport = (report) => {
  requireCondition(isRecord(report), 'The research endpoint did not return a report object.')
  requireCondition(['ready', 'exploration'].includes(report.status), `The report ended in an unexpected state: ${cleanText(report.status, 80) || 'missing'}.`)
  requireCondition(cleanText(report.patient?.condition, 160).toLowerCase() === 'retinitis pigmentosa', 'The fictional report did not retain its requested condition.')

  const summary = summarizeReport(report)
  for (const [section, count] of Object.entries(summary.cards)) {
    requireCondition(count > 0, `The report is missing its required ${section} section.`)
  }

  const serialized = JSON.stringify(report).toLowerCase()
  requireCondition(!serialized.includes('no clear lead yet'), 'The report still contains the old blank-report placeholder text.')
  requireCondition(!serialized.includes('no clear idea yet'), 'The report still contains the old blank-report placeholder text.')
  return summary
}

const fictionalPatient = {
  condition: 'Retinitis Pigmentosa',
  geneticVariant: 'USH2A',
  goals: 'Fictional deployment verification only. Do not use this profile for treatment decisions.',
  reportStyle: 'plain',
}

export const verifyDeployment = async ({
  baseUrl,
  testPasscode = '',
  fetchImpl = globalThis.fetch,
  runReport = Boolean(testPasscode),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reportTimeoutMs = REPORT_TIMEOUT_MS,
} = {}) => {
  const deploymentUrl = normalizeDeploymentUrl(baseUrl)
  const passcode = String(testPasscode || '').trim()
  if (runReport && !passcode) {
    throw new Error('DEPLOYMENT_TEST_PASSCODE is required for a full fictional report check.')
  }

  const checks = []
  const runCheck = async (name, callback) => {
    const detail = await callback()
    checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) })
    return detail
  }

  await runCheck('landing page loads', async () => {
    const result = await fetchResponse({
      fetchImpl,
      url: deploymentUrl,
      headers: { Accept: 'text/html' },
      timeoutMs,
      label: 'Landing page',
    })
    requireStatus(result, 200, 'Landing page')
    requireCondition(/<div\s+id=["']root["']/i.test(result.text), 'Landing page did not contain the application root.')
    return 'Application shell returned.'
  })

  await runCheck('server-side passcode gate is enabled', async () => {
    const result = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/access/status'),
      headers: { Accept: 'application/json' },
      timeoutMs,
      label: 'Access status',
    })
    requireStatus(result, 200, 'Access status')
    const status = requireJsonObject(result, 'Access status')
    requireCondition(status.protection === 'enabled', 'The deployed API passcode is not configured.')
    requireCondition(status.access === 'locked', 'The deployed API did not begin in a locked state.')
    return 'Anonymous API session is locked.'
  })

  await runCheck('anonymous API requests are rejected', async () => {
    const health = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/health'),
      headers: { Accept: 'application/json' },
      timeoutMs,
      label: 'Anonymous health check',
    })
    requireStatus(health, 401, 'Anonymous health check')
    requireCondition(health.json?.code === 'access_required', 'Anonymous health check was not rejected by the access gate.')

    const report = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/research-run'),
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: { privacyAcknowledged: true, patient: fictionalPatient },
      timeoutMs,
      label: 'Anonymous report request',
    })
    requireStatus(report, 401, 'Anonymous report request')
    requireCondition(report.json?.code === 'access_required', 'Anonymous report request was not rejected by the access gate.')
    return 'Health and research routes are protected.'
  })

  await runCheck('wrong passcodes are rejected', async () => {
    const result = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/access/login'),
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: { passcode: `deployment-check-invalid-${Date.now()}` },
      timeoutMs,
      label: 'Wrong-passcode check',
    })
    requireStatus(result, [401, 429], 'Wrong-passcode check')
    requireCondition(result.json?.access !== 'granted', 'An incorrect passcode was accepted.')
    return 'Incorrect passcode was refused.'
  })

  if (!passcode) {
    return {
      baseUrl: deploymentUrl,
      mode: 'locked-only',
      checkedAt: new Date().toISOString(),
      checks,
      note: 'Set DEPLOYMENT_TEST_PASSCODE to include the authenticated fictional report check.',
    }
  }

  const login = await runCheck('test passcode creates a secure server session', async () => {
    const result = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/access/login'),
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: { passcode },
      timeoutMs,
      label: 'Test passcode login',
    })
    requireStatus(result, 200, 'Test passcode login')
    requireCondition(result.json?.access === 'granted', 'The test passcode did not grant access.')
    const setCookie = headerValue(result.response.headers, 'set-cookie')
    requireCondition(/HttpOnly/i.test(setCookie), 'The access cookie is not HttpOnly.')
    requireCondition(/SameSite=Strict/i.test(setCookie), 'The access cookie is not SameSite=Strict.')
    if (new URL(deploymentUrl).protocol === 'https:') {
      requireCondition(/(?:^|;)\s*Secure(?:;|$)/i.test(setCookie), 'The HTTPS deployment access cookie is not marked Secure.')
    }
    const cookie = cookieFromLogin(result.response)
    requireCondition(cookie, 'The login response did not issue an access cookie.')
    return { cookie, detail: 'HttpOnly session cookie issued.' }
  })

  const sessionCookie = login.cookie
  const authorizedHeaders = {
    Accept: 'application/json',
    Cookie: sessionCookie,
  }

  await runCheck('authenticated health endpoint responds', async () => {
    const result = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/health'),
      headers: authorizedHeaders,
      timeoutMs,
      label: 'Authenticated health check',
    })
    requireStatus(result, 200, 'Authenticated health check')
    requireCondition(result.json?.ok === true, 'Authenticated health check did not return ok: true.')
    return 'Server API is available.'
  })

  await runCheck('privacy acknowledgement is enforced', async () => {
    const result = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/research-run'),
      method: 'POST',
      headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
      body: { patient: fictionalPatient },
      timeoutMs,
      label: 'Privacy acknowledgement check',
    })
    requireStatus(result, 400, 'Privacy acknowledgement check')
    requireCondition(/privacy and safety notice/i.test(cleanText(result.json?.error, 220)), 'The research route accepted a request without the privacy acknowledgement.')
    return 'Research route requires the acknowledgement.'
  })

  let reportSummary = null
  if (runReport) {
    reportSummary = await runCheck('fictional condition report has every required section', async () => {
      const result = await fetchResponse({
        fetchImpl,
        url: endpointUrl(deploymentUrl, '/api/research-run'),
        method: 'POST',
        headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
        body: { privacyAcknowledged: true, patient: fictionalPatient },
        timeoutMs: reportTimeoutMs,
        label: 'Fictional condition report',
      })
      requireStatus(result, 200, 'Fictional condition report')
      return requireCompleteReport(requireJsonObject(result, 'Fictional condition report'))
    })
  }

  await runCheck('logout clears the browser session', async () => {
    const logout = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/access/logout'),
      method: 'POST',
      headers: authorizedHeaders,
      timeoutMs,
      label: 'Logout',
    })
    requireStatus(logout, 200, 'Logout')
    requireCondition(logout.json?.access === 'locked', 'Logout did not report a locked session.')
    requireCondition(/Max-Age=0/i.test(headerValue(logout.response.headers, 'set-cookie')), 'Logout did not clear the session cookie.')

    const relocked = await fetchResponse({
      fetchImpl,
      url: endpointUrl(deploymentUrl, '/api/health'),
      headers: { Accept: 'application/json' },
      timeoutMs,
      label: 'Post-logout health check',
    })
    requireStatus(relocked, 401, 'Post-logout health check')
    return 'Browser session is locked after logout.'
  })

  return {
    baseUrl: deploymentUrl,
    mode: runReport ? 'full' : 'authenticated-only',
    checkedAt: new Date().toISOString(),
    checks,
    ...(reportSummary ? { report: reportSummary } : {}),
  }
}

const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]

if (isDirectRun) {
  const baseUrl = process.env.DEPLOYMENT_URL || process.argv[2]
  const testPasscode = process.env.DEPLOYMENT_TEST_PASSCODE || ''
  const runReport = Boolean(testPasscode) && process.env.DEPLOYMENT_FULL_RUN !== 'false'

  verifyDeployment({ baseUrl, testPasscode, runReport })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((error) => {
      console.error(`Deployment verification failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
