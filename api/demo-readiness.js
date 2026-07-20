import { requireAccess } from '../lib/access-gate.js';
import { setSameOriginCors } from '../lib/cors.js';
import { buildDemoReadiness } from '../lib/demo-readiness.js';
import { loadSavedDemo, sealSavedDemo } from '../lib/saved-demo.js';
import { requireTermsConsent } from '../lib/terms-consent.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'GET,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAccess(req, res) || !requireTermsConsent(req, res)) return;

  const action = String(req.query?.action || 'preflight');
  if (action === 'saved-report') {
    const report = await loadSavedDemo();
    return res.status(200).json({
      ...report,
      provenanceSeal: sealSavedDemo(report),
      servedAt: new Date().toISOString(),
      live: false
    });
  }
  if (action !== 'preflight') {
    return res.status(400).json({ error: 'Unsupported demo-readiness action', code: 'INVALID_ACTION' });
  }

  const expectedSha = String(req.query?.expectedSha || '');
  const live = String(req.query?.live || '') === '1';
  const readiness = await buildDemoReadiness({ expectedSha, live });
  return res.status(readiness.ready ? 200 : 503).json(readiness);
}
