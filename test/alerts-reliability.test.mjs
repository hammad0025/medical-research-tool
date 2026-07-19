import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL_CALL } from '../lib/internal-call.js';

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RESEND_API_KEY;

const store = await import('../lib/alerts-store.js');
const subscribeHandler = (await import('../api/alerts-subscribe.js')).default;
const { default: cronHandler, _alertsCronTest } = await import('../api/alerts-cron.js');

const baseSub = (id = 'sub-1') => ({
  id,
  email: 'patient@example.test',
  condition: 'Example condition',
  cadence: 'weekly',
  patientContext: null,
  unsubscribeToken: `unsubscribe-token-${id}`,
  ownerToken: `owner-capability-${id}`,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastRunAt: null,
  active: true
});

const response = () => {
  const captured = { status: 200, body: undefined };
  return {
    captured,
    res: {
      setHeader() {},
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
      end() { return this; }
    }
  };
};

const invokeFixture = async (_handler, body) => {
  if (body.limitPerSource) {
    return {
      status: 200,
      body: {
        groundedForPrompt: [{ id: 'PMID:1', title: 'Study', year: 2026, citations: 2 }],
        fdaManufacturers: [],
        qualityBreakdown: { totalScreened: 1 }
      }
    };
  }
  return { status: 200, body: { trials: [] } };
};

test.beforeEach(() => store._resetForTests());

test('malformed records are skipped and cleaned without poisoning a page', async () => {
  await store.createSubscription(baseSub());
  store._injectMalformedForTests('bad-json', '{not json', 'patient@example.test');
  store._injectMalformedForTests('wrong-shape', { id: 'different' }, 'patient@example.test');

  const page = await store.listSubscriptionsPage({ limit: 10 });
  assert.deepEqual(page.subscriptions.map((sub) => sub.id), ['sub-1']);
  assert.equal(page.malformed, 2);
  assert.deepEqual((await store.listSubscriptionsByEmail('patient@example.test')).map((sub) => sub.id), ['sub-1']);
});

test('subscription scans are bounded and cursor through the remaining records', async () => {
  for (let i = 0; i < 55; i += 1) {
    await store.createSubscription({
      ...baseSub(`sub-${String(i).padStart(2, '0')}`),
      condition: `Condition ${i}`
    });
  }
  const first = await store.listSubscriptionsPage({ limit: 999 });
  assert.equal(first.subscriptions.length, 50);
  assert.notEqual(first.cursor, '0');
  const second = await store.listSubscriptionsPage({ cursor: first.cursor, limit: 999 });
  assert.equal(second.subscriptions.length, 5);
  assert.equal(second.cursor, '0');
});

test('create is atomic, and unsubscribe tombstone prevents stale resurrection', async () => {
  const left = baseSub('left');
  const right = { ...baseSub('right'), condition: 'example CONDITION' };
  const [a, b] = await Promise.all([
    store.createSubscription(left),
    store.createSubscription(right)
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);

  const winner = a || b;
  const stale = { ...winner, lastRunAt: '2026-07-18T00:00:00.000Z' };
  assert.equal(await store.deleteSubscription(winner.id), true);
  assert.equal(await store.putSubscription(stale), null);
  assert.equal(await store.getSubscription(winner.id), null);
});

test('mocked or provider-id-less sends never advance state or ledger', async () => {
  const sub = baseSub();
  await store.createSubscription(sub);

  for (const result of [
    { mocked: true, provider: 'none' },
    { mocked: false, provider: 'resend' }
  ]) {
    const run = await _alertsCronTest.oneRun(sub, {
      now: new Date('2026-07-18T12:00:00.000Z'),
      invokeFn: invokeFixture,
      sendEmailFn: async () => result
    });
    assert.equal(run.sent, false);
    assert.equal(run.stateAdvanced, false);
  }

  assert.equal((await store.getSubscription(sub.id)).lastRunAt, null);
  assert.equal((await store.getSentLedger(sub.id)).size, 0);
});

test('deadline aborts before send and releases the delivery lease', async () => {
  const sub = baseSub();
  await store.createSubscription(sub);
  let sends = 0;
  await assert.rejects(
    _alertsCronTest.oneRun(sub, {
      now: new Date('2026-07-18T12:00:00.000Z'),
      deadlineAt: 0,
      invokeFn: invokeFixture,
      sendEmailFn: async () => {
        sends += 1;
        return { mocked: false, provider: 'resend', id: 'should-not-send' };
      }
    }),
    /deadline exceeded/
  );
  assert.equal(sends, 0);
  const runKey = _alertsCronTest.periodKey('weekly', new Date('2026-07-18T12:00:00.000Z'));
  assert.equal(await store.claimDelivery(sub.id, runKey, 'after-deadline', 5_000), 'claimed');
});

test('concurrent workers send once and commit provider-id ledger atomically', async () => {
  const sub = baseSub();
  await store.createSubscription(sub);
  let sends = 0;
  let key;
  const sendEmailFn = async (message) => {
    sends += 1;
    key = message.idempotencyKey;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { mocked: false, provider: 'resend', id: 'resend-message-1' };
  };

  const runs = await Promise.all([
    _alertsCronTest.oneRun(sub, {
      now: new Date('2026-07-18T12:00:00.000Z'), invokeFn: invokeFixture, sendEmailFn
    }),
    _alertsCronTest.oneRun(sub, {
      now: new Date('2026-07-18T12:00:00.000Z'), invokeFn: invokeFixture, sendEmailFn
    })
  ]);

  assert.equal(sends, 1);
  assert.equal(key, `alerts:${sub.id}:${_alertsCronTest.periodKey('weekly', new Date('2026-07-18T12:00:00.000Z'))}`);
  assert.equal(runs.filter((run) => run.sent).length, 1);
  assert.equal(runs.filter((run) => run.skipped === 'busy').length, 1);
  assert.deepEqual([...(await store.getSentLedger(sub.id))], ['PMID:1']);
});

test('expired crash lease can retry, while stale worker cannot commit', async () => {
  const sub = baseSub();
  await store.createSubscription(sub);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal(await store.claimDelivery(sub.id, 'weekly:1', 'crashed', 5_000), 'claimed');
    assert.equal(await store.claimDelivery(sub.id, 'weekly:1', 'early', 5_000), 'busy');
    now += 5_001;
    assert.equal(await store.claimDelivery(sub.id, 'weekly:1', 'retry', 5_000), 'claimed');
    assert.equal(await store.completeDelivery({
      subId: sub.id,
      runKey: 'weekly:1',
      token: 'crashed',
      providerId: 'stale-provider-id',
      itemIds: ['stale'],
      lastRunAt: '2026-07-18T00:00:00.000Z'
    }), 'lost');
    assert.equal(await store.completeDelivery({
      subId: sub.id,
      runKey: 'weekly:1',
      token: 'retry',
      providerId: 'resend-provider-id',
      itemIds: ['fresh'],
      lastRunAt: '2026-07-18T00:00:00.000Z'
    }), 'completed');
    assert.equal(await store.claimDelivery(sub.id, 'weekly:1', 'later', 5_000), 'delivered');
    assert.deepEqual([...(await store.getSentLedger(sub.id))], ['fresh']);
  } finally {
    Date.now = originalNow;
  }
});

test('cadence periods are deterministic across weekly and monthly runs', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  assert.equal(_alertsCronTest.isDue({ cadence: 'weekly', lastRunAt: '2026-07-17T00:00:00.000Z' }, now), false);
  assert.equal(_alertsCronTest.isDue({ cadence: 'weekly', lastRunAt: '2026-07-10T00:00:00.000Z' }, now), true);
  assert.equal(_alertsCronTest.isDue({ cadence: 'monthly', lastRunAt: '2026-07-01T00:00:00.000Z' }, now), false);
  assert.equal(_alertsCronTest.isDue({ cadence: 'monthly', lastRunAt: '2026-06-30T23:59:59.000Z' }, now), true);
});

test('list requires capability ownership and exposes only public fields', async () => {
  const sub = baseSub();
  await store.createSubscription({
    ...sub,
    lastRunStats: { providerId: 'must-not-leak', screened: 12 }
  });
  const { captured, res } = response();
  await subscribeHandler({
    [INTERNAL_CALL]: true,
    method: 'GET',
    query: { email: sub.email, token: sub.ownerToken },
    headers: {}
  }, res);
  assert.equal(captured.status, 200);
  assert.deepEqual(Object.keys(captured.body.subscriptions[0]).sort(), [
    'active', 'cadence', 'condition', 'createdAt', 'expiresAt', 'id', 'lastRunAt'
  ]);

  const denied = response();
  await subscribeHandler({
    [INTERNAL_CALL]: true,
    method: 'GET',
    query: { email: sub.email, token: 'wrong-capability-token' },
    headers: {}
  }, denied.res);
  assert.equal(denied.captured.status, 403);
});

test('cron returns an alertable non-2xx when its page is wholly malformed', async () => {
  store._injectMalformedForTests('bad-only', '{broken');
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-test-secret';
  const { captured, res } = response();
  try {
    await cronHandler({
      method: 'POST',
      query: {},
      body: { dryRun: true },
      headers: {
        authorization: 'Bearer cron-test-secret',
        'content-type': 'application/json'
      }
    }, res);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
  assert.equal(captured.status, 503);
  assert.equal(captured.body.ok, false);
  assert.equal(captured.body.malformedSkipped, 1);
});

test('Redis write is one atomic command and malformed cleanup tolerates partial failures', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const commands = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    if (command[0] === 'EVAL') {
      return { ok: true, json: async () => ({ result: 1 }) };
    }
    if (command[0] === 'SSCAN') {
      return { ok: true, json: async () => ({ result: ['0', ['bad-1', 'bad-2']] }) };
    }
    if (command[0] === 'MGET') {
      return { ok: true, json: async () => ({ result: ['{broken', null] }) };
    }
    if (command[0] === 'DEL') throw new Error('simulated cleanup outage');
    return { ok: true, json: async () => ({ result: 1 }) };
  };

  try {
    const redisStore = await import(`../lib/alerts-store.js?redis-test=${Date.now()}`);
    assert.ok(await redisStore.createSubscription(baseSub('redis-sub')));
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'EVAL');

    const page = await redisStore.listSubscriptionsPage({ limit: 2 });
    assert.equal(page.malformed, 2);
    assert.deepEqual(page.subscriptions, []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('delivery completion atomically preserves subscription TTL and bounds delivery ledgers', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const scripts = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === 'EVAL') {
      scripts.push(command[1]);
      const script = command[1];
      const result = script.includes("return 'completed'")
        ? 'completed'
        : script.includes("return 'claimed'")
          ? 'claimed'
          : 1;
      return { ok: true, json: async () => ({ result }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };

  try {
    const redisStore = await import(`../lib/alerts-store.js?redis-ttl=${Date.now()}`);
    await redisStore.createSubscription(baseSub('redis-ttl-sub'));
    assert.equal(await redisStore.claimDelivery('redis-ttl-sub', 'weekly:1', 'worker'), 'claimed');
    assert.equal(await redisStore.completeDelivery({
      subId: 'redis-ttl-sub',
      runKey: 'weekly:1',
      token: 'worker',
      providerId: 'resend-id',
      itemIds: ['PMID:1'],
      lastRunAt: '2026-07-18T00:00:00.000Z'
    }), 'completed');

    const completion = scripts.find((script) => script.includes("return 'completed'"));
    assert.match(completion, /PTTL', KEYS\[1\]/);
    assert.match(completion, /SET', KEYS\[1\], cjson\.encode\(sub\), 'PX', subscriptionTtl/);
    assert.match(completion, /PEXPIRE', KEYS\[3\], subscriptionTtl/);
    assert.match(completion, /PEXPIRE', KEYS\[5\], subscriptionTtl/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});
