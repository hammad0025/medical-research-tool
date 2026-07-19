import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PERPLEXITY_API_KEY;
delete process.env.MRT_ACCESS_PASSCODE;
process.env.MRT_DISABLE_USAGE_LIMIT = '0';
process.env.MRT_FREE_LIMIT = '3';
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;

const queue = await import('../lib/brain-queue.js');
const usage = await import('../lib/usage-store.js');
const kbStore = await import('../lib/kb-store.js');
const spend = await import('../lib/spend-controls.js');
const { INTERNAL_CALL } = await import('../lib/internal-call.js');
const healthHandler = (await import('../api/health.js')).default;

test.beforeEach(() => {
  queue._resetBrainQueueForTests();
  usage._resetForTests();
  kbStore._resetDynamicKbForTests();
});

test('queue deduplicates and leases work to only one concurrent consumer', async () => {
  await queue.enqueueBrainRefresh('Condition One', 'condition-one');
  await queue.enqueueBrainRefresh('Condition One Updated', 'condition-one');

  const now = Date.now() + 100;
  const [left, right] = await Promise.all([
    queue.dequeueBrainRefreshBatch(1, { now, leaseMs: 1000 }),
    queue.dequeueBrainRefreshBatch(1, { now, leaseMs: 1000 })
  ]);
  const leased = [...left, ...right];
  assert.equal(leased.length, 1);
  assert.equal(leased[0].slug, 'condition-one');
  assert.equal(await queue.ackBrainRefresh({ ...leased[0], leaseToken: 'wrong' }), false);
  assert.equal((await queue.dequeueBrainRefreshBatch(1, { now: now + 500 })).length, 0);

  const recovered = await queue.dequeueBrainRefreshBatch(1, { now: now + 1001 });
  assert.equal(recovered.length, 1);
  assert.equal(await queue.ackBrainRefresh(leased[0]), false);
  assert.equal(await queue.ackBrainRefresh(recovered[0]), true);
  assert.equal((await queue.dequeueBrainRefreshBatch(1, { now: now + 2000 })).length, 0);
});

test('queue retry preserves work and dead-letters after bounded attempts', async () => {
  await queue.enqueueBrainRefresh('Retry Me', 'retry-me');
  const now = Date.now() + 100;
  const [first] = await queue.dequeueBrainRefreshBatch(1, { now });
  assert.equal(await queue.retryBrainRefresh(first, { now, delayMs: 0 }), true);

  const [second] = await queue.dequeueBrainRefreshBatch(1, { now });
  assert.equal(second.slug, 'retry-me');
  assert.equal(await queue.retryBrainRefresh(second, { now, delayMs: 0, maxAttempts: 2 }), true);
  assert.equal((await queue.dequeueBrainRefreshBatch(1, { now: now + 1 })).length, 0);
  assert.deepEqual((await queue.listDeadBrainRefreshes()).map((entry) => entry.slug), ['retry-me']);
  assert.equal(await queue.requeueDeadBrainRefresh('retry-me', { now: now + 2 }), true);
  const [recovered] = await queue.dequeueBrainRefreshBatch(1, { now: now + 2 });
  assert.equal(recovered.slug, 'retry-me');
  assert.equal(recovered.attempt, 0);
  assert.equal(await queue.ackBrainRefresh(recovered), true);
});

test('usage credit consumption is atomic under concurrency', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 25 }, () => usage.consumeResearchCredit('203.0.113.20'))
  );
  assert.equal(attempts.filter((result) => result.allowed).length, 3);
  assert.ok(attempts.every((result) => Number.isFinite(result.used)));

  const snapshot = await usage.getUsage('203.0.113.20');
  assert.deepEqual(
    { used: snapshot.used, remaining: snapshot.remaining, limit: snapshot.limit },
    { used: 3, remaining: 0, limit: 3 }
  );
});

test('invalid finite-limit configuration fails closed', () => {
  const source = `
    process.env.MRT_DISABLE_USAGE_LIMIT = '0';
    process.env.MRT_FREE_LIMIT = 'Infinity';
    process.env.NODE_ENV = 'production';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const store = await import('./lib/usage-store.js');
    try {
      await store.consumeResearchCredit('203.0.113.21');
      process.stdout.write(JSON.stringify({ allowed: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ allowed: false, code: error.code }));
    }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'DURABLE_ENFORCEMENT_UNAVAILABLE');
});

test('all paid modes and direct handlers share spend enforcement', async () => {
  for (const mode of [
    'research', 'repurpose', 'trials', 'chat', 'translate',
    'benchmark-models', 'validate', 'polish-report'
  ]) {
    assert.equal(spend.isPaidUserMode(mode), true, mode);
  }

  const previous = process.env.MRT_SPEND_ENABLED;
  process.env.MRT_SPEND_ENABLED = '0';
  try {
    let statusCode = null;
    let body = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { body = value; return this; }
    };
    assert.equal(await spend.enforceDirectPaidHandlerPolicy({
      headers: { 'x-real-ip': '203.0.113.40' }
    }, res), false);
    assert.equal(statusCode, 503);
    assert.equal(body.code, 'RESEARCH_SPEND_DISABLED');
    assert.equal(await spend.enforceDirectPaidHandlerPolicy({ [INTERNAL_CALL]: true }, res), true);
  } finally {
    if (previous === undefined) delete process.env.MRT_SPEND_ENABLED;
    else process.env.MRT_SPEND_ENABLED = previous;
  }
});

test('KB updates replace aliases atomically without mutating caller data', async () => {
  const original = {
    slug: 'condition-a',
    condition: 'Condition A',
    aliases: ['Old Alias'],
    evidence: []
  };
  await kbStore.putDynamicKb(original);
  assert.equal(original.dynamicBuiltAt, undefined);
  assert.equal((await kbStore.lookupDynamicKb('Old Alias')).slug, 'condition-a');

  await kbStore.putDynamicKb({
    ...original,
    aliases: ['New Alias']
  });
  assert.equal(await kbStore.lookupDynamicKb('Old Alias'), null);
  assert.equal((await kbStore.lookupDynamicKb('New Alias')).slug, 'condition-a');
  assert.deepEqual(await kbStore.listDynamicKbSlugs(), ['condition-a']);
  await assert.rejects(kbStore.putDynamicKb({ condition: 'Broken' }), /kb\.slug required/);
  assert.equal((await kbStore.getDynamicKb('condition-a')).condition, 'Condition A');
});

test('health fails closed with sanitized dependency states', async () => {
  process.env.UPSTASH_REDIS_REST_TOKEN = 'do-not-expose-this-secret';
  let statusCode = null;
  let body = null;
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
    end() { return this; }
  };
  await healthHandler({ method: 'GET', headers: {}, query: {} }, res);
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  assert.equal(statusCode, 503);
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.infra.dependencies.redis, {
    required: true,
    configured: false,
    state: 'missing'
  });
  assert.equal(JSON.stringify(body).includes('do-not-expose-this-secret'), false);
});
