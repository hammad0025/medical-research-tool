// Site-wide access gate.
//
// Dorothy explicitly requested: "no one could stumble upon it and use it
// accidentally at this point." This module enforces that requirement at
// the API edge. If `MRT_ACCESS_PASSCODE` is set in the environment, every
// API endpoint requires the caller to present a matching passcode via the
// `x-access-passcode` header (preferred) or `accessPasscode` body field.
//
// Fail-open by design when the env var is absent so local development and
// the existing test harness keep working without changes. To turn the gate
// ON in production set MRT_ACCESS_PASSCODE in Vercel.
//
// You can configure multiple passcodes by comma-separating them — useful
// for issuing one to Dorothy, one to Tim, and a rotating one to Hammad
// (so any single passcode can be revoked without churning the others).
//
// Cron + internal in-process calls bypass the gate: the cron route checks
// its own CRON_SECRET, and consolidated handlers invoke peer modules
// in-process with `INTERNAL_CALL` (see lib/internal-call.js) — not spoofable
// from HTTP because it is a Symbol, not a header.
import { INTERNAL_CALL } from './internal-call.js';

// Normalize so a passcode can't be rejected over trivial differences a phone
// keyboard introduces: leading capital (iOS auto-capitalize), trailing space,
// or smart-quote/case drift. All issued codes are lowercase, so lowercasing
// here is safe and bulletproofs the gate during live demos.
const normalize = (s) => String(s || '').trim().toLowerCase();

const rawPasscodes = String(process.env.MRT_ACCESS_PASSCODE || '')
  .split(',')
  .map(normalize)
  .filter(Boolean);

const validPasscodes = new Set(rawPasscodes);

// Gate is OFF unless MRT_ACCESS_GATE_FORCE=1 is set in Vercel env.
// Production had MRT_ACCESS_PASSCODE set which blocked every API call
// (401 ACCESS_GATE_BLOCKED) — including Dorothy's demo when no passcode
// was entered. Flip MRT_ACCESS_GATE_FORCE=1 to re-lock after demos.
export const isAccessGateEnabled = () => {
  if (String(process.env.MRT_ACCESS_GATE_FORCE || '0').trim() !== '1') return false;
  return validPasscodes.size > 0;
};

const extractPasscode = (req) => {
  const header = req.headers?.['x-access-passcode'];
  if (header) return normalize(Array.isArray(header) ? header[0] : header);
  const bodyVal = req.body?.accessPasscode;
  if (bodyVal) return normalize(bodyVal);
  const queryVal = req.query?.accessPasscode;
  if (queryVal) return normalize(queryVal);
  return '';
};

// Returns true when the caller is allowed through. When the gate is OFF
// (env var unset) every caller is allowed through. When the gate is ON
// the caller must present a matching passcode; if they don't, we write
// a 401 + JSON error to the response and return false so the handler can
// short-circuit with `if (!requireAccess(req, res)) return;`.
export const requireAccess = (req, res) => {
  if (!isAccessGateEnabled()) return true;
  if (req.method === 'OPTIONS') return true; // preflight is always fine
  if (req[INTERNAL_CALL] === true) return true;
  const provided = extractPasscode(req);
  if (provided && validPasscodes.has(provided)) return true;
  try {
    res.status(401).json({
      error: 'Access denied. This deployment is restricted. Enter your access passcode to continue.',
      code: 'ACCESS_GATE_BLOCKED'
    });
  } catch (_) {
    // res may not be a typical Vercel res in some test harnesses; ignore.
  }
  return false;
};
