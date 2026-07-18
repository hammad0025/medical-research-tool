import { timingSafeEqual } from 'node:crypto';

const equalSecret = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};

export const authorizeCron = (req, expected = process.env.CRON_SECRET) => {
  const secret = String(expected || '').trim();
  if (!secret) return { ok: false, code: 'CRON_SECRET_MISCONFIGURED', status: 503 };
  const auth = Array.isArray(req.headers?.authorization)
    ? req.headers.authorization[0]
    : String(req.headers?.authorization || '');
  const prefix = 'Bearer ';
  const supplied = auth.startsWith(prefix) ? auth.slice(prefix.length) : '';
  return equalSecret(supplied, secret)
    ? { ok: true }
    : { ok: false, code: 'CRON_UNAUTHORIZED', status: 401 };
};
