// /api/kb — curated knowledge base loader.
//
// The KB is a per-disease corpus of hand-curated landmark references
// (guidelines, landmark RCTs, FDA labels, authoritative reviews) stored as
// JSON files in /data/kb/<slug>.json. Every query on a condition that has a
// KB file pins these references into the evidence pack so Claude always sees
// the canonical ground truth — not just whatever the live PubMed search
// happened to rank highly this minute.
//
// This module is used TWO ways:
//   1. As a Vercel serverless HTTP endpoint: GET /api/kb?condition=IPF
//      (returns { matched, slug, condition, kb: {...} } or { matched: false })
//   2. As an importable function: `import { loadKb } from './kb.js'`
//      called by evidence.js to inject KB items into the pack.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, '..', 'data', 'kb');

let kbCache = null;
let kbCacheLoadedAt = 0;
const KB_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadAllKbs() {
  const now = Date.now();
  if (kbCache && now - kbCacheLoadedAt < KB_CACHE_TTL_MS) return kbCache;

  const out = [];
  try {
    const files = await fs.readdir(KB_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (f.startsWith('_')) continue;
      try {
        const raw = await fs.readFile(path.join(KB_DIR, f), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.slug && Array.isArray(parsed.items)) {
          out.push(parsed);
        }
      } catch (err) {
        console.warn(`[kb] failed to parse ${f}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[kb] KB directory unreadable:', err.message);
  }

  kbCache = out;
  kbCacheLoadedAt = now;
  return out;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Match a free-text condition string against available KBs using slug and aliases.
// Returns { kb, score } for the best match, or null.
export async function matchKb(conditionText) {
  const needle = normalize(conditionText);
  if (!needle) return null;

  const all = await loadAllKbs();
  let best = null;

  for (const kb of all) {
    const haystackTokens = [kb.slug, kb.condition, ...(kb.aliases || [])]
      .map(normalize)
      .filter(Boolean);

    for (const h of haystackTokens) {
      if (!h) continue;
      if (needle === h) {
        return { kb, score: 100, matchedOn: h };
      }
      if (needle.includes(h) || h.includes(needle)) {
        const score = Math.min(needle.length, h.length) /
                      Math.max(needle.length, h.length) * 90;
        if (!best || score > best.score) {
          best = { kb, score, matchedOn: h };
        }
      }
    }
  }

  if (best && best.score >= 40) return best;
  return null;
}

// Pure function called by evidence.js.
// Returns a list of KB items rendered in the same shape as evidence-pack items
// (so they can be merged cleanly), or [] if no KB matches.
export async function loadKb(conditionText) {
  const match = await matchKb(conditionText);
  if (!match) return { matched: false, items: [], meta: null };

  const { kb } = match;
  const items = (kb.items || []).map((it) => ({
    id: it.id,
    source: 'CuratedKB',
    isCuratedKB: true,
    kbSlug: kb.slug,
    kbCondition: kb.condition,
    category: it.category,
    tier: it.tier,
    journalTier: it.tier,
    title: it.title,
    authors: it.authors,
    journal: it.journal,
    year: it.year,
    doi: it.doi,
    pmid: it.pmid,
    url: it.url,
    accessLevel: it.accessLevel || 'abstract',
    summary: it.summary || '',
    keyPassages: Array.isArray(it.keyPassages) ? it.keyPassages : [],
    abstract: [
      it.summary ? `Editor's summary: ${it.summary}` : '',
      ...(Array.isArray(it.keyPassages) ? it.keyPassages : []).map(
        (p) => `Verbatim passage (${p.topic}): "${p.quote}"`
      )
    ]
      .filter(Boolean)
      .join('\n\n')
  }));

  return {
    matched: true,
    matchedOn: match.matchedOn,
    score: match.score,
    items,
    meta: {
      condition: kb.condition,
      slug: kb.slug,
      version: kb.version,
      lastUpdated: kb.lastUpdated,
      curatedBy: kb.curatedBy,
      editorialNote: kb.editorialNote,
      itemCount: items.length,
      canonicalFacts: kb.canonicalFacts || [],
      lifestyleRecommendations: kb.lifestyleRecommendations || [],
      redFlags: kb.redFlags || []
    }
  };
}

export async function listKbs() {
  const all = await loadAllKbs();
  return all.map((kb) => ({
    slug: kb.slug,
    condition: kb.condition,
    aliases: kb.aliases || [],
    version: kb.version,
    lastUpdated: kb.lastUpdated,
    itemCount: (kb.items || []).length
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const condition = body.condition || body.q;

    if (!condition) {
      const all = await listKbs();
      return res.status(200).json({
        availableKnowledgeBases: all,
        note: 'Provide ?condition=<name> to retrieve a specific KB.'
      });
    }

    const result = await loadKb(condition);
    if (!result.matched) {
      const all = await listKbs();
      return res.status(200).json({
        matched: false,
        requestedCondition: condition,
        note: 'No curated knowledge base exists for this condition. Live-fetched evidence will still be provided; consider hand-curating a KB to pin ground-truth references.',
        availableKnowledgeBases: all
      });
    }

    return res.status(200).json({
      matched: true,
      matchedOn: result.matchedOn,
      score: result.score,
      meta: result.meta,
      items: result.items
    });
  } catch (err) {
    console.error('[kb] handler error:', err);
    return res.status(500).json({
      error: 'kb_failed',
      detail: err.message || String(err)
    });
  }
}
