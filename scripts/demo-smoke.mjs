#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assessReportCompletion,
  sealReportCompletion,
  verifyReportCompletionSeal
} from '../lib/report-completion.js';
import { TERMS_VERSION } from '../lib/terms-consent.js';

const args = new Set(process.argv.slice(2));
const production = args.has('--production') || process.env.MRT_DEMO_PRODUCTION === '1';
const preflightOnly = args.has('--preflight');
const allowPaidProductionRun = process.env.MRT_DEMO_ALLOW_PAID === '1';
const timeoutMs = Number(process.env.MRT_DEMO_TIMEOUT_MS || 10_000);
const maxAttempts = Math.min(3, Math.max(1, Number(process.env.MRT_DEMO_ATTEMPTS || 2)));
const profiles = JSON.parse(await readFile(
  new URL('../data/demo/golden-profiles.json', import.meta.url),
  'utf8'
));
const saved = JSON.parse(await readFile(
  new URL('../data/demo/saved-verified-report.json', import.meta.url),
  'utf8'
));

const pass = (message) => console.log(`✓ ${message}`);
const request = async (url, init = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetch(url, {
        redirect: 'manual',
        cache: 'no-store',
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
};

const cookieFrom = (response) =>
  String(response.headers.get('set-cookie') || '').split(';')[0];

const runLocal = async () => {
  assert.equal(profiles.version, 1);
  assert.ok(profiles.profiles.length >= 2 && profiles.profiles.length <= 3);
  for (const profile of profiles.profiles) {
    assert.match(profile.id, /^[a-z0-9-]+$/);
    assert.ok(profile.patient.condition);
    assert.equal(profile.invariants.requireCitations, true);
    assert.equal(profile.invariants.requireTrialUrls, true);
    assert.equal(profile.invariants.requireExportSeal, true);
    assert.ok(profile.invariants.forbiddenClaims.length);
  }
  pass(`${profiles.profiles.length} golden profiles and invariant contracts validated`);

  assert.equal(saved.kind, 'saved-demo');
  assert.equal(saved.live, undefined);
  assert.match(saved.label, /saved demo — not live/i);
  assert.match(saved.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(saved.reviewedGitSha, /^[a-f0-9]{40}$/);
  assert.match(saved.researchText, /saved demo — not live/i);
  assert.doesNotMatch(saved.researchText, /\b(?:generated live|live result|generated now)\b/i);
  assert.ok(saved.trials.studies.every((study) =>
    /^https:\/\/clinicaltrials\.gov\//.test(study.url)
  ));
  const allowedSavedUrls = new Set([
    ...saved.evidencePack.map((item) => item.pubmedUrl || item.url),
    ...saved.trials.studies.map((study) => study.url)
  ]);
  const authoredUrls = [
    ...saved.researchText.matchAll(/\[[^\]]+\]\((https:\/\/[^)]+)\)/g),
    ...saved.repurposeText.matchAll(/\[[^\]]+\]\((https:\/\/[^)]+)\)/g)
  ].map((match) => match[1]);
  assert.ok(authoredUrls.every((url) => allowedSavedUrls.has(url)),
    'saved fallback contains a citation outside its export allowlist');
  pass('saved fallback provenance and links validated');

  process.env.NODE_ENV = 'test';
  const profileKey = 'golden-profile-key';
  const completion = assessReportCompletion({
    profileKey,
    termsVersion: TERMS_VERSION,
    sections: {
      research: { text: saved.researchText, profileKey },
      repurpose: { text: saved.repurposeText, profileKey }
    },
    trials: { status: 'complete', profileKey },
    audits: saved.audits,
    savedDemo: {
      kind: saved.kind,
      generatedAt: saved.generatedAt,
      reviewedGitSha: saved.reviewedGitSha
    }
  }, { termsAccepted: true });
  assert.equal(completion.eligible, true);
  const sealed = { ...completion, issuedAt: saved.generatedAt };
  const now = Date.parse(saved.generatedAt);
  const seal = sealReportCompletion(sealed, {
    now,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA'
  });
  assert.equal(verifyReportCompletionSeal({ contract: sealed, seal, now }).ok, true);
  pass('saved fallback passes the same completion seal contract');

  const appSource = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  for (const assertion of [
    '/api/report-completion',
    'This report is not ready to export',
    'Export Word',
    'Export Text',
    'Save as PDF',
    'title="Reset demo/browser data"'
  ]) assert.ok(appSource.includes(assertion), `missing user-flow assertion: ${assertion}`);
  pass('export blocking and key browser flows are wired');

  console.log('Demo smoke passed in deterministic local/mock mode (no network or paid calls).');
};

const runProduction = async () => {
  const base = String(process.env.MRT_BASE_URL || '').replace(/\/+$/, '');
  const expectedSha = String(process.env.MRT_EXPECTED_SHA || '').trim();
  const passcode = String(
    process.env.MRT_DEMO_ACCESS_PASSCODE || process.env.MRT_ACCESS_PASSCODE || ''
  ).trim();
  assert.match(base, /^https:\/\//, 'MRT_BASE_URL must be an HTTPS deployment URL');
  assert.match(expectedSha, /^[a-f0-9]{40}$/i, 'MRT_EXPECTED_SHA must be the full reviewed SHA');
  assert.ok(passcode, 'MRT_DEMO_ACCESS_PASSCODE (a single operator code) is required');

  const accessResponse = await request(`${base}/api/access-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode })
  });
  const accessCookie = cookieFrom(accessResponse);
  assert.ok(accessResponse.ok && accessCookie, `access setup failed: HTTP ${accessResponse.status}`);

  const termsResponse = await request(`${base}/api/terms-consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: accessCookie },
    body: JSON.stringify({ accepted: true, termsVersion: TERMS_VERSION })
  });
  const termsCookie = cookieFrom(termsResponse);
  assert.ok(termsResponse.ok && termsCookie, `Terms setup failed: HTTP ${termsResponse.status}`);
  const cookie = `${accessCookie}; ${termsCookie}`;

  const readinessResponse = await request(
    `${base}/api/demo-readiness?action=preflight&live=1&expectedSha=${encodeURIComponent(expectedSha)}`,
    { headers: { Cookie: cookie } }
  );
  const readiness = await readinessResponse.json().catch(() => null);
  assert.equal(readinessResponse.status, 200,
    `preflight blocked: ${JSON.stringify(readiness?.blockers || readiness)}`);
  assert.equal(readiness.deploymentSha, expectedSha);
  pass(`exact deployed SHA and ${readiness.checks.length} readiness checks passed`);

  for (const path of ['/', '/terms']) {
    const response = await request(`${base}${path}`, { headers: { Cookie: cookie } });
    assert.ok(response.ok, `${path} returned HTTP ${response.status}`);
  }
  for (const path of ['/api/health', '/api/research', '/api/trials', '/api/report-completion']) {
    const response = await request(`${base}${path}`, {
      method: path === '/api/health' ? 'GET' : 'OPTIONS',
      headers: { Cookie: cookie }
    });
    assert.ok(response.status < 500, `${path} returned HTTP ${response.status}`);
  }
  const savedResponse = await request(`${base}/api/demo-readiness?action=saved-report`, {
    headers: { Cookie: cookie }
  });
  const savedBody = await savedResponse.json().catch(() => null);
  assert.ok(savedResponse.ok && savedBody?.kind === 'saved-demo' && savedBody?.live === false);
  pass('critical routes and saved fallback are reachable');

  if (!preflightOnly) {
    const runtimeResponse = await request(`${base}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mode: 'runtime-config' })
    });
    const runtime = await runtimeResponse.json().catch(() => null);
    assert.ok(runtimeResponse.ok && runtime?.ai?.researchModel);
    pass('authenticated runtime-config user flow passed without generation spend');

    if (allowPaidProductionRun) {
      const golden = profiles.profiles[0];
      const reportResponse = await request(`${base}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          mode: 'research',
          patient: golden.patient,
          audience: 'layperson'
        })
      });
      const report = await reportResponse.json().catch(() => null);
      assert.ok(reportResponse.ok, `paid golden report failed: HTTP ${reportResponse.status}`);
      const text = (report?.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      assert.ok(text.length >= 500, 'golden report was too short to be complete');
      assert.ok(golden.invariants.conditionTerms.some((term) =>
        text.toLowerCase().includes(term.toLowerCase())
      ), 'golden report omitted the condition');
      for (const term of golden.invariants.requiredTreatmentTerms) {
        assert.ok(text.toLowerCase().includes(term.toLowerCase()), `golden report omitted ${term}`);
      }
      assert.match(text, /\[[^\]]+\]\(https:\/\/[^)]+\)/, 'golden report omitted citations');
      assert.doesNotMatch(text, /\b(?:is a cure|cures (?:IPF|fibrosis))\b/i);
      pass(`paid production golden profile passed (${golden.id})`);
    } else {
      pass('paid production generation skipped (set MRT_DEMO_ALLOW_PAID=1 explicitly)');
    }
  }
  console.log(allowPaidProductionRun && !preflightOnly
    ? 'Authenticated production demo smoke passed, including one paid golden report.'
    : 'Authenticated production demo preflight passed; no report generation call was made.');
};

await (production ? runProduction() : runLocal());
