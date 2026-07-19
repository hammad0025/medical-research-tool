import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import alertsHandler from '../api/alerts-subscribe.js';
import {
  _resetForTests,
  alertRetentionSeconds,
  createSubscription,
  getSubscription
} from '../lib/alerts-store.js';
import {
  RETENTION_SECONDS,
  SERVER_DATA_INVENTORY
} from '../lib/privacy-governance.js';
import {
  _resetErrorStoreForTests,
  getConditionErrors,
  recordConditionErrors
} from '../lib/error-store.js';
import {
  clearTermsConsent,
  establishTermsConsent,
  hasTermsConsent,
  TERMS_VERSION
} from '../lib/terms-consent.js';
import { buildAssuranceDataFlow } from '../scripts/assurance-data-flow.mjs';

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

const invokeAlerts = async ({ method = 'POST', query = {}, body = {} } = {}) => {
  const res = response();
  await alertsHandler({
    method,
    query,
    body,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' }
  }, res);
  return res.state;
};

test('data-flow inventory covers every sensitive repository store and processor class', async () => {
  const report = await buildAssuranceDataFlow();
  assert.match(report.scope, /not a legal certification/i);
  assert.deepEqual(
    report.stores.map(({ id }) => id).sort(),
    [
      'browser-alert-capabilities',
      'browser-chat',
      'browser-profile',
      'server-access-attempts',
      'server-alerts',
      'server-condition-refresh',
      'server-error-memory',
      'server-security-audit',
      'server-shared-knowledge',
      'server-transient-research',
      'server-usage',
      'terms-cookie'
    ]
  );
  assert.deepEqual(
    report.transfers.map(({ recipient }) => recipient).sort(),
    [
      'Anthropic',
      'Perplexity / OpenAI / xAI',
      'Resend',
      'Upstash',
      'public medical-data services'
    ]
  );
  for (const item of [...report.stores, ...report.transfers]) {
    assert.ok(item.evidence.path);
    assert.ok(Number.isInteger(item.evidence.line), `${item.id || item.recipient} has line evidence`);
  }
});

test('consent is version-bound, tamper-evident, expiring, and explicitly withdrawable', () => {
  const previousSecret = process.env.MRT_TERMS_SIGNING_SECRET;
  process.env.MRT_TERMS_SIGNING_SECRET = 'privacy-assurance-test-secret';
  try {
    const issued = response();
    assert.equal(establishTermsConsent(issued), true);
    const setCookie = issued.state.headers['Set-Cookie'];
    assert.match(setCookie, new RegExp(`mrt_terms_consent=${TERMS_VERSION}`));
    assert.match(setCookie, /Max-Age=\d+/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);

    const cookie = setCookie.split(';')[0];
    assert.equal(hasTermsConsent({ headers: { cookie } }), true);
    assert.equal(hasTermsConsent({ headers: { cookie: `${cookie}tampered` } }), false);

    const withdrawn = response();
    clearTermsConsent(withdrawn);
    assert.match(withdrawn.state.headers['Set-Cookie'], /Max-Age=0/);
  } finally {
    if (previousSecret === undefined) delete process.env.MRT_TERMS_SIGNING_SECRET;
    else process.env.MRT_TERMS_SIGNING_SECRET = previousSecret;
  }
});

test('client, server, and published Terms use one current consent version', async () => {
  const [client, terms] = await Promise.all([
    readFile(new URL('../src/app.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../docs/TERMS_OF_USE.md', import.meta.url), 'utf8')
  ]);
  assert.match(client, new RegExp(`const MRT_TERMS_VERSION = '${TERMS_VERSION}'`));
  assert.match(terms, /Last updated:\*\* July 18, 2026/);
  assert.match(terms, /A new version requires renewed acceptance/);
});

test('alert collection minimizes context and never returns private fields on list', async () => {
  _resetForTests();
  const created = await invokeAlerts({
    body: {
      email: 'Owner@Example.test',
      condition: 'Example condition',
      cadence: 'daily',
      patientContext: {
        age: '123456789012345',
        gender: 'female',
        stage: 'stage 2',
        diagnoses: 'd'.repeat(500),
        medications: 'm'.repeat(500),
        allergies: 'a'.repeat(300),
        notes: 'n'.repeat(500),
        name: 'must not persist',
        mrn: 'must not persist',
        address: 'must not persist'
      }
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.cadence, 'weekly');

  const stored = await getSubscription(created.body.id);
  assert.deepEqual(Object.keys(stored.patientContext).sort(), [
    'age', 'allergies', 'diagnoses', 'gender', 'medications', 'notes', 'stage'
  ]);
  assert.equal(stored.patientContext.age.length, 10);
  assert.equal(stored.patientContext.diagnoses.length, 400);
  assert.equal(stored.patientContext.allergies.length, 200);
  assert.equal(stored.patientContext.notes.length, 400);

  const listed = await invokeAlerts({
    method: 'GET',
    query: { email: 'owner@example.test', token: created.body.ownerToken }
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 1);
  assert.deepEqual(Object.keys(listed.body.subscriptions[0]).sort(), [
    'active', 'cadence', 'condition', 'createdAt', 'expiresAt', 'id', 'lastRunAt'
  ]);
  assert.doesNotMatch(JSON.stringify(listed.body), /owner@example|patientContext|Token|must not persist/i);
});

test('capability tokens prevent cross-user alert reads and deletion removes linked state', async () => {
  _resetForTests();
  const created = await invokeAlerts({
    body: { email: 'first@example.test', condition: 'Example condition' }
  });
  assert.equal(created.status, 201);

  const wrongRead = await invokeAlerts({
    method: 'GET',
    query: { email: 'first@example.test', token: 'attacker-token-is-long-enough' }
  });
  assert.equal(wrongRead.status, 403);
  assert.equal(wrongRead.body.code, 'OWNER_TOKEN_INVALID');

  const wrongExport = await invokeAlerts({
    method: 'GET',
    query: { action: 'export', id: created.body.id, token: 'attacker-token-is-long-enough' }
  });
  assert.equal(wrongExport.status, 403);

  const exported = await invokeAlerts({
    method: 'GET',
    query: { action: 'export', id: created.body.id, token: created.body.ownerToken }
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.subscription.email, 'first@example.test');
  assert.equal('ownerToken' in exported.body.subscription, false);
  assert.equal('unsubscribeToken' in exported.body.subscription, false);

  const wrongDelete = await invokeAlerts({
    query: { action: 'unsubscribe' },
    body: { id: created.body.id, token: 'attacker-token-is-long-enough' }
  });
  assert.equal(wrongDelete.status, 403);
  assert.ok(await getSubscription(created.body.id));

  const removed = await invokeAlerts({
    method: 'DELETE',
    body: { id: created.body.id, token: created.body.unsubscribeToken }
  });
  assert.equal(removed.status, 200);
  assert.equal(await getSubscription(created.body.id), null);
});

test('server inventory and retention contracts are complete and bounded', async () => {
  assert.equal(alertRetentionSeconds(), RETENTION_SECONDS.alerts);
  assert.deepEqual(
    SERVER_DATA_INVENTORY.map(({ id }) => id),
    [
      'access-attempt-enforcement',
      'on-demand-profile',
      'alert-subscription',
      'usage-enforcement',
      'condition-error-memory',
      'security-audit',
      'condition-refresh-queue',
      'shared-knowledge-cache'
    ]
  );
  const inventory = await invokeAlerts({ method: 'GET', query: { action: 'inventory' } });
  assert.equal(inventory.status, 200);
  assert.match(inventory.body.scope, /not a legal compliance certification/i);
  assert.equal(inventory.body.serverData.length, SERVER_DATA_INVENTORY.length);
  assert.ok(inventory.body.externalProviderLimitations.length >= 3);

  _resetForTests();
  await createSubscription({
    id: 'expired-subscription',
    email: 'expired@example.test',
    condition: 'Example',
    createdAt: new Date(Date.now() - 2_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString()
  });
  assert.equal(await getSubscription('expired-subscription'), null);

  _resetErrorStoreForTests();
  await recordConditionErrors('Example', {
    source: 'validator',
    type: 'unsupported',
    claim: 'Expired operational correction',
    ts: Date.now() - (RETENTION_SECONDS.errorMemory + 1) * 1000
  });
  assert.deepEqual(await getConditionErrors('Example'), []);
});

test('user-facing local erase enumerates every sensitive browser key and resets state', async () => {
  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  for (const key of [
    'mrt_patient',
    'mrt_audience',
    'mrt_hipaa',
    'mrt_floating_chat_v1',
    'mra-alerts-email',
    'mra-alerts-owner-tokens',
    'mrt-theme-mode'
  ]) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(source, /localStorage\.removeItem\(key\)/);
  assert.match(source, />\s*Erase local data\s*</);
  assert.match(source, /setPatient\(\{ \.\.\.EMPTY_PATIENT_PROFILE \}\)/);
  assert.match(source, /setFloatingChatHistory\(\[\]\)/);
});

test('retention, deletion, export, redaction, and disclosure controls pass repository contracts', async () => {
  const report = await buildAssuranceDataFlow();
  const byId = Object.fromEntries(report.controls.map((control) => [control.id, control]));
  assert.equal(byId['local-retention-deletion'].status, 'pass');
  assert.equal(byId['server-retention'].status, 'pass');
  assert.equal(byId.deletion.status, 'pass');
  assert.equal(byId['data-export'].status, 'pass');
  assert.equal(byId['log-error-redaction'].status, 'pass');
  assert.equal(byId['third-party-disclosure'].status, 'pass');
  assert.equal(byId['cross-user-access'].status, 'pass');
  for (const id of [
    'local-retention-deletion',
    'server-retention',
    'deletion',
    'data-export',
    'log-error-redaction',
    'third-party-disclosure',
    'cross-user-access'
  ]) {
    assert.ok(byId[id].evidence.every(({ path, line }) => path && Number.isInteger(line)), id);
  }
});
