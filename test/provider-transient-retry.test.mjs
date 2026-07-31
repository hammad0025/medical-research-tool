// A run's logs showed eighteen consecutive "Anthropic provider failure HTTP 502"
// entries. The retry loop ran four attempts but only advanced on a
// model-not-found error, so a transient gateway failure gave up on the first
// response and killed whole lanes of an already-expensive report.

import test from 'node:test';
import assert from 'node:assert/strict';

import { callAnthropicMessages } from '../api/research.js';

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body
});

const errorResponse = (status, { retryAfter = null } = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({ error: { message: `HTTP ${status}` } })
});

const withStubbedFetch = async (handler, run) => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return handler(calls.length);
  };
  try {
    return { result: await run(), attempts: calls.length };
  } finally {
    globalThis.fetch = previous;
  }
};

const call = () => callAnthropicMessages({
  model: 'claude-fable-5',
  maxTokens: 100,
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  apiKey: 'test-key'
});

test('a transient 502 is retried and the call recovers', async () => {
  const { result, attempts } = await withStubbedFetch(
    (n) => (n < 3 ? errorResponse(502) : jsonResponse({ content: [{ type: 'text', text: 'ok' }] })),
    call
  );
  assert.equal(attempts, 3, 'should retry twice before succeeding');
  assert.equal(result.ok, true);
});

test('transient retries are bounded rather than unlimited', async () => {
  const { result, attempts } = await withStubbedFetch(() => errorResponse(503), call);
  assert.ok(attempts <= 3, `expected at most 3 attempts, made ${attempts}`);
  assert.equal(result.ok, false, 'a persistently failing provider must still fail');
});

test('429 is treated as transient and honours retry-after', async () => {
  const started = Date.now();
  const { result, attempts } = await withStubbedFetch(
    (n) => (n < 2
      ? errorResponse(429, { retryAfter: '1' })
      : jsonResponse({ content: [{ type: 'text', text: 'ok' }] })),
    call
  );
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started >= 900, 'retry-after must be respected');
});

test('a non-transient 400 is not retried', async () => {
  const { attempts, result } = await withStubbedFetch(() => errorResponse(400), call);
  assert.equal(attempts, 1, 'a client error must fail fast, not burn retries');
  assert.equal(result.ok, false);
});
