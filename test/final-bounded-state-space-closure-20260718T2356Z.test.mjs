import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const REPORT_URL = new URL('../.verify-runs/final-bounded-state-space-closure-20260718T2356Z.json', import.meta.url);
const RUN_ID = 'final-bounded-state-space-closure-20260718T2356Z';

Object.assign(process.env, {
  NODE_ENV: 'production',
  VERCEL_ENV: 'production',
  MRT_ACCESS_PASSCODE: 'closure-access-code',
  MRT_TERMS_SIGNING_SECRET: 'closure-terms-secret',
  MRT_REPORT_SEAL_SECRET: 'closure-report-seal-secret',
  MRT_DISABLE_USAGE_LIMIT: '1',
  MRT_DYNAMIC_KB: '0',
  MRT_BRAIN_CRON: '0',
  MRT_SPEND_ENABLED: '1',
  MRT_RESEARCH_ENABLED: '1',
  CRON_SECRET: 'closure-cron-secret'
});
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PERPLEXITY_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RESEND_API_KEY;
delete process.env.ALERTS_EMAIL_FROM;
delete process.env.ALERTS_PUBLIC_URL;
delete process.env.ALERTS_MONITOR_WEBHOOK_URL;

const dimensions = {
  route: [
    '/api/access-session', '/api/alerts-cron', '/api/alerts-subscribe',
    '/api/brain-cron', '/api/demo-readiness', '/api/health',
    '/api/private-static', '/api/report-completion', '/api/research',
    '/api/terms-consent', '/api/trials', '/terms'
  ],
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  access: ['gate-disabled-local', 'valid-header', 'valid-session', 'missing', 'invalid', 'expired', 'misconfigured'],
  terms: ['current', 'missing', 'expired', 'tampered', 'stale-version', 'misconfigured'],
  role: ['anonymous', 'patient', 'reviewer', 'cron'],
  patientContext: ['complete', 'minimal-condition-only', 'missing-demographics', 'missing-medications', 'invalid-shape'],
  reportStage: ['not-started', 'gather', 'synthesize-front', 'synthesize-back', 'sealed-export'],
  reportState: ['complete', 'degraded', 'failed', 'stale', 'cancelled', 'empty'],
  providerState: ['success', 'timeout', 'error', 'malformed', 'partial', 'cancelled'],
  redisState: ['available', 'unavailable', 'misconfigured'],
  resendState: ['available', 'unavailable', 'timeout', 'error', 'malformed', 'partial'],
  sourceLinkState: ['allowlisted-live-shape', 'dead', 'missing', 'unsafe-scheme', 'unallowlisted', 'malformed'],
  outputSink: [
    'screen-markdown', 'treatment-card', 'candidate-card', 'combo-card',
    'references-tab', 'alert-email-html', 'word-doc', 'print-pdf',
    'clipboard-text', 'subscription-json', 'api-json', 'saved-demo'
  ],
  contentType: [
    'application/json', 'application/json;charset=utf-8', 'text/plain',
    'application/x-www-form-urlencoded', 'multipart/form-data', 'missing', 'invalid'
  ]
};

const baseline = Object.fromEntries(Object.entries(dimensions).map(([name, values]) => [name, values[0]]));
const pairwise = [];
const names = Object.keys(dimensions);
for (let left = 0; left < names.length; left += 1) {
  for (let right = left + 1; right < names.length; right += 1) {
    const a = names[left];
    const b = names[right];
    for (const av of dimensions[a]) {
      for (const bv of dimensions[b]) pairwise.push({ ...baseline, [a]: av, [b]: bv });
    }
  }
}

const pairKey = (a, av, b, bv) => `${a}=${av}|${b}=${bv}`;
const requiredPairs = new Set();
for (let left = 0; left < names.length; left += 1) {
  for (let right = left + 1; right < names.length; right += 1) {
    for (const av of dimensions[names[left]]) {
      for (const bv of dimensions[names[right]]) {
        requiredPairs.add(pairKey(names[left], av, names[right], bv));
      }
    }
  }
}
const coveredPairs = new Set();
for (const row of pairwise) {
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) {
      coveredPairs.add(pairKey(names[left], row[names[left]], names[right], row[names[right]]));
    }
  }
}

const highRiskTriples = [
  { route: '/api/research', access: 'missing', terms: 'current' },
  { route: '/api/research', access: 'valid-session', terms: 'missing' },
  { route: '/api/research', role: 'reviewer', providerState: 'error' },
  { route: '/api/trials', patientContext: 'missing-demographics', providerState: 'partial' },
  { route: '/api/report-completion', reportState: 'stale', outputSink: 'word-doc' },
  { route: '/api/report-completion', reportState: 'degraded', outputSink: 'print-pdf' },
  { route: '/api/alerts-cron', redisState: 'unavailable', resendState: 'available' },
  { route: '/api/alerts-cron', redisState: 'available', resendState: 'unavailable' },
  { route: '/api/alerts-subscribe', role: 'anonymous', sourceLinkState: 'unallowlisted' },
  { route: '/api/brain-cron', role: 'cron', redisState: 'misconfigured' },
  { outputSink: 'alert-email-html', sourceLinkState: 'unsafe-scheme', providerState: 'malformed' },
  { outputSink: 'screen-markdown', sourceLinkState: 'unsafe-scheme', reportState: 'complete' },
  { contentType: 'text/plain', route: '/api/research', access: 'valid-session' },
  { contentType: 'multipart/form-data', route: '/api/report-completion', terms: 'current' },
  { providerState: 'cancelled', reportStage: 'gather', reportState: 'cancelled' },
  { patientContext: 'invalid-shape', reportStage: 'synthesize-front', providerState: 'partial' }
];

const routeInventory = {
  '/api/access-session': { methods: ['POST', 'DELETE', 'OPTIONS'], access: false, terms: false, roles: ['anonymous'] },
  '/api/alerts-cron': { methods: ['GET', 'POST', 'OPTIONS'], access: false, terms: false, roles: ['cron'] },
  '/api/alerts-subscribe': { methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], access: true, terms: true, roles: ['patient'] },
  '/api/brain-cron': { methods: ['GET', 'POST', 'OPTIONS'], access: false, terms: false, roles: ['cron'] },
  '/api/demo-readiness': { methods: ['GET', 'OPTIONS'], access: true, terms: true, roles: ['patient'] },
  '/api/health': { methods: ['GET', 'OPTIONS'], access: true, terms: true, roles: ['patient'] },
  '/api/private-static': { methods: ['ALL'], access: false, terms: false, roles: ['anonymous'] },
  '/api/report-completion': { methods: ['POST', 'OPTIONS'], access: true, terms: true, roles: ['patient'] },
  '/api/research': { methods: ['POST', 'OPTIONS'], access: true, terms: true, roles: ['patient', 'reviewer'] },
  '/api/terms-consent': { methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], access: true, terms: false, roles: ['patient'] },
  '/api/trials': { methods: ['GET', 'POST', 'OPTIONS'], access: true, terms: true, roles: ['patient'] },
  '/terms': { methods: ['GET', 'HEAD'], access: false, terms: false, roles: ['anonymous'], static: true }
};

const researchModes = [
  'research', 'repurpose', 'trials', 'chat', 'runtime-config',
  'resolve-condition', 'condition-subtypes', 'flag-error',
  'parse-patient-message', 'usage', 'activate-plan', 'translate',
  'benchmark-models', 'validate', 'polish-report'
];
const supportedContentTypes = {
  requestBodies: ['application/json', 'application/json;charset=utf-8'],
  responseAndSinks: [
    'application/json', 'text/html', 'text/plain',
    'application/msword;charset=utf-8', 'print/PDF'
  ]
};
const outputSinks = {
  ui: ['screen-markdown', 'treatment-card', 'candidate-card', 'combo-card', 'references-tab', 'saved-demo'],
  exports: ['word-doc', 'print-pdf', 'clipboard-text', 'subscription-json'],
  server: ['api-json', 'alert-email-html']
};

const pathsHit = [];
const defects = [];
const gaps = [];
const failures = [];
let makeInternalRequest = (req) => req;

const makeRes = () => {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.ended = true; return this; },
    send(value) { this.body = value; this.ended = true; return this; },
    end(value) { this.body = value; this.ended = true; return this; }
  };
};

const invoke = async (route, handler, {
  method = 'GET', headers = {}, query = {}, body, internal = false
} = {}) => {
  const requestHeaders = body === undefined
    ? headers
    : { 'content-type': 'application/json', ...headers };
  const plainReq = {
    method,
    headers: { host: 'closure.invalid', ...requestHeaders },
    query,
    body,
    socket: { remoteAddress: '127.0.0.1' }
  };
  const req = internal ? makeInternalRequest(plainReq) : plainReq;
  const res = makeRes();
  try {
    await handler(req, res);
    pathsHit.push({ route, method, status: res.statusCode, code: res.body?.code || null });
  } catch (error) {
    pathsHit.push({ route, method, thrown: error?.name || 'Error' });
    failures.push({ route, method, error: String(error?.message || error) });
  }
  return res;
};

const cookieFrom = (res) => String(res.getHeader('set-cookie') || '').split(';')[0];

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

const validReportInput = (termsVersion) => ({
  profileKey: 'condition|female|moderate|54',
  termsVersion,
  sections: {
    research: { text: 'Complete research.', profileKey: 'condition|female|moderate|54' },
    repurpose: { text: 'Complete repurpose.', profileKey: 'condition|female|moderate|54' }
  },
  trials: { status: 'complete', profileKey: 'condition|female|moderate|54' },
  audits: {
    validation: {
      research: passingValidation(),
      repurpose: passingValidation()
    },
    citations: { research: { status: 'passed' }, repurpose: { status: 'passed' } },
    coverage: { finalMissed: [] }
  }
});

test('final bounded state-space closure audit', async () => {
  assert.equal(requiredPairs.size, coveredPairs.size, 'pairwise covering array must cover every required pair');
  assert.deepEqual([...requiredPairs].filter((key) => !coveredPairs.has(key)), []);

  const [
    accessApi, alertsCronApi, alertsSubscribeApi, brainCronApi, demoApi,
    healthApi, privateApi, completionApi, researchApi, termsApi, trialsApi,
    accessLib, termsLib, completionLib, boundaryLib, linksLib, emailLib,
    timeoutLib, infraLib, internalLib
  ] = await Promise.all([
    import('../api/access-session.js'), import('../api/alerts-cron.js'),
    import('../api/alerts-subscribe.js'), import('../api/brain-cron.js'),
    import('../api/demo-readiness.js'), import('../api/health.js'),
    import('../api/private-static.js'), import('../api/report-completion.js'),
    import('../api/research.js'), import('../api/terms-consent.js'),
    import('../api/trials.js'), import('../lib/access-gate.js'),
    import('../lib/terms-consent.js'), import('../lib/report-completion.js'),
    import('../lib/request-boundary.js'), import('../lib/report-links.js'),
    import('../lib/alerts-email.js'), import('../lib/fetch-timeout.js'),
    import('../lib/infra-status.js'), import('../lib/internal-call.js')
  ]);
  makeInternalRequest = internalLib.asInternalReq;

  const handlers = {
    '/api/access-session': accessApi.default,
    '/api/alerts-cron': alertsCronApi.default,
    '/api/alerts-subscribe': alertsSubscribeApi.default,
    '/api/brain-cron': brainCronApi.default,
    '/api/demo-readiness': demoApi.default,
    '/api/health': healthApi.default,
    '/api/private-static': privateApi.default,
    '/api/report-completion': completionApi.default,
    '/api/research': researchApi.default,
    '/api/terms-consent': termsApi.default,
    '/api/trials': trialsApi.default
  };

  const accessCookieRes = makeRes();
  assert.equal(accessLib.establishAccessSession('closure-access-code', accessCookieRes), true);
  const termsCookieRes = makeRes();
  assert.equal(termsLib.establishTermsConsent(termsCookieRes), true);
  const accessCookie = cookieFrom(accessCookieRes);
  const termsCookie = cookieFrom(termsCookieRes);
  const authorizedHeaders = { cookie: `${accessCookie}; ${termsCookie}` };
  const accessOnlyHeaders = { cookie: accessCookie };

  for (const [route, handler] of Object.entries(handlers)) {
    for (const method of dimensions.method) {
      const res = await invoke(route, handler, {
        method,
        body: method === 'POST' ? {} : undefined
      });
      if (routeInventory[route].access && method !== 'OPTIONS' && routeInventory[route].methods.includes(method)) {
        assert.equal(res.statusCode, 401, `${route} ${method} must fail closed without access`);
      }
    }
  }

  for (const route of Object.keys(handlers).filter((name) => routeInventory[name].terms)) {
    const method = routeInventory[route].methods.find((item) => item !== 'OPTIONS') || 'GET';
    const res = await invoke(route, handlers[route], {
      method,
      headers: accessOnlyHeaders,
      body: method === 'POST' ? {} : undefined
    });
    assert.equal(res.statusCode, 428, `${route} must require current Terms after access`);
  }

  const foreign = await invoke('/api/research', researchApi.default, {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid' },
    body: { mode: 'runtime-config' }
  });
  assert.equal(foreign.statusCode, 403);

  const unavailableAccessLimiter = await invoke('/api/access-session', accessApi.default, {
    method: 'POST', body: { passcode: 'wrong' }
  });
  assert.equal(unavailableAccessLimiter.statusCode, 503);
  assert.equal(unavailableAccessLimiter.body.code, 'ACCESS_RATE_LIMIT_UNAVAILABLE');
  assert.equal((await invoke('/api/access-session', accessApi.default, {
    method: 'DELETE'
  })).statusCode, 204);

  const termsGet = await invoke('/api/terms-consent', termsApi.default, {
    method: 'GET', headers: authorizedHeaders
  });
  assert.equal(termsGet.statusCode, 200);
  assert.equal(termsGet.body.accepted, true);
  assert.equal((await invoke('/api/terms-consent', termsApi.default, {
    method: 'POST', headers: { cookie: accessCookie },
    body: { accepted: false, termsVersion: termsLib.TERMS_VERSION }
  })).statusCode, 400);

  const runtime = await invoke('/api/research', researchApi.default, {
    method: 'POST', headers: authorizedHeaders, body: { mode: 'runtime-config' }
  });
  assert.equal(runtime.statusCode, 200);

  const completion = await invoke('/api/report-completion', completionApi.default, {
    method: 'POST', headers: authorizedHeaders, body: validReportInput(termsLib.TERMS_VERSION)
  });
  assert.equal(completion.statusCode, 200);
  assert.equal(completion.body.contract.classification, 'full');

  const demo = await invoke('/api/demo-readiness', demoApi.default, {
    method: 'GET', headers: authorizedHeaders, query: { action: 'saved-report' }
  });
  assert.equal(demo.statusCode, 200);
  assert.equal(demo.body.live, false);

  const inventory = await invoke('/api/alerts-subscribe', alertsSubscribeApi.default, {
    method: 'GET', headers: authorizedHeaders, query: { action: 'inventory' }
  });
  assert.equal(inventory.statusCode, 200);

  const brain = await invoke('/api/brain-cron', brainCronApi.default, {
    method: 'GET', headers: { authorization: 'Bearer closure-cron-secret' }
  });
  assert.equal(brain.statusCode, 200);
  assert.equal(brain.body.skipped, true);

  const alertCron = await invoke('/api/alerts-cron', alertsCronApi.default, {
    method: 'GET', headers: { authorization: 'Bearer closure-cron-secret' }
  });
  assert.equal(alertCron.statusCode, 503);
  assert.equal(alertCron.body.code, 'ALERT_DELIVERY_MISCONFIGURED');

  const providerOutcomes = [];
  const originalFetch = globalThis.fetch;
  const providerMocks = {
    success: async () => new Response(JSON.stringify({ studies: [] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }),
    timeout: async () => {
      const error = new Error('fixture timeout');
      error.name = 'TimeoutError';
      error.code = 'ETIMEDOUT';
      error.timedOut = true;
      throw error;
    },
    error: async () => new Response('provider error', { status: 503 }),
    malformed: async () => new Response('{not-json', { status: 200 }),
    cancelled: async () => {
      const error = new Error('caller cancelled');
      error.name = 'AbortError';
      throw error;
    }
  };
  try {
    for (const state of ['success', 'timeout', 'error', 'malformed', 'cancelled']) {
      globalThis.fetch = providerMocks[state];
      const res = await invoke('/api/trials', trialsApi.default, {
        method: 'POST',
        internal: true,
        headers: authorizedHeaders,
        body: {
          condition: 'Closure fixture condition',
          dossier: { canonical: 'Closure fixture condition', synonyms: [], meshTerms: [], topCenters: [] }
        }
      });
      providerOutcomes.push({
        state,
        status: res.statusCode,
        degraded: res.body?.degraded === true,
        reasons: (res.body?.providerErrors || []).map((item) => item.reason)
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body?.degraded === true, state !== 'success');
      if (state === 'cancelled') {
        assert.equal(res.body.status, 'cancelled');
        assert.equal(res.body.cancelled, true);
        assert.ok(res.body.providerErrors.every((item) => item.reason === 'cancelled'));
      }
    }

    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      return call % 2
        ? new Response(JSON.stringify({ studies: [] }), { status: 200 })
        : new Response('partial provider failure', { status: 503 });
    };
    const partial = await invoke('/api/trials', trialsApi.default, {
      method: 'POST',
      internal: true,
      headers: authorizedHeaders,
      body: {
        condition: 'Closure fixture condition',
        dossier: { canonical: 'Closure fixture condition', synonyms: ['Fixture alias'], meshTerms: [], topCenters: [] }
      }
    });
    providerOutcomes.push({
      state: 'partial',
      status: partial.statusCode,
      degraded: partial.body?.degraded === true,
      reasons: (partial.body?.providerErrors || []).map((item) => item.reason)
    });
    assert.equal(partial.statusCode, 200);
    assert.equal(partial.body.degraded, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const reportCartesian = [];
  for (const state of dimensions.reportState) {
    for (const termsState of ['current', 'missing', 'stale-version']) {
      const input = validReportInput(termsLib.TERMS_VERSION);
      let termsAccepted = termsState === 'current';
      if (termsState === 'stale-version') input.termsVersion = 'old';
      if (state === 'degraded') input.trials.status = 'degraded';
      if (state === 'failed') input.audits.citations.research = { status: 'failed' };
      if (state === 'stale') input.sections.research.profileKey = 'old-profile';
      if (state === 'cancelled') input.trials.status = 'cancelled';
      if (state === 'empty') input.sections.research.text = '';
      const contract = completionLib.assessReportCompletion(input, { termsAccepted });
      reportCartesian.push({
        state, termsState, eligible: contract.eligible,
        classification: contract.classification, missing: contract.missing, failed: contract.failed
      });
    }
  }
  assert.equal(reportCartesian.length, dimensions.reportState.length * 3);
  assert.equal(reportCartesian.find((row) => row.state === 'complete' && row.termsState === 'current').classification, 'full');
  assert.equal(reportCartesian.find((row) => row.state === 'degraded' && row.termsState === 'current').classification, 'degraded');
  assert.equal(reportCartesian.find((row) => row.state === 'cancelled' && row.termsState === 'current').classification, 'blocked');

  const boundaryCases = [
    ['unicode', { text: '患者 café 👩🏽‍⚕️ e\u0301' }, 200],
    ['array-root', [], 400],
    ['null-root', null, 400],
    ['circular', null, 400],
    ['deep', { a: { b: { c: 1 } } }, 413],
    ['oversized-declared', {}, 413]
  ];
  const boundaryResults = [];
  for (const [name, initialBody, expected] of boundaryCases) {
    const body = name === 'circular' ? {} : initialBody;
    if (name === 'circular') body.self = body;
    const req = {
      headers: {
        'content-type': 'application/json',
        ...(name === 'oversized-declared' ? { 'content-length': '999' } : {})
      },
      body
    };
    const res = makeRes();
    const accepted = boundaryLib.requireJsonObjectBody(req, res, {
      maxBytes: 128, maxDepth: 1, maxStringBytes: 64
    });
    const status = accepted ? 200 : res.statusCode;
    boundaryResults.push({ name, status, code: res.body?.code || null });
    assert.equal(status, expected, name);
  }

  const contentTypeResults = [];
  for (const contentType of dimensions.contentType) {
    const res = makeRes();
    const headers = contentType === 'missing' ? {} : { 'content-type': contentType };
    const accepted = boundaryLib.requireJsonObjectBody({ headers, body: { ok: true } }, res);
    contentTypeResults.push({ contentType, accepted: Boolean(accepted), status: res.statusCode });
  }
  for (const row of contentTypeResults) {
    const expected = row.contentType === 'application/json' ||
      row.contentType === 'application/json;charset=utf-8';
    assert.equal(row.accepted, expected, `Content-Type acceptance: ${row.contentType}`);
    if (!expected) assert.equal(row.status, 415, `Content-Type rejection: ${row.contentType}`);
  }

  const unsafeHtml = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">open</a>';
  const sanitized = linksLib.sanitizeReportHtml(unsafeHtml, new Set());
  assert.doesNotMatch(sanitized, /<(?:script|img|a)\b/i);
  for (const unsafeUrl of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)',
    'java\u0000script:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)', '%6a%61vascript:alert(1)', '  javascript:alert(1)'
  ]) {
    const emailHtml = emailLib.renderAlertHtml({
      sub: { condition: '<img src=x onerror=1>', patientContext: {} },
      condition: '<script>alert(1)</script>',
      newItems: [{ title: '**Markdown** <svg onload=1>', text: '患者', url: unsafeUrl }],
      trials: [{ nctId: 'NCT00000001', title: 'Trial', url: unsafeUrl }],
      fdaActions: [],
      qualityBreakdown: { totalScreened: 1 },
      unsubscribeUrl: unsafeUrl
    });
    assert.doesNotMatch(emailHtml, /<script\b|<[^>]+\son(?:error|load)\s*=/i);
    assert.doesNotMatch(emailHtml, /href\s*=\s*["'][^"']*(?:javascript|data|vbscript|%6a)/i);
    assert.doesNotMatch(emailHtml, />Unsubscribe</);
  }
  const trustedEmailHtml = emailLib.renderAlertHtml({
    sub: { condition: 'Condition', patientContext: {} },
    condition: 'Condition',
    newItems: [{ title: 'Source', url: 'https://example.org/source' }],
    qualityBreakdown: { totalScreened: 1 },
    unsubscribeUrl: 'https://example.org/unsubscribe?id=abc&token=secret'
  });
  assert.match(trustedEmailHtml, /href="https:\/\/example\.org\/source"/);
  assert.match(trustedEmailHtml, />Unsubscribe</);

  await assert.rejects(
    timeoutLib.fetchWithTimeout('https://provider.invalid', {}, {
      timeoutMs: 5,
      provider: 'Closure fixture',
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    }),
    (error) => timeoutLib.isTimeoutError(error)
  );
  const abort = new AbortController();
  const cancelled = timeoutLib.fetchWithTimeout('https://provider.invalid', { signal: abort.signal }, {
    timeoutMs: 100,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  const cancelReason = new Error('caller cancelled');
  abort.abort(cancelReason);
  await assert.rejects(cancelled, (error) => error === cancelReason);

  const infra = infraLib.getInfraStatus();
  assert.equal(infra.dependencies.redis.state, 'missing');
  assert.equal(infra.emailConfigured, false);

  const frontend = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  const sinkEvidence = {
    'screen-markdown': /renderMarkdown|Markdown/.test(frontend),
    'treatment-card': /const TreatmentCard =/.test(frontend),
    'candidate-card': /const CandidateCard =/.test(frontend),
    'combo-card': /const ComboCard =/.test(frontend),
    'references-tab': /const RefsTab =/.test(frontend),
    'alert-email-html': true,
    'word-doc': /downloadWordDocument/.test(frontend),
    'print-pdf': /printExportDocument/.test(frontend),
    'clipboard-text': /navigator\.clipboard\.writeText/.test(frontend),
    'subscription-json': /exportSubscriptionData/.test(frontend),
    'api-json': true,
    'saved-demo': /saved-report/.test(frontend)
  };
  for (const [sink, found] of Object.entries(sinkEvidence)) {
    if (!found) gaps.push({ critical: true, kind: 'output-sink', sink });
  }

  const criticalRoutes = Object.entries(routeInventory)
    .filter(([, value]) => !value.static)
    .map(([route]) => route);
  for (const route of criticalRoutes) {
    const hit = pathsHit.some((path) => path.route === route);
    if (!hit) gaps.push({ critical: true, kind: 'route-unexecuted', route });
  }
  for (const route of criticalRoutes.filter((name) => routeInventory[name].access)) {
    const blocked = pathsHit.some((path) => path.route === route && path.status === 401);
    if (!blocked) gaps.push({ critical: true, kind: 'access-state-uncovered', route, state: 'missing' });
  }
  for (const route of criticalRoutes.filter((name) => routeInventory[name].terms)) {
    const blocked = pathsHit.some((path) => path.route === route && path.status === 428);
    if (!blocked) gaps.push({ critical: true, kind: 'terms-state-uncovered', route, state: 'missing' });
  }

  assert.ok(
    providerOutcomes.find((row) => row.state === 'cancelled')?.reasons.every((reason) => reason === 'cancelled'),
    'trial provider cancellation must remain distinct from generic provider failure'
  );

  const criticalGaps = gaps.filter((gap) => gap.critical);
  const report = {
    schemaVersion: 1,
    runId: RUN_ID,
    deterministic: true,
    liveOrPaidCalls: false,
    productionFilesEdited: false,
    dimensions,
    routeInventory,
    researchModes,
    reportStages: dimensions.reportStage,
    reportStates: dimensions.reportState,
    providerStates: dimensions.providerState,
    infrastructureStates: {
      redis: dimensions.redisState,
      resend: dimensions.resendState
    },
    supportedContentTypes,
    outputSinks,
    pairwise: {
      algorithm: 'deterministic baseline-expanded all-pairs covering array',
      rows: pairwise,
      requiredPairCount: requiredPairs.size,
      coveredPairCount: coveredPairs.size,
      uncoveredPairs: [...requiredPairs].filter((key) => !coveredPairs.has(key))
    },
    highRiskTriples,
    exhaustiveSmallDomains: {
      reportStateByTermsState: reportCartesian,
      requestBoundaryCases: boundaryResults,
      contentTypes: contentTypeResults
    },
    providerOutcomes,
    sinkEvidence,
    pathsHit,
    gaps,
    defects,
    failures,
    closure: {
      criticalGaps: criticalGaps.length,
      defects: defects.length,
      failures: failures.length,
      passed: criticalGaps.length === 0 && defects.length === 0 && failures.length === 0
    }
  };
  await mkdir(new URL('../.verify-runs/', import.meta.url), { recursive: true });
  await writeFile(REPORT_URL, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  assert.deepEqual(criticalGaps, [], 'uncovered critical route/state pairs remain');
  assert.deepEqual(failures, [], 'production handler executions must not throw');
  assert.deepEqual(defects, [], 'exact production defects remain; see machine-readable closure report');
});
