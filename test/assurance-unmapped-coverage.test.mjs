import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import accessSession from '../api/access-session.js';
import brainCron from '../api/brain-cron.js';
import demoReadiness from '../api/demo-readiness.js';
import privateStatic from '../api/private-static.js';
import termsConsent from '../api/terms-consent.js';
import { runBrainRefreshBatch } from '../lib/brain-refresh.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import diseaseDossier from '../lib/disease-dossier.js';
import europePmc from '../lib/europe-pmc.js';
import evidence from '../lib/evidence.js';
import kb from '../lib/kb.js';
import openalex from '../lib/openalex.js';
import openfda from '../lib/openfda.js';
import pubmed from '../lib/pubmed.js';
import unpaywall from '../lib/unpaywall.js';
import validate from '../lib/validate.js';

const response = () => {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
};

const hostileRequest = (method = 'OPTIONS') => ({
  method,
  headers: { host: 'app.test', origin: 'https://evil.test' },
  query: {},
  body: {}
});

test('previously unmapped routes reject hostile origins or private access', async () => {
  for (const handler of [accessSession, brainCron, demoReadiness, termsConsent]) {
    const res = response();
    await handler(hostileRequest(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'ORIGIN_BLOCKED');
  }
  const hidden = response();
  privateStatic(hostileRequest('GET'), hidden);
  assert.equal(hidden.statusCode, 404);
});

test('internal HTTP-compatible handlers reject wildcard cross-origin access', async () => {
  for (const handler of [
    diseaseDossier,
    europePmc,
    evidence,
    kb,
    openalex,
    openfda,
    pubmed,
    unpaywall,
    validate
  ]) {
    const res = response();
    await handler(hostileRequest(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'ORIGIN_BLOCKED');
    assert.notEqual(res.getHeader('access-control-allow-origin'), '*');
  }
});

test('brain refresh empty batches are deterministic and side-effect free', async () => {
  assert.deepEqual(await runBrainRefreshBatch([]), []);
});

test('terms page is a real production document', async () => {
  const html = await readFile(new URL('../terms.html', import.meta.url), 'utf8');
  assert.match(html, /Terms of Use/i);
  assert.match(html, /not medical advice/i);
});

test('request boundary rejects oversized, deeply nested, and non-object bodies', () => {
  const oversized = response();
  assert.equal(requireJsonObjectBody({
    headers: { 'content-type': 'application/json', 'content-length': '5000' },
    body: { passcode: 'x' }
  }, oversized, { maxBytes: 1024 }), null);
  assert.equal(oversized.statusCode, 413);

  const arrayBody = response();
  assert.equal(requireJsonObjectBody({
    headers: { 'content-type': 'application/json' },
    body: []
  }, arrayBody), null);
  assert.equal(arrayBody.statusCode, 400);

  for (const body of [
    { values: Array.from({ length: 4 }, () => 'x') },
    { nested: { deeper: { value: true } } },
    { text: 'x'.repeat(64) }
  ]) {
    const bounded = response();
    assert.equal(requireJsonObjectBody(
      { headers: { 'content-type': 'application/json' }, body },
      bounded,
      { maxArrayItems: 3, maxDepth: 2, maxStringBytes: 32 }
    ), null);
    assert.equal(bounded.statusCode, 413);
    assert.equal(bounded.body.code, 'REQUEST_BODY_TOO_LARGE');
  }
});

test('request boundary enforces JSON media type before strict parsing', () => {
  for (const value of [
    'application/json',
    'application/json;charset=utf-8',
    'Application/JSON; Charset="UTF-8"'
  ]) {
    const res = response();
    assert.deepEqual(requireJsonObjectBody({
      headers: { 'content-type': value },
      body: '{"ok":true}'
    }, res), { ok: true });
  }

  for (const value of [
    undefined,
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/problem+json',
    'application/json; charset=iso-8859-1',
    'application/json; boundary=unsafe'
  ]) {
    const res = response();
    const headers = value ? { 'content-type': value } : {};
    assert.equal(requireJsonObjectBody({ headers, body: '{"ok":true}' }, res), null);
    assert.equal(res.statusCode, 415);
    assert.equal(res.body.code, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const duplicate = response();
  assert.equal(requireJsonObjectBody({
    headers: { 'content-type': 'application/json' },
    body: '{"patient":{"age":40,"age":41}}'
  }, duplicate), null);
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.body.code, 'DUPLICATE_JSON_KEY');
});
