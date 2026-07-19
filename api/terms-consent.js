import { requireAccess } from '../lib/access-gate.js';
import { setSameOriginCors } from '../lib/cors.js';
import {
  clearTermsConsent,
  establishTermsConsent,
  hasTermsConsent,
  isTermsConsentMisconfigured,
  isTermsConsentRequired,
  TERMS_VERSION
} from '../lib/terms-consent.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'GET,POST,DELETE,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAccess(req, res)) return;

  if (req.method === 'DELETE') {
    clearTermsConsent(res);
    return res.status(204).end();
  }

  const required = isTermsConsentRequired();
  if (req.method === 'GET') {
    return res.status(200).json({
      required,
      accepted: hasTermsConsent(req),
      termsVersion: TERMS_VERSION,
      termsUrl: '/terms'
    });
  }

  if (isTermsConsentMisconfigured()) {
    return res.status(503).json({
      error: 'The Terms acceptance service is temporarily unavailable. Please try again later.',
      code: 'TERMS_CONSENT_MISCONFIGURED'
    });
  }
  const body = requireJsonObjectBody(req, res, { maxBytes: 4 * 1024 });
  if (!body) return;
  if (body.accepted !== true || body.termsVersion !== TERMS_VERSION) {
    return res.status(400).json({
      error: 'Explicit acceptance of the current Terms of Use is required.',
      code: 'TERMS_ACCEPTANCE_INVALID',
      termsVersion: TERMS_VERSION
    });
  }
  if (required && !establishTermsConsent(res)) {
    return res.status(503).json({
      error: 'We could not record your Terms acceptance. Please try again later.',
      code: 'TERMS_CONSENT_MISCONFIGURED'
    });
  }
  return res.status(200).json({
    ok: true,
    required,
    accepted: true,
    termsVersion: TERMS_VERSION,
    termsUrl: '/terms'
  });
}
