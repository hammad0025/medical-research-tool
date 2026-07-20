import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SHA = 'a'.repeat(40);
Object.assign(process.env, {
  NODE_ENV: 'production',
  VERCEL_ENV: 'production',
  VERCEL_GIT_COMMIT_SHA: SHA,
  MRT_ACCESS_PASSCODE: 'test-demo-passcode',
  MRT_REPORT_SEAL_SECRET: 'test-report-seal-secret-with-enough-entropy',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token'
});

const { buildDemoReadiness, DEMO_REQUIRED_ROUTES } =
  await import(`../lib/demo-readiness.js?test=${Date.now()}`);
const { assessReportCompletion } = await import('../lib/report-completion.js');
const {
  savedDemoMatchesCompletionInput,
  sealSavedDemo,
  verifySavedDemo
} = await import('../lib/saved-demo.js');
const { TERMS_VERSION } = await import('../lib/terms-consent.js');

test('demo preflight requires exact deployed SHA and operational dependencies', async () => {
  const readiness = await buildDemoReadiness({
    expectedSha: SHA,
    live: true,
    modelProbe: async () => ({ ok: true, state: 'available', model: 'test-model' }),
    redisProbe: async () => ({ ok: true }),
    publicProviderProbe: async () => ({ ok: true, providers: {} })
  });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.ok(DEMO_REQUIRED_ROUTES.includes('/api/report-completion'));
  assert.ok(DEMO_REQUIRED_ROUTES.includes('/api/demo-readiness'));
});

test('SHA mismatch and unavailable model remain hard blockers', async () => {
  const readiness = await buildDemoReadiness({
    expectedSha: 'b'.repeat(40),
    live: true,
    modelProbe: async () => ({ ok: false, state: 'http-404', model: 'missing-model' }),
    redisProbe: async () => ({ ok: true }),
    publicProviderProbe: async () => ({ ok: true, providers: {} })
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.includes('deployed-sha'));
  assert.ok(readiness.blockers.includes('anthropic-model'));
});

test('saved demo provenance is server-owned and the reviewed fixture can export', async () => {
  const saved = JSON.parse(await readFile(
    new URL('../data/demo/saved-verified-report.json', import.meta.url),
    'utf8'
  ));
  const profileKey = 'saved-profile';
  const input = {
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
  };
  const callerForged = assessReportCompletion(input, { termsAccepted: true });
  assert.equal(callerForged.eligible, false);
  assert.ok(callerForged.failed.includes('validation:research'));

  const provenance = {
    kind: saved.kind,
    generatedAt: saved.generatedAt,
    reviewedGitSha: saved.reviewedGitSha
  };
  const valid = assessReportCompletion({
    ...input,
    outputQualityVersion: '1'
  }, {
    termsAccepted: true,
    savedDemoProvenance: provenance
  });
  assert.equal(valid.eligible, true);
  assert.equal(valid.label, 'Saved example report — not live');
  assert.equal(valid.provenance.reviewedGitSha, saved.reviewedGitSha);

  const invalid = assessReportCompletion(input, {
    termsAccepted: true,
    savedDemoProvenance: { ...provenance, reviewedGitSha: 'not-a-sha' }
  });
  assert.equal(invalid.eligible, false);
  assert.ok(invalid.failed.includes('saved-demo:provenance'));

  const now = Date.now();
  const seal = sealSavedDemo(saved, { now });
  assert.equal(verifySavedDemo(saved, seal, { now }).ok, true);
  const tampered = { ...saved, researchText: `${saved.researchText}\nForged claim.` };
  assert.equal(verifySavedDemo(tampered, seal, { now }).ok, false);
  assert.equal(savedDemoMatchesCompletionInput(saved, input), true);
  assert.equal(savedDemoMatchesCompletionInput(tampered, input), false);
});

test('browser reset clears local data and both server sessions', async () => {
  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  assert.match(source, /title="Reset demo\/browser data"/);
  assert.match(source, /fetch\('\/api\/terms-consent', \{ method: 'DELETE' \}\)/);
  assert.match(source, /fetch\('\/api\/access-session', \{ method: 'DELETE' \}\)/);
  assert.match(source, /Load saved demo \(not live\)/);
});
