import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'offline-anthropic-fixture';
process.env.MRT_DISABLE_USAGE_LIMIT = '1';
process.env.MRT_LINKCHECK_ENABLED = '0';
process.env.MRT_GATHER_SIGNING_SECRET = 'offline-gather-secret';
process.env.MRT_REPORT_SEAL_SECRET = 'offline-report-secret';
process.env.MRT_RESEARCH_PIPELINE_ENABLED = '1';
process.env.MRT_GATHER_DEADLINE_MS = '3000';
delete process.env.PERPLEXITY_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { asInternalReq } = await import('../lib/internal-call.js');
const researchHandler = (await import('../api/research.js')).default;
const completionHandler = (await import('../api/report-completion.js')).default;
const { verifyReportCompletionSeal } = await import('../lib/report-completion.js');
const { createReportOutputArtifact } = await import('../lib/report-artifact.js');
const { sealTrialRegistryPayload } = await import('../lib/trial-registry-gate.js');
const { establishTermsConsent, TERMS_VERSION } = await import('../lib/terms-consent.js');
const { sanitizeReportHtml } = await import('../lib/report-links.js');

const patient = {
  condition: 'Idiopathic pulmonary fibrosis',
  age: '61',
  gender: 'male',
  stage: 'moderate',
  medications: 'nintedanib'
};

const passingValidation = () => ({
  primary: {
    overallScore: 100,
    agreement: 'high',
    confirmed: [],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'Fixture validation passed.'
  }
});

const response = () => {
  const headers = new Map();
  const captured = { statusCode: 200, body: undefined, headers };
  captured.res = {
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { captured.statusCode = code; return this; },
    json(value) { captured.body = value; return this; },
    end(value) { captured.body = value; return this; }
  };
  return captured;
};

const invoke = async (handler, body, { method = 'POST', headers = {}, internal = true } = {}) => {
  const out = response();
  const requestHeaders = body === undefined
    ? headers
    : { 'content-type': 'application/json', ...headers };
  const input = {
    method,
    body,
    headers: requestHeaders,
    query: {},
    socket: { remoteAddress: '127.0.0.1' }
  };
  await handler(internal ? asInternalReq(input) : input, out.res);
  return out;
};

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' }
});

const synthesisText = `## 1. Snapshot
This fixture report is grounded in an offline evidence pack.

PROVIDER: Standard care
TREATMENT: Nintedanib
FDA_STATUS: Approved
LENGTH_FREQUENCY: As prescribed by the treating clinician.
EFFICACY: Slowed decline in the measured lung-function outcome.
SAFETY: MODERATE — monitoring is required.
RISKS: Gastrointestinal and liver-test abnormalities.
INTERACTIONS: Review the full medication list.
REFERENCES: [PubMed](https://pubmed.ncbi.nlm.nih.gov/24836310/)

Not medical advice.`;

const offlineFetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('api.anthropic.com')) {
    return jsonResponse({
      id: 'msg_offline_fixture',
      model: JSON.parse(init.body || '{}').model || 'fixture-model',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: synthesisText }],
      usage: { input_tokens: 10, output_tokens: 50 }
    });
  }
  if (url.includes('clinicaltrials.gov/api/v2/studies')) {
    return jsonResponse({ totalCount: 0, studies: [] });
  }
  if (url.includes('europepmc.org') || url.includes('ebi.ac.uk/europepmc')) {
    return jsonResponse({ hitCount: 0, resultList: { result: [] } });
  }
  if (url.includes('api.openalex.org')) {
    return jsonResponse({ meta: { count: 0 }, results: [] });
  }
  if (url.includes('api.fda.gov')) {
    return jsonResponse({ meta: { results: { total: 0 } }, results: [] }, 404);
  }
  if (url.includes('eutils.ncbi.nlm.nih.gov')) {
    return jsonResponse({ esearchresult: { idlist: [], count: '0' }, result: { uids: [] } });
  }
  if (url.includes('api.unpaywall.org')) return jsonResponse({ is_oa: false });
  throw new Error(`OFFLINE_TEST_BLOCKED_NETWORK: ${url}`);
};

test('offline gather → seal → synthesize → finalize → render/export route contract', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = offlineFetch;
  try {
    const gathered = await invoke(researchHandler, {
      mode: 'research',
      phase: 'gather',
      patient,
      audience: 'layperson',
      validate: false
    });
    assert.equal(gathered.statusCode, 200, JSON.stringify(gathered.body));
    assert.equal(gathered.body.phase, 'gather');
    assert.match(gathered.body.gatherSeal, /^1\.\d+\.[A-Za-z0-9_-]{43}$/);
    assert.ok(gathered.body.gatherFingerprint);
    assert.ok(Array.isArray(gathered.body.evidence?.groundedForPrompt));

    const synthesized = await invoke(researchHandler, {
      mode: 'research',
      phase: 'synthesize',
      half: 'front',
      patient,
      audience: 'layperson',
      validate: false,
      gatherFingerprint: gathered.body.gatherFingerprint,
      gatherSeal: gathered.body.gatherSeal,
      providedDossier: gathered.body.dossier,
      providedEvidence: gathered.body.evidence,
      providedTrials: gathered.body.trials
    }, {
      headers: { 'x-idempotency-key': 'offline-synthesis-fixture-0001' }
    });
    assert.equal(synthesized.statusCode, 200, JSON.stringify(synthesized.body));
    const finalized = synthesized.body.content?.find((item) => item.type === 'text')?.text;
    assert.match(finalized, /Nintedanib/);
    assert.equal(synthesized.body.citationAudit.status, 'degraded');

    const polished = await invoke(researchHandler, {
      mode: 'polish-report',
      analysisText: finalized,
      patient,
      condition: patient.condition,
      evidencePack: gathered.body.evidence.groundedForPrompt,
      validate: false
    });
    assert.equal(polished.statusCode, 200);
    const polishedText = polished.body.content[0].text;
    assert.doesNotMatch(polishedText, /javascript:/i);

    const consent = response();
    assert.equal(establishTermsConsent(consent.res), true);
    const cookie = String(consent.headers.get('set-cookie')).split(';')[0];
    const artifactFields = {
      stage: 'final',
      segment: 'final',
      patient,
      validation: passingValidation(),
      citationAudit: { status: 'passed' },
      coverageAudit: { finalMissed: [] }
    };
    const trialsPayload = {
      query: { condition: patient.condition },
      status: 'empty',
      studies: []
    };
    trialsPayload.registrySeal = sealTrialRegistryPayload(trialsPayload);
    const sealed = await invoke(completionHandler, {
      surface: 'full',
      termsVersion: TERMS_VERSION,
      artifacts: {
        research: createReportOutputArtifact({
          ...artifactFields,
          mode: 'research',
          text: polishedText
        }),
        repurpose: createReportOutputArtifact({
          ...artifactFields,
          mode: 'repurpose',
          text: 'CANDIDATE: Offline idea\nREFERENCES: [Published study](https://pubmed.ncbi.nlm.nih.gov/12345678/)'
        })
      },
      trialsPayload
    }, { internal: false, headers: { cookie } });
    assert.equal(sealed.statusCode, 200, JSON.stringify(sealed.body));
    assert.equal(sealed.body.contract.eligible, true);
    assert.equal(
      verifyReportCompletionSeal({
        contract: sealed.body.contract,
        seal: sealed.body.seal
      }).ok,
      true
    );

    const rendered = sanitizeReportHtml(
      `<p>${polishedText}</p><script>fail()</script>`,
      new Set(['https://pubmed.ncbi.nlm.nih.gov/24836310/'])
    );
    assert.doesNotMatch(rendered, /<script/i);
    assert.match(rendered, /Nintedanib/);

    await t.test('tampered pools and stale profiles cannot synthesize', async () => {
      const tampered = structuredClone(gathered.body.evidence);
      tampered.groundedForPrompt.push({ title: 'Injected evidence' });
      const rejected = await invoke(researchHandler, {
        mode: 'research',
        phase: 'synthesize',
        patient,
        gatherFingerprint: gathered.body.gatherFingerprint,
        gatherSeal: gathered.body.gatherSeal,
        providedDossier: gathered.body.dossier,
        providedEvidence: tampered,
        providedTrials: gathered.body.trials
      }, {
        headers: { 'x-idempotency-key': 'offline-tampered-synthesis-0001' }
      });
      assert.equal(rejected.statusCode, 409);
      assert.equal(rejected.body.code, 'GATHER_SEAL_INVALID');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('route rejects malformed bodies and bounded request text before provider calls', async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('provider must not be called');
  };
  try {
    const malformed = await invoke(researchHandler, 'not-an-object');
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.code, 'INVALID_JSON');

    const oversized = await invoke(researchHandler, {
      mode: 'research',
      phase: 'gather',
      patient,
      userQuery: 'x'.repeat(20_001)
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.body.code, 'REQUEST_TOO_LARGE');
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('malformed provider JSON is contained as a route error without leaking input', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes('api.anthropic.com')) {
      return new Response('{malformed', { status: 200 });
    }
    return offlineFetch(input);
  };
  try {
    const result = await invoke(researchHandler, {
      mode: 'translate',
      text: 'private fixture phrase',
      sourceLanguage: 'English',
      targetLanguage: 'Spanish'
    });
    assert.equal(result.statusCode, 502);
    assert.match(result.body.error, /invalid response|non-JSON/i);
    assert.doesNotMatch(JSON.stringify(result.body), /private fixture phrase/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
