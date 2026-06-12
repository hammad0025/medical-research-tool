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

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const FREE_LIMIT = Number(process.env.MRT_FREE_LIMIT || 4);
const PRO_LIMIT = Number(process.env.MRT_PRO_LIMIT || process.env.MRT_PAID_LIMIT || 100);
const MAX_LIMIT = Number(process.env.MRT_MAX_LIMIT || 500);
const PRO_PRICE_USD = Number(process.env.MRT_PRO_PRICE_USD || process.env.MRT_PAID_PRICE_USD || 20);
const MAX_PRICE_USD = Number(process.env.MRT_MAX_PRICE_USD || 79);

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

// TEMPORARY master kill-switch for monthly usage metering.
// Default is ON (metering DISABLED) — Hammad asked to turn the Free-plan cap
// off "for now" (2026-06-12) while the client runs demos/testing. Unlike
// MRT_SKIP_USAGE_LIMIT (which intentionally does NOT bypass in production),
// this switch disables metering in ALL environments, including production.
// To re-enable the Free/Pro/Max caps later, set MRT_DISABLE_USAGE_LIMIT=0
// (or flip the default below back to '0').
const usageLimitsDisabled = () =>
  String(process.env.MRT_DISABLE_USAGE_LIMIT ?? '1').trim() === '1';

/** True when monthly per-IP metering should not block. */
export const isUsageLimitBypassed = (ip) => {
  if (usageLimitsDisabled()) return true;
  if (process.env.VERCEL_ENV === 'production') return false;
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
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
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
  const key = `${month}:${ip}`;
  if (useUpstash) {
    const raw = await upstash(['HMGET', `usage:${key}`, 'count', 'plan', 'paid']);
    const count = Number((raw && raw[0]) || 0);
    const planField = (raw && raw[1]) || '';
    const legacyPaid = String((raw && raw[2]) || '0') === '1';
    const plan = planField ? normalizePlan(planField) : (legacyPaid ? 'pro' : 'free');
    return { count, plan };
  }
  const v = mem.usageByMonthIp.get(key) || { count: 0, plan: 'free' };
  return { count: Number(v.count || 0), plan: normalizePlan(v.plan || (v.paid ? 'pro' : 'free')) };
};

const writeUsage = async (month, ip, { count, plan }) => {
  const key = `${month}:${ip}`;
  const normalized = normalizePlan(plan);
  if (useUpstash) {
    await upstash(['HSET', `usage:${key}`, 'count', String(count), 'plan', normalized, 'paid', normalized === 'free' ? '0' : '1']);
    await upstash(['EXPIRE', `usage:${key}`, String(45 * 24 * 3600)]);
    return;
  }
  mem.usageByMonthIp.set(key, { count, plan: normalized });
};

const getPersistentPlan = async (ip) => {
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
  const normalized = normalizePlan(plan);
  if (useUpstash) {
    await upstash(['SET', `usage:plan-ip:${ip}`, normalized]);
    if (normalized !== 'free') {
      await upstash(['SET', `usage:paid-ip:${ip}`, '1']);
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

/** @deprecated use verifyPlanCode — kept for backward compat */
export const verifyPaidCode = (code) => !!verifyPlanCode(code);

export const activatePlanForIp = async (ip, plan) => {
  const tier = normalizePlan(plan);
  if (tier === 'free') throw new Error('Cannot activate free plan');
  const month = nowMonth();
  const key = ipKey(ip);
  await setPersistentPlan(key, tier);
  const cur = await readUsage(month, key);
  await writeUsage(month, key, { count: cur.count, plan: tier });
  return { month, ip: key, plan: tier };
};

/** @deprecated use activatePlanForIp — kept for backward compat */
export const activatePaidForIp = async (ip) => activatePlanForIp(ip, 'pro');

const usageSnapshot = async (ip, { count, plan }) => {
  const tier = normalizePlan(plan);
  const limit = PLAN_LIMITS[tier];
  const used = Number(count || 0);
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

export const getUsage = async (ip) => {
  if (isUsageLimitBypassed(ip)) return devUsageSnapshot(ip);
  const month = nowMonth();
  const key = ipKey(ip);
  const cur = await readUsage(month, key);
  const tier = await resolveEffectivePlan(month, key, cur);
  if (tier !== cur.plan) {
    await writeUsage(month, key, { count: cur.count, plan: tier });
  }
  return usageSnapshot(key, { count: cur.count, plan: tier });
};

export const consumeResearchCredit = async (ip) => {
  if (isUsageLimitBypassed(ip)) {
    return { allowed: true, ...devUsageSnapshot(ip) };
  }
  const month = nowMonth();
  const key = ipKey(ip);
  const cur = await readUsage(month, key);
  const tier = await resolveEffectivePlan(month, key, cur);
  const limit = PLAN_LIMITS[tier];
  if (cur.count >= limit) {
    return {
      allowed: false,
      ...(await usageSnapshot(key, { count: cur.count, plan: tier }))
    };
  }
  const next = cur.count + 1;
  await writeUsage(month, key, { count: next, plan: tier });
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
