const parseResponse = async (response) => {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.detail || data.error || 'The local research service did not return a usable response.')
    error.code = data.code || ''
    error.status = response.status
    throw error
  }
  return data
}

export const isTransientNetworkError = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return error?.name !== 'AbortError'
    && !error?.status
    && !error?.code
    && /failed to fetch|network(?:error| request failed)?|load failed/.test(message)
}

const requestJson = async (path, options = {}, timeoutMs) => {
  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  if (options.signal) options.signal.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const response = await fetch(path, { credentials: 'same-origin', ...options, signal: controller.signal })
    return await parseResponse(response)
  } catch (error) {
    if (timedOut) {
      throw new Error('This report took longer than 4 minutes. The search was stopped so you can try again.')
    }
    if (options.signal?.aborted) {
      const abortError = new Error('Research was canceled.')
      abortError.name = 'AbortError'
      throw abortError
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort)
  }
}

export const getResearchHealth = async () => {
  return requestJson('/api/health', { headers: { Accept: 'application/json' } }, 8_000)
}

export const getSiteAccessStatus = async () => {
  return requestJson('/api/access/status', { headers: { Accept: 'application/json' } }, 8_000)
}

export const loginSiteAccess = async (passcode) => {
  return requestJson('/api/access/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ passcode }),
  }, 12_000)
}

export const logoutSiteAccess = async () => {
  return requestJson('/api/access/logout', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  }, 8_000)
}

export const extractResearchIntake = async (description, { signal, privacyAcknowledged = false } = {}) => {
  return requestJson('/api/intake-extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ description, privacyAcknowledged }),
    signal,
  }, 70_000)
}

export const runResearchReview = async (patient, { signal, privacyAcknowledged = false } = {}) => {
  const request = () => requestJson('/api/research-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ patient, privacyAcknowledged }),
    signal,
  }, 240_000)

  try {
    return await request()
  } catch (error) {
    // A deploy handoff or a dropped connection can fail before Vercel sees a request.
    if (!isTransientNetworkError(error) || signal?.aborted) throw error
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    return request()
  }
}
