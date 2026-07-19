import { requireAccess } from '../lib/access-gate.js';
import { setSameOriginCors } from '../lib/cors.js';
import {
  assessReportCompletion,
  isReportSealMisconfigured,
  sealReportCompletion,
  verifyReportCompletionSeal
} from '../lib/report-completion.js';
import { hasTermsConsent, requireTermsConsent } from '../lib/terms-consent.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'POST,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAccess(req, res) || !requireTermsConsent(req, res)) return;
  if (isReportSealMisconfigured()) {
    return res.status(503).json({
      error: 'Report sealing is not configured for this deployment.',
      code: 'REPORT_SEAL_CONFIG'
    });
  }

  const body = requireJsonObjectBody(req, res, { maxBytes: 1024 * 1024 });
  if (!body) return;
  const contract = assessReportCompletion(body, {
    termsAccepted: hasTermsConsent(req)
  });
  const now = Date.now();
  const sealed = {
    ...contract,
    issuedAt: new Date(now).toISOString()
  };
  const seal = sealReportCompletion(sealed, { now });
  const verification = verifyReportCompletionSeal({
    contract: sealed,
    seal,
    now
  });
  if (!verification.ok) {
    return res.status(503).json({
      error: 'Report sealing verification failed.',
      code: verification.code || 'REPORT_SEAL_INVALID'
    });
  }
  return res.status(contract.eligible ? 200 : 409).json({
    contract: sealed,
    seal
  });
}
