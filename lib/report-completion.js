import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TERMS_VERSION } from './terms-consent.js';

export const REPORT_CONTRACT_VERSION = '2026-07-19.1';
export const REPORT_SEAL_PURPOSE = 'report-completion.export';
export const REPORT_SEAL_TTL_MS = 15 * 60 * 1000;
const REPORT_SEAL_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const LOCAL_REPORT_SEAL_SECRET = 'mrt-explicit-local-test-report-seal-v1';

const textPresent = (value) => String(value || '').trim().length > 0;
export const VALIDATION_PASS_SCORE = 80;
const validationPassed = (audit, { allowSavedFixture = false } = {}) => {
  if (audit?.fixture === true) {
    return allowSavedFixture && audit.status === 'passed';
  }
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return false;
  if (audit.status != null && audit.status !== 'passed') return false;
  const primary = audit.primary;
  if (!primary || typeof primary !== 'object' || Array.isArray(primary)) return false;
  if (!Number.isFinite(primary.overallScore) ||
      primary.overallScore < VALIDATION_PASS_SCORE ||
      primary.agreement !== 'high') return false;
  for (const key of [
    'confirmed',
    'disputed',
    'unsupported',
    'hallucinatedCitations',
    'demographicMismatches',
    'missingPerspectives'
  ]) {
    if (!Array.isArray(primary[key])) return false;
  }
  if (!textPresent(primary.overall)) return false;
  return primary.disputed.length === 0 &&
    primary.unsupported.length === 0 &&
    primary.hallucinatedCitations.length === 0 &&
    primary.demographicMismatches.length === 0;
};
const citationPassed = (audit) =>
  audit?.status === 'passed' || audit?.status === 'degraded';
const coveragePassed = (audit) =>
  audit?.status === 'not-applicable' ||
  audit?.status === 'passed' ||
  (Array.isArray(audit?.finalMissed) && audit.finalMissed.length === 0) ||
  (Array.isArray(audit?.initialMissed) && audit.initialMissed.length === 0);

const COMPLETION_MESSAGES = {
  'section:research': 'The condition report is not finished.',
  'section:repurpose': 'The drug and supplement ideas review is not finished.',
  'trials:state': 'The clinical-trial search is not finished.',
  'stale:research': 'The condition report belongs to an earlier profile.',
  'stale:repurpose': 'The drug and supplement ideas belong to an earlier profile.',
  'stale:trials': 'The clinical-trial results belong to an earlier profile.',
  'terms:stale': 'Please accept the current Terms of Use before exporting.',
  'validation:research': 'The condition report did not pass its safety review.',
  'validation:repurpose': 'The drug and supplement ideas did not pass their safety review.',
  'citations:research': 'The condition report still has unverified source links.',
  'citations:repurpose': 'The drug and supplement ideas still have unverified source links.',
  coverage: 'The required treatment coverage review is not finished.',
  'saved-demo:provenance': 'The saved example could not be verified.',
  'trials:degraded': 'Some clinical-trial searches were unavailable, so the trial list may be incomplete.',
  'citations:research': 'Some condition-report sources could not be checked.',
  'citations:repurpose': 'Some drug and supplement idea sources could not be checked.',
  'evidence:degraded': 'Some research sources were unavailable, so this report may be partial.'
};

export const reportCompletionMessage = (code) =>
  COMPLETION_MESSAGES[String(code || '')] || 'Part of the report is not ready.';

export const assessReportCompletion = (input = {}, { termsAccepted = false } = {}) => {
  const profileKey = String(input.profileKey || '');
  const sections = input.sections || {};
  const audits = input.audits || {};
  const trials = input.trials || {};
  const missing = [];
  const failed = [];
  const degraded = [];
  const savedDemo = input.savedDemo && input.savedDemo.kind === 'saved-demo'
    ? {
        kind: 'saved-demo',
        generatedAt: String(input.savedDemo.generatedAt || ''),
        reviewedGitSha: String(input.savedDemo.reviewedGitSha || '')
      }
    : null;

  for (const name of ['research', 'repurpose']) {
    const section = sections[name] || {};
    if (!textPresent(section.text)) missing.push(`section:${name}`);
    if (!profileKey || section.profileKey !== profileKey) failed.push(`stale:${name}`);
  }

  if (!['complete', 'empty', 'degraded'].includes(trials.status)) {
    missing.push('trials:state');
  } else if (trials.profileKey !== profileKey) {
    failed.push('stale:trials');
  } else if (trials.status === 'degraded') {
    degraded.push('trials:degraded');
  }

  if (!termsAccepted || input.termsVersion !== TERMS_VERSION) failed.push('terms:stale');

  for (const name of ['research', 'repurpose']) {
    if (!validationPassed(audits.validation?.[name], {
      allowSavedFixture: !!savedDemo
    })) failed.push(`validation:${name}`);
    if (!citationPassed(audits.citations?.[name])) failed.push(`citations:${name}`);
    if (audits.citations?.[name]?.status === 'degraded') degraded.push(`citations:${name}`);
  }
  if (!coveragePassed(audits.coverage)) failed.push('coverage');

  if (input.evidenceDegraded) degraded.push('evidence:degraded');
  if (savedDemo && (
    !/^\d{4}-\d{2}-\d{2}T/.test(savedDemo.generatedAt) ||
    !/^[a-f0-9]{40}$/i.test(savedDemo.reviewedGitSha)
  )) failed.push('saved-demo:provenance');
  const eligible = missing.length === 0 && failed.length === 0;
  const classification = eligible
    ? (degraded.length ? 'degraded' : 'full')
    : 'blocked';

  return {
    version: REPORT_CONTRACT_VERSION,
    termsVersion: TERMS_VERSION,
    profileKey,
    eligible,
    classification,
    missing,
    failed,
    degraded,
    missingMessages: missing.map(reportCompletionMessage),
    failedMessages: failed.map(reportCompletionMessage),
    coverageMessages: degraded.map(reportCompletionMessage),
    provenance: savedDemo,
    label: savedDemo && eligible
      ? 'Saved example report — not live'
      : classification === 'full'
        ? 'Complete report'
      : classification === 'degraded'
        ? 'Report with partial source coverage'
        : 'Report not ready to export'
  };
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
};

const stableJson = (value) => JSON.stringify(stableValue(value));

const explicitLocalOrTestMode = () => {
  const vercelEnvironment = String(process.env.VERCEL_ENV || '').toLowerCase();
  if (['production', 'preview'].includes(vercelEnvironment)) return false;
  return ['development', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase()) ||
    vercelEnvironment === 'development';
};

const signingSecret = (override) => {
  const dedicated = String(override || process.env.MRT_REPORT_SEAL_SECRET || '').trim();
  if (dedicated) return dedicated;
  return explicitLocalOrTestMode() ? LOCAL_REPORT_SEAL_SECRET : '';
};

export const isReportSealMisconfigured = () => !signingSecret();

const configurationError = () => {
  const error = new Error('MRT_REPORT_SEAL_SECRET is required outside explicit local/test mode');
  error.code = 'REPORT_SEAL_CONFIG';
  return error;
};

const normalizePurpose = (purpose) => {
  const value = String(purpose || '').trim();
  if (!/^[a-z][a-z0-9.-]{2,80}$/.test(value)) {
    const error = new Error('Invalid report-seal purpose');
    error.code = 'REPORT_SEAL_PURPOSE';
    throw error;
  }
  return value;
};

const purposeKey = (secret, purpose) =>
  createHmac('sha256', secret)
    .update(`mrt/report-seal/key/v${REPORT_SEAL_VERSION}\0${purpose}`)
    .digest();

const signaturePayload = ({ contract, purpose, issuedAt, expiresAt, nonce }) =>
  [
    `mrt/report-seal/v${REPORT_SEAL_VERSION}`,
    purpose,
    String(issuedAt),
    String(expiresAt),
    nonce,
    stableJson(contract)
  ].join('\n');

const signatureFor = ({ contract, purpose, issuedAt, expiresAt, nonce, secret }) =>
  createHmac('sha256', purposeKey(secret, purpose))
    .update(signaturePayload({ contract, purpose, issuedAt, expiresAt, nonce }))
    .digest('base64url');

export const sealReportCompletion = (contract, {
  purpose = REPORT_SEAL_PURPOSE,
  now = Date.now(),
  ttlMs = REPORT_SEAL_TTL_MS,
  secret,
  nonce
} = {}) => {
  const key = signingSecret(secret);
  if (!key) throw configurationError();
  const normalizedPurpose = normalizePurpose(purpose);
  const issuedAt = Number(now);
  const lifetime = Number(ttlMs);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(lifetime) ||
    lifetime <= 0 ||
    lifetime > REPORT_SEAL_TTL_MS
  ) {
    throw new Error('Invalid report-seal lifetime');
  }
  const expiresAt = issuedAt + lifetime;
  const tokenNonce = nonce == null
    ? randomBytes(16).toString('base64url')
    : String(nonce);
  if (!/^[A-Za-z0-9_-]{22}$/.test(tokenNonce)) {
    throw new Error('Invalid report-seal nonce');
  }
  const signature = signatureFor({
    contract,
    purpose: normalizedPurpose,
    issuedAt,
    expiresAt,
    nonce: tokenNonce,
    secret: key
  });
  return `${REPORT_SEAL_VERSION}.${issuedAt}.${expiresAt}.${tokenNonce}.${signature}`;
};

export const verifyReportCompletionSeal = ({
  contract,
  seal,
  purpose = REPORT_SEAL_PURPOSE,
  now = Date.now(),
  secret
} = {}) => {
  const key = signingSecret(secret);
  if (!key) return { ok: false, code: 'REPORT_SEAL_CONFIG' };
  let normalizedPurpose;
  try {
    normalizedPurpose = normalizePurpose(purpose);
  } catch {
    return { ok: false, code: 'REPORT_SEAL_PURPOSE' };
  }
  const match = String(seal || '').match(
    /^1\.(\d{10,16})\.(\d{10,16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/
  );
  if (!match) return { ok: false, code: 'REPORT_SEAL_INVALID' };
  const issuedAt = Number(match[1]);
  const expiresAt = Number(match[2]);
  const checkedAt = Number(now);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(checkedAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > REPORT_SEAL_TTL_MS ||
    issuedAt > checkedAt + MAX_CLOCK_SKEW_MS ||
    checkedAt > expiresAt
  ) {
    return { ok: false, code: 'REPORT_SEAL_EXPIRED' };
  }
  const expected = Buffer.from(signatureFor({
    contract,
    purpose: normalizedPurpose,
    issuedAt,
    expiresAt,
    nonce: match[3],
    secret: key
  }));
  const supplied = Buffer.from(match[4]);
  const ok = expected.length === supplied.length && timingSafeEqual(expected, supplied);
  return ok
    ? { ok: true, purpose: normalizedPurpose, issuedAt, expiresAt }
    : { ok: false, code: 'REPORT_SEAL_INVALID' };
};
