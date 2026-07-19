import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { approvedUpgradeUrl } from '../lib/upgrade-url.js';

const root = new URL('..', import.meta.url);
const isolated = (source) => JSON.parse(execFileSync(
  process.execPath,
  ['--input-type=module', '--eval', source],
  { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', VERCEL_ENV: '' } }
));

test('upgrade links accept only normalized absolute https URLs on server and client', async () => {
  assert.equal(approvedUpgradeUrl('https://buy.example.test/checkout?id=1'), 'https://buy.example.test/checkout?id=1');
  for (const unsafe of [
    'javascript:alert(1)',
    'java%73cript:alert(1)',
    'data:text/html,unsafe',
    '//buy.example.test/checkout',
    '/relative-checkout',
    'https://user:pass@buy.example.test/',
    'https://buy.example.test/%0aalert',
    'https://buy.example.test/\nalert',
    '\u0000https://buy.example.test/'
  ]) {
    assert.equal(approvedUpgradeUrl(unsafe), null, unsafe);
  }

  const [server, client] = await Promise.all([
    readFile(new URL('../api/research.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.jsx', import.meta.url), 'utf8')
  ]);
  assert.match(server, /upgradeUrl: approvedUpgradeUrl\(process\.env\.MRT_UPGRADE_URL\)/);
  assert.match(client, /const upgradeUrl = approvedUpgradeUrl\(runtimeConfig\?\.monetization\?\.upgradeUrl\)/);
  assert.match(client, /<a href=\{upgradeUrl\}/);
});

test('malformed percent-encoded access and Terms cookies fail closed without throwing', () => {
  const result = isolated(`
    process.env.MRT_ACCESS_PASSCODE = 'cookie-test-passcode';
    process.env.MRT_TERMS_SIGNING_SECRET = 'cookie-test-terms-secret';
    const gate = await import('./lib/access-gate.js');
    const terms = await import('./lib/terms-consent.js');
    const response = () => ({
      statusCode: 200, body: null,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    });
    const res = response();
    const allowed = gate.requireAccess({
      method: 'GET',
      headers: { cookie: 'mrt_access_session=%E0%A4%A; other=ok' }
    }, res);
    const consent = terms.hasTermsConsent({
      headers: { cookie: 'mrt_terms_consent=%; other=ok' }
    });
    process.stdout.write(JSON.stringify({ allowed, status: res.statusCode, consent }));
  `);
  assert.deepEqual(result, { allowed: false, status: 401, consent: false });
});

test('quota rejection precedes provider reservation and consumes no additional credit', () => {
  const result = isolated(`
    process.env.MRT_DISABLE_USAGE_LIMIT = '0';
    process.env.MRT_FREE_LIMIT = '1';
    process.env.MRT_DAILY_PROVIDER_BUDGET_USD = '0.03';
    process.env.MRT_MONTHLY_PROVIDER_BUDGET_USD = '0.03';
    process.env.MRT_SPEND_ENABLED = '1';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const usage = await import('./lib/usage-store.js');
    const budget = await import('./lib/provider-budget.js');
    const { asInternalReq } = await import('./lib/internal-call.js');
    const handler = (await import('./api/research.js')).default;
    usage._resetForTests();
    budget._resetProviderBudgetForTests();
    await usage.consumeResearchCredit('203.0.113.90');
    const state = { status: 200, body: null, headers: new Map() };
    const res = {
      setHeader(k, v) { state.headers.set(String(k).toLowerCase(), v); },
      getHeader(k) { return state.headers.get(String(k).toLowerCase()); },
      status(code) { state.status = code; return this; },
      json(body) { state.body = body; return this; },
      end() { return this; }
    };
    await handler(asInternalReq({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'quota-order-fixture-0001',
        'x-real-ip': '203.0.113.90'
      },
      body: { mode: 'chat', userQuery: 'offline quota check' },
      query: {},
      socket: { remoteAddress: '203.0.113.90' }
    }), res);
    const after = await usage.getUsage('203.0.113.90');
    const available = await budget.reserveProviderBudget({
      estimatedUsd: 0.03,
      scope: 'after-quota-rejection',
      now: Date.UTC(2026, 6, 19)
    });
    process.stdout.write(JSON.stringify({
      status: state.status,
      code: state.body?.code,
      used: after.used,
      providerBudgetAvailable: available.allowed
    }));
  `);
  assert.deepEqual(result, {
    status: 402,
    code: 'USAGE_LIMIT_REACHED',
    used: 1,
    providerBudgetAvailable: true
  });
});

test('rate-limited upgrade requests consume neither usage credit nor provider budget', () => {
  const result = isolated(`
    process.env.MRT_DISABLE_USAGE_LIMIT = '0';
    process.env.MRT_FREE_LIMIT = '2';
    process.env.MRT_DAILY_PROVIDER_BUDGET_USD = '0.03';
    process.env.MRT_MONTHLY_PROVIDER_BUDGET_USD = '0.03';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const usage = await import('./lib/usage-store.js');
    const budget = await import('./lib/provider-budget.js');
    const security = await import('./lib/security-enforcement.js');
    const { asInternalReq } = await import('./lib/internal-call.js');
    const handler = (await import('./api/research.js')).default;
    usage._resetForTests();
    budget._resetProviderBudgetForTests();
    security._resetSecurityEnforcementForTests();
    const statuses = [];
    for (let index = 0; index <= security.privilegedSecurityConfig.maxUpgradeAttempts; index += 1) {
      const state = { status: 200, body: null, headers: new Map() };
      const res = {
        setHeader(k, v) { state.headers.set(String(k).toLowerCase(), v); },
        getHeader(k) { return state.headers.get(String(k).toLowerCase()); },
        status(code) { state.status = code; return this; },
        json(body) { state.body = body; return this; },
        end() { return this; }
      };
      await handler(asInternalReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.91' },
        body: { mode: 'activate-plan', code: 'invalid-upgrade-code' },
        query: {},
        socket: { remoteAddress: '203.0.113.91' }
      }), res);
      statuses.push(state.status);
    }
    const after = await usage.getUsage('203.0.113.91');
    const available = await budget.reserveProviderBudget({
      estimatedUsd: 0.03,
      scope: 'after-rate-limit',
      now: Date.UTC(2026, 6, 19)
    });
    process.stdout.write(JSON.stringify({
      finalStatus: statuses.at(-1),
      used: after.used,
      providerBudgetAvailable: available.allowed
    }));
  `);
  assert.deepEqual(result, {
    finalStatus: 429,
    used: 0,
    providerBudgetAvailable: true
  });
});

test('release preflight requires the dedicated report seal and smoke checks its safe contract', async () => {
  const env = {
    ...process.env,
    MRT_BASE_URL: 'https://offline.example.test',
    MRT_EXPECTED_SHA: 'a'.repeat(40),
    MRT_ACCESS_PASSCODE: 'offline-access',
    MRT_REVIEWER_TOKEN: 'offline-reviewer',
    CRON_SECRET: 'offline-cron',
    UPSTASH_REDIS_REST_URL: 'https://redis.offline.example.test',
    UPSTASH_REDIS_REST_TOKEN: 'offline-redis'
  };
  delete env.MRT_REPORT_SEAL_SECRET;
  const missing = spawnSync(process.execPath, ['scripts/validate-release-config.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /MRT_REPORT_SEAL_SECRET is required/);

  const present = spawnSync(process.execPath, ['scripts/validate-release-config.mjs'], {
    cwd: root,
    env: { ...env, MRT_REPORT_SEAL_SECRET: 'offline-dedicated-report-secret' },
    encoding: 'utf8'
  });
  assert.equal(present.status, 0, present.stderr);
  assert.doesNotMatch(`${present.stdout}${present.stderr}`, /offline-dedicated-report-secret/);

  const smoke = await readFile(new URL('../scripts/postdeploy-smoke.mjs', import.meta.url), 'utf8');
  assert.match(smoke, /request\('\/api\/report-completion'/);
  assert.match(smoke, /response\.status !== 409/);
  assert.match(smoke, /body\?\.contract\?\.eligible !== false/);
});
