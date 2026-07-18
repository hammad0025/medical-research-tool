// Durable refresh queue. Items are leased, then explicitly acknowledged or
// retried; an expired lease is recovered by the next dequeue.

import { randomUUID } from 'node:crypto';

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const QUEUE_KEY = 'brain:refresh:queue';
const PAYLOAD_KEY = 'brain:refresh:payload';
const LEASE_KEY = 'brain:refresh:leases';
const LEASE_TOKEN_KEY = 'brain:refresh:lease-tokens';
const ATTEMPTS_KEY = 'brain:refresh:attempts';
const DEAD_KEY = 'brain:refresh:dead';
const SEARCH_LOG_KEY = 'brain:search:log';
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

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
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
};

const memQueue = new Map();
const memLeases = new Map();
const memAttempts = new Map();
const memDead = new Map();
const memSearchLog = new Map();

export const isBrainQueueConfigured = () => useUpstash;

export const enqueueBrainRefresh = async (canonical, slug) => {
  const name = String(canonical || '').trim();
  const s = String(slug || '').trim();
  if (!name || !s) return;
  const now = Date.now();
  const payload = { canonical: name, slug: s, queuedAt: new Date(now).toISOString() };
  const entry = JSON.stringify(payload);

  if (useUpstash) {
    // ZADD NX keeps the oldest due time while HSET refreshes metadata. If an
    // item is currently leased, it is not inserted a second time.
    await upstash([
      'EVAL',
      `redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
       redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
       if not redis.call('ZSCORE', KEYS[4], ARGV[1]) then
         redis.call('ZADD', KEYS[1], 'NX', ARGV[3], ARGV[1])
       end
       return 1`,
      '4', QUEUE_KEY, PAYLOAD_KEY, SEARCH_LOG_KEY, LEASE_KEY,
      s, entry, String(now)
    ]);
  } else {
    const existing = memQueue.get(s);
    if (!memLeases.has(s)) {
      memQueue.set(s, { ...payload, queuedAt: now, score: existing?.score ?? now });
    }
    memSearchLog.set(s, { ...payload, queuedAt: now });
  }
};

export const logBrainSearch = async (canonical, slug) => {
  await enqueueBrainRefresh(canonical, slug);
};

export const dequeueBrainRefreshBatch = async (limit = 8, options = {}) => {
  const n = Math.max(1, Math.min(Number(limit) || 8, 20));
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const leaseMs = Math.max(1, Number(options.leaseMs) || DEFAULT_LEASE_MS);
  const leaseUntil = now + leaseMs;
  const batchToken = randomUUID();
  if (useUpstash) {
    const raw = (await upstash([
      'EVAL',
      `local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
       for _, slug in ipairs(expired) do
         redis.call('ZREM', KEYS[3], slug)
         redis.call('HDEL', KEYS[4], slug)
         if redis.call('HEXISTS', KEYS[2], slug) == 1 then
           redis.call('ZADD', KEYS[1], ARGV[1], slug)
         end
       end
       local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
       local out = {}
       for i, member in ipairs(due) do
         local slug = member
         local payload = redis.call('HGET', KEYS[2], slug)
         if not payload then
           local ok, decoded = pcall(cjson.decode, member)
           if ok and decoded and decoded['slug'] then
             slug = tostring(decoded['slug'])
             payload = member
             redis.call('HSET', KEYS[2], slug, payload)
           end
         end
         redis.call('ZREM', KEYS[1], member)
         if payload then
           if not redis.call('ZSCORE', KEYS[3], slug) then
             local token = ARGV[4] .. ':' .. i
             redis.call('ZADD', KEYS[3], ARGV[2], slug)
             redis.call('HSET', KEYS[4], slug, token)
             table.insert(out, payload)
             table.insert(out, token)
             table.insert(out, redis.call('HGET', KEYS[6], slug) or '0')
           end
         else
           redis.call('HSET', KEYS[5], member, 'missing payload')
         end
       end
       return out`,
      '6', QUEUE_KEY, PAYLOAD_KEY, LEASE_KEY, LEASE_TOKEN_KEY, DEAD_KEY, ATTEMPTS_KEY,
      String(now), String(leaseUntil), String(n), batchToken
    ])) || [];
    const out = [];
    for (let i = 0; i < raw.length; i += 3) {
      try {
        out.push({
          ...JSON.parse(raw[i]),
          leaseToken: raw[i + 1],
          leaseUntil,
          attempt: Number(raw[i + 2]) || 0
        });
      } catch {
        // Script has already dead-lettered structurally missing payloads.
      }
    }
    return out;
  }

  for (const [slug, lease] of memLeases) {
    if (lease.leaseUntil <= now) {
      memLeases.delete(slug);
      const payload = lease.payload;
      memQueue.set(slug, { ...payload, score: now });
    }
  }
  const sorted = [...memQueue.values()]
    .filter((item) => item.score <= now)
    .sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug))
    .slice(0, n);
  return sorted.map((item, i) => {
    const leaseToken = `${batchToken}:${i + 1}`;
    memQueue.delete(item.slug);
    memLeases.set(item.slug, { payload: item, leaseToken, leaseUntil });
    const { canonical, slug, queuedAt } = item;
    return {
      canonical,
      slug,
      queuedAt,
      leaseToken,
      leaseUntil,
      attempt: memAttempts.get(slug) || 0
    };
  });
};

export const ackBrainRefresh = async (entry) => {
  const slug = String(entry?.slug || '').trim();
  const token = String(entry?.leaseToken || '').trim();
  if (!slug || !token) return false;
  if (useUpstash) {
    return Number(await upstash([
      'EVAL',
      `if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
       redis.call('ZREM', KEYS[1], ARGV[1])
       redis.call('HDEL', KEYS[2], ARGV[1])
       redis.call('HDEL', KEYS[3], ARGV[1])
       redis.call('HDEL', KEYS[4], ARGV[1])
       return 1`,
      '4', LEASE_KEY, LEASE_TOKEN_KEY, PAYLOAD_KEY, ATTEMPTS_KEY, slug, token
    ])) === 1;
  }
  const lease = memLeases.get(slug);
  if (!lease || lease.leaseToken !== token) return false;
  memLeases.delete(slug);
  memAttempts.delete(slug);
  return true;
};

export const retryBrainRefresh = async (entry, options = {}) => {
  const slug = String(entry?.slug || '').trim();
  const token = String(entry?.leaseToken || '').trim();
  if (!slug || !token) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const requestedDelay = Number(options.delayMs);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(0, requestedDelay)
    : Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, Number(entry.attempt || 0))));
  if (useUpstash) {
    const result = await upstash([
      'EVAL',
      `if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
       redis.call('ZREM', KEYS[1], ARGV[1])
       redis.call('HDEL', KEYS[2], ARGV[1])
       local attempts = redis.call('HINCRBY', KEYS[5], ARGV[1], 1)
       if attempts >= tonumber(ARGV[4]) then
         local payload = redis.call('HGET', KEYS[3], ARGV[1]) or ''
         redis.call('HSET', KEYS[6], ARGV[1], payload)
         redis.call('HDEL', KEYS[3], ARGV[1])
         return -attempts
       end
       redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
       return attempts`,
      '6', LEASE_KEY, LEASE_TOKEN_KEY, PAYLOAD_KEY, QUEUE_KEY, ATTEMPTS_KEY, DEAD_KEY,
      slug, token, String(now + delayMs), String(maxAttempts)
    ]);
    return Number(result) !== 0;
  }
  const lease = memLeases.get(slug);
  if (!lease || lease.leaseToken !== token) return false;
  memLeases.delete(slug);
  const attempts = (memAttempts.get(slug) || 0) + 1;
  memAttempts.set(slug, attempts);
  if (attempts >= maxAttempts) {
    memDead.set(slug, { ...lease.payload, attempts });
  } else {
    memQueue.set(slug, { ...lease.payload, score: now + delayMs });
  }
  return true;
};

export const listDeadBrainRefreshes = async () => {
  if (useUpstash) {
    const all = (await upstash(['HGETALL', DEAD_KEY])) || [];
    const out = [];
    for (let i = 0; i < all.length; i += 2) {
      try {
        out.push({ ...JSON.parse(all[i + 1]), slug: all[i] });
      } catch {
        out.push({ slug: all[i], corrupt: true });
      }
    }
    return out;
  }
  return [...memDead.entries()].map(([slug, entry]) => ({ ...entry, slug }));
};

export const requeueDeadBrainRefresh = async (slug, options = {}) => {
  const s = String(slug || '').trim();
  if (!s) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (useUpstash) {
    return Number(await upstash([
      'EVAL',
      `local payload = redis.call('HGET', KEYS[1], ARGV[1])
       if not payload then return 0 end
       redis.call('HDEL', KEYS[1], ARGV[1])
       redis.call('HDEL', KEYS[2], ARGV[1])
       redis.call('HSET', KEYS[3], ARGV[1], payload)
       redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
       return 1`,
      '4', DEAD_KEY, ATTEMPTS_KEY, PAYLOAD_KEY, QUEUE_KEY, s, String(now)
    ])) === 1;
  }
  const entry = memDead.get(s);
  if (!entry) return false;
  memDead.delete(s);
  memAttempts.delete(s);
  memQueue.set(s, { ...entry, score: now });
  return true;
};

export const listRecentSearches = async () => {
  if (useUpstash) {
    const all = (await upstash(['HGETALL', SEARCH_LOG_KEY])) || [];
    const out = [];
    for (let i = 0; i < all.length; i += 2) {
      try { out.push(JSON.parse(all[i + 1])); } catch { /* skip */ }
    }
    return out;
  }
  return [...memSearchLog.values()];
};

export const _resetBrainQueueForTests = () => {
  if (useUpstash) return;
  memQueue.clear();
  memLeases.clear();
  memAttempts.clear();
  memDead.clear();
  memSearchLog.clear();
};
