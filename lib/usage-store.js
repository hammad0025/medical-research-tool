// Monthly usage + plan store (IP-based).
//
// Goal:
// - Enforce "first 4 free per IP per month"
// - Pro / Max paid tiers with higher monthly caps
// - Keep the gate server-side (frontend can never bypass it)
//
// Backends:
//   1) Upstash Redis REST (durable) when UPSTASH_* is configured
//   2) In-memory Map fallback (ephemeral; local dev/tests)
//
// Redis key layout:
//   usage:<YYYY-MM>:<ipKey>   -> hash { count, plan }
//   usage:plan-ip:<ipKey>     -> "pro" | "max" (persistent plan flag)
//
// Backward compat:
//   - Legacy hash field `paid=1` is treated as plan=pro
//   - MRT_PAID_* env vars map to the Pro tier
//   - MRT_PAID_CODES activate Pro (same as MRT_PRO_CODES)
//
// Notes:
// - We intentionally meter only the *entry* call of a run in api/research
//   (phase=all or phase=gather) so split synthesis calls don't double-charge.

import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';
import { appendSecurityAudit } from './security-enforcement.js';
import { RETENTION_SECONDS } from './privacy-governance.js';

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_TIMEOUT_MS = timeoutFor('redis', 5_000);
const USAGE_RETENTION_SECONDS = RETENTION_SECONDS.usageCounters;
const PLAN_RETENTION_SECONDS = RETENTION_SECONDS.usagePlan;
const AUDIT_RETENTION_SECONDS = RETENTION_SECONDS.securityAudit;

const requiresDurableStore = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const assertStoreAvailable = () => {
  if (requiresDurableStore() && !useUpstash) {
    const error = new Error('Durable usage enforcement is unavailable');
    error.code = 'DURABLE_ENFORCEMENT_UNAVAILABLE';
    throw error;
  }
};

const finiteConfig = (names, fallback, { integer = false } = {}) => {
  const configured = names.map((name) => process.env[name]).find((value) => value != null && String(value).trim() !== '');
  if (configured == null) return fallback;
  const value = Number(configured);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) return 0;
  return value;
};

// Invalid configured limits fail closed at zero. This prevents NaN/Infinity
// from silently turning a quota into unlimited access.
const FREE_LIMIT = finiteConfig(['MRT_FREE_LIMIT'], 4, { integer: true });
const PRO_LIMIT = finiteConfig(['MRT_PRO_LIMIT', 'MRT_PAID_LIMIT'], 100, { integer: true });
const MAX_LIMIT = finiteConfig(['MRT_MAX_LIMIT'], 500, { integer: true });
const PRO_PRICE_USD = finiteConfig(['MRT_PRO_PRICE_USD', 'MRT_PAID_PRICE_USD'], 20);
const MAX_PRICE_USD = finiteConfig(['MRT_MAX_PRICE_USD'], 79);

const PLAN_LIMITS = { free: FREE_LIMIT, pro: PRO_LIMIT, max: MAX_LIMIT };
const PLAN_RANK = { free: 0, pro: 1, max: 2 };

const alwaysMaxIps = new Set(
  String(process.env.MRT_PAID_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const proCodes = new Set(
  [
    ...String(process.env.MRT_PRO_CODES || '').split(','),
    ...String(process.env.MRT_PAID_CODES || '').split(',')
  ]
    .map((s) => s.trim())
    .filter(Boolean)
);

const maxCodes = new Set(
  String(process.env.MRT_MAX_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const DEV_LIMIT = 999999;
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

const normalizePlan = (plan) => {
  const p = String(plan || 'free').trim().toLowerCase();
  if (p === 'paid') return 'pro';
  return PLAN_LIMITS[p] != null ? p : 'free';
};

const higherPlan = (a, b) => (PLAN_RANK[normalizePlan(a)] >= PLAN_RANK[normalizePlan(b)] ? normalizePlan(a) : normalizePlan(b));

const nowMonth = () => {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
};

const ipKey = (ip) => String(ip || 'unknown').trim().toLowerCase();

// Explicit emergency kill-switch. Missing or malformed configuration keeps
// metering enabled (fail closed), including in production.
const usageLimitsDisabled = () =>
  String(process.env.MRT_DISABLE_USAGE_LIMIT ?? '0').trim() === '1';

/** True when monthly per-IP metering should not block. */
export const isUsageLimitBypassed = (ip) => {
  if (requiresDurableStore()) return false;
  if (usageLimitsDisabled()) return true;
  if (process.env.VERCEL_ENV === 'development') return true;
  if (process.env.NODE_ENV === 'development') return true;
  if (String(process.env.MRT_SKIP_USAGE_LIMIT || '').trim() === '1') return true;
  return LOCALHOST_IPS.has(ipKey(ip));
};

const devUsageSnapshot = (ip) => ({
  month: nowMonth(),
  ip: ipKey(ip),
  used: 0,
  limit: DEV_LIMIT,
  remaining: DEV_LIMIT,
  plan: 'dev',
  paid: false,
  unlimited: true
});

const upstash = async (command) => {
  if (!useUpstash) throw new Error('Upstash not configured');
  const r = await fetchWithTimeout(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  }, { timeoutMs: REDIS_TIMEOUT_MS, provider: 'Redis' });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Upstash ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  if (data.error) throw new Error(`Upstash error: ${data.error}`);
  return data.result;
};

const mem = {
  usageByMonthIp: new Map(), // `${month}:${ip}` -> { count, plan }
  planByIp: new Map() // ip -> plan
};

const readUsage = async (month, ip) => {
  assertStoreAvailable();
  const key = `${month}:${ip}`;
  if (useUpstash) {
    const raw = await upstash(['HMGET', `usage:${key}`, 'count', 'plan', 'paid']);
    const rawCount = (raw && raw[0]) ?? '0';
    const parsedCount = Number(rawCount);
    const countValid = Number.isSafeInteger(parsedCount) && parsedCount >= 0;
    const count = countValid ? parsedCount : null;
    const planField = (raw && raw[1]) || '';
    const legacyPaid = String((raw && raw[2]) || '0') === '1';
    const plan = planField ? normalizePlan(planField) : (legacyPaid ? 'pro' : 'free');
    return { count, countValid, plan };
  }
  const v = mem.usageByMonthIp.get(key) || { count: 0, plan: 'free' };
  const parsedCount = Number(v.count ?? 0);
  const countValid = Number.isSafeInteger(parsedCount) && parsedCount >= 0;
  return {
    count: countValid ? parsedCount : null,
    countValid,
    plan: normalizePlan(v.plan || (v.paid ? 'pro' : 'free'))
  };
};

const writeUsage = async (month, ip, { count, plan }) => {
  assertStoreAvailable();
  const key = `${month}:${ip}`;
  const normalized = normalizePlan(plan);
  if (useUpstash) {
    await upstash(['HSET', `usage:${key}`, 'count', String(count), 'plan', normalized, 'paid', normalized === 'free' ? '0' : '1']);
    await upstash(['EXPIRE', `usage:${key}`, String(USAGE_RETENTION_SECONDS)]);
    return;
  }
  mem.usageByMonthIp.set(key, { count, plan: normalized });
};

const getPersistentPlan = async (ip) => {
  assertStoreAvailable();
  if (alwaysMaxIps.has(ip)) return 'max';
  if (useUpstash) {
    const v = await upstash(['GET', `usage:plan-ip:${ip}`]);
    if (v) return normalizePlan(v);
    // Legacy persistent paid flag
    const legacy = await upstash(['GET', `usage:paid-ip:${ip}`]);
    if (String(legacy || '0') === '1') return 'pro';
    return 'free';
  }
  return normalizePlan(mem.planByIp.get(ip) || 'free');
};

const setPersistentPlan = async (ip, plan) => {
  assertStoreAvailable();
  const normalized = normalizePlan(plan);
  if (useUpstash) {
    await upstash(['SET', `usage:plan-ip:${ip}`, normalized, 'EX', String(PLAN_RETENTION_SECONDS)]);
    if (normalized !== 'free') {
      await upstash(['SET', `usage:paid-ip:${ip}`, '1', 'EX', String(PLAN_RETENTION_SECONDS)]);
    }
    return;
  }
  mem.planByIp.set(ip, normalized);
};

const resolveEffectivePlan = async (month, ip, cur) => {
  const persistent = await getPersistentPlan(ip);
  return higherPlan(persistent, cur.plan || 'free');
};

export const limits = () => ({
  free: FREE_LIMIT,
  pro: PRO_LIMIT,
  max: MAX_LIMIT,
  // Backward compat alias used by older clients/tests
  paid: PRO_LIMIT
});

export const pricing = () => ({
  freeRunsPerMonth: FREE_LIMIT,
  proRunsPerMonth: PRO_LIMIT,
  maxRunsPerMonth: MAX_LIMIT,
  proPriceUsd: PRO_PRICE_USD,
  maxPriceUsd: MAX_PRICE_USD,
  // Backward compat
  paidRunsPerMonth: PRO_LIMIT,
  paidPriceUsd: PRO_PRICE_USD
});

export const verifyPlanCode = (code) => {
  const c = String(code || '').trim();
  if (!c) return null;
  if (maxCodes.has(c)) return 'max';
  if (proCodes.has(c)) return 'pro';
  return null;
};

export const activatePlanForIp = async (ip, plan, { audit = null } = {}) => {
  assertStoreAvailable();
  if (!audit || audit.action !== 'upgrade.activate' || !audit.eventId || !audit.actor) {
    const error = new Error('Purpose-scoped upgrade authorization is required');
    error.code = 'UPGRADE_AUTH_REQUIRED';
    throw error;
  }
  const tier = normalizePlan(plan);
  if (tier === 'free') throw new Error('Cannot activate free plan');
  const month = nowMonth();
  const key = ipKey(ip);
  if (useUpstash) {
    const usageKey = `usage:${month}:${key}`;
    await upstash([
      'EVAL',
      `redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[8])
       if ARGV[1] ~= 'free' then redis.call('SET', KEYS[2], '1', 'EX', ARGV[8]) end
       local count = redis.call('HGET', KEYS[3], 'count')
       if not count then count = '0'
       elseif not tonumber(count) or tonumber(count) < 0 or tonumber(count) % 1 ~= 0 then count = ARGV[3] end
       redis.call('HSET', KEYS[3], 'count', count, 'plan', ARGV[1], 'paid', ARGV[1] == 'free' and '0' or '1')
       redis.call('EXPIRE', KEYS[3], ARGV[2])
       redis.call('XADD', KEYS[4], '*',
         'eventId', ARGV[4], 'action', 'upgrade.activate',
         'actor', ARGV[5], 'target', ARGV[6], 'plan', ARGV[1],
         'timestamp', ARGV[7])
       redis.call('EXPIRE', KEYS[4], ARGV[9])
       return 1`,
      '4', `usage:plan-ip:${key}`, `usage:paid-ip:${key}`, usageKey, 'security:audit:v1',
      tier, String(USAGE_RETENTION_SECONDS), String(PLAN_LIMITS[tier]),
      String(audit?.eventId || ''), String(audit?.actor || 'upgrade-code'),
      String(audit?.target || key), String(audit?.timestamp || new Date().toISOString()),
      String(PLAN_RETENTION_SECONDS), String(AUDIT_RETENTION_SECONDS)
    ]);
  } else {
    await appendSecurityAudit(audit);
    await setPersistentPlan(key, tier);
    const cur = await readUsage(month, key);
    await writeUsage(month, key, { count: cur.countValid ? cur.count : 0, plan: tier });
  }
  return { month, ip: key, plan: tier };
};

const usageSnapshot = async (ip, { count, plan }) => {
  const tier = normalizePlan(plan);
  const limit = PLAN_LIMITS[tier];
  const parsed = Number(count);
  const used = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : limit;
  return {
    month: nowMonth(),
    ip: ipKey(ip),
    used,
    limit,
    remaining: Math.max(0, limit - used),
    plan: tier,
    paid: tier !== 'free'
  };
};

export const getUsage = async (ip, { authenticatedPreview = false } = {}) => {
  assertStoreAvailable();
  if (authenticatedPreview || isUsageLimitBypassed(ip)) return devUsageSnapshot(ip);
  const month = nowMonth();
  const key = ipKey(ip);
  const cur = await readUsage(month, key);
  const tier = await resolveEffectivePlan(month, key, cur);
  if (tier !== cur.plan && cur.countValid) {
    await writeUsage(month, key, { count: cur.count, plan: tier });
  }
  return usageSnapshot(key, { count: cur.count, plan: tier });
};

export const consumeResearchCredit = async (ip, { authenticatedPreview = false } = {}) => {
  assertStoreAvailable();
  if (authenticatedPreview || isUsageLimitBypassed(ip)) {
    return { allowed: true, ...devUsageSnapshot(ip) };
  }
  const month = nowMonth();
  const key = ipKey(ip);
  const cur = await readUsage(month, key);
  const tier = await resolveEffectivePlan(month, key, cur);
  const limit = PLAN_LIMITS[tier];
  if (useUpstash) {
    const result = await upstash([
      'EVAL',
      `local raw = redis.call('HGET', KEYS[1], 'count')
       local count = tonumber(raw or '0')
       local limit = tonumber(ARGV[1])
       if not count or count < 0 or count % 1 ~= 0 or not limit or limit < 0 or limit % 1 ~= 0 then
         return {0, ARGV[1]}
       end
       if count >= limit then return {0, tostring(count)} end
       count = count + 1
       redis.call('HSET', KEYS[1], 'count', tostring(count), 'plan', ARGV[2], 'paid', ARGV[2] == 'free' and '0' or '1')
       redis.call('EXPIRE', KEYS[1], ARGV[3])
       return {1, tostring(count)}`,
      '1', `usage:${month}:${key}`, String(limit), tier, String(USAGE_RETENTION_SECONDS)
    ]);
    const allowed = Number(result?.[0]) === 1;
    const count = Number(result?.[1]);
    return { allowed, ...(await usageSnapshot(key, { count, plan: tier })) };
  }

  // Re-read the in-memory record after the last await. The check and update
  // below contain no await, so concurrent Promise callers cannot interleave.
  const memKey = `${month}:${key}`;
  const latest = mem.usageByMonthIp.get(memKey) || { count: 0, plan: tier };
  const latestCount = Number(latest.count ?? 0);
  const countValid = Number.isSafeInteger(latestCount) && latestCount >= 0;
  if (!countValid || latestCount >= limit) {
    return {
      allowed: false,
      ...(await usageSnapshot(key, { count: countValid ? latestCount : limit, plan: tier }))
    };
  }
  const next = latestCount + 1;
  mem.usageByMonthIp.set(memKey, { count: next, plan: tier });
  return {
    allowed: true,
    ...(await usageSnapshot(key, { count: next, plan: tier }))
  };
};

export const _resetForTests = () => {
  if (useUpstash) return;
  mem.usageByMonthIp.clear();
  mem.planByIp.clear();
};
