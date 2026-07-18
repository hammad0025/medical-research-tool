#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createGatherSeal,
  verifyGatherSeal
} from '../lib/gather-seal.js';
import {
  assertSafeProbeUrl,
  isPrivateAddress,
  probeUrl
} from '../lib/link-check.js';
import { authorizeCron } from '../lib/cron-auth.js';
import { validateVerdictSchema } from '../lib/validate.js';

const root = new URL('../', import.meta.url);
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`\x1b[32m✓\x1b[0m ${name}`);
};

const response = () => {
  const state = { status: 200, body: null, headers: {} };
  return {
    state,
    setHeader(key, value) { state.headers[key] = value; },
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return this; },
    end() { return this; }
  };
};

await test('production access gate fails closed when unconfigured', async () => {
  const oldNode = process.env.NODE_ENV;
  const oldPass = process.env.MRT_ACCESS_PASSCODE;
  process.env.NODE_ENV = 'production';
  delete process.env.MRT_ACCESS_PASSCODE;
  const gate = await import(`../lib/access-gate.js?missing=${Date.now()}`);
  const res = response();
  assert.equal(gate.requireAccess({ method: 'GET', headers: {} }, res), false);
  assert.equal(res.state.status, 503);
  assert.equal(res.state.body.code, 'ACCESS_GATE_MISCONFIGURED');
  if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
  if (oldPass === undefined) delete process.env.MRT_ACCESS_PASSCODE; else process.env.MRT_ACCESS_PASSCODE = oldPass;
});

await test('access passcode is accepted only from its header', async () => {
  const oldNode = process.env.NODE_ENV;
  const oldPass = process.env.MRT_ACCESS_PASSCODE;
  process.env.NODE_ENV = 'production';
  process.env.MRT_ACCESS_PASSCODE = 'correct horse';
  const gate = await import(`../lib/access-gate.js?configured=${Date.now()}`);
  const bodyRes = response();
  assert.equal(gate.requireAccess({
    method: 'POST', headers: {}, body: { accessPasscode: 'correct horse' }
  }, bodyRes), false);
  assert.equal(bodyRes.state.status, 401);
  assert.equal(gate.requireAccess({
    method: 'POST', headers: { 'x-access-passcode': 'correct horse' }
  }, response()), true);
  if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
  if (oldPass === undefined) delete process.env.MRT_ACCESS_PASSCODE; else process.env.MRT_ACCESS_PASSCODE = oldPass;
});

await test('passcode exchange creates an HttpOnly session without browser storage', async () => {
  const oldNode = process.env.NODE_ENV;
  const oldPass = process.env.MRT_ACCESS_PASSCODE;
  process.env.NODE_ENV = 'production';
  process.env.MRT_ACCESS_PASSCODE = 'session-only-passcode';
  const gate = await import(`../lib/access-gate.js?session=${Date.now()}`);
  const issued = response();
  assert.equal(gate.establishAccessSession('session-only-passcode', issued), true);
  const setCookie = issued.state.headers['Set-Cookie'];
  assert.match(setCookie, /^mrt_access_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /session-only-passcode/);
  const cookie = setCookie.split(';')[0];
  assert.equal(gate.requireAccess({
    method: 'POST', headers: { cookie }
  }, response()), true);
  const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(indexSource, /mrt_access_passcode_v1|localStorage\.setItem\([^)]*passcode/i);
  if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
  if (oldPass === undefined) delete process.env.MRT_ACCESS_PASSCODE; else process.env.MRT_ACCESS_PASSCODE = oldPass;
});

await test('cron authorization fails closed and rejects query secrets', () => {
  assert.deepEqual(authorizeCron({ headers: {}, query: {} }, ''), {
    ok: false, code: 'CRON_SECRET_MISCONFIGURED', status: 503
  });
  assert.equal(authorizeCron({ headers: {}, query: { secret: 'cron-key' } }, 'cron-key').ok, false);
  assert.equal(authorizeCron({
    headers: { authorization: 'Bearer cron-key' }, query: {}
  }, 'cron-key').ok, true);
});

await test('gather seals reject tampering, expiry, and invalid pool shapes', () => {
  const base = {
    gatherFingerprint: 'ipf|female|moderate|64',
    dossier: { canonical: 'Idiopathic pulmonary fibrosis' },
    evidence: { groundedForPrompt: [{ id: 'PMID:1', title: 'Study' }], topRanked: [] },
    trials: { studies: [{ nctId: 'NCT00000001' }] },
    now: 1_700_000_000_000,
    secret: 'test-seal-secret'
  };
  const seal = createGatherSeal(base);
  assert.equal(verifyGatherSeal({ ...base, seal, now: base.now + 1_000 }).ok, true);
  assert.equal(verifyGatherSeal({
    ...base,
    seal,
    evidence: { ...base.evidence, groundedForPrompt: [{ id: 'forged' }] },
    now: base.now + 1_000
  }).code, 'GATHER_SEAL_INVALID');
  assert.equal(verifyGatherSeal({ ...base, seal, now: base.now + 31 * 60 * 1000 }).code, 'GATHER_SEAL_EXPIRED');
  assert.equal(verifyGatherSeal({ ...base, seal, trials: { studies: 'bad' } }).code, 'GATHER_POOL_INVALID');
});

await test('SSRF guard blocks private IPs and private redirect targets', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('::1'), true);
  await assert.rejects(() => assertSafeProbeUrl('http://127.0.0.1/admin'));
  let fetches = 0;
  const result = await probeUrl('https://public.example/start', 1000, {
    resolver: async (host) => host === 'public.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => {
      fetches += 1;
      return {
        status: 302,
        headers: { get: () => 'http://127.0.0.1/internal' }
      };
    }
  });
  assert.equal(result.dead, true);
  assert.equal(fetches, 2); // HEAD then GET confirmation; neither follows the private hop.
});

await test('validator accepts only the closed verdict schema', () => {
  const valid = {
    overallScore: 90,
    agreement: 'high',
    confirmed: [{ claim: 'c', evidenceRef: 'PMID:1' }],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'Grounded.'
  };
  assert.equal(validateVerdictSchema(valid)?.agreement, 'high');
  assert.equal(validateVerdictSchema({ ...valid, agreement: 'maybe' }), null);
  assert.equal(validateVerdictSchema({
    ...valid,
    hallucinatedCitations: [{ url: 'file:///etc/passwd', issue: 'bad' }]
  }), null);
});

await test('subscription listing requires a matching ownership token', async () => {
  const oldNode = process.env.NODE_ENV;
  const oldPass = process.env.MRT_ACCESS_PASSCODE;
  process.env.NODE_ENV = 'test';
  process.env.MRT_ACCESS_PASSCODE = 'test-access';
  const { default: alerts } = await import(`../api/alerts-subscribe.js?test=${Date.now()}`);
  const auth = { 'x-access-passcode': 'test-access' };
  const created = response();
  await alerts({
    method: 'POST', headers: auth, query: {},
    body: { email: 'owner@example.com', condition: 'IPF', patientContext: { medications: 'nintedanib' } }
  }, created);
  assert.equal(created.state.status, 201);
  const denied = response();
  await alerts({
    method: 'GET', headers: auth, query: { email: 'owner@example.com' }
  }, denied);
  assert.equal(denied.state.status, 403);
  const listed = response();
  await alerts({
    method: 'GET', headers: auth,
    query: { email: 'owner@example.com', token: created.state.body.ownerToken }
  }, listed);
  assert.equal(listed.state.status, 200);
  assert.equal(listed.state.body.subscriptions.length, 1);
  assert.equal('patientContext' in listed.state.body.subscriptions[0], false);
  assert.equal('email' in listed.state.body.subscriptions[0], false);
  if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
  if (oldPass === undefined) delete process.env.MRT_ACCESS_PASSCODE; else process.env.MRT_ACCESS_PASSCODE = oldPass;
});

await test('deployment config denies private paths and sets security/cache headers', async () => {
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  const destinations = new Map(config.rewrites.map((r) => [r.source, r.destination]));
  for (const source of ['/lib/:path*', '/data/:path*', '/docs/:path*', '/.verify-runs/:path*']) {
    assert.equal(destinations.get(source), '/api/private-static');
  }
  const allHeaders = config.headers.find((h) => h.source === '/(.*)').headers;
  const csp = allHeaders.find((h) => h.key === 'Content-Security-Policy')?.value || '';
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const apiHeaders = config.headers.find((h) => h.source === '/api/(.*)').headers;
  assert.match(apiHeaders.find((h) => h.key === 'Cache-Control').value, /no-store/);
  const ignored = await readFile(new URL('.vercelignore', root), 'utf8');
  for (const path of ['.cursor', '.verify-runs', '.verify-screenshots', 'docs', 'scripts', 'tmp']) {
    assert.match(ignored, new RegExp(`^${path.replace('.', '\\.')}\\s*$`, 'm'));
  }
});

await test('all Markdown HTML sinks pass through the sanitizer', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /const sanitizeRenderedHtml =/);
  assert.equal((html.match(/<div[^>]+dangerouslySetInnerHTML/g) || []).length, 1);
  assert.match(html, /sanitizeRenderedHtml\(window\.marked\.parse/);
  assert.match(html, /block\.innerHTML = renderMarkdownForExport/);
  assert.match(html, /return sanitizeRenderedHtml\(window\.marked\.parse/);
});

await test('Terms disclose persisted alert context', async () => {
  const terms = await readFile(new URL('docs/TERMS_OF_USE.md', root), 'utf8');
  assert.match(terms, /diagnoses, medications, allergies/);
  assert.match(terms, /until you unsubscribe/);
  assert.doesNotMatch(terms, /We do not store any other profile data/);
});

console.log(`\n${passed} containment regressions passed.`);
