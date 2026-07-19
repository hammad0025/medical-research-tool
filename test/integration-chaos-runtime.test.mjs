import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { fetchWithTimeout, isTimeoutError } from '../lib/fetch-timeout.js';
import { parseJsonRejectDuplicates } from '../lib/strict-json.js';

const hangingFetch = async (_input, { signal } = {}) => new Promise((resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('hanging provider calls time out while caller cancellation remains distinguishable', async () => {
  await assert.rejects(
    fetchWithTimeout('https://provider.offline.invalid', {}, {
      provider: 'offline provider',
      timeoutMs: 15,
      fetchImpl: hangingFetch
    }),
    (error) => {
      assert.equal(isTimeoutError(error), true);
      assert.equal(error.provider, 'offline provider');
      return true;
    }
  );

  const controller = new AbortController();
  const cancellation = new Error('run cancelled by fixture');
  const pending = fetchWithTimeout(
    'https://provider.offline.invalid',
    { signal: controller.signal },
    { timeoutMs: 1_000, fetchImpl: hangingFetch }
  );
  controller.abort(cancellation);
  await assert.rejects(pending, (error) => error === cancellation && !isTimeoutError(error));
});

test('strict provider JSON rejects malformed and duplicate-key payloads', () => {
  assert.throws(() => parseJsonRejectDuplicates('{"ok":'), SyntaxError);
  assert.throws(
    () => parseJsonRejectDuplicates('{"result":{"status":"ok","status":"failed"}}'),
    /Duplicate JSON key: status/
  );
});

test('cold starts do not retain ephemeral queue or usage state', () => {
  const script = `
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MRT_DISABLE_USAGE_LIMIT = '0';
    process.env.MRT_FREE_LIMIT = '2';
    const queue = await import('./lib/brain-queue.js');
    const usage = await import('./lib/usage-store.js');
    const queued = (await queue.dequeueBrainRefreshBatch(10)).length;
    const snapshot = await usage.getUsage('192.0.2.55');
    process.stdout.write(JSON.stringify({ queued, used: snapshot.used }));
  `;
  const runCold = () => JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        PERPLEXITY_API_KEY: '',
        RESEND_API_KEY: ''
      }
    }
  ));
  assert.deepEqual(runCold(), { queued: 0, used: 0 });
  assert.deepEqual(runCold(), { queued: 0, used: 0 });
});

test('degraded health is a sanitized 503 contract with no provider calls', async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  };
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'must-not-leak';
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('health must remain offline');
  };
  try {
    const healthHandler = (await import(`../api/health.js?chaos-health=${Date.now()}`)).default;
    let statusCode = 200;
    let body;
    const res = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(value) { body = value; return this; },
      end() { return this; }
    };
    await healthHandler({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(statusCode, 503);
    assert.equal(body.status, 'degraded');
    assert.equal(body.infra.dependencies.redis.state, 'missing');
    assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NODE_ENV', previous.nodeEnv);
    restore('VERCEL_ENV', previous.vercelEnv);
    restore('UPSTASH_REDIS_REST_URL', previous.url);
    restore('UPSTASH_REDIS_REST_TOKEN', previous.token);
  }
});
