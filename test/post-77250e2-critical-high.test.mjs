import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MRT_REPORT_SEAL_SECRET = 'post-77250e2-report-seal-secret';

import { classifyAccessProbeResponse } from '../lib/access-transition.js';
import { asInternalReq, INTERNAL_CALL } from '../lib/internal-call.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import { paidRequestControlPlan } from '../lib/spend-controls.js';
import {
  beginBillableRequest,
  fingerprintBillableRequest
} from '../lib/billable-request-store.js';
import {
  buildBrowserResearchRequest,
  resolvePaidRequestIdempotencyKey
} from '../lib/research-request.js';
import { _alertsCronTest } from '../api/alerts-cron.js';
import completionHandler from '../api/report-completion.js';
import researchHandler, { RESEARCH_GATHER_SEAL_TTL_MS } from '../api/research.js';
import { createReportOutputArtifact } from '../lib/report-artifact.js';
import { sealTrialRegistryPayload } from '../lib/trial-registry-gate.js';
import { createGatherSeal, verifyGatherSeal } from '../lib/gather-seal.js';
import { establishTermsConsent, TERMS_VERSION } from '../lib/terms-consent.js';

const response = () => {
  const headers = new Map();
  const state = { status: 200, body: null, headers };
  state.res = {
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return this; },
    end() { return this; }
  };
  return state;
};

const passingValidation = () => ({
  status: 'passed',
  primary: {
    overallScore: 95,
    agreement: 'high',
    confirmed: [],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'Server validation passed.'
  }
});

test('fresh authorized users transition from 428 into the Terms gate', () => {
  assert.deepEqual(classifyAccessProbeResponse({
    status: 428,
    code: 'TERMS_ACCEPTANCE_REQUIRED',
    error: 'Accept Terms'
  }), {
    ok: true,
    gateEnabled: true,
    termsRequired: true
  });
  assert.equal(classifyAccessProbeResponse({
    status: 401,
    code: 'ACCESS_GATE_BLOCKED'
  }).ok, false);
  assert.equal(classifyAccessProbeResponse({
    status: 503,
    code: 'ACCESS_GATE_MISCONFIGURED'
  }).ok, false);
});

test('internal fan-out supplies JSON media type and retains unforgeable marker', () => {
  const req = asInternalReq({ method: 'POST', body: { condition: 'IPF' }, headers: {} });
  let response = null;
  const parsed = requireJsonObjectBody(req, {
    status(code) {
      return {
        json(body) {
          response = { code, body };
        }
      };
    }
  });
  assert.deepEqual(parsed, { condition: 'IPF' });
  assert.equal(response, null);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req[INTERNAL_CALL], true);
});

test('research accepts a sub-megabyte sealed-gather shape above the generic node count', async () => {
  const structuralProbe = Object.fromEntries(
    Array.from({ length: 40 }, (_, group) => [
      `trial-${group}`,
      Array.from({ length: 300 }, (_, criterion) => criterion)
    ])
  );
  const out = response();
  const req = asInternalReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { mode: 'runtime-config', structuralProbe }
  });
  await researchHandler(req, out.res);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body?.build?.sha !== undefined, true);
});

test('research retries retain signed gathers for two hours without changing default seal freshness', () => {
  const now = 1_700_000_000_000;
  const input = {
    gatherFingerprint: 'parkinson-retry-fixture',
    dossier: { canonical: 'Parkinson Disease' },
    evidence: { groundedForPrompt: [], topRanked: [] },
    trials: { studies: [] },
    now,
    secret: 'research-retry-gather-secret'
  };
  const seal = createGatherSeal(input);
  const afterOneHour = { ...input, seal, now: now + 60 * 60 * 1000 };
  assert.equal(verifyGatherSeal(afterOneHour).code, 'GATHER_SEAL_EXPIRED');
  assert.equal(verifyGatherSeal({
    ...afterOneHour,
    ttlMs: RESEARCH_GATHER_SEAL_TTL_MS
  }).ok, true);
});

test('scheduled-alert internal dispatch reaches JSON data handlers', async () => {
  const handler = async (req, res) => {
    const body = requireJsonObjectBody(req, res);
    if (!body) return;
    return res.status(200).json({ reached: true, condition: body.condition });
  };
  const result = await _alertsCronTest.invoke(handler, { condition: 'Type 1 diabetes' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { reached: true, condition: 'Type 1 diabetes' });
});

test('split synthesis always requires budget and idempotency controls', () => {
  for (const mode of ['research', 'repurpose']) {
    const plan = paidRequestControlPlan({
      mode,
      phase: 'synthesize',
      pipelineMode: true,
      usageBypassed: true
    });
    assert.deepEqual(plan, {
      splitSynthesis: true,
      meterUsage: false,
      requireIdempotencyAndBudget: true
    });
  }
});

test('browser split-synthesis requests satisfy API idempotency policy', async () => {
  const base = {
    mode: 'research',
    phase: 'synthesize',
    half: 'front',
    patient: { condition: 'Type 1 diabetes', age: '42' },
    gatherFingerprint: 'gather-fingerprint-type-1',
    gatherSeal: 'sealed-gather-type-1'
  };
  const request = buildBrowserResearchRequest(base, { profileKey: 'profile-type-1' });
  const retry = buildBrowserResearchRequest(structuredClone(base), {
    profileKey: 'profile-type-1'
  });
  const body = JSON.parse(request.body);
  const retryBody = JSON.parse(retry.body);
  assert.equal(body.idempotencyKey, retryBody.idempotencyKey);
  assert.ok(body.idempotencyKey.length >= 16 && body.idempotencyKey.length <= 256);

  const backKey = JSON.parse(buildBrowserResearchRequest({
    ...base,
    half: 'back'
  }, { profileKey: 'profile-type-1' }).body).idempotencyKey;
  const freshGatherKey = JSON.parse(buildBrowserResearchRequest({
    ...base,
    gatherSeal: 'sealed-gather-type-1-fresh'
  }, { profileKey: 'profile-type-1' }).body).idempotencyKey;
  const otherProfileKey = JSON.parse(buildBrowserResearchRequest({
    ...base,
    patient: { condition: 'Type 1 diabetes', age: '63' }
  }, { profileKey: 'profile-type-1-older' }).body).idempotencyKey;
  const repurposeLaneKeys = [0, 1, 2].map((batchLane) =>
    JSON.parse(buildBrowserResearchRequest({
      ...base,
      mode: 'repurpose',
      batchLane
    }, { profileKey: 'profile-type-1' }).body).idempotencyKey
  );
  assert.notEqual(body.idempotencyKey, backKey);
  assert.notEqual(body.idempotencyKey, freshGatherKey);
  assert.notEqual(body.idempotencyKey, otherProfileKey);
  assert.equal(new Set(repurposeLaneKeys).size, 3);
  assert.ok(repurposeLaneKeys.every((key) => key !== body.idempotencyKey));

  const fingerprint = fingerprintBillableRequest({
    ...body,
    idempotencyKey: undefined
  });
  const reservation = await beginBillableRequest({
    key: body.idempotencyKey,
    scope: 'browser-fixture:research:synthesize',
    fingerprint
  });
  assert.equal(reservation.state, 'reserved');
  const retryReservation = await beginBillableRequest({
    key: retryBody.idempotencyKey,
    scope: 'browser-fixture:research:synthesize',
    fingerprint
  });
  assert.equal(retryReservation.state, 'in-progress');
});

test('authenticated private preview derives a stable server key for stale browser requests', () => {
  const fingerprint = fingerprintBillableRequest({
    mode: 'research',
    phase: 'synthesize',
    half: 'front',
    gatherFingerprint: 'saved-parkinson-gather'
  });
  const first = resolvePaidRequestIdempotencyKey({
    requestFingerprint: fingerprint,
    authenticatedPreview: true
  });
  const retry = resolvePaidRequestIdempotencyKey({
    requestFingerprint: fingerprint,
    authenticatedPreview: true
  });
  assert.equal(first, retry);
  assert.match(first, /^mrt-private-preview-v2:[a-f0-9]{64}$/);
  assert.equal(resolvePaidRequestIdempotencyKey({
    requestFingerprint: fingerprint,
    authenticatedPreview: false
  }), '');
  assert.equal(resolvePaidRequestIdempotencyKey({
    suppliedKey: 'browser-supplied-key-0001',
    requestFingerprint: fingerprint,
    authenticatedPreview: true
  }), first);
  assert.equal(resolvePaidRequestIdempotencyKey({
    suppliedKey: 'browser-supplied-key-0001',
    requestFingerprint: fingerprint,
    authenticatedPreview: false
  }), 'browser-supplied-key-0001');
});

test('completion endpoint rejects seal-oracle forgery and accepts server artifacts', async () => {
  const consent = response();
  assert.equal(establishTermsConsent(consent.res), true);
  const cookie = String(consent.headers.get('set-cookie')).split(';')[0];
  const invoke = async (body) => {
    const out = response();
    await completionHandler({
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      query: {},
      body,
      socket: { remoteAddress: '127.0.0.1' }
    }, out.res);
    return out;
  };

  const forged = await invoke({
    surface: 'research',
    termsVersion: TERMS_VERSION,
    profileKey: 'plausible-profile',
    sections: {
      research: { text: 'Fabricated report text.', profileKey: 'plausible-profile' },
      repurpose: { text: 'Fabricated ideas.', profileKey: 'plausible-profile' }
    },
    trials: { status: 'complete', profileKey: 'plausible-profile' },
    audits: {
      validation: {
        research: passingValidation(),
        repurpose: passingValidation()
      },
      citations: {
        research: { status: 'passed' },
        repurpose: { status: 'passed' }
      },
      coverage: { finalMissed: [] }
    },
    reportContent: 'Fabricated report text.'
  });
  assert.equal(forged.status, 409);
  assert.equal(forged.body.seal, undefined);
  assert.equal(forged.body.code, 'REPORT_OUTPUT_REQUIRED');

  const patient = { condition: 'Idiopathic pulmonary fibrosis', age: '61' };
  const researchText = 'Condition research complete.';
  const repurposeText =
    'CANDIDATE: Pulmonary rehabilitation\n' +
    'REFERENCES: [Published study](https://pubmed.ncbi.nlm.nih.gov/32741912/)';
  const artifactFields = {
    stage: 'final',
    segment: 'final',
    patient,
    validation: passingValidation(),
    citationAudit: { status: 'passed' },
    coverageAudit: { finalMissed: [] }
  };
  const research = createReportOutputArtifact({
    ...artifactFields,
    mode: 'research',
    text: researchText
  });
  const repurpose = createReportOutputArtifact({
    ...artifactFields,
    mode: 'repurpose',
    text: repurposeText
  });
  const trialsPayload = {
    query: { condition: patient.condition },
    status: 'empty',
    studies: []
  };
  trialsPayload.registrySeal = sealTrialRegistryPayload(trialsPayload);
  const mutatedArtifact = structuredClone(research);
  mutatedArtifact.payload.text = 'Changed after server issuance.';
  const mutated = await invoke({
    surface: 'research',
    termsVersion: TERMS_VERSION,
    artifacts: { research: mutatedArtifact, repurpose },
    trialsPayload
  });
  assert.equal(mutated.status, 409);
  assert.equal(mutated.body.seal, undefined);
  assert.equal(mutated.body.code, 'REPORT_SEAL_INVALID');

  const valid = await invoke({
    surface: 'research',
    termsVersion: TERMS_VERSION,
    artifacts: { research, repurpose },
    trialsPayload
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.contract.eligible, true);
  assert.equal(valid.body.canonicalContent, researchText);
  assert.match(valid.body.seal, /^1\./);
});

test('completion endpoint binds signed trials to the resolved condition subtype', async () => {
  const consent = response();
  assert.equal(establishTermsConsent(consent.res), true);
  const cookie = String(consent.headers.get('set-cookie')).split(';')[0];
  const invoke = async (body) => {
    const out = response();
    await completionHandler({
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      query: {},
      body,
      socket: { remoteAddress: '127.0.0.1' }
    }, out.res);
    return out;
  };
  const patient = { condition: 'Type 1 diabetes', age: '42' };
  const artifactFields = {
    stage: 'final',
    segment: 'final',
    patient,
    validation: passingValidation(),
    citationAudit: { status: 'passed' },
    coverageAudit: { finalMissed: [] }
  };
  const artifacts = {
    research: createReportOutputArtifact({
      ...artifactFields,
      mode: 'research',
      text: 'Type 1 diabetes condition report.'
    }),
    repurpose: createReportOutputArtifact({
      ...artifactFields,
      mode: 'repurpose',
      text: 'CANDIDATE: Supportive care\nREFERENCES: [Published study](https://pubmed.ncbi.nlm.nih.gov/12345678/)'
    })
  };
  const bodyFor = (condition) => {
    const trialsPayload = {
      query: { condition },
      status: 'empty',
      studies: []
    };
    trialsPayload.registrySeal = sealTrialRegistryPayload(trialsPayload);
    return {
      surface: 'full',
      termsVersion: TERMS_VERSION,
      artifacts,
      trialsPayload
    };
  };

  const generic = await invoke(bodyFor('diabetes'));
  assert.equal(generic.status, 409);
  assert.equal(generic.body.code, 'TRIAL_PROFILE_MISMATCH');
  assert.equal(generic.body.seal, undefined);

  const exact = await invoke(bodyFor('Type 1 diabetes'));
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.contract.eligible, true);

  const alias = await invoke(bodyFor('T1D'));
  assert.equal(alias.status, 200, JSON.stringify(alias.body));
  assert.equal(alias.body.contract.eligible, true);
});
