import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPlainObject, stableJson } from './stable-serialize.js';

const MAX_POOL_BYTES = 2_500_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const configuredSecret = () =>
  String(process.env.MRT_GATHER_SIGNING_SECRET || process.env.MRT_ACCESS_PASSCODE || '').trim();

const productionLike = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const getSecret = (override) => {
  const secret = String(override || configuredSecret()).trim();
  if (secret) return secret;
  if (productionLike()) return '';
  return 'mrt-local-development-gather-seal';
};

const poolPayload = ({ gatherFingerprint, dossier, evidence, trials, issuedAt }) => ({
  version: 1,
  issuedAt,
  gatherFingerprint: String(gatherFingerprint || ''),
  pools: {
    dossier: dossier || null,
    evidence: evidence || null,
    trials: trials || null
  }
});

const sign = (payload, secret) =>
  createHmac('sha256', secret).update(stableJson(payload)).digest('base64url');

export const validateGatherPoolsShape = ({ dossier, evidence, trials } = {}) => {
  if (dossier != null && !isPlainObject(dossier)) return { ok: false, error: 'dossier must be an object' };
  if (evidence != null && !isPlainObject(evidence)) return { ok: false, error: 'evidence must be an object' };
  if (trials != null && !isPlainObject(trials)) return { ok: false, error: 'trials must be an object' };
  if (evidence?.groundedForPrompt != null && !Array.isArray(evidence.groundedForPrompt)) {
    return { ok: false, error: 'evidence.groundedForPrompt must be an array' };
  }
  if (evidence?.topRanked != null && !Array.isArray(evidence.topRanked)) {
    return { ok: false, error: 'evidence.topRanked must be an array' };
  }
  if (trials?.studies != null && !Array.isArray(trials.studies)) {
    return { ok: false, error: 'trials.studies must be an array' };
  }
  const bytes = Buffer.byteLength(stableJson({ dossier, evidence, trials }), 'utf8');
  if (bytes > MAX_POOL_BYTES) return { ok: false, error: 'gather pools exceed size limit' };
  return { ok: true };
};

export const createGatherSeal = ({
  gatherFingerprint,
  dossier,
  evidence,
  trials,
  now = Date.now(),
  secret
} = {}) => {
  const key = getSecret(secret);
  if (!key) throw new Error('MRT_GATHER_SIGNING_SECRET is required in production');
  const shape = validateGatherPoolsShape({ dossier, evidence, trials });
  if (!shape.ok) throw new Error(shape.error);
  const payload = poolPayload({ gatherFingerprint, dossier, evidence, trials, issuedAt: now });
  return `${payload.version}.${payload.issuedAt}.${sign(payload, key)}`;
};

export const verifyGatherSeal = ({
  seal,
  gatherFingerprint,
  dossier,
  evidence,
  trials,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  secret
} = {}) => {
  const key = getSecret(secret);
  if (!key) return { ok: false, code: 'GATHER_SEAL_CONFIG' };
  const match = String(seal || '').match(/^1\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return { ok: false, code: 'GATHER_SEAL_INVALID' };
  const issuedAt = Number(match[1]);
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > ttlMs) {
    return { ok: false, code: 'GATHER_SEAL_EXPIRED' };
  }
  const shape = validateGatherPoolsShape({ dossier, evidence, trials });
  if (!shape.ok) return { ok: false, code: 'GATHER_POOL_INVALID', error: shape.error };
  const payload = poolPayload({ gatherFingerprint, dossier, evidence, trials, issuedAt });
  const expected = Buffer.from(sign(payload, key));
  const supplied = Buffer.from(match[2]);
  const ok = expected.length === supplied.length && timingSafeEqual(expected, supplied);
  return ok ? { ok: true } : { ok: false, code: 'GATHER_SEAL_INVALID' };
};
