import {
  clearAccessSession,
  establishAccessSession,
  isAccessGateEnabled,
  isAccessGateMisconfigured
} from '../lib/access-gate.js';
import {
  accessAttemptStatus,
  accessRateLimitConfig,
  clearAccessFailures,
  recordAccessFailure
} from '../lib/access-rate-limit.js';
import { setSameOriginCors } from '../lib/cors.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (!setSameOriginCors(req, res, {
    methods: 'POST,DELETE,OPTIONS',
    headers: 'Content-Type'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }

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
      error: 'This private preview is temporarily unavailable.',
      code: 'ACCESS_GATE_MISCONFIGURED'
    });
  }
  if (!isAccessGateEnabled()) {
    return res.status(200).json({ ok: true, gateEnabled: false });
  }
  const body = requireJsonObjectBody(req, res, { maxBytes: 4 * 1024, allowEmpty: true });
  if (!body) return;
  try {
    const attempt = await accessAttemptStatus(req);
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(accessRateLimitConfig.windowSeconds));
      clearAccessSession(res);
      return res.status(429).json({
        error: 'Too many rejected access attempts. Try again later.',
        code: 'ACCESS_RATE_LIMITED'
      });
    }
  } catch {
    clearAccessSession(res);
    return res.status(503).json({
      error: 'Access verification is temporarily unavailable.',
      code: 'ACCESS_RATE_LIMIT_UNAVAILABLE'
    });
  }
  if (!establishAccessSession(body.passcode, res)) {
    try {
      await recordAccessFailure(req);
    } catch {
      clearAccessSession(res);
      return res.status(503).json({
        error: 'Access verification is temporarily unavailable.',
        code: 'ACCESS_RATE_LIMIT_UNAVAILABLE'
      });
    }
    clearAccessSession(res);
    return res.status(401).json({
      error: 'That access code was not recognized. Check it and try again.',
      code: 'ACCESS_GATE_BLOCKED'
    });
  }
  try {
    await clearAccessFailures(req);
  } catch {
    clearAccessSession(res);
    return res.status(503).json({
      error: 'Access verification is temporarily unavailable.',
      code: 'ACCESS_RATE_LIMIT_UNAVAILABLE'
    });
  }
  return res.status(200).json({ ok: true, gateEnabled: true });
}
