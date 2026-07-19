import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accessAttemptStatus,
  clearAccessFailures,
  recordAccessFailure
} from '../lib/access-rate-limit.js';
import { isAllowedRequestOrigin, setSameOriginCors } from '../lib/cors.js';
import {
  establishTermsConsent,
  hasTermsConsent,
  requireTermsConsent,
  TERMS_VERSION
} from '../lib/terms-consent.js';

const reqForIp = (ip) => ({ headers: { 'x-forwarded-for': ip } });

test('access failures are blocked after five attempts and clear after success', async () => {
  const req = reqForIp('203.0.113.44');
  await clearAccessFailures(req);
  for (let i = 0; i < 5; i++) await recordAccessFailure(req);
  assert.equal((await accessAttemptStatus(req)).allowed, false);
  await clearAccessFailures(req);
  assert.equal((await accessAttemptStatus(req)).allowed, true);
});

test('CORS accepts same-origin requests and rejects foreign origins', () => {
  const same = { headers: { host: 'private.example', origin: 'https://private.example' } };
  const foreign = { headers: { host: 'private.example', origin: 'https://attacker.example' } };
  assert.equal(isAllowedRequestOrigin(same), true);
  assert.equal(isAllowedRequestOrigin(foreign), false);

  const headers = new Map();
  const res = { setHeader: (name, value) => headers.set(name, value) };
  assert.equal(setSameOriginCors(same, res), true);
  assert.equal(headers.get('Access-Control-Allow-Origin'), 'https://private.example');
  assert.notEqual(headers.get('Access-Control-Allow-Origin'), '*');
});

test('production API access requires a current server-signed Terms cookie', () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    passcode: process.env.MRT_ACCESS_PASSCODE,
    secret: process.env.MRT_TERMS_SIGNING_SECRET
  };
  process.env.NODE_ENV = 'production';
  process.env.MRT_ACCESS_PASSCODE = 'test-access-passcode';
  process.env.MRT_TERMS_SIGNING_SECRET = 'test-terms-signing-secret';
  try {
    const blocked = {
      statusCode: null,
      body: null,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    assert.equal(requireTermsConsent({ method: 'POST', headers: {} }, blocked), false);
    assert.equal(blocked.statusCode, 428);
    assert.equal(blocked.body.code, 'TERMS_ACCEPTANCE_REQUIRED');
    assert.equal(blocked.body.termsVersion, TERMS_VERSION);

    const issued = new Map();
    assert.equal(establishTermsConsent({ setHeader: (name, value) => issued.set(name, value) }), true);
    const cookie = issued.get('Set-Cookie').split(';')[0];
    assert.equal(hasTermsConsent({ headers: { cookie } }), true);
    assert.equal(hasTermsConsent({ headers: { cookie: `${cookie}tampered` } }), false);
  } finally {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NODE_ENV', previous.nodeEnv);
    restore('MRT_ACCESS_PASSCODE', previous.passcode);
    restore('MRT_TERMS_SIGNING_SECRET', previous.secret);
  }
});
