import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MRT_REPORT_SEAL_SECRET = 'offline-medium-low-report-secret';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RESEND_API_KEY;

const { admitSourceRow } = await import('../lib/source-admission-gate.js');
const {
  alertHtmlToText,
  renderAlertHtml,
  renderAlertSubject
} = await import('../lib/alerts-email.js');
const alertsStore = await import('../lib/alerts-store.js');
const { _alertsCronTest } = await import('../api/alerts-cron.js');
const {
  cachedCompletionForClipboard,
  normalizeTrialStudies,
  trialBooleanLabel
} = await import('../lib/report-surface.js');
const completionHandler = (await import('../api/report-completion.js')).default;
const { loadSavedDemo, sealSavedDemo } = await import('../lib/saved-demo.js');
const { establishTermsConsent, TERMS_VERSION } = await import('../lib/terms-consent.js');

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

test.beforeEach(() => alertsStore._resetForTests());

test('malformed percent-encoded DOI is rejected without escaping the admission boundary', () => {
  assert.doesNotThrow(() => {
    const result = admitSourceRow({
      title: 'Example condition source',
      url: 'https://doi.org/10.1000/bad%ZZ',
      abstract: 'Example condition is directly discussed in this sufficiently detailed source text for admission review.'
    }, { condition: 'Example condition' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INVALID_DOI');
  });
});

test('FDA-only alerts identify the update, link to FDA, and decode ordinary entities', () => {
  const fdaActions = [{
    summary: 'Manufacturer recall',
    url: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm'
  }];
  const subject = renderAlertSubject({
    condition: 'Example condition',
    newItems: [],
    trials: [],
    fdaActions
  });
  const html = renderAlertHtml({
    sub: { condition: 'Example condition' },
    condition: 'Example condition',
    newItems: [],
    trials: [],
    fdaActions,
    unsubscribeUrl: ''
  });
  assert.doesNotMatch(subject, /no updates/i);
  assert.match(subject, /FDA action/);
  assert.doesNotMatch(html, /No new peer-reviewed research/);
  assert.match(html, /accessdata\.fda\.gov/);
  assert.equal(alertHtmlToText('Journal &middot; 2026 &ndash; cited 4&times;'), 'Journal · 2026 – cited 4×');
});

test('alert cron preserves registry titles and authoritative FDA destinations', async () => {
  const sub = {
    id: 'medium-alert',
    email: 'patient@example.test',
    condition: 'Example condition',
    cadence: 'weekly',
    active: true,
    patientContext: null,
    unsubscribeToken: 'unsubscribe-medium-alert',
    ownerToken: 'owner-medium-alert',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastRunAt: null
  };
  await alertsStore.createSubscription(sub);
  let sentMessage;
  const invokeFn = async (_handler, body) => body.limitPerSource
    ? {
        status: 200,
        body: {
          groundedForPrompt: [],
          qualityBreakdown: { totalScreened: 1 },
          fdaManufacturers: [{
            manufacturer: 'Example Pharma',
            enforcementActions: [{
              classification: 'II',
              recallInitiationDate: '2026-07-01',
              reason: 'Example reason'
            }]
          }]
        }
      }
    : {
        status: 200,
        body: {
          studies: [{
            nctId: 'NCT12345678',
            briefTitle: 'Preserved registry trial title',
            status: 'RECRUITING'
          }]
        }
      };
  const result = await _alertsCronTest.oneRun(sub, {
    now: new Date('2026-07-19T12:00:00.000Z'),
    invokeFn,
    sendEmailFn: async (message) => {
      sentMessage = message;
      return { mocked: false, provider: 'fixture', id: 'message-medium-alert' };
    }
  });
  assert.equal(result.sent, true);
  assert.match(sentMessage.html, /Preserved registry trial title/);
  assert.match(sentMessage.html, /accessdata\.fda\.gov/);
  assert.doesNotMatch(sentMessage.subject, /no updates/i);
});

test('malformed nested trial fields normalize safely and missing booleans remain unknown', () => {
  const studies = normalizeTrialStudies([
    {
      nctId: 'NCT12345678',
      phases: { malformed: true },
      countries: 'not-an-array',
      designations: 42,
      oversight: ['bad'],
      eligibilityAssessment: { checks: 'bad' },
      acceptingNewPatients: null,
      hasPlacebo: { malformed: true }
    },
    null,
    'bad'
  ]);
  assert.equal(studies.length, 3);
  assert.deepEqual(studies[0].phases, []);
  assert.deepEqual(studies[0].countries, []);
  assert.deepEqual(studies[0].eligibilityAssessment.checks, []);
  assert.equal(trialBooleanLabel(studies[0].acceptingNewPatients), 'Unknown');
  assert.equal(trialBooleanLabel(studies[0].hasPlacebo, { unknown: 'Not listed' }), 'Not listed');
  assert.equal(trialBooleanLabel(false), 'No');
});

test('clipboard completion uses only current content-bound cached server state', () => {
  const now = 1_750_000_000_000;
  const contract = { eligible: true, seal: `1.${now - 1}.${now + 60_000}.nonce.signature` };
  const cached = { reportContent: 'verified report', contract };
  assert.equal(cachedCompletionForClipboard(cached, 'verified report', now), contract);
  assert.equal(cachedCompletionForClipboard(cached, 'forged report', now), null);
  assert.equal(cachedCompletionForClipboard(cached, 'verified report', now + 60_001), null);
  assert.equal(cachedCompletionForClipboard({
    reportContent: 'verified report',
    contract: { ...contract, eligible: false }
  }, 'verified report', now), null);
});

test('alert pagination cursor persists independently of an invocation query', async () => {
  assert.equal(await alertsStore.getAlertCronCursor(), '0');
  assert.equal(await alertsStore.setAlertCronCursor('42'), '42');
  assert.equal(await alertsStore.getAlertCronCursor(), '42');
  assert.equal(await alertsStore.setAlertCronCursor('malformed'), '0');
  assert.equal(await alertsStore.getAlertCronCursor(), '0');
});

test('server-owned saved demo completes while forged provenance is rejected', async () => {
  const saved = await loadSavedDemo();
  const consent = response();
  assert.equal(establishTermsConsent(consent.res), true);
  const cookie = String(consent.headers.get('set-cookie')).split(';')[0];
  const invoke = async (provenanceSeal) => {
    const out = response();
    await completionHandler({
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      query: {},
      body: {
        surface: 'full',
        termsVersion: TERMS_VERSION,
        savedDemo: { provenanceSeal }
      },
      socket: { remoteAddress: '127.0.0.1' }
    }, out.res);
    return out;
  };
  const valid = await invoke(sealSavedDemo(saved));
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.contract.eligible, true);
  assert.equal(valid.body.contract.label, 'Saved example report — not live');

  const forged = await invoke(`${sealSavedDemo(saved)}forged`);
  assert.equal(forged.status, 409);
  assert.equal(forged.body.code, 'SAVED_DEMO_PROVENANCE_INVALID');
});

test('source and overlay surfaces expose all rows and do not intercept clicks', async () => {
  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  const refs = source.slice(source.indexOf('const RefsTab ='), source.indexOf('/* ==================== Footer'));
  const disclaimer = source.slice(source.indexOf('const StickyDisclaimer ='), source.indexOf('/* ==================== Access gate UI'));
  const copy = source.slice(source.indexOf('const ResearchTab ='), source.indexOf('const trialOrderingBreakdown ='));
  assert.doesNotMatch(refs, /evidencePack\.slice\(0,\s*40\)/);
  assert.match(refs, /evidenceRows\.map/);
  assert.match(refs, /none matched the server-provided source allowlist/);
  assert.match(disclaimer, /pointerEvents:\s*'none'/);
  assert.match(copy, /cachedCompletionForClipboard/);
  const clipboardCall = copy.indexOf('const write = navigator.clipboard.writeText');
  const clickBlock = copy.slice(Math.max(0, clipboardCall - 1200), clipboardCall + 500);
  assert.doesNotMatch(clickBlock, /await\s+getCompletionContract/);
  assert.match(clickBlock, /const write = navigator\.clipboard\.writeText/);
});
