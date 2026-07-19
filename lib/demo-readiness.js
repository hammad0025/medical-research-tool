import { DEFAULT_RESEARCH_MODEL, MODEL_FALLBACK_CHAIN } from './anthropic-models.js';
import { isAccessGateMisconfigured, isAccessGateEnabled } from './access-gate.js';
import { getInfraStatus, pingUpstash } from './infra-status.js';
import { isReportSealMisconfigured } from './report-completion.js';
import { isTermsConsentMisconfigured, TERMS_VERSION } from './terms-consent.js';

export const DEMO_REQUIRED_ROUTES = Object.freeze([
  '/',
  '/terms',
  '/api/access-session',
  '/api/terms-consent',
  '/api/health',
  '/api/research',
  '/api/trials',
  '/api/report-completion',
  '/api/demo-readiness'
]);

const configuredTemperature = () => {
  const value = Number(process.env.ANTHROPIC_TEMPERATURE);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
};

const check = (id, ok, detail, blocking = true) => ({
  id,
  ok: Boolean(ok),
  blocking,
  detail
});

export const probeAnthropicModel = async ({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = DEFAULT_RESEARCH_MODEL,
  fetchImpl = fetch,
  timeoutMs = 5000
} = {}) => {
  if (!apiKey) return { ok: false, state: 'missing-key', model };
  try {
    const response = await fetchImpl(
      `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    return {
      ok: response.ok,
      state: response.ok ? 'available' : `http-${response.status}`,
      model
    };
  } catch {
    return { ok: false, state: 'unreachable', model };
  }
};

const PUBLIC_PROVIDER_PROBES = Object.freeze({
  clinicalTrials: 'https://clinicaltrials.gov/api/v2/studies?pageSize=1&query.cond=asthma',
  pubmed: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=asthma&retmax=1&retmode=json',
  europePmc: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=asthma&pageSize=1&format=json',
  openAlex: 'https://api.openalex.org/works?search=asthma&per-page=1',
  openFda: 'https://api.fda.gov/drug/label.json?limit=1'
});

export const probePublicMedicalProviders = async ({
  fetchImpl = fetch,
  timeoutMs = 5000
} = {}) => {
  const entries = await Promise.all(Object.entries(PUBLIC_PROVIDER_PROBES).map(async ([name, url]) => {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'medical-research-tool-demo-preflight/1.0' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      return [name, { ok: response.ok, state: response.ok ? 'operational' : `http-${response.status}` }];
    } catch {
      return [name, { ok: false, state: 'unreachable' }];
    }
  }));
  const providers = Object.fromEntries(entries);
  return {
    ok: Object.values(providers).every((provider) => provider.ok),
    providers
  };
};

export const buildDemoReadiness = async ({
  expectedSha,
  live = false,
  modelProbe = probeAnthropicModel,
  redisProbe = pingUpstash,
  publicProviderProbe = probePublicMedicalProviders
} = {}) => {
  const deployedSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
  const reviewedSha = String(expectedSha || '').trim();
  const infra = getInfraStatus();
  const modelConfigured = MODEL_FALLBACK_CHAIN.includes(DEFAULT_RESEARCH_MODEL);
  const localModel = {
    ok: modelConfigured && !!process.env.ANTHROPIC_API_KEY,
    state: 'config-only',
    model: DEFAULT_RESEARCH_MODEL
  };
  const localRedis = {
        ok: infra.dependencies.redis.configured,
        error: infra.dependencies.redis.configured ? undefined : 'not configured'
  };
  const localPublicProviders = {
    ok: true,
    state: 'not-probed',
    required: Object.keys(PUBLIC_PROVIDER_PROBES)
  };
  const [model, redis, publicProviders] = live
    ? await Promise.all([modelProbe(), redisProbe(), publicProviderProbe()])
    : [localModel, localRedis, localPublicProviders];
  const shaOk = /^[a-f0-9]{40}$/i.test(reviewedSha) && deployedSha === reviewedSha;
  const checks = [
    check('deployed-sha', shaOk, {
      expected: reviewedSha || null,
      actual: deployedSha || null
    }),
    check('access-gate', isAccessGateEnabled() && !isAccessGateMisconfigured(), 'production access gate configured'),
    check('terms', !isTermsConsentMisconfigured(), { version: TERMS_VERSION }),
    check('anthropic-key', !!process.env.ANTHROPIC_API_KEY, 'primary report provider configured'),
    check('anthropic-model', model.ok, model),
    check('deterministic-generation', configuredTemperature() === 0, {
      temperature: configuredTemperature(),
      modelFallbackChain: MODEL_FALLBACK_CHAIN
    }),
    check('upstash', redis.ok, redis),
    check('report-seal', !isReportSealMisconfigured(), 'dedicated report seal configured'),
    check('public-medical-providers', publicProviders.ok, publicProviders),
    check('validator-provider', infra.dependencies.perplexity.configured, {
      configured: infra.dependencies.perplexity.configured,
      note: 'Recommended for cross-AI validation; report completion gates still apply.'
    }, false)
  ];
  const blockers = checks.filter((item) => item.blocking && !item.ok);
  return {
    ready: blockers.length === 0,
    mode: live ? 'live-readiness' : 'config-only',
    checkedAt: new Date().toISOString(),
    deploymentSha: deployedSha || null,
    expectedSha: reviewedSha || null,
    requiredRoutes: DEMO_REQUIRED_ROUTES,
    checks,
    blockers: blockers.map((item) => item.id)
  };
};
