// Executes the deterministic repurpose lanes through the real handler.
//
// Nothing exercised this path before. A hoist that deleted one line too many
// left `rendered is not defined` in the mechanistic lane -- a ReferenceError
// that only appears when the code RUNS -- and the whole suite stayed green
// while the lane was completely broken. `node --check` cannot see it either,
// since the file parses fine. Only running it catches this class.
import test from 'node:test';
import assert from 'node:assert/strict';

import researchHandler from '../api/research.js';
import { createGatherSeal } from '../lib/gather-seal.js';
import {
  REPURPOSE_RESEARCHED_LANE,
  REPURPOSE_MECHANISTIC_LANE
} from '../lib/repurpose-quality.js';

const SECRET = 'lane-e2e-test-secret';

const response = () => {
  const out = { status: null, body: null };
  out.res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
    setHeader() {},
    end() {}
  };
  return out;
};

// Canned provider responses. Routed by URL so the lane renders real candidates
// without touching the network.
const AGENTS = [
  { name: 'Test Agent Alpha', mechanism: 'Blocks a pathway implicated in this condition.', usualUse: 'Another condition', url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/' },
  { name: 'Test Agent Beta', mechanism: 'Modulates a receptor relevant to this condition.', usualUse: 'Another condition', url: 'https://pubmed.ncbi.nlm.nih.gov/23456789/' }
];
const SEARCH_ITEMS = AGENTS.map((a) => ({
  name: a.name, url: a.url, year: 2023, evidence: 'rct',
  finding: 'A trial reported no meaningful benefit.',
  mechanism: a.mechanism, usualUse: a.usualUse
}));

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => payload,
  text: async () => JSON.stringify(payload)
});

// The two searches must return DIFFERENT agents. Handing both the same names
// made the mechanistic lane correctly drop every one as already-researched, so
// it rendered nothing and the test proved nothing.
const MECHANISTIC_ITEMS = [
  { name: 'Test Mechanistic Gamma', mechanism: 'Engages a pathway implicated in this condition.', usualUse: 'A different condition', url: 'https://pubmed.ncbi.nlm.nih.gov/34567890/' },
  { name: 'Test Mechanistic Delta', mechanism: 'Modulates a target relevant to this condition.', usualUse: 'A different condition', url: 'https://pubmed.ncbi.nlm.nih.gov/45678901/' }
];

const installFetchStub = () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url?.url || url || '');
    if (href.includes('perplexity.ai')) {
      // The mechanistic search identifies itself by its system prompt.
      const body = String(init?.body || '');
      const items = body.includes('translational pharmacologist')
        ? MECHANISTIC_ITEMS
        : SEARCH_ITEMS;
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(items) } }]
      });
    }
    // Registry studied-check: report nothing, so no candidate is filtered out.
    if (href.includes('clinicaltrials.gov')) return jsonResponse({ totalCount: 0, studies: [] });
    return jsonResponse({});
  };
  return () => { globalThis.fetch = original; };
};

const condition = 'Parkinson Disease';
// poolsFingerprint is what binds these pools to the gather; without it the
// handler takes a stricter path and answers GATHER_STALE before any lane runs.
const gatherFingerprint = 'lane-e2e-fingerprint';
const dossier = {
  canonical: condition,
  topCenters: [],
  keyInvestigators: [],
  poolsFingerprint: gatherFingerprint
};
const evidence = { groundedForPrompt: [], topRanked: [] };
const trials = { studies: [], studiedInterventions: [] };

const laneRequest = (batchLane) => {
  const seal = createGatherSeal({
    gatherFingerprint, dossier, evidence, trials, secret: SECRET
  });
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': `mrt-lane-e2e-test-key-lane-${batchLane}`
    },
    body: {
      mode: 'repurpose',
      phase: 'synthesize',
      half: 'front',
      batchLane,
      batchSize: 8,
      audience: 'layperson',
      patient: { condition },
      gatherSeal: seal,
      gatherFingerprint,
      providedDossier: dossier,
      providedEvidence: evidence,
      providedTrials: trials,
      idempotencyKey: `mrt-lane-e2e-test-key-lane-${batchLane}`
    }
  };
};

for (const [name, lane] of [
  ['researched', REPURPOSE_RESEARCHED_LANE],
  ['mechanistic', REPURPOSE_MECHANISTIC_LANE]
]) {
  test(`the ${name} lane runs without throwing`, async () => {
    const saved = {
      secret: process.env.MRT_GATHER_SIGNING_SECRET,
      pplx: process.env.PERPLEXITY_API_KEY,
      limit: process.env.MRT_DISABLE_USAGE_LIMIT,
      anthropic: process.env.ANTHROPIC_API_KEY,
      seal: process.env.MRT_REPORT_SEAL_SECRET
    };
    // Without a key the handler answers 503 before any lane runs -- which is
    // how the first version of this test passed while the lane was broken.
    // The deterministic lanes never call Anthropic; this only clears the gate.
    process.env.ANTHROPIC_API_KEY = 'test-key-lanes-do-not-call-anthropic';
    process.env.MRT_REPORT_SEAL_SECRET = 'lane-e2e-report-seal-secret';
    process.env.MRT_GATHER_SIGNING_SECRET = SECRET;
    // The search MUST return candidates, or the lane short-circuits before the
    // render line and the test proves nothing. Verified: with the search
    // stubbed out to return [], deleting `const rendered = ...` still passed.
    process.env.PERPLEXITY_API_KEY = 'test-key-not-used-network-is-stubbed';
    process.env.MRT_DISABLE_USAGE_LIMIT = '1';
    const restoreFetch = installFetchStub();
    try {
      const out = response();
      await researchHandler(laneRequest(lane), out.res);

      // A ReferenceError anywhere in the lane surfaces as this exact shape.
      assert.notEqual(
        out.body?.code, 'INTERNAL_SERVER_ERROR',
        `${name} lane threw: ${JSON.stringify(out.body)}`
      );
      assert.notEqual(out.status, 500, `${name} lane returned 500: ${JSON.stringify(out.body)}`);
      assert.equal(out.status, 200, `lane did not run: ${JSON.stringify(out.body)}`);
      const text = (out.body?.content || []).map((b) => b?.text || '').join('');
      assert.ok(text.length > 0, 'the lane must render candidates, or this proves nothing');
      // A lane that renders text must also issue the signed artifact
      // /api/report-completion requires, or that endpoint answers 409.
      assert.ok(out.body?.outputArtifact, 'a rendering lane must issue an outputArtifact');
    } finally {
      restoreFetch();
      for (const [key, value] of [
        ['MRT_GATHER_SIGNING_SECRET', saved.secret],
        ['PERPLEXITY_API_KEY', saved.pplx],
        ['MRT_DISABLE_USAGE_LIMIT', saved.limit],
        ['ANTHROPIC_API_KEY', saved.anthropic],
        ['MRT_REPORT_SEAL_SECRET', saved.seal]
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
