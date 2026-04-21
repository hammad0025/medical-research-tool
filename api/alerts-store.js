// Pluggable subscription store for weekly email alerts.
//
// Supports two backends, picked at runtime from env vars:
//
//   1. Upstash Redis REST (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//      — durable, free tier gives 10k commands/day which is plenty for
//      this scale. The REST API is fetch-based, so no native dependency.
//   2. In-memory Map (default, used when Upstash isn't configured).
//      — zero setup, resets on every cold start. Fine for local dev +
//      the e2e suite; in production the cron would have nothing to run.
//
// Key layout (Redis):
//   alerts:sub:<id>          → JSON blob for that subscription
//   alerts:index             → Set of all subscription IDs (for listAll)
//   alerts:by-email:<email>  → Set of subscription IDs owned by that email
//   alerts:sent:<id>         → Set of itemIds already emailed (capped at 500)
//
// All operations return promises, even in the in-memory path, so the
// caller doesn't care which backend is in use.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

// ---------- Upstash REST primitive --------------------------------------

// Upstash's REST API accepts either path-style (/SET/key/value) or body-style
// (JSON array of command parts) requests. Body-style is safer for arbitrary
// values containing slashes/binary/unicode. Every call needs the Bearer token.
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

// ---------- In-memory fallback ------------------------------------------

const memStore = {
  subs: new Map(),         // id -> subscription object
  byEmail: new Map(),      // email -> Set of ids
  sentLedger: new Map()    // id -> Set of itemIds already emailed
};

// ---------- Public API --------------------------------------------------

export const isConfigured = () => useUpstash;
export const backendName = () => (useUpstash ? 'upstash-redis' : 'in-memory (ephemeral)');

export const putSubscription = async (sub) => {
  if (!sub.id) throw new Error('sub.id required');
  const normalizedEmail = String(sub.email || '').trim().toLowerCase();
  sub.email = normalizedEmail;
  if (useUpstash) {
    await upstash(['SET', `alerts:sub:${sub.id}`, JSON.stringify(sub)]);
    await upstash(['SADD', 'alerts:index', sub.id]);
    await upstash(['SADD', `alerts:by-email:${normalizedEmail}`, sub.id]);
  } else {
    memStore.subs.set(sub.id, sub);
    if (!memStore.byEmail.has(normalizedEmail)) memStore.byEmail.set(normalizedEmail, new Set());
    memStore.byEmail.get(normalizedEmail).add(sub.id);
  }
  return sub;
};

export const getSubscription = async (id) => {
  if (useUpstash) {
    const raw = await upstash(['GET', `alerts:sub:${id}`]);
    return raw ? JSON.parse(raw) : null;
  }
  return memStore.subs.get(id) || null;
};

export const deleteSubscription = async (id) => {
  const sub = await getSubscription(id);
  if (!sub) return false;
  if (useUpstash) {
    await upstash(['DEL', `alerts:sub:${id}`]);
    await upstash(['SREM', 'alerts:index', id]);
    await upstash(['SREM', `alerts:by-email:${sub.email}`, id]);
    await upstash(['DEL', `alerts:sent:${id}`]);
  } else {
    memStore.subs.delete(id);
    memStore.byEmail.get(sub.email)?.delete(id);
    memStore.sentLedger.delete(id);
  }
  return true;
};

export const listSubscriptions = async () => {
  if (useUpstash) {
    const ids = (await upstash(['SMEMBERS', 'alerts:index'])) || [];
    if (!ids.length) return [];
    const raws = await upstash(['MGET', ...ids.map((id) => `alerts:sub:${id}`)]);
    return raws.filter(Boolean).map((s) => JSON.parse(s));
  }
  return [...memStore.subs.values()];
};

export const listSubscriptionsByEmail = async (email) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return [];
  if (useUpstash) {
    const ids = (await upstash(['SMEMBERS', `alerts:by-email:${normalizedEmail}`])) || [];
    if (!ids.length) return [];
    const raws = await upstash(['MGET', ...ids.map((id) => `alerts:sub:${id}`)]);
    return raws.filter(Boolean).map((s) => JSON.parse(s));
  }
  const ids = [...(memStore.byEmail.get(normalizedEmail) || [])];
  return ids.map((id) => memStore.subs.get(id)).filter(Boolean);
};

// Sent-item ledger: tracks which item IDs (DOI or PMID) we've already
// included in an email for this subscription, so the next weekly run
// doesn't re-email the same landmark paper every week. Capped at 500 IDs
// per subscription to bound storage.
export const getSentLedger = async (subId) => {
  if (useUpstash) {
    const ids = (await upstash(['SMEMBERS', `alerts:sent:${subId}`])) || [];
    return new Set(ids);
  }
  return memStore.sentLedger.get(subId) || new Set();
};

export const addToSentLedger = async (subId, itemIds) => {
  if (!itemIds || !itemIds.length) return;
  if (useUpstash) {
    await upstash(['SADD', `alerts:sent:${subId}`, ...itemIds]);
    // Cap the ledger at 500 members to keep memory bounded. Upstash has no
    // direct cap, so we re-read and re-seed if oversized. Cheap because
    // this runs once a week per subscription.
    const count = await upstash(['SCARD', `alerts:sent:${subId}`]);
    if (count > 500) {
      const all = await upstash(['SMEMBERS', `alerts:sent:${subId}`]);
      const keep = all.slice(-500);
      await upstash(['DEL', `alerts:sent:${subId}`]);
      if (keep.length) await upstash(['SADD', `alerts:sent:${subId}`, ...keep]);
    }
    return;
  }
  if (!memStore.sentLedger.has(subId)) memStore.sentLedger.set(subId, new Set());
  const set = memStore.sentLedger.get(subId);
  itemIds.forEach((id) => set.add(id));
  if (set.size > 500) {
    const arr = [...set].slice(-500);
    memStore.sentLedger.set(subId, new Set(arr));
  }
};

// Test-only: wipe the in-memory store. No-op against Upstash so we never
// nuke production data from a local test run.
export const _resetForTests = () => {
  if (useUpstash) return;
  memStore.subs.clear();
  memStore.byEmail.clear();
  memStore.sentLedger.clear();
};
