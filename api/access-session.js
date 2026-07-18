import {
  clearAccessSession,
  establishAccessSession,
  isAccessGateEnabled,
  isAccessGateMisconfigured
} from '../lib/access-gate.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'DELETE') {
    clearAccessSession(res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (isAccessGateMisconfigured()) {
    return res.status(503).json({
      error: 'Access control is not configured for this deployment.',
      code: 'ACCESS_GATE_MISCONFIGURED'
    });
  }
  if (!isAccessGateEnabled()) {
    return res.status(200).json({ ok: true, gateEnabled: false });
  }
  if (!establishAccessSession(req.body?.passcode, res)) {
    clearAccessSession(res);
    return res.status(401).json({
      error: 'Access passcode rejected.',
      code: 'ACCESS_GATE_BLOCKED'
    });
  }
  return res.status(200).json({ ok: true, gateEnabled: true });
}
