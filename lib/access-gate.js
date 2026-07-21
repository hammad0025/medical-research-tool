// Site-wide access gate.
//
// Dorothy mandate: private preview only — nobody who stumbles on the link
// should be able to use the product. When `MRT_ACCESS_PASSCODE` is set,
// every API endpoint requires a matching passcode via `x-access-passcode`.
//
// Gate is ON whenever at least one passcode is configured. Local dev and
// the test harness leave `MRT_ACCESS_PASSCODE` unset so the gate stays off.
// Do NOT re-introduce a "force" opt-in that leaves production open while
// the passcode env var is set — that is exactly how the site was left
// world-readable after a demo.
//
// Multiple passcodes: comma-separate them (Dorothy / Hammad / rotating).
//
// Cron + internal in-process calls bypass the gate: the cron route checks
// its own CRON_SECRET, and consolidated handlers invoke peer modules
// in-process with `INTERNAL_CALL` (see lib/internal-call.js) — not spoofable
// from HTTP because it is a Symbol, not a header.
import { INTERNAL_CALL } from './internal-call.js';
import { normalizePasscode as normalize } from './normalize.js';
import { createHmac } from 'node:crypto';
import { safeEqual } from './safe-compare.js';

// Normalize so a passcode can't be rejected over trivial differences a phone
// keyboard introduces: leading capital (iOS auto-capitalize), trailing space,
// or smart-quote/case drift. All issued codes are lowercase, so lowercasing
// here is safe and bulletproofs the gate during live demos.

const rawPasscodes = String(process.env.MRT_ACCESS_PASSCODE || '')
  .split(',')
  .map(normalize)
  .filter(Boolean);

const validPasscodes = new Set(rawPasscodes);
const SESSION_COOKIE = 'mrt_access_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const sessionSigningKey = createHmac('sha256', 'mrt-access-session-v1')
  .update(rawPasscodes.join('\n'))
  .digest();

const deploymentRequiresGate = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

/** True when production/preview has at least one configured passcode. */
export const isAccessGateEnabled = () => validPasscodes.size > 0;
export const isAccessGateMisconfigured = () =>
  deploymentRequiresGate() && !isAccessGateEnabled();

const extractPasscode = (req) => {
  const header = req.headers?.['x-access-passcode'];
  if (header) return normalize(Array.isArray(header) ? header[0] : header);
  return '';
};

const signExpiry = (expiresAt) =>
  createHmac('sha256', sessionSigningKey).update(String(expiresAt)).digest('base64url');

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
      // Malformed percent encodings are invalid cookie values, not route errors.
      cookies[name] = '';
    }
  }
  return cookies;
};

const hasValidSession = (req) => {
  if (!isAccessGateEnabled()) return false;
  const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE] || '';
  const match = token.match(/^(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  return Number.isSafeInteger(expiresAt) &&
    expiresAt > Date.now() &&
    safeEqual(match[2], signExpiry(expiresAt));
};

const hasAuthorizedAccess = (req) => {
  if (!isAccessGateEnabled()) return false;
  if (req?.[INTERNAL_CALL] === true) return true;
  if (hasValidSession(req)) return true;
  const provided = extractPasscode(req);
  return Boolean(provided && validPasscodes.has(provided));
};

export const isPrivatePreviewUnlimited = (req) =>
  String(process.env.MRT_PRIVATE_PREVIEW_UNLIMITED || '').trim() === '1' &&
  hasAuthorizedAccess(req);

export const establishAccessSession = (passcode, res) => {
  const supplied = normalize(passcode);
  if (!supplied || !validPasscodes.has(supplied)) return false;
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const token = `${expiresAt}.${signExpiry(expiresAt)}`;
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  return true;
};

export const clearAccessSession = (res) => {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
};

// Returns true when the caller is allowed through. When the gate is OFF
// (env var unset) every caller is allowed through. When the gate is ON
// the caller must present a matching passcode; if they don't, we write
// a 401 + JSON error to the response and return false so the handler can
// short-circuit with `if (!requireAccess(req, res)) return;`.
export const requireAccess = (req, res) => {
  res.setHeader?.('Cache-Control', 'private, no-store, max-age=0');
  if (req.method === 'OPTIONS') return true; // preflight is always fine
  if (req[INTERNAL_CALL] === true) return true;
  if (isAccessGateMisconfigured()) {
    res.status(503).json({
      error: 'This private preview is temporarily unavailable.',
      code: 'ACCESS_GATE_MISCONFIGURED'
    });
    return false;
  }
  if (!isAccessGateEnabled()) return true;
  if (hasAuthorizedAccess(req)) return true;
  try {
    res.status(401).json({
      error: 'This is a private preview. Enter your access code to continue.',
      code: 'ACCESS_GATE_BLOCKED'
    });
  } catch (_) {
    // res may not be a typical Vercel res in some test harnesses; ignore.
  }
  return false;
};
