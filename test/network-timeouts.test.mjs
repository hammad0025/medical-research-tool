import test from 'node:test';
import assert from 'node:assert/strict';
import { asInternalReq } from '../lib/internal-call.js';
import { fetchWithTimeout, isTimeoutError, withTimeout } from '../lib/fetch-timeout.js';
import { collectProviderFailures } from '../lib/evidence.js';

const hangingFetch = async (_url, { signal } = {}) => new Promise((resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

const invoke = async (handler, body) => {
  let statusCode = 200;
  let responseBody;
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { responseBody = value; return this; },
    end() { return this; }
  };
  await handler(asInternalReq({ method: 'POST', body, headers: {}, query: {} }), res);
  return { statusCode, body: responseBody };
};

test('fetchWithTimeout aborts a hanging request with typed metadata', async () => {
  await assert.rejects(
    fetchWithTimeout('https://provider.invalid', {}, {
      timeoutMs: 10,
      provider: 'Fixture provider',
      fetchImpl: hangingFetch
    }),
    (error) => {
      assert.equal(isTimeoutError(error), true);
      assert.equal(error.provider, 'Fixture provider');
      assert.equal(error.timeoutMs, 10);
      return true;
    }
  );
});

test('fetchWithTimeout preserves caller cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  const request = fetchWithTimeout('https://provider.invalid', { signal: controller.signal }, {
    timeoutMs: 1_000,
    fetchImpl: hangingFetch
  });
  controller.abort(reason);
  await assert.rejects(request, (error) => {
    assert.equal(error, reason);
    assert.equal(isTimeoutError(error), false);
    return true;
  });
});

test('non-fetch provider operations have finite typed deadlines', async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), {
      timeoutMs: 10,
      provider: 'Fixture Redis'
    }),
    (error) =>
      isTimeoutError(error) &&
      error.provider === 'Fixture Redis' &&
      error.timeoutMs === 10
  );
});

test('evidence fan-out preserves timeout and partial-provider failures', () => {
  const failures = collectProviderFailures([
    ['PubMed', [{ status: 504, body: { timeout: true } }]],
    ['openFDA', [{ status: 200, body: {
      degraded: true,
      providerErrors: [{ provider: 'openFDA label', reason: 'timeout' }]
    } }]]
  ]);
  assert.deepEqual(failures, [
    { provider: 'PubMed', reason: 'timeout' },
    { provider: 'openFDA label', reason: 'timeout' }
  ]);
});

test('openFDA reports timed-out partial providers instead of silent empty data', async () => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = process.env.MRT_OPENFDA_TIMEOUT_MS;
  process.env.MRT_OPENFDA_TIMEOUT_MS = '10';
  globalThis.fetch = hangingFetch;
  try {
    const handler = (await import(`../lib/openfda.js?timeout-test=${Date.now()}`)).default;
    const response = await invoke(handler, { drug: 'fixture' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.degraded, true);
    assert.deepEqual(response.body.providerErrors.map((item) => item.reason), ['timeout', 'timeout']);
    assert.equal(response.body.label, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTimeout === undefined) delete process.env.MRT_OPENFDA_TIMEOUT_MS;
    else process.env.MRT_OPENFDA_TIMEOUT_MS = previousTimeout;
  }
});

test('Redis and Resend calls enforce their configured deadlines', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    redisTimeout: process.env.MRT_REDIS_TIMEOUT_MS,
    resendKey: process.env.RESEND_API_KEY,
    resendTimeout: process.env.MRT_RESEND_TIMEOUT_MS
  };
  Object.assign(process.env, {
    UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
    MRT_REDIS_TIMEOUT_MS: '10',
    RESEND_API_KEY: 'fixture-resend-key',
    MRT_RESEND_TIMEOUT_MS: '10'
  });
  globalThis.fetch = hangingFetch;
  try {
    const nonce = Date.now();
    const store = await import(`../lib/brain-overlay.js?timeout-test=${nonce}`);
    const email = await import(`../lib/alerts-email.js?timeout-test=${nonce}`);
    await assert.rejects(store.getBrainOverlay('fixture'), (error) => isTimeoutError(error));
    await assert.rejects(
      email.sendEmail({ to: 'patient@example.com', subject: 'Fixture', html: '<p>Fixture</p>' }),
      (error) => isTimeoutError(error)
    );
  } finally {
    globalThis.fetch = previousFetch;
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('UPSTASH_REDIS_REST_URL', previousEnv.url);
    restore('UPSTASH_REDIS_REST_TOKEN', previousEnv.token);
    restore('MRT_REDIS_TIMEOUT_MS', previousEnv.redisTimeout);
    restore('RESEND_API_KEY', previousEnv.resendKey);
    restore('MRT_RESEND_TIMEOUT_MS', previousEnv.resendTimeout);
  }
});
