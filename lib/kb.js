// /api/kb — curated knowledge base loader.
//
// The KB is a per-disease corpus stored as JSON in /data/kb/<slug>.json.
// Its job is to HELP FIND the right literature on every query — not to
// replace live search. Pinned landmark refs are a floor; literatureSearchSeeds
// and pipelineDrugs trigger explicit PubMed/EPMC/OpenAlex queries so topics
// like "IPF metformin" are retrieved fresh even when a generic condition
// search would miss them.
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

// "Huntingtons" → "huntington", "Huntington's" → "huntington" for matching.
const softenPhrase = (s) =>
  normalize(s)
    .split(' ')
    .map((w) => (w.length >= 5 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ')
    .trim();

const phraseMatchScore = (needle, haystack) => {
  if (!needle || !haystack) return 0;
  if (needle === haystack) return 100;
  const softNeedle = softenPhrase(needle);
  const softHay = softenPhrase(haystack);
  if (softNeedle === softHay) return 95;
  if (needle.includes(haystack) || haystack.includes(needle)) {
    return (Math.min(needle.length, haystack.length) / Math.max(needle.length, haystack.length)) * 90;
  }
  if (softNeedle.includes(softHay) || softHay.includes(softNeedle)) {
    return (Math.min(softNeedle.length, softHay.length) / Math.max(softNeedle.length, softHay.length)) * 85;
  }
  return 0;
};

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
      const score = phraseMatchScore(needle, h);
      if (score >= 100) return { kb, score: 100, matchedOn: h };
      if (score >= 40 && (!best || score > best.score)) {
        best = { kb, score, matchedOn: h };
      }
    }
  }

  if (best && best.score >= 40) return best;
  return null;
}

// Pure function called by evidence.js.
// Returns a list of KB items rendered in the same shape as evidence-pack items
// (so they can be merged cleanly), or [] if no KB matches.
//
// Pass `fallbackCanonical` / `fallbackSynonyms` when a disease dossier has
// already resolved typos ("Leber congetials amurosis" → LCA) so the curated
// KB still loads even when the raw user string does not match aliases.
export async function loadKb(conditionText, options = {}) {
  const { fallbackCanonical, fallbackSynonyms = [] } = options;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (value) => {
    const text = String(value || '').trim();
    const key = normalize(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(text);
  };
  addCandidate(conditionText);
  addCandidate(fallbackCanonical);
  for (const alias of fallbackSynonyms) addCandidate(alias);

  let match = null;
  for (const cand of candidates) {
    match = await matchKb(cand);
    if (match) break;
  }
  if (!match) return { matched: false, items: [], meta: null };

  const { kb } = match;

  // Human-review gate. Auto-generated KBs ship with `reviewed: false`. Until a
  // person verifies them, we hold back the *prescriptive* safety claims — the
  // "this drug was studied and failed" list (excludedAgents) and red-flag
  // warnings — because a single wrong entry would inject a brand-new error.
  // Everything else (grounded landmark papers, key facts with citations,
  // pipeline drugs) still ships, since those are descriptive and citation-backed.
  // Hand-curated KBs have no `reviewed` field (undefined) and are unaffected.
  const isUnreviewed = kb.reviewed === false;

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
      aliases: Array.isArray(kb.aliases) ? kb.aliases : [],
      version: kb.version,
      lastUpdated: kb.lastUpdated,
      curatedBy: kb.curatedBy,
      editorialNote: kb.editorialNote,
      itemCount: items.length,
      canonicalFacts: kb.canonicalFacts || [],
      lifestyleRecommendations: kb.lifestyleRecommendations || [],
      reviewed: kb.reviewed !== false,
      redFlags: isUnreviewed ? [] : (kb.redFlags || []),
      // Anti-"AI slop" guardrails — propagated to evidence.js, trials.js,
      // research.js synthesis prompt, and the post-synthesis coverage audit.
      pipelineDrugs: Array.isArray(kb.pipelineDrugs) ? kb.pipelineDrugs : [],
      excludedAgents: isUnreviewed ? [] : (Array.isArray(kb.excludedAgents) ? kb.excludedAgents : []),
      literatureSearchSeeds: Array.isArray(kb.literatureSearchSeeds) ? kb.literatureSearchSeeds : [],
      // Dossier-equivalent fields — carried through so disease-dossier.js
      // can skip the Haiku/Sonnet "realtime intake" Claude call for
      // conditions we have curated. This is the single biggest cost cut
      // in the pipeline (saves ~$0.025 per run per condition that has a
      // KB file — IPF, RP, and anything we add next).
      subspecialty: kb.subspecialty || '',
      icd10: kb.icd10 || '',
      icd11: kb.icd11 || '',
      meshTerms: Array.isArray(kb.meshTerms) ? kb.meshTerms : [],
      topCenters: Array.isArray(kb.topCenters) ? kb.topCenters : [],
      keyInvestigators: Array.isArray(kb.keyInvestigators) ? kb.keyInvestigators : [],
      patientAdvocacy: Array.isArray(kb.patientAdvocacy) ? kb.patientAdvocacy : [],
      landmarkTrials: Array.isArray(kb.landmarkTrials) ? kb.landmarkTrials : [],
      commonComorbidities: Array.isArray(kb.commonComorbidities) ? kb.commonComorbidities : [],
      lifestyleCategories: Array.isArray(kb.lifestyleCategories) ? kb.lifestyleCategories : []
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
