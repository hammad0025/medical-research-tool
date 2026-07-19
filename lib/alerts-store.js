// Durable alert subscriptions and delivery state. Redis mutations that span
// multiple keys use Lua so partial network failures cannot leave split indexes.

import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';
import { RETENTION_SECONDS } from './privacy-governance.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const MAX_LEDGER = 500;
const MAX_PAGE = 50;
const ALERT_RETENTION_SECONDS = RETENTION_SECONDS.alerts;
const REDIS_TIMEOUT_MS = timeoutFor('redis', 5_000);

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
  if (!r.ok) throw new Error(`Upstash ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (data.error) throw new Error(`Upstash error: ${data.error}`);
  return data.result;
};

const memStore = {
  subs: new Map(),
  byEmail: new Map(),
  unique: new Map(),
  sentLedger: new Map(),
  claims: new Map(),
  deliveries: new Map(),
  tombstones: new Set()
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const normalizeCondition = (condition) => String(condition || '').trim().toLowerCase();
const uniqueKey = (email, condition) =>
  `${encodeURIComponent(normalizeEmail(email))}:${encodeURIComponent(normalizeCondition(condition))}`;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const boundedLimit = (limit) => Math.max(1, Math.min(MAX_PAGE, Number(limit) || 20));

const validSubscription = (value, expectedId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !value.id || (expectedId && value.id !== expectedId)) return null;
  if (!normalizeEmail(value.email) || typeof value.condition !== 'string' || !value.condition.trim()) return null;
  const createdAtMs = Date.parse(value.createdAt || '');
  const configuredExpiry = Date.parse(value.expiresAt || '');
  const expiresAtMs = Number.isFinite(configuredExpiry)
    ? configuredExpiry
    : (Number.isFinite(createdAtMs) ? createdAtMs : Date.now()) + ALERT_RETENTION_SECONDS * 1000;
  return {
    ...value,
    email: normalizeEmail(value.email),
    condition: value.condition.trim(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
};

const isExpired = (sub, now = Date.now()) => Date.parse(sub?.expiresAt || '') <= now;
const remainingTtl = (sub) => Math.max(1, Math.ceil((Date.parse(sub.expiresAt) - Date.now()) / 1000));

const parseSubscription = (raw, expectedId) => {
  try {
    return validSubscription(typeof raw === 'string' ? JSON.parse(raw) : raw, expectedId);
  } catch {
    return null;
  }
};

const cleanupBadRedisRecord = async (id, email) => {
  const commands = [
    ['SREM', 'alerts:index', id],
    ['DEL', `alerts:sub:${id}`]
  ];
  if (email) commands.push(['SREM', `alerts:by-email:${email}`, id]);
  await Promise.allSettled(commands.map(upstash));
};

export const isConfigured = () => useUpstash;
export const backendName = () => (useUpstash ? 'upstash-redis' : 'in-memory (ephemeral)');
export const alertRetentionSeconds = () => ALERT_RETENTION_SECONDS;

export const createSubscription = async (input) => {
  const sub = validSubscription(input);
  if (!sub) throw new Error('valid subscription required');
  const dedupe = uniqueKey(sub.email, sub.condition);
  if (useUpstash) {
    const script = `
      if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
      local existing = redis.call('GET', KEYS[3])
      if existing then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
      redis.call('SADD', KEYS[2], ARGV[2])
      redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
      redis.call('SADD', KEYS[5], ARGV[2])
      return 1`;
    const created = await upstash([
      'EVAL', script, '5',
      `alerts:sub:${sub.id}`, 'alerts:index', `alerts:unique:${dedupe}`,
      `alerts:tombstone:${sub.id}`, `alerts:by-email:${sub.email}`,
      JSON.stringify(sub), sub.id, String(remainingTtl(sub))
    ]);
    return Number(created) === 1 ? clone(sub) : null;
  }
  if (memStore.tombstones.has(sub.id) || memStore.unique.has(dedupe)) return null;
  memStore.subs.set(sub.id, clone(sub));
  memStore.unique.set(dedupe, sub.id);
  if (!memStore.byEmail.has(sub.email)) memStore.byEmail.set(sub.email, new Set());
  memStore.byEmail.get(sub.email).add(sub.id);
  return clone(sub);
};

// Updates an existing record only. This prevents a stale cron worker from
// recreating a subscription after unsubscribe.
export const putSubscription = async (input) => {
  const sub = validSubscription(input);
  if (!sub) throw new Error('valid subscription required');
  if (useUpstash) {
    const script = `
      if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      return 1`;
    const updated = await upstash([
      'EVAL', script, '2', `alerts:sub:${sub.id}`, `alerts:tombstone:${sub.id}`,
      JSON.stringify(sub), String(remainingTtl(sub))
    ]);
    return Number(updated) === 1 ? clone(sub) : null;
  }
  if (memStore.tombstones.has(sub.id) || !memStore.subs.has(sub.id)) return null;
  memStore.subs.set(sub.id, clone(sub));
  return clone(sub);
};

export const getSubscription = async (id) => {
  const key = String(id || '');
  if (!key) return null;
  if (useUpstash) {
    const raw = await upstash(['GET', `alerts:sub:${key}`]);
    if (!raw) return null;
    const sub = parseSubscription(raw, key);
    if (!sub) await cleanupBadRedisRecord(key);
    else if (isExpired(sub)) {
      await deleteSubscription(key, sub);
      return null;
    }
    return sub;
  }
  const sub = parseSubscription(memStore.subs.get(key), key);
  if (sub && isExpired(sub)) {
    await deleteSubscription(key, sub);
    return null;
  }
  return sub;
};

export const deleteSubscription = async (id, knownSubscription = null) => {
  const key = String(id || '');
  const sub = knownSubscription || await getSubscription(key);
  if (!sub) return false;
  const dedupe = uniqueKey(sub.email, sub.condition);
  if (useUpstash) {
    const script = `
      redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
      redis.call('DEL', KEYS[2], KEYS[6], KEYS[7], KEYS[8])
      redis.call('SREM', KEYS[3], ARGV[1])
      redis.call('SREM', KEYS[4], ARGV[1])
      if redis.call('GET', KEYS[5]) == ARGV[1] then redis.call('DEL', KEYS[5]) end
      return 1`;
    await upstash([
      'EVAL', script, '8',
      `alerts:tombstone:${key}`, `alerts:sub:${key}`, 'alerts:index',
      `alerts:by-email:${sub.email}`, `alerts:unique:${dedupe}`,
      `alerts:sent:${key}`, `alerts:claim:${key}`, `alerts:deliveries:${key}`,
      key, String(ALERT_RETENTION_SECONDS)
    ]);
  } else {
    memStore.tombstones.add(key);
    memStore.subs.delete(key);
    memStore.byEmail.get(sub.email)?.delete(key);
    if (memStore.unique.get(dedupe) === key) memStore.unique.delete(dedupe);
    memStore.sentLedger.delete(key);
    memStore.claims.delete(key);
    for (const deliveryKey of memStore.deliveries.keys()) {
      if (deliveryKey.startsWith(`${key}:`)) memStore.deliveries.delete(deliveryKey);
    }
  }
  return true;
};

export const listSubscriptionsPage = async ({ cursor = '0', limit = 20 } = {}) => {
  const count = boundedLimit(limit);
  if (useUpstash) {
    const result = await upstash(['SSCAN', 'alerts:index', String(cursor || '0'), 'COUNT', String(count)]);
    const nextCursor = String(result?.[0] ?? '0');
    const ids = Array.isArray(result?.[1]) ? result[1].slice(0, count) : [];
    if (!ids.length) return { subscriptions: [], cursor: nextCursor, malformed: 0 };
    const raws = await upstash(['MGET', ...ids.map((id) => `alerts:sub:${id}`)]);
    const subscriptions = [];
    let malformed = 0;
    const cleanups = [];
    ids.forEach((id, index) => {
      const sub = parseSubscription(raws?.[index], id);
      if (sub && !isExpired(sub)) subscriptions.push(sub);
      else {
        malformed += 1;
        cleanups.push(sub ? deleteSubscription(id, sub) : cleanupBadRedisRecord(id));
      }
    });
    await Promise.allSettled(cleanups);
    return { subscriptions, cursor: nextCursor, malformed };
  }
  const ids = [...memStore.subs.keys()].sort();
  const offset = Math.max(0, Number.parseInt(String(cursor), 10) || 0);
  const selected = ids.slice(offset, offset + count);
  const subscriptions = [];
  let malformed = 0;
  for (const id of selected) {
    const sub = parseSubscription(memStore.subs.get(id), id);
    if (sub && !isExpired(sub)) subscriptions.push(clone(sub));
    else {
      malformed += 1;
      if (sub) await deleteSubscription(id, sub);
      else {
        memStore.subs.delete(id);
        for (const set of memStore.byEmail.values()) set.delete(id);
      }
    }
  }
  const next = offset + selected.length < ids.length ? String(offset + selected.length) : '0';
  return { subscriptions, cursor: next, malformed };
};

export const listSubscriptions = async () =>
  (await listSubscriptionsPage({ limit: MAX_PAGE })).subscriptions;

export const listSubscriptionsByEmail = async (email, { limit = MAX_PAGE } = {}) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const count = boundedLimit(limit);
  if (useUpstash) {
    const result = await upstash([
      'SSCAN', `alerts:by-email:${normalized}`, '0', 'COUNT', String(count)
    ]);
    const ids = (result?.[1] || []).slice(0, count);
    if (!ids.length) return [];
    const raws = await upstash(['MGET', ...ids.map((id) => `alerts:sub:${id}`)]);
    const valid = [];
    const cleanups = [];
    ids.forEach((id, index) => {
      const sub = parseSubscription(raws?.[index], id);
      if (sub && sub.email === normalized && !isExpired(sub)) valid.push(sub);
      else cleanups.push(sub && isExpired(sub)
        ? deleteSubscription(id, sub)
        : upstash(['SREM', `alerts:by-email:${normalized}`, id]));
    });
    await Promise.allSettled(cleanups);
    return valid;
  }
  const ids = [...(memStore.byEmail.get(normalized) || [])].slice(0, count);
  const valid = [];
  for (const id of ids) {
    const sub = parseSubscription(memStore.subs.get(id), id);
    if (sub && sub.email === normalized && !isExpired(sub)) valid.push(clone(sub));
    else if (sub && isExpired(sub)) await deleteSubscription(id, sub);
    else memStore.byEmail.get(normalized)?.delete(id);
  }
  return valid;
};

export const getSentLedger = async (subId) => {
  if (useUpstash) {
    const ids = (await upstash(['SMEMBERS', `alerts:sent:${subId}`])) || [];
    return new Set(ids.filter((id) => typeof id === 'string' && id));
  }
  return new Set(memStore.sentLedger.get(subId) || []);
};

export const claimDelivery = async (subId, runKey, token, leaseMs = 60_000) => {
  const lease = Math.max(5_000, Math.min(300_000, Number(leaseMs) || 60_000));
  const deliveryKey = `${subId}:${runKey}`;
  if (useUpstash) {
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 1 then return 'missing' end
      if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 'delivered' end
      local ok = redis.call('SET', KEYS[4], ARGV[1] .. ':' .. ARGV[2], 'NX', 'PX', ARGV[3])
      if ok then return 'claimed' end
      return 'busy'`;
    return upstash([
      'EVAL', script, '4',
      `alerts:sub:${subId}`, `alerts:tombstone:${subId}`,
      `alerts:deliveries:${subId}`, `alerts:claim:${subId}`,
      runKey, token, String(lease)
    ]);
  }
  if (!memStore.subs.has(subId) || memStore.tombstones.has(subId)) return 'missing';
  if (memStore.deliveries.has(deliveryKey)) return 'delivered';
  const now = Date.now();
  const existing = memStore.claims.get(subId);
  if (existing && existing.expiresAt > now) return 'busy';
  memStore.claims.set(subId, { value: `${runKey}:${token}`, expiresAt: now + lease });
  return 'claimed';
};

export const releaseDeliveryClaim = async (subId, runKey, token) => {
  const expected = `${runKey}:${token}`;
  if (useUpstash) {
    const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
    return Number(await upstash(['EVAL', script, '1', `alerts:claim:${subId}`, expected])) === 1;
  }
  if (memStore.claims.get(subId)?.value !== expected) return false;
  memStore.claims.delete(subId);
  return true;
};

export const completeDelivery = async ({
  subId, runKey, token, providerId, itemIds = [], lastRunAt, lastRunStats
}) => {
  if (!providerId) throw new Error('providerId required');
  const expected = `${runKey}:${token}`;
  const deliveryKey = `${subId}:${runKey}`;
  const additions = [...new Set(itemIds.filter((id) => typeof id === 'string' && id))];
  if (useUpstash) {
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 1 then return 'missing' end
      if redis.call('HEXISTS', KEYS[3], ARGV[2]) == 1 then return 'delivered' end
      if redis.call('GET', KEYS[4]) ~= ARGV[1] then return 'lost' end
      local subscriptionTtl = redis.call('PTTL', KEYS[1])
      if subscriptionTtl <= 0 then return 'missing' end
      local sub = cjson.decode(redis.call('GET', KEYS[1]))
      sub['lastRunAt'] = ARGV[4]
      sub['lastRunStats'] = cjson.decode(ARGV[5])
      redis.call('SET', KEYS[1], cjson.encode(sub), 'PX', subscriptionTtl)
      redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
      redis.call('PEXPIRE', KEYS[3], subscriptionTtl)
      local deliveryExcess = redis.call('HLEN', KEYS[3]) - 60
      if deliveryExcess > 0 then
        local old = redis.call('HKEYS', KEYS[3])
        for i = 1, deliveryExcess do redis.call('HDEL', KEYS[3], old[i]) end
      end
      for i = 6, #ARGV do redis.call('SADD', KEYS[5], ARGV[i]) end
      redis.call('PEXPIRE', KEYS[5], subscriptionTtl)
      local excess = redis.call('SCARD', KEYS[5]) - ${MAX_LEDGER}
      if excess > 0 then redis.call('SPOP', KEYS[5], excess) end
      redis.call('DEL', KEYS[4])
      return 'completed'`;
    return upstash([
      'EVAL', script, '5',
      `alerts:sub:${subId}`, `alerts:tombstone:${subId}`,
      `alerts:deliveries:${subId}`, `alerts:claim:${subId}`, `alerts:sent:${subId}`,
      expected, runKey, providerId, lastRunAt, JSON.stringify(lastRunStats || {}), ...additions
    ]);
  }
  if (!memStore.subs.has(subId) || memStore.tombstones.has(subId)) return 'missing';
  if (memStore.deliveries.has(deliveryKey)) return 'delivered';
  if (memStore.claims.get(subId)?.value !== expected) return 'lost';
  const sub = memStore.subs.get(subId);
  sub.lastRunAt = lastRunAt;
  sub.lastRunStats = clone(lastRunStats || {});
  memStore.deliveries.set(deliveryKey, providerId);
  const deliveryKeys = [...memStore.deliveries.keys()].filter((key) => key.startsWith(`${subId}:`));
  while (deliveryKeys.length > 60) memStore.deliveries.delete(deliveryKeys.shift());
  if (!memStore.sentLedger.has(subId)) memStore.sentLedger.set(subId, new Set());
  const ledger = memStore.sentLedger.get(subId);
  additions.forEach((id) => ledger.add(id));
  while (ledger.size > MAX_LEDGER) ledger.delete(ledger.values().next().value);
  memStore.claims.delete(subId);
  return 'completed';
};

export const _resetForTests = () => {
  if (useUpstash) return;
  for (const value of Object.values(memStore)) {
    if (typeof value.clear === 'function') value.clear();
  }
};

export const _injectMalformedForTests = (id, value, email = '') => {
  if (useUpstash) throw new Error('in-memory backend required');
  memStore.subs.set(id, value);
  if (email) {
    const normalized = normalizeEmail(email);
    if (!memStore.byEmail.has(normalized)) memStore.byEmail.set(normalized, new Set());
    memStore.byEmail.get(normalized).add(id);
  }
};
