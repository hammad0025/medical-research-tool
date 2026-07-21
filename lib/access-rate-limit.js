import { createHash } from 'node:crypto';
import { RETENTION_SECONDS } from './privacy-governance.js';
import { clientIp } from './client-ip.js';

const WINDOW_SECONDS = RETENTION_SECONDS.accessAttempts;
const MAX_FAILURES = 5;
const MAX_NETWORK_FAILURES = 20;
const MAX_GLOBAL_FAILURES = 100;
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const hasRedis = !!(UPSTASH_URL && UPSTASH_TOKEN);
const memory = globalThis.__mrtAccessFailures || new Map();
globalThis.__mrtAccessFailures = memory;

const requiresDurableStore = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const assertStoreAvailable = () => {
  if (requiresDurableStore() && !hasRedis) {
    const error = new Error('Durable access-attempt enforcement is unavailable');
    error.code = 'DURABLE_ENFORCEMENT_UNAVAILABLE';
    throw error;
  }
};

const digest = (value) =>
  createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 24);

const networkIdentity = (ip) => {
  const value = String(ip || '').toLowerCase();
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255)) {
    return `v4:${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
  }
  if (value.includes(':')) {
    return `v6:${value.split(':').slice(0, 4).join(':')}::/64`;
  }
  return 'unknown';
};

const keysFor = (req) => {
  const ip = clientIp(req);
  return [
    { key: `access-fail:ip:${digest(ip)}`, limit: MAX_FAILURES },
    { key: `access-fail:network:${digest(networkIdentity(ip))}`, limit: MAX_NETWORK_FAILURES },
    { key: 'access-fail:global', limit: MAX_GLOBAL_FAILURES }
  ];
};

const redis = async (command) => {
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`rate-limit store returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error('rate-limit store rejected command');
  return body.result;
};

const pruneMemory = (key, now = Date.now()) => {
  const value = memory.get(key);
  if (value && value.expiresAt <= now) memory.delete(key);
  return memory.get(key) || { count: 0, expiresAt: now + WINDOW_SECONDS * 1000 };
};

export const accessAttemptStatus = async (req) => {
  assertStoreAvailable();
  const keys = keysFor(req);
  if (hasRedis) {
    try {
      const counts = await Promise.all(keys.map(({ key }) => redis(['GET', key])));
      const allowed = keys.every(({ limit }, index) => Number(counts[index] || 0) < limit);
      return {
        allowed,
        remaining: Math.max(0, Math.min(
          ...keys.map(({ limit }, index) => limit - Number(counts[index] || 0))
        ))
      };
    } catch (error) {
      if (String(process.env.NODE_ENV).toLowerCase() === 'production') throw error;
    }
  }
  const entries = keys.map(({ key, limit }) => ({ value: pruneMemory(key), limit }));
  return {
    allowed: entries.every(({ value, limit }) => value.count < limit),
    remaining: Math.max(0, Math.min(...entries.map(({ value, limit }) => limit - value.count)))
  };
};

export const recordAccessFailure = async (req) => {
  assertStoreAvailable();
  const keys = keysFor(req);
  if (hasRedis) {
    try {
      const counts = await Promise.all(keys.map(async ({ key }) => {
        const count = Number(await redis(['INCR', key]) || 0);
        if (count === 1) await redis(['EXPIRE', key, WINDOW_SECONDS]);
        return count;
      }));
      return counts[0];
    } catch (error) {
      if (String(process.env.NODE_ENV).toLowerCase() === 'production') throw error;
    }
  }
  const entries = keys.map(({ key }) => ({ key, value: pruneMemory(key) }));
  for (const { key, value } of entries) {
    value.count += 1;
    memory.set(key, value);
  }
  return entries[0].value.count;
};

export const clearAccessFailures = async (req) => {
  assertStoreAvailable();
  const key = keysFor(req)[0].key;
  memory.delete(key);
  if (hasRedis) await redis(['DEL', key]);
};

export const accessRateLimitConfig = {
  maxFailures: MAX_FAILURES,
  maxNetworkFailures: MAX_NETWORK_FAILURES,
  maxGlobalFailures: MAX_GLOBAL_FAILURES,
  windowSeconds: WINDOW_SECONDS
};
