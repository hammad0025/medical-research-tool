// Persistent store for dynamically built knowledge bases.
//
// When a user searches a condition we do not have a static JSON file for,
// the pipeline can build a grounded KB (PubMed + Perplexity + Claude) and
// save it here so the next search — by anyone — starts smarter.
//
// Backends (picked at runtime from env vars):
//   1. Upstash Redis via the official @upstash/redis REST client when
//      UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set. REST-based,
//      so it works inside Vercel serverless and gives cross-instance
//      persistence — the same condition built on one cold instance is a cache
//      hit on every other instance.
//   2. In-memory Map (default, used when Upstash isn't configured). Resets on
//      every cold start. Fine for local dev + tests; production must set
//      Upstash or every search re-builds.
//
// A dynamic KB is stored as an opaque JSON blob: the whole object is
// round-tripped through the client untouched, so any new fields (e.g.
// provenance/QA stamps added elsewhere) survive automatically without changes
// here.

import { Redis } from '@upstash/redis';

// Trim creds: a stray trailing newline/space in the Vercel env var makes the
// @upstash/redis client throw UrlError at construction, which (since the client
// is built at module load) crashes the ENTIRE /api/research function on import.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const credentialsConfigured = !!(UPSTASH_URL && UPSTASH_TOKEN);

const PREFIX = 'kb:dynamic:';
const INDEX_KEY = 'kb:dynamic:index';
const ALIAS_PREFIX = 'kb:dynamic:alias:';
const ALIAS_SET_PREFIX = 'kb:dynamic:aliases:';

// Construct the client only when configured. The constructor does not open a
// connection (the REST client is stateless), so this never crashes at import
// time when Upstash isn't set — local/dev simply falls through to in-memory.
let redis = null;
let redisInitError = null;
if (credentialsConfigured) {
  try {
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  } catch (error) {
    redisInitError = error;
  }
}
const useUpstash = !!redis;

const normalizeKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const mem = {
  bySlug: new Map(),
  aliasToSlug: new Map(),
  index: new Set()
};

export const isDynamicKbStoreConfigured = () => useUpstash;
export const dynamicKbBackendName = () => (useUpstash ? 'upstash-redis' : 'in-memory (ephemeral)');
export const dynamicKbStoreConfigError = () => redisInitError?.message || null;

export const getDynamicKb = async (slug) => {
  if (!slug) return null;
  if (useUpstash) {
    const kb = await redis.get(`${PREFIX}${slug}`);
    if (typeof kb === 'string') {
      try { return JSON.parse(kb); } catch { return null; }
    }
    return kb || null;
  }
  return mem.bySlug.get(slug) || null;
};

export const lookupDynamicKb = async (conditionText) => {
  const key = normalizeKey(conditionText);
  if (!key) return null;

  if (useUpstash) {
    const slug = await redis.get(`${ALIAS_PREFIX}${key}`);
    if (slug) {
      const kb = await getDynamicKb(String(slug));
      if (kb) return kb;
      // Repair a dangling alias left by data created before atomic writes.
      await redis.del(`${ALIAS_PREFIX}${key}`);
    }
    // Fall back to slug derived from the string itself.
    return getDynamicKb(key.replace(/\s+/g, '-').slice(0, 64));
  }

  const slug = mem.aliasToSlug.get(key);
  if (slug) return mem.bySlug.get(slug) || null;
  return mem.bySlug.get(key.replace(/\s+/g, '-').slice(0, 64)) || null;
};

const aliasKeysForKb = (kb) => {
  const keys = new Set();
  const add = (s) => {
    const k = normalizeKey(s);
    if (k) keys.add(k);
  };
  add(kb.condition);
  add(kb.slug);
  for (const a of kb.aliases || []) add(a);
  return [...keys];
};

export const putDynamicKb = async (kb) => {
  if (!kb?.slug) throw new Error('kb.slug required');
  const stored = {
    ...kb,
    dynamicBuiltAt: kb.dynamicBuiltAt || new Date().toISOString(),
    source: 'dynamic-brain'
  };
  const aliases = aliasKeysForKb(stored);

  if (useUpstash) {
    // One Redis script commits the blob, index and alias replacement together.
    // A failed request therefore leaves the previous complete version intact.
    await redis.eval(
      `local old = redis.call('SMEMBERS', KEYS[3])
       for _, alias in ipairs(old) do
         local aliasKey = ARGV[1] .. alias
         if redis.call('GET', aliasKey) == ARGV[2] then redis.call('DEL', aliasKey) end
       end
       redis.call('DEL', KEYS[3])
       redis.call('SET', KEYS[1], ARGV[3])
       redis.call('SADD', KEYS[2], ARGV[2])
       for i = 4, #ARGV do
         redis.call('SET', ARGV[1] .. ARGV[i], ARGV[2])
         redis.call('SADD', KEYS[3], ARGV[i])
       end
       return 1`,
      [`${PREFIX}${stored.slug}`, INDEX_KEY, `${ALIAS_SET_PREFIX}${stored.slug}`],
      [ALIAS_PREFIX, stored.slug, JSON.stringify(stored), ...aliases]
    );
  } else {
    for (const [alias, slug] of mem.aliasToSlug) {
      if (slug === stored.slug) mem.aliasToSlug.delete(alias);
    }
    mem.bySlug.set(stored.slug, structuredClone(stored));
    mem.index.add(stored.slug);
    for (const alias of aliases) {
      mem.aliasToSlug.set(alias, stored.slug);
    }
  }
  return stored;
};

export const listDynamicKbSlugs = async () => {
  if (useUpstash) {
    return (await redis.smembers(INDEX_KEY)) || [];
  }
  return [...mem.index];
};

// Best-effort repair for indexes written by older, non-transactional code.
export const repairDynamicKbStore = async () => {
  const slugs = await listDynamicKbSlugs();
  const removed = [];
  for (const slug of slugs) {
    if (await getDynamicKb(slug)) continue;
    if (useUpstash) await redis.srem(INDEX_KEY, slug);
    else mem.index.delete(slug);
    removed.push(slug);
  }
  return { checked: slugs.length, removed };
};

export const _resetDynamicKbForTests = () => {
  if (useUpstash) return;
  mem.bySlug.clear();
  mem.aliasToSlug.clear();
  mem.index.clear();
};
