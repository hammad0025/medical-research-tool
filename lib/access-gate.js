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
// its own CRON_SECRET, and the consolidated `research.js` invokes peer
// handlers in-process (no HTTP) so the inner handlers never see a request
// that needs gating.

const rawPasscodes = String(process.env.MRT_ACCESS_PASSCODE || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const validPasscodes = new Set(rawPasscodes);

export const isAccessGateEnabled = () => validPasscodes.size > 0;

const extractPasscode = (req) => {
  const header = req.headers?.['x-access-passcode'];
  if (header) return String(Array.isArray(header) ? header[0] : header).trim();
  const bodyVal = req.body?.accessPasscode;
  if (bodyVal) return String(bodyVal).trim();
  const queryVal = req.query?.accessPasscode;
  if (queryVal) return String(queryVal).trim();
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
