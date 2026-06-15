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
import { lookupDynamicKb, getDynamicKb } from './kb-store.js';
import { ensureDynamicKb } from './kb-bootstrap.js';
import { slugFromCondition } from './kb-builder.js';
import { getBrainOverlay } from './brain-overlay.js';

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

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "LADA" must not match Alzheimer alias "AD". Short tokens only match as whole words.
const hasWholeWord = (text, word) => {
  if (!text || !word) return false;
  const re = new RegExp(`(^|[\\s-])${escapeRe(word)}([\\s-]|$)`);
  return re.test(text);
};

const phraseMatchScore = (needle, haystack) => {
  if (!needle || !haystack) return 0;
  if (needle === haystack) return 100;
  const softNeedle = softenPhrase(needle);
  const softHay = softenPhrase(haystack);
  if (softNeedle === softHay) return 95;

  const minLen = Math.min(needle.length, haystack.length);
  if (minLen <= 3) {
    if (hasWholeWord(needle, haystack) || hasWholeWord(haystack, needle)) return 88;
    return 0;
  }

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

const applyBrainOverlay = async (result, slug) => {
  const overlay = await getBrainOverlay(slug);
  if (!overlay || !result?.matched) return result;

  result.meta.lastRefreshedAt = overlay.lastRefreshedAt || result.meta.lastRefreshedAt;
  result.meta.trialHighlights = overlay.trialHighlights || result.meta.trialHighlights || [];
  result.meta.webUpdates = overlay.webUpdates || result.meta.webUpdates || [];
  result.meta.dailyRefresh = true;

  for (const w of overlay.webUpdates || []) {
    if (!w?.title || !w?.url) continue;
    result.items.push({
      id: `daily-web-${result.items.length + 1}`,
      source: 'CuratedKB',
      isCuratedKB: true,
      isDailyRefresh: true,
      kbSlug: slug,
      kbCondition: result.meta.condition,
      category: 'review',
      tier: 'B',
      journalTier: 'B',
      title: w.title,
      authors: w.sourceName || 'Web (daily refresh)',
      journal: w.sourceName || 'Perplexity web scout',
      year: w.year || null,
      url: w.url,
      accessLevel: 'abstract',
      summary: w.finding || '',
      keyPassages: [],
      abstract: w.finding ? `Daily refresh: ${w.finding}` : ''
    });
  }
  result.meta.itemCount = result.items.length;
  return result;
};

const kbRecordToLoadResult = (kb, match) => {
  const isUnreviewed = kb.reviewed === false;
  const isDynamic = kb.source === 'dynamic-brain' || match.matchedOn?.startsWith('dynamic');

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
      source: isDynamic ? 'dynamic-brain' : 'static',
      dynamicBuiltAt: kb.dynamicBuiltAt || null,
      canonicalFacts: kb.canonicalFacts || [],
      lifestyleRecommendations: kb.lifestyleRecommendations || [],
      reviewed: kb.reviewed !== false,
      redFlags: isUnreviewed ? [] : (kb.redFlags || []),
      pipelineDrugs: Array.isArray(kb.pipelineDrugs) ? kb.pipelineDrugs : [],
      excludedAgents: isUnreviewed ? [] : (Array.isArray(kb.excludedAgents) ? kb.excludedAgents : []),
      literatureSearchSeeds: Array.isArray(kb.literatureSearchSeeds) ? kb.literatureSearchSeeds : [],
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
};

async function lookupDynamicKbForCandidates(candidates) {
  for (const cand of candidates) {
    const dyn = await lookupDynamicKb(cand);
    if (dyn) return { kb: dyn, score: 88, matchedOn: 'dynamic-brain' };
  }
  const slug = slugFromCondition(candidates.find(Boolean));
  if (slug) {
    const bySlug = await getDynamicKb(slug);
    if (bySlug) return { kb: bySlug, score: 88, matchedOn: 'dynamic-brain' };
  }
  return null;
};

// Pure function called by evidence.js.
// Returns a list of KB items rendered in the same shape as evidence-pack items
// (so they can be merged cleanly), or [] if no KB matches.
//
// Pass `fallbackCanonical` / `fallbackSynonyms` when a disease dossier has
// already resolved typos ("Leber congetials amurosis" → LCA) so the curated
// KB still loads even when the raw user string does not match aliases.
export async function loadKb(conditionText, options = {}) {
  const {
    fallbackCanonical,
    fallbackSynonyms = [],
    ensureBuild = false,
    dossier = null
  } = options;
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
  if (match) return applyBrainOverlay(kbRecordToLoadResult(match.kb, match), match.kb.slug);

  const dynamicMatch = await lookupDynamicKbForCandidates(candidates);
  if (dynamicMatch) {
    const result = kbRecordToLoadResult(dynamicMatch.kb, dynamicMatch);
    if (dynamicMatch.kb.lastRefreshedAt) result.meta.lastRefreshedAt = dynamicMatch.kb.lastRefreshedAt;
    if (dynamicMatch.kb.trialHighlights) result.meta.trialHighlights = dynamicMatch.kb.trialHighlights;
    if (dynamicMatch.kb.webUpdates) result.meta.webUpdates = dynamicMatch.kb.webUpdates;
    return result;
  }

  if (ensureBuild && fallbackCanonical) {
    const built = await ensureDynamicKb(fallbackCanonical, dossier || {});
    if (built) {
      return kbRecordToLoadResult(built, {
        score: 90,
        matchedOn: built.dynamicBuiltAt ? 'dynamic-brain-new' : 'dynamic-brain'
      });
    }
  }

  return { matched: false, items: [], meta: null };
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
        note: 'No reference pack yet. A full research run will build one from PubMed + Perplexity + Claude for future searches.',
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
