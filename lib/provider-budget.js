import { randomUUID } from 'node:crypto';
import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_TIMEOUT_MS = timeoutFor('redis', 5_000);
const mem = { daily: new Map(), monthly: new Map(), reservations: new Map() };

const finiteUsd = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
};
const toMicros = (usd) => Math.round(Number(usd) * 1_000_000);
const limits = () => ({
  daily: toMicros(finiteUsd('MRT_DAILY_PROVIDER_BUDGET_USD', 50)),
  monthly: toMicros(finiteUsd('MRT_MONTHLY_PROVIDER_BUDGET_USD', 500))
});
const periods = (now) => {
  const date = new Date(now);
  return {
    day: date.toISOString().slice(0, 10),
    month: date.toISOString().slice(0, 7)
  };
};
const requiresDurable = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const assertStore = () => {
  if (requiresDurable() && !useUpstash) {
    const error = new Error('Durable provider budget enforcement is unavailable');
    error.code = 'DURABLE_BUDGET_UNAVAILABLE';
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
  }, { timeoutMs: REDIS_TIMEOUT_MS, provider: 'Redis provider budget' });
  if (!response.ok) throw new Error(`Provider budget HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`Provider budget error: ${data.error}`);
  return data.result;
};

export const estimateProviderCostUsd = ({ mode, fanout = 1 } = {}) => {
  const estimates = {
    research: 0.12,
    repurpose: 0.12,
    trials: 0.04,
    chat: 0.03,
    translate: 0.03,
    'benchmark-models': 0.12,
    validate: 0.04,
    'polish-report': 0.05,
    evidence: 0.03,
    'dynamic-kb': 0.04,
    'brain-refresh': 0.05
  };
  return (estimates[String(mode)] || 0.05) * Math.max(1, Math.min(50, Number(fanout) || 1));
};

export const reserveProviderBudget = async ({ estimatedUsd, scope = 'provider', now = Date.now() }) => {
  assertStore();
  const amount = toMicros(estimatedUsd);
  const configured = limits();
  if (!Number.isSafeInteger(amount) || amount <= 0 || configured.daily <= 0 || configured.monthly <= 0) {
    return { allowed: false, code: 'PROVIDER_BUDGET_EXHAUSTED' };
  }
  const { day, month } = periods(now);
  const reservationId = randomUUID();
  if (useUpstash) {
    const result = await redis([
      'EVAL',
      `local daily = tonumber(redis.call('GET', KEYS[1]) or '0')
       local monthly = tonumber(redis.call('GET', KEYS[2]) or '0')
       local amount = tonumber(ARGV[1])
       if not daily or not monthly or not amount then return {0, 0, 0} end
       if daily + amount > tonumber(ARGV[2]) or monthly + amount > tonumber(ARGV[3]) then
         return {0, daily, monthly}
       end
       daily = redis.call('INCRBY', KEYS[1], amount)
       monthly = redis.call('INCRBY', KEYS[2], amount)
       redis.call('EXPIRE', KEYS[1], ARGV[4])
       redis.call('EXPIRE', KEYS[2], ARGV[5])
       redis.call('SET', KEYS[3], ARGV[6], 'EX', ARGV[4])
       return {1, daily, monthly}`,
      '3',
      `provider-budget:day:${day}`,
      `provider-budget:month:${month}`,
      `provider-budget:reservation:${reservationId}`,
      String(amount),
      String(configured.daily),
      String(configured.monthly),
      String(3 * 24 * 60 * 60),
      String(40 * 24 * 60 * 60),
      JSON.stringify({ amount, day, month, scope })
    ]);
    return {
      allowed: Number(result?.[0]) === 1,
      code: Number(result?.[0]) === 1 ? undefined : 'PROVIDER_BUDGET_EXHAUSTED',
      reservationId,
      estimatedUsd,
      dailyUsedUsd: Number(result?.[1] || 0) / 1_000_000,
      monthlyUsedUsd: Number(result?.[2] || 0) / 1_000_000
    };
  }
  const daily = mem.daily.get(day) || 0;
  const monthly = mem.monthly.get(month) || 0;
  if (daily + amount > configured.daily || monthly + amount > configured.monthly) {
    return { allowed: false, code: 'PROVIDER_BUDGET_EXHAUSTED' };
  }
  mem.daily.set(day, daily + amount);
  mem.monthly.set(month, monthly + amount);
  mem.reservations.set(reservationId, { amount, day, month, scope });
  return {
    allowed: true,
    reservationId,
    estimatedUsd,
    dailyUsedUsd: (daily + amount) / 1_000_000,
    monthlyUsedUsd: (monthly + amount) / 1_000_000
  };
};

export const reconcileProviderBudget = async ({ reservationId, actualUsd }) => {
  assertStore();
  if (!reservationId) return false;
  const actual = toMicros(actualUsd);
  if (!Number.isSafeInteger(actual) || actual < 0) return false;
  if (useUpstash) {
    const result = await redis([
      'EVAL',
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local item = cjson.decode(raw)
       local delta = tonumber(ARGV[1]) - tonumber(item.amount)
       if delta ~= 0 then
         redis.call('INCRBY', 'provider-budget:day:' .. item.day, delta)
         redis.call('INCRBY', 'provider-budget:month:' .. item.month, delta)
       end
       redis.call('DEL', KEYS[1])
       return 1`,
      '1',
      `provider-budget:reservation:${reservationId}`,
      String(actual)
    ]);
    return Number(result) === 1;
  }
  const item = mem.reservations.get(reservationId);
  if (!item) return false;
  const delta = actual - item.amount;
  mem.daily.set(item.day, Math.max(0, (mem.daily.get(item.day) || 0) + delta));
  mem.monthly.set(item.month, Math.max(0, (mem.monthly.get(item.month) || 0) + delta));
  mem.reservations.delete(reservationId);
  return true;
};

export const _resetProviderBudgetForTests = () => {
  mem.daily.clear();
  mem.monthly.clear();
  mem.reservations.clear();
};
