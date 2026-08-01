import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  _resetBillableRequestsForTests,
  beginBillableRequest,
  completeBillableRequest,
  fingerprintBillableRequest
} from '../lib/billable-request-store.js';
import { normalizeEvidenceFanoutInput } from '../lib/evidence.js';
import {
  _resetProviderBudgetForTests,
  reconcileProviderBudget,
  reserveProviderBudget
} from '../lib/provider-budget.js';
import {
  buildCanonicalReportModel,
  REPORT_PATIENT_FIELD_POLICY
} from '../lib/report-model.js';

test.beforeEach(() => {
  _resetBillableRequestsForTests();
  _resetProviderBudgetForTests();
});

test('billable request reservation is atomic, conflict-safe, and replayable', async () => {
  const fingerprint = fingerprintBillableRequest({ mode: 'research', condition: 'Example' });
  const attempts = await Promise.all(Array.from({ length: 12 }, () =>
    beginBillableRequest({
      key: 'fixture-idempotency-key-123',
      scope: '203.0.113.10:research:all',
      fingerprint
    })
  ));
  assert.equal(attempts.filter(({ state }) => state === 'reserved').length, 1);
  assert.equal(attempts.filter(({ state }) => state === 'in-progress').length, 11);

  const reserved = attempts.find(({ state }) => state === 'reserved');
  assert.equal(await completeBillableRequest({
    ...reserved,
    fingerprint,
    status: 200,
    body: { ok: true, result: 'sealed' }
  }), true);
  assert.deepEqual(await beginBillableRequest({
    key: 'fixture-idempotency-key-123',
    scope: '203.0.113.10:research:all',
    fingerprint
  }), {
    state: 'replay',
    status: 200,
    body: { ok: true, result: 'sealed' }
  });
  assert.equal((await beginBillableRequest({
    key: 'fixture-idempotency-key-123',
    scope: '203.0.113.10:research:all',
    fingerprint: fingerprintBillableRequest({ mode: 'research', condition: 'Different' })
  })).state, 'conflict');
});

test('expired idempotency leases can retry and stale workers cannot commit', async () => {
  const fingerprint = fingerprintBillableRequest({ mode: 'research', condition: 'Lease' });
  const first = await beginBillableRequest({
    key: 'fixture-expiring-idempotency-key',
    scope: 'lease-scope',
    fingerprint,
    now: 1_000
  });
  const retry = await beginBillableRequest({
    key: 'fixture-expiring-idempotency-key',
    scope: 'lease-scope',
    fingerprint,
    now: 1_000 + 6 * 60 * 1000
  });
  assert.equal(first.state, 'reserved');
  assert.equal(retry.state, 'reserved');
  assert.notEqual(first.leaseToken, retry.leaseToken);
  assert.equal(await completeBillableRequest({
    ...first,
    fingerprint,
    status: 200,
    body: { stale: true },
    now: 1_000 + 6 * 60 * 1000
  }), false);
  assert.equal(await completeBillableRequest({
    ...retry,
    fingerprint,
    status: 200,
    body: { stale: false },
    now: 1_000 + 6 * 60 * 1000
  }), true);
});

test('daily and monthly monetary budgets reserve atomically and reconcile', async () => {
  const previousDaily = process.env.MRT_DAILY_PROVIDER_BUDGET_USD;
  const previousMonthly = process.env.MRT_MONTHLY_PROVIDER_BUDGET_USD;
  process.env.MRT_DAILY_PROVIDER_BUDGET_USD = '0.10';
  process.env.MRT_MONTHLY_PROVIDER_BUDGET_USD = '0.20';
  try {
    const attempts = await Promise.all(Array.from({ length: 10 }, () =>
      reserveProviderBudget({ estimatedUsd: 0.03, scope: 'fixture', now: Date.UTC(2026, 6, 19) })
    ));
    assert.equal(attempts.filter(({ allowed }) => allowed).length, 3);
    assert.ok(attempts.filter(({ allowed }) => !allowed).every(
      ({ code }) => code === 'PROVIDER_BUDGET_EXHAUSTED'
    ));
    const first = attempts.find(({ allowed }) => allowed);
    assert.equal(await reconcileProviderBudget({
      reservationId: first.reservationId,
      actualUsd: 0.01
    }), true);
    assert.equal((await reserveProviderBudget({
      estimatedUsd: 0.03,
      scope: 'after-reconcile',
      now: Date.UTC(2026, 6, 19)
    })).allowed, true);
  } finally {
    if (previousDaily === undefined) delete process.env.MRT_DAILY_PROVIDER_BUDGET_USD;
    else process.env.MRT_DAILY_PROVIDER_BUDGET_USD = previousDaily;
    if (previousMonthly === undefined) delete process.env.MRT_MONTHLY_PROVIDER_BUDGET_USD;
    else process.env.MRT_MONTHLY_PROVIDER_BUDGET_USD = previousMonthly;
  }
});

test('direct evidence arrays are normalized, deduplicated, and capped before fan-out', () => {
  const input = normalizeEvidenceFanoutInput({
    treatments: Array.from({ length: 20 }, (_, index) => `Treatment ${index}`),
    drugs: ['Drug A', 'drug a', ...Array.from({ length: 20 }, (_, index) => `Drug ${index}`)],
    manufacturers: Array.from({ length: 20 }, (_, index) => `Maker ${index}`),
    limitPerSource: 999
  });
  assert.equal(input.treatments.length, 8);
  assert.equal(input.drugs.length, 8);
  assert.equal(input.manufacturers.length, 6);
  // Clamped, not honoured verbatim. The bound was raised from 10 to 40: at 10
  // per source a condition with a very large literature (IPF) returned barely
  // a hundred papers in total, and the report implied that was all that
  // existed. What this test guards is that an absurd request is still bounded.
  assert.equal(input.limitPerSource, 40);
  assert.equal(input.drugs.filter((value) => value.toLowerCase() === 'drug a').length, 1);
  assert.deepEqual(normalizeEvidenceFanoutInput(), {
    treatments: [],
    drugs: [],
    manufacturers: [],
    limitPerSource: 25
  });
});

test('one canonical report model covers every patient field and all report surfaces', async () => {
  const patient = Object.fromEntries(
    Object.keys(REPORT_PATIENT_FIELD_POLICY).map((key) => [key, `${key}-value`])
  );
  const model = buildCanonicalReportModel({
    patient,
    researchText: 'Research',
    repurposeText: 'Repurpose',
    trialsText: 'Trials',
    treatments: [{ treatment: 'A' }],
    candidates: [{ candidate: 'B' }],
    combos: [{ combo: 'A + B' }],
    references: [{ url: 'https://example.test' }]
  });
  assert.deepEqual(model.patientFields.map(({ key }) => key), Object.keys(REPORT_PATIENT_FIELD_POLICY));
  assert.ok(model.patientFields.every(({ included, value, omissionReason }) =>
    included && value && omissionReason === null
  ));
  assert.equal(model.sections.researchText, 'Research');
  assert.equal(model.sections.repurposeText, 'Repurpose');
  assert.equal(model.sections.trialsText, 'Trials');

  const app = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  assert.match(app, /buildCanonicalReportModel/);
  assert.match(app, /buildFullReportBody\(\{ reportModel: props\.reportModel \}\)/);
  assert.match(app, /Profile fields not included because no value was provided/);
  assert.match(app, /X-Idempotency-Key/);
});
