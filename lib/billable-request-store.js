import { createHash, randomUUID } from 'node:crypto';
import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_TIMEOUT_MS = timeoutFor('redis', 5_000);
const TTL_SECONDS = 24 * 60 * 60;
const LEASE_MS = 5 * 60 * 1000;
const mem = new Map();

const requiresDurableStore = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const assertStore = () => {
  if (requiresDurableStore() && !useUpstash) {
    const error = new Error('Durable idempotency enforcement is unavailable');
    error.code = 'DURABLE_IDEMPOTENCY_UNAVAILABLE';
    throw error;
  }
};

const redis = async (command) => {
  const response = await fetchWithTimeout(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  }, { timeoutMs: REDIS_TIMEOUT_MS, provider: 'Redis idempotency store' });
  if (!response.ok) throw new Error(`Idempotency store HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`Idempotency store error: ${data.error}`);
  return data.result;
};

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
export const fingerprintBillableRequest = (value) =>
  digest(typeof value === 'string' ? value : JSON.stringify(value));

const keyFor = (scope, key) => `idempotency:v1:${digest(scope).slice(0, 24)}:${digest(key)}`;
const parseRecord = (value) => {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};

export const beginBillableRequest = async ({ key, scope, fingerprint, now = Date.now() }) => {
  assertStore();
  const normalizedKey = String(key || '').trim();
  if (normalizedKey.length < 16 || normalizedKey.length > 256) {
    return { state: 'invalid' };
  }
  const storeKey = keyFor(scope, normalizedKey);
  const pending = {
    state: 'pending',
    fingerprint,
    leaseToken: randomUUID(),
    createdAt: new Date(now).toISOString(),
    leaseExpiresAt: now + LEASE_MS
  };
  let existing;
  if (useUpstash) {
    const result = await redis([
      'EVAL',
      `local existing = redis.call('GET', KEYS[1])
       if existing then
         local current = cjson.decode(existing)
         if current.state ~= 'pending' or tonumber(current.leaseExpiresAt or '0') > tonumber(ARGV[3]) then
           return {0, existing}
         end
       end
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
       return {1, ARGV[1]}`,
      '1',
      storeKey,
      JSON.stringify(pending),
      String(TTL_SECONDS),
      String(now)
    ]);
    existing = Number(result?.[0]) === 1 ? null : parseRecord(result?.[1]);
  } else {
    const current = mem.get(storeKey);
    if (
      current &&
      current.expiresAt > now &&
      (current.record.state !== 'pending' || current.record.leaseExpiresAt > now)
    ) {
      existing = current.record;
    } else {
      mem.set(storeKey, { record: pending, expiresAt: now + TTL_SECONDS * 1000 });
    }
  }
  if (!existing) return { state: 'reserved', storeKey, leaseToken: pending.leaseToken };
  if (existing.fingerprint !== fingerprint) return { state: 'conflict' };
  if (existing.state === 'complete') {
    return { state: 'replay', status: existing.status, body: existing.body };
  }
  return { state: 'in-progress' };
};

export const completeBillableRequest = async ({
  storeKey,
  leaseToken,
  fingerprint,
  status,
  body,
  now = Date.now()
}) => {
  assertStore();
  const complete = {
    state: 'complete',
    fingerprint,
    status,
    body,
    completedAt: new Date(now).toISOString()
  };
  if (useUpstash) {
    const result = await redis([
      'EVAL',
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local current = cjson.decode(raw)
       if current.leaseToken ~= ARGV[1] then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
       return 1`,
      '1',
      storeKey,
      leaseToken,
      JSON.stringify(complete),
      String(TTL_SECONDS)
    ]);
    return Number(result) === 1;
  }
  const current = mem.get(storeKey);
  if (!current || current.record.leaseToken !== leaseToken) return false;
  mem.set(storeKey, { record: complete, expiresAt: now + TTL_SECONDS * 1000 });
  return true;
};

export const _resetBillableRequestsForTests = () => mem.clear();
