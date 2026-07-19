import test from 'node:test';
import assert from 'node:assert/strict';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' }
});

test('mock Redis failure injection rejects malformed JSON and never falls back silently', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.offline.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'offline-token';
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://redis.offline.invalid');
    assert.match(init.headers.Authorization, /^Bearer /);
    calls += 1;
    return new Response('{broken redis json', { status: 200 });
  };
  try {
    const queue = await import(`../lib/brain-queue.js?chaos-redis=${Date.now()}`);
    await assert.rejects(
      queue.enqueueBrainRefresh('Offline Condition', 'offline-condition'),
      /JSON|Unexpected|position/i
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previous.url;
    if (previous.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previous.token;
  }
});

test('mock Resend receives stable idempotency key and fails closed on malformed acceptance', async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'offline-resend-key';
  const observed = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.resend.com/emails');
    observed.push(init.headers['Idempotency-Key']);
    return jsonResponse({ accepted: true });
  };
  try {
    const email = await import(`../lib/alerts-email.js?chaos-resend=${Date.now()}`);
    const payload = {
      to: 'offline@example.test',
      subject: 'Offline assurance',
      html: '<p>fixture</p>',
      idempotencyKey: 'alerts:fixture:weekly:123'
    };
    await assert.rejects(email.sendEmail(payload), /missing provider message id/i);
    await assert.rejects(email.sendEmail(payload), /missing provider message id/i);
    assert.deepEqual(observed, [
      'alerts:fixture:weekly:123',
      'alerts:fixture:weekly:123'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }
});

test('concurrent alert workers claim once, retry safely, and complete idempotently', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const store = await import(`../lib/alerts-store.js?chaos-memory=${Date.now()}`);
  store._resetForTests();
  const sub = {
    id: 'sub-chaos',
    email: 'patient@example.test',
    condition: 'Fixture condition',
    cadence: 'weekly',
    active: true
  };
  assert.ok(await store.createSubscription(sub));
  assert.equal(await store.createSubscription({ ...sub, id: 'duplicate' }), null);

  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.claimDelivery(sub.id, 'weekly:123', `worker-${index}`, 5_000)
    )
  );
  assert.equal(claims.filter((state) => state === 'claimed').length, 1);
  assert.equal(claims.filter((state) => state === 'busy').length, 19);
  const winner = claims.indexOf('claimed');

  assert.equal(
    await store.completeDelivery({
      subId: sub.id,
      runKey: 'weekly:123',
      token: `worker-${winner}`,
      providerId: 'resend-offline-1',
      itemIds: ['paper:1', 'paper:1'],
      lastRunAt: new Date(0).toISOString(),
      lastRunStats: { sent: 1 }
    }),
    'completed'
  );
  assert.equal(
    await store.completeDelivery({
      subId: sub.id,
      runKey: 'weekly:123',
      token: `worker-${winner}`,
      providerId: 'resend-offline-1',
      itemIds: ['paper:1']
    }),
    'delivered'
  );
  assert.deepEqual([...await store.getSentLedger(sub.id)], ['paper:1']);
});

test('queue leases serialize concurrent workers and recover cancellation by retry', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const queue = await import(`../lib/brain-queue.js?chaos-workers=${Date.now()}`);
  queue._resetBrainQueueForTests();
  await Promise.all(
    Array.from({ length: 12 }, () => queue.enqueueBrainRefresh('Same job', 'same-job'))
  );
  const now = Date.now() + 10;
  const batches = await Promise.all(
    Array.from({ length: 12 }, () => queue.dequeueBrainRefreshBatch(1, { now, leaseMs: 20 }))
  );
  const [lease] = batches.flat();
  assert.ok(lease);
  assert.equal(batches.flat().length, 1);

  assert.equal(await queue.retryBrainRefresh(lease, { now, delayMs: 0 }), true);
  const [retry] = await queue.dequeueBrainRefreshBatch(1, { now, leaseMs: 20 });
  assert.equal(retry.attempt, 1);
  assert.equal(await queue.ackBrainRefresh({ ...retry, leaseToken: 'cancelled-worker' }), false);

  const [recovered] = await queue.dequeueBrainRefreshBatch(1, {
    now: now + 21,
    leaseMs: 20
  });
  assert.equal(recovered.slug, 'same-job');
  assert.equal(await queue.ackBrainRefresh(recovered), true);
});
