// Queue of conditions the brain should refresh daily — populated when users
// search, drained by /api/brain-cron.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const QUEUE_KEY = 'brain:refresh:queue';
const SEARCH_LOG_KEY = 'brain:search:log';

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
const memSearchLog = new Map();

export const isBrainQueueConfigured = () => useUpstash;

export const enqueueBrainRefresh = async (canonical, slug) => {
  const name = String(canonical || '').trim();
  const s = String(slug || '').trim();
  if (!name || !s) return;
  const now = Date.now();
  const entry = JSON.stringify({ canonical: name, slug: s, queuedAt: new Date(now).toISOString() });

  if (useUpstash) {
    await upstash(['ZADD', QUEUE_KEY, now, entry]);
    await upstash(['HSET', SEARCH_LOG_KEY, s, entry]);
  } else {
    memQueue.set(s, { canonical: name, slug: s, queuedAt: now, score: now });
    memSearchLog.set(s, { canonical: name, slug: s, queuedAt: now });
  }
};

export const logBrainSearch = async (canonical, slug) => {
  await enqueueBrainRefresh(canonical, slug);
};

export const dequeueBrainRefreshBatch = async (limit = 8) => {
  const n = Math.max(1, Math.min(Number(limit) || 8, 20));
  if (useUpstash) {
    const raw = (await upstash(['ZRANGE', QUEUE_KEY, 0, n - 1])) || [];
    if (!raw.length) return [];
    const out = raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    for (const item of raw) await upstash(['ZREM', QUEUE_KEY, item]);
    return out;
  }
  const sorted = [...memQueue.values()].sort((a, b) => a.score - b.score).slice(0, n);
  for (const item of sorted) memQueue.delete(item.slug);
  return sorted.map(({ canonical, slug, queuedAt }) => ({ canonical, slug, queuedAt }));
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
  memSearchLog.clear();
};
