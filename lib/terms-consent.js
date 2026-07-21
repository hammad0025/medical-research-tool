import { createHmac } from 'node:crypto';
import { INTERNAL_CALL } from './internal-call.js';
import { safeEqual } from './safe-compare.js';
import { RETENTION_SECONDS } from './privacy-governance.js';

export const TERMS_VERSION = '2026-07-18-2';
const COOKIE_NAME = 'mrt_terms_consent';
const CONSENT_TTL_SECONDS = RETENTION_SECONDS.termsConsent;

const productionDeployment = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const signingSecret = () =>
  String(
    process.env.MRT_TERMS_SIGNING_SECRET ||
    process.env.MRT_ACCESS_PASSCODE ||
    (!productionDeployment() ? 'mrt-local-development-terms' : '')
  ).trim();

const parseCookies = (header) => {
  const cookies = Object.create(null);
  for (const rawPart of String(header || '').split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const at = part.indexOf('=');
    const name = at < 0 ? part : part.slice(0, at);
    try {
      cookies[name] = at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
    } catch {
      // Treat malformed percent encodings as an invalid consent cookie.
      cookies[name] = '';
    }
  }
  return cookies;
};

const signatureFor = (version, expiresAt) =>
  createHmac('sha256', signingSecret())
    .update(`${version}\n${expiresAt}`)
    .digest('base64url');

export const isTermsConsentRequired = () => true;

export const isTermsConsentMisconfigured = () =>
  isTermsConsentRequired() && !signingSecret();

export const hasTermsConsent = (req) => {
  if (!signingSecret()) return false;
  const token = parseCookies(req.headers?.cookie)[COOKIE_NAME] || '';
  const match = token.match(/^([0-9-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!match || match[1] !== TERMS_VERSION) return false;
  const expiresAt = Number(match[2]);
  return Number.isSafeInteger(expiresAt) &&
    expiresAt > Date.now() &&
    safeEqual(match[3], signatureFor(match[1], expiresAt));
};

export const establishTermsConsent = (res) => {
  if (!signingSecret()) return false;
  const expiresAt = Date.now() + CONSENT_TTL_SECONDS * 1000;
  const token = `${TERMS_VERSION}.${expiresAt}.${signatureFor(TERMS_VERSION, expiresAt)}`;
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${CONSENT_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`
  );
  return true;
};

export const clearTermsConsent = (res) => {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`
  );
};

export const requireTermsConsent = (req, res) => {
  if (req.method === 'OPTIONS' || req[INTERNAL_CALL] === true) return true;
  if (!productionDeployment() || hasTermsConsent(req)) return true;
  res.setHeader?.('Cache-Control', 'private, no-store, max-age=0');
  if (isTermsConsentMisconfigured()) {
    res.status(503).json({
      error: 'The Terms acceptance service is temporarily unavailable. Please try again later.',
      code: 'TERMS_CONSENT_MISCONFIGURED'
    });
    return false;
  }
  res.status(428).json({
    error: 'Accept the current Terms of Use before using this service.',
    code: 'TERMS_ACCEPTANCE_REQUIRED',
    termsVersion: TERMS_VERSION,
    termsUrl: '/terms'
  });
  return false;
};
