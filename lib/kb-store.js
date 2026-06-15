// Persistent store for dynamically built knowledge bases.
//
// When a user searches a condition we do not have a static JSON file for,
// the pipeline can build a grounded KB (PubMed + Perplexity + Claude) and
// save it here so the next search — by anyone — starts smarter.
//
// Backends (same pattern as alerts-store.js):
//   1. Upstash Redis REST when UPSTASH_REDIS_REST_URL + TOKEN are set
//   2. In-memory Map (dev / cold-start ephemeral)

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const PREFIX = 'kb:dynamic:';
const INDEX_KEY = 'kb:dynamic:index';
const ALIAS_PREFIX = 'kb:dynamic:alias:';

const normalizeKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  bySlug: new Map(),
  aliasToSlug: new Map(),
  index: new Set()
};

export const isDynamicKbStoreConfigured = () => useUpstash;
export const dynamicKbBackendName = () => (useUpstash ? 'upstash-redis' : 'in-memory (ephemeral)');

export const getDynamicKb = async (slug) => {
  if (!slug) return null;
  if (useUpstash) {
    const raw = await upstash(['GET', `${PREFIX}${slug}`]);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.bySlug.get(slug) || null;
};

export const lookupDynamicKb = async (conditionText) => {
  const key = normalizeKey(conditionText);
  if (!key) return null;

  if (useUpstash) {
    const slug = await upstash(['GET', `${ALIAS_PREFIX}${key}`]);
    if (slug) return getDynamicKb(slug);
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
  kb.dynamicBuiltAt = kb.dynamicBuiltAt || new Date().toISOString();
  kb.source = 'dynamic-brain';

  if (useUpstash) {
    await upstash(['SET', `${PREFIX}${kb.slug}`, JSON.stringify(kb)]);
    await upstash(['SADD', INDEX_KEY, kb.slug]);
    for (const alias of aliasKeysForKb(kb)) {
      await upstash(['SET', `${ALIAS_PREFIX}${alias}`, kb.slug]);
    }
  } else {
    mem.bySlug.set(kb.slug, kb);
    mem.index.add(kb.slug);
    for (const alias of aliasKeysForKb(kb)) {
      mem.aliasToSlug.set(alias, kb.slug);
    }
  }
  return kb;
};

export const listDynamicKbSlugs = async () => {
  if (useUpstash) {
    return (await upstash(['SMEMBERS', INDEX_KEY])) || [];
  }
  return [...mem.index];
};

export const _resetDynamicKbForTests = () => {
  if (useUpstash) return;
  mem.bySlug.clear();
  mem.aliasToSlug.clear();
  mem.index.clear();
};
