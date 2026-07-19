import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatherSeal, verifyGatherSeal } from '../lib/gather-seal.js';
import {
  REPORT_SEAL_PURPOSE,
  REPORT_SEAL_TTL_MS,
  sealReportCompletion,
  verifyReportCompletionSeal
} from '../lib/report-completion.js';

const response = () => {
  const state = { status: 200, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) { state.headers[name] = value; },
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return this; }
  };
};

test('gather seal rejects payload tampering, wrong keys, future issuance, and expiry', () => {
  const input = {
    gatherFingerprint: 'condition=ipf|age=64',
    dossier: { canonical: 'Idiopathic pulmonary fibrosis' },
    evidence: { groundedForPrompt: [{ id: 'PMID:1' }], topRanked: [] },
    trials: { studies: [{ nctId: 'NCT00000001' }] },
    now: 1_700_000_000_000,
    secret: 'gather-key-version-2'
  };
  const seal = createGatherSeal(input);
  assert.equal(verifyGatherSeal({ ...input, seal, now: input.now + 1 }).ok, true);
  assert.equal(verifyGatherSeal({
    ...input,
    evidence: { groundedForPrompt: [{ id: 'forged' }], topRanked: [] },
    seal,
    now: input.now + 1
  }).code, 'GATHER_SEAL_INVALID');
  assert.equal(verifyGatherSeal({
    ...input,
    secret: 'rotated-gather-key',
    seal,
    now: input.now + 1
  }).code, 'GATHER_SEAL_INVALID');
  assert.equal(verifyGatherSeal({
    ...input,
    seal,
    now: input.now - 61_000
  }).code, 'GATHER_SEAL_EXPIRED');
  assert.equal(verifyGatherSeal({
    ...input,
    seal,
    now: input.now + 30 * 60 * 1000 + 1
  }).code, 'GATHER_SEAL_EXPIRED');
});

test('gather seal replay is currently accepted throughout its TTL', () => {
  const input = {
    gatherFingerprint: 'condition=ipf',
    dossier: { canonical: 'IPF' },
    evidence: { groundedForPrompt: [], topRanked: [] },
    trials: { studies: [] },
    now: 1_700_000_000_000,
    secret: 'gather-replay-test-key'
  };
  const seal = createGatherSeal(input);
  const first = verifyGatherSeal({ ...input, seal, now: input.now + 1_000 });
  const replay = verifyGatherSeal({ ...input, seal, now: input.now + 2_000 });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true, 'documents missing one-time nonce/replay storage');
});

test('access sessions reject tampering and old-key rotation but remain replayable until expiry', async () => {
  const previousNode = process.env.NODE_ENV;
  const previousPasscode = process.env.MRT_ACCESS_PASSCODE;
  const realNow = Date.now;
  try {
    process.env.NODE_ENV = 'production';
    process.env.MRT_ACCESS_PASSCODE = 'access-key-version-one';
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const gate = await import(`../lib/access-gate.js?crypto-session=${process.pid}-${now}`);
    const issued = response();
    assert.equal(gate.establishAccessSession('access-key-version-one', issued), true);
    const cookie = issued.state.headers['Set-Cookie'].split(';')[0];

    assert.equal(gate.requireAccess({ method: 'GET', headers: { cookie } }, response()), true);
    assert.equal(gate.requireAccess({ method: 'GET', headers: { cookie } }, response()), true);

    const [name, encoded] = cookie.split('=');
    const token = decodeURIComponent(encoded);
    const tampered = `${name}=${encodeURIComponent(`${token.slice(0, -1)}x`)}`;
    assert.equal(gate.requireAccess({ method: 'GET', headers: { cookie: tampered } }, response()), false);

    process.env.MRT_ACCESS_PASSCODE = 'access-key-version-two';
    const rotated = await import(`../lib/access-gate.js?crypto-rotation=${process.pid}-${now}`);
    assert.equal(rotated.requireAccess({ method: 'GET', headers: { cookie } }, response()), false);

    now += 8 * 60 * 60 * 1000 + 1;
    assert.equal(gate.requireAccess({ method: 'GET', headers: { cookie } }, response()), false);
  } finally {
    Date.now = realNow;
    if (previousNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNode;
    if (previousPasscode === undefined) delete process.env.MRT_ACCESS_PASSCODE;
    else process.env.MRT_ACCESS_PASSCODE = previousPasscode;
  }
});

test('report seals verify across cold starts and reject tampering or wrong purposes', async () => {
  const previous = process.env.MRT_REPORT_SEAL_SECRET;
  try {
    process.env.MRT_REPORT_SEAL_SECRET = 'dedicated-report-key';
    const contract = { version: '1', eligible: true, profileKey: 'profile-1' };
    const now = 1_700_000_000_000;
    const seal = sealReportCompletion(contract, { now });
    assert.match(seal, /^1\.\d+\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(verifyReportCompletionSeal({ contract, seal, now: now + 1 }).ok, true);
    assert.equal(verifyReportCompletionSeal({
      contract: { ...contract, eligible: false },
      seal,
      now: now + 1
    }).code, 'REPORT_SEAL_INVALID');
    const forgedSeal = `${seal.slice(0, -1)}${seal.endsWith('x') ? 'y' : 'x'}`;
    assert.equal(verifyReportCompletionSeal({
      contract,
      seal: forgedSeal,
      now: now + 1
    }).code, 'REPORT_SEAL_INVALID');
    assert.equal(verifyReportCompletionSeal({
      contract,
      seal,
      purpose: 'report-completion.preview',
      now: now + 1
    }).code, 'REPORT_SEAL_INVALID');

    const coldStart = await import(`../lib/report-completion.js?cold-start=${process.pid}-${now}`);
    assert.equal(coldStart.verifyReportCompletionSeal({
      contract,
      seal,
      purpose: REPORT_SEAL_PURPOSE,
      now: now + 1
    }).ok, true);
  } finally {
    if (previous === undefined) delete process.env.MRT_REPORT_SEAL_SECRET;
    else process.env.MRT_REPORT_SEAL_SECRET = previous;
  }
});

test('report-seal replay is bounded by expiry and independent issuance uses nonces', () => {
  const contract = { version: '1', eligible: true, profileKey: 'profile-1' };
  const now = 1_700_000_000_000;
  const secret = 'dedicated-report-replay-key';
  const first = sealReportCompletion(contract, { now, secret });
  const independentlyIssued = sealReportCompletion(contract, { now, secret });
  assert.notEqual(first, independentlyIssued);
  assert.equal(verifyReportCompletionSeal({
    contract,
    seal: first,
    now: now + 1,
    secret
  }).ok, true);
  assert.equal(verifyReportCompletionSeal({
    contract,
    seal: first,
    now: now + REPORT_SEAL_TTL_MS,
    secret
  }).ok, true);
  assert.equal(verifyReportCompletionSeal({
    contract,
    seal: first,
    now: now + REPORT_SEAL_TTL_MS + 1,
    secret
  }).code, 'REPORT_SEAL_EXPIRED');
});

test('report sealing fails closed without its dedicated secret outside local/test mode', async () => {
  const previous = {
    node: process.env.NODE_ENV,
    vercel: process.env.VERCEL_ENV,
    report: process.env.MRT_REPORT_SEAL_SECRET,
    terms: process.env.MRT_TERMS_SIGNING_SECRET,
    access: process.env.MRT_ACCESS_PASSCODE
  };
  try {
    process.env.NODE_ENV = 'test';
    process.env.VERCEL_ENV = 'preview';
    delete process.env.MRT_REPORT_SEAL_SECRET;
    process.env.MRT_TERMS_SIGNING_SECRET = 'must-not-sign-reports';
    process.env.MRT_ACCESS_PASSCODE = 'must-not-sign-reports-either';
    const fresh = await import(`../lib/report-completion.js?missing-secret=${process.pid}`);
    assert.throws(
      () => fresh.sealReportCompletion({ eligible: true }),
      (error) => error?.code === 'REPORT_SEAL_CONFIG'
    );
    assert.deepEqual(
      fresh.verifyReportCompletionSeal({ contract: {}, seal: 'invalid' }),
      { ok: false, code: 'REPORT_SEAL_CONFIG' }
    );
    const { INTERNAL_CALL } = await import('../lib/internal-call.js');
    const handler = (await import(`../api/report-completion.js?missing-secret=${process.pid}`)).default;
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: {},
      [INTERNAL_CALL]: true
    }, res);
    assert.equal(res.state.status, 503);
    assert.equal(res.state.body.code, 'REPORT_SEAL_CONFIG');
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: previous.node,
      VERCEL_ENV: previous.vercel,
      MRT_REPORT_SEAL_SECRET: previous.report,
      MRT_TERMS_SIGNING_SECRET: previous.terms,
      MRT_ACCESS_PASSCODE: previous.access
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
