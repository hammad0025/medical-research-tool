import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const response = () => {
  const state = { status: 200, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) { state.headers[name] = value; },
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return this; },
    end() { return this; }
  };
};

test('production cold starts fail closed without durable enforcement', () => {
  const source = `
    process.env.NODE_ENV = 'production';
    process.env.MRT_DISABLE_USAGE_LIMIT = '1';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const access = await import('./lib/access-rate-limit.js');
    const usage = await import('./lib/usage-store.js');
    const req = { headers: { 'x-forwarded-for': '203.0.113.90' } };
    const codes = [];
    for (const action of [
      () => access.recordAccessFailure(req),
      () => usage.consumeResearchCredit('203.0.113.90')
    ]) {
      try { await action(); codes.push('BYPASSED'); }
      catch (error) { codes.push(error.code); }
    }
    process.stdout.write(JSON.stringify(codes));
  `;
  for (let coldStart = 0; coldStart < 2; coldStart += 1) {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    }));
    assert.deepEqual(result, [
      'DURABLE_ENFORCEMENT_UNAVAILABLE',
      'DURABLE_ENFORCEMENT_UNAVAILABLE'
    ]);
  }
});

test('fresh module instances share durable access and usage counters', async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    freeLimit: process.env.MRT_FREE_LIMIT
  };
  const previousFetch = globalThis.fetch;
  process.env.NODE_ENV = 'production';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.MRT_FREE_LIMIT = '2';
  const strings = new Map();
  const hashes = new Map();
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    let result = null;
    if (command[0] === 'GET') result = strings.get(command[1]) ?? null;
    if (command[0] === 'SET') {
      strings.set(command[1], String(command[2]));
      result = 'OK';
    }
    if (command[0] === 'DEL') {
      strings.delete(command[1]);
      result = 1;
    }
    if (command[0] === 'INCR') {
      result = Number(strings.get(command[1]) || 0) + 1;
      strings.set(command[1], String(result));
    }
    if (command[0] === 'EXPIRE') result = 1;
    if (command[0] === 'HMGET') {
      const value = hashes.get(command[1]) || {};
      result = command.slice(2).map((field) => value[field] ?? null);
    }
    if (command[0] === 'EVAL' && command[1].includes("HGET', KEYS[1], 'count")) {
      const key = command[3];
      const limit = Number(command[4]);
      const value = hashes.get(key) || {};
      const count = Number(value.count || 0);
      if (count >= limit) result = [0, String(count)];
      else {
        const next = count + 1;
        hashes.set(key, { count: String(next), plan: command[5], paid: '0' });
        result = [1, String(next)];
      }
    }
    return { ok: true, json: async () => ({ result }), text: async () => '' };
  };
  try {
    const accessA = await import(`../lib/access-rate-limit.js?instance=a-${Date.now()}`);
    const accessB = await import(`../lib/access-rate-limit.js?instance=b-${Date.now()}`);
    const req = { headers: { 'x-forwarded-for': '203.0.113.91' } };
    await Promise.all([
      accessA.recordAccessFailure(req),
      accessA.recordAccessFailure(req),
      accessB.recordAccessFailure(req),
      accessB.recordAccessFailure(req),
      accessB.recordAccessFailure(req)
    ]);
    assert.equal((await accessA.accessAttemptStatus(req)).allowed, false);

    const usageA = await import(`../lib/usage-store.js?instance=a-${Date.now()}`);
    const usageB = await import(`../lib/usage-store.js?instance=b-${Date.now()}`);
    assert.equal((await usageA.consumeResearchCredit('203.0.113.92')).allowed, true);
    assert.equal((await usageB.consumeResearchCredit('203.0.113.92')).allowed, true);
    assert.equal((await usageA.consumeResearchCredit('203.0.113.92')).allowed, false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      UPSTASH_REDIS_REST_URL: previous.url,
      UPSTASH_REDIS_REST_TOKEN: previous.token,
      MRT_FREE_LIMIT: previous.freeLimit
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('ordinary preview users cannot write global error memory', async () => {
  process.env.MRT_REVIEWER_TOKEN = 'reviewer-only-secret';
  const { default: research } = await import(`../api/research.js?ordinary-denial=${Date.now()}`);
  const denied = response();
  await research({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.93'
    },
    body: { mode: 'flag-error', condition: 'Condition', claim: 'Incorrect claim' }
  }, denied);
  assert.equal(denied.state.status, 403);
  assert.equal(denied.state.body.code, 'REVIEWER_AUTH_REQUIRED');
  delete process.env.MRT_REVIEWER_TOKEN;
});

test('authorized global writes and upgrades emit immutable audit events', () => {
  const source = `
    process.env.NODE_ENV = 'test';
    process.env.MRT_REVIEWER_TOKEN = 'reviewer-only-secret';
    process.env.MRT_PRO_CODES = 'purpose-scoped-upgrade';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const security = await import('./lib/security-enforcement.js');
    const { default: research } = await import('./api/research.js');
    const makeRes = () => ({
      statusCode: 200, body: null, headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      end() { return this; }
    });
    const flagged = makeRes();
    await research({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.95',
        'x-reviewer-token': 'reviewer-only-secret'
      },
      body: { mode: 'flag-error', condition: 'Condition', claim: 'Correction' }
    }, flagged);
    const upgraded = makeRes();
    await research({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mrt_access_session=user-session',
        'x-forwarded-for': '203.0.113.96'
      },
      body: { mode: 'activate-plan', code: 'purpose-scoped-upgrade' }
    }, upgraded);
    process.stdout.write(JSON.stringify({
      statuses: [flagged.statusCode, upgraded.statusCode],
      actions: security._auditEventsForTests().map((event) => event.action),
      immutable: security._auditEventsForTests().every(Object.isFrozen)
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  }));
  assert.deepEqual(result.statuses, [200, 200]);
  assert.deepEqual(result.actions, ['error-memory.write', 'upgrade.activate']);
  assert.equal(result.immutable, true);
});

test('upgrade guesses have per-user and IP attempt limits', () => {
  const source = `
    process.env.NODE_ENV = 'test';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const security = await import('./lib/security-enforcement.js');
    const req = {
      headers: {
        cookie: 'mrt_access_session=user-session',
        'x-forwarded-for': '203.0.113.94'
      }
    };
    const allowed = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      allowed.push((await security.reserveUpgradeAttempt(req)).allowed);
    }
    process.stdout.write(JSON.stringify(allowed));
  `;
  const allowed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  }));
  assert.deepEqual(allowed, [true, true, true, true, true, false]);
});
