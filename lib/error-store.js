// Persistent per-condition error memory.
//
// Dorothy's request: "the tool should remember the errors it catches and not
// repeat them." Two things feed this store:
//   1. The second-AI cross-validator (lib/validate.js) — every claim it marks
//      disputed / unsupported, and every citation it marks hallucinated, is
//      saved here against the condition it was found in.
//   2. The user ("Dorothy can teach it") — a manual flag from the UI.
// On the next report for that same condition, api/research.js pulls these back
// out and injects them into the synthesis prompt as known failure modes the
// model must not repeat.
//
// Backends (picked at runtime from env vars — same pattern as lib/kb-store.js):
//   1. Upstash Redis via the official @upstash/redis REST client when
//      UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set. REST-based,
//      so it survives across Vercel serverless instances — an error caught on
//      one cold instance is remembered on every other instance.
//   2. In-memory Map (default, used when Upstash isn't configured). Resets on
//      every cold start. Fine for local dev + tests.

import { Redis } from '@upstash/redis';

// Trim creds: a stray trailing newline/space in the Vercel env var makes the
// @upstash/redis client throw UrlError at construction, which (since the client
// is built at module load) would crash the whole importing function. Mirror the
// exact defensive trim kb-store.js uses.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const PREFIX = 'errors:';

// Newest-kept cap on the stored list. Old mistakes matter less than recent
// ones, and an unbounded list would eventually blow up both Redis payloads and
// the prompt block. ~50 gives plenty of memory per condition.
const MAX_ERRORS = 50;

// Construct the client only when configured. The constructor does not open a
// connection (the REST client is stateless), so this never crashes at import
// time when Upstash isn't set — local/dev simply falls through to in-memory.
const redis = useUpstash ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN }) : null;

const normalizeKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// In-memory fallback: condition-key -> array of error records.
const mem = new Map();

export const isErrorStoreConfigured = () => useUpstash;
export const errorStoreBackendName = () => (useUpstash ? 'upstash-redis' : 'in-memory (ephemeral)');

// Dedupe signature for a record: the quote (verbatim text the validator
// flagged) is the strongest key; fall back to the claim. Normalized so trivial
// whitespace/punctuation/case differences collapse to the same mistake.
const dedupeSig = (rec) =>
  normalizeKey(rec?.quote || rec?.claim || '');

const ALLOWED_TYPES = new Set([
  'disputed',
  'unsupported',
  'hallucinated_citation',
  'user_flagged'
]);

// Coerce arbitrary input into a clean, storable error record. Drops anything
// with no identifying text (nothing to dedupe or learn from) by returning null.
const sanitizeRecord = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => {
    if (v == null) return undefined;
    const s = String(v).trim();
    return s ? s : undefined;
  };
  const type = ALLOWED_TYPES.has(raw.type) ? raw.type : 'unsupported';
  const rec = {
    type,
    claim: str(raw.claim),
    quote: str(raw.quote),
    reason: str(raw.reason),
    correction: str(raw.correction),
    url: str(raw.url),
    source: raw.source === 'user' ? 'user' : 'validator',
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now()
  };
  // Drop undefined fields so records stay compact.
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  if (!dedupeSig(rec)) return null;
  return rec;
};

const readList = async (key) => {
  if (useUpstash) {
    const list = await redis.get(`${PREFIX}${key}`);
    return Array.isArray(list) ? list : [];
  }
  return mem.get(key) ? [...mem.get(key)] : [];
};

const writeList = async (key, list) => {
  if (useUpstash) {
    await redis.set(`${PREFIX}${key}`, list);
  } else {
    mem.set(key, list);
  }
};

// Record one or more error records against a condition. Deduping is on the
// normalized quote/claim text so the same mistake caught across many reports is
// only stored once (the newest wins — it may carry a better correction). The
// list is capped at MAX_ERRORS, keeping the most recent. Returns the number of
// records now stored for the condition.
export const recordConditionErrors = async (condition, records) => {
  const key = normalizeKey(condition);
  if (!key) return 0;
  const incoming = (Array.isArray(records) ? records : [records])
    .map(sanitizeRecord)
    .filter(Boolean);
  if (!incoming.length) return (await readList(key)).length;

  const existing = await readList(key);
  // Index existing by dedupe signature so a re-caught mistake refreshes in
  // place (moves to newest, keeps the latest correction) instead of piling up.
  const bySig = new Map();
  for (const rec of existing) bySig.set(dedupeSig(rec), rec);
  for (const rec of incoming) bySig.set(dedupeSig(rec), rec);

  // Newest last → sort by ts ascending, then keep the last MAX_ERRORS.
  const merged = [...bySig.values()]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-MAX_ERRORS);

  await writeList(key, merged);
  return merged.length;
};

// Fetch stored error records for a condition, newest first. `limit` caps how
// many are returned (the prompt builder asks for ~15 so the block can't blow
// up the prompt); pass 0/undefined for all.
export const getConditionErrors = async (condition, limit = 0) => {
  const key = normalizeKey(condition);
  if (!key) return [];
  const list = await readList(key);
  const newestFirst = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return limit > 0 ? newestFirst.slice(0, limit) : newestFirst;
};

export const _resetErrorStoreForTests = () => {
  if (useUpstash) return;
  mem.clear();
};
