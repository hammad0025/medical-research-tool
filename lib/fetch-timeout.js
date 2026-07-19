const finiteTimeout = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const timeoutFor = (provider, fallbackMs) => finiteTimeout(
  process.env[`MRT_${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TIMEOUT_MS`],
  finiteTimeout(process.env.MRT_EXTERNAL_FETCH_TIMEOUT_MS, fallbackMs)
);

export const isTimeoutError = (error) =>
  error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.timedOut === true;

export const withTimeout = async (task, {
  timeoutMs = 15_000,
  provider = 'operation'
} = {}) => {
  const ms = finiteTimeout(timeoutMs, 15_000);
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${provider} timed out after ${ms}ms`);
      error.name = 'TimeoutError';
      error.code = 'ETIMEDOUT';
      error.timedOut = true;
      error.timeoutMs = ms;
      error.provider = provider;
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const fetchWithTimeout = async (input, init = {}, {
  timeoutMs = 15_000,
  provider = 'external provider',
  fetchImpl = globalThis.fetch
} = {}) => {
  const ms = finiteTimeout(timeoutMs, 15_000);
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;

  const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    const error = new Error(`${provider} timed out after ${ms}ms`);
    error.name = 'TimeoutError';
    error.code = 'ETIMEDOUT';
    error.timedOut = true;
    error.timeoutMs = ms;
    error.provider = provider;
    controller.abort(error);
  }, ms);

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
};
