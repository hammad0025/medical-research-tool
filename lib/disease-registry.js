// Every Cure disease registry — ~19k drug-targetable conditions from Mondo.
// Built by scripts/build-disease-registry.mjs from everycure/disease-list (CC-BY-4.0).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'disease-registry.json');

let registry = null;
let aliasIndex = null;
let loadedAt = 0;
const TTL_MS = 10 * 60 * 1000;

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const soften = (s) =>
  normalize(s)
    .split(' ')
    .map((w) => (w.length >= 5 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ')
    .trim();

const scorePhrase = (needle, hay) => {
  if (!needle || !hay) return 0;
  if (needle === hay) return 100;
  const sn = soften(needle);
  const sh = soften(hay);
  if (sn === sh) return 95;
  if (needle.includes(hay) || hay.includes(needle)) {
    return (Math.min(needle.length, hay.length) / Math.max(needle.length, hay.length)) * 88;
  }
  if (sn.includes(sh) || sh.includes(sn)) {
    return (Math.min(sn.length, sh.length) / Math.max(sn.length, sh.length)) * 82;
  }
  return 0;
};

const buildAliasIndex = (diseases) => {
  const index = new Map();
  const add = (phrase, entry) => {
    const key = normalize(phrase);
    if (!key || key.length < 2) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  };
  for (const d of diseases) {
    add(d.name, d);
    add(d.slug.replace(/-/g, ' '), d);
    for (const syn of d.synonyms || []) add(syn, d);
  }
  return index;
};

export const loadDiseaseRegistry = async () => {
  const now = Date.now();
  if (registry && now - loadedAt < TTL_MS) return registry;
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    registry = JSON.parse(raw);
    aliasIndex = buildAliasIndex(registry.diseases || []);
    loadedAt = now;
    return registry;
  } catch (e) {
    console.warn('[disease-registry] not loaded:', e?.message || e);
    registry = { count: 0, diseases: [] };
    aliasIndex = new Map();
    loadedAt = now;
    return registry;
  }
};

export const registryStats = async () => {
  const r = await loadDiseaseRegistry();
  return {
    loaded: (r.diseases || []).length > 0,
    count: r.count || (r.diseases || []).length,
    version: r.version,
    source: r.source,
    builtAt: r.builtAt
  };
};

// Best registry match for free-text input. Returns { entry, score, matchedOn } or null.
export const lookupDisease = async (conditionText) => {
  const needle = normalize(conditionText);
  if (!needle || needle.length < 2) return null;
  await loadDiseaseRegistry();

  let best = null;
  const consider = (entry, phrase) => {
    const score = scorePhrase(needle, normalize(phrase));
    if (score >= 100) return { entry, score: 100, matchedOn: phrase };
    if (score >= 55 && (!best || score > best.score)) {
      best = { entry, score, matchedOn: phrase };
    }
    return null;
  };

  // Exact alias bucket first
  const bucket = aliasIndex.get(needle);
  if (bucket?.length === 1) {
    return { entry: bucket[0], score: 100, matchedOn: conditionText };
  }
  if (bucket?.length > 1) {
    for (const entry of bucket) {
      const exact = consider(entry, entry.name);
      if (exact) return exact;
    }
  }

  for (const entry of registry.diseases || []) {
    const exact = consider(entry, entry.name);
    if (exact) return exact;
    for (const syn of entry.synonyms || []) {
      const hit = consider(entry, syn);
      if (hit) return hit;
    }
  }

  return best;
};

export const buildDossierFromRegistry = (input, match) => {
  const entry = match?.entry;
  if (!entry?.name) return null;
  const group = entry.group ? String(entry.group) : '';
  const specialty = entry.specialty ? String(entry.specialty) : '';
  const subspecialty = [specialty, group].filter(Boolean).join(' / ') || '';

  return {
    canonical: entry.name,
    synonyms: [entry.name, ...(entry.synonyms || [])].filter(
      (s, i, arr) => s && arr.indexOf(s) === i
    ).slice(0, 14),
    meshTerms: [],
    subspecialty,
    topCenters: [],
    keyInvestigators: [],
    patientAdvocacy: [],
    landmarkTrials: [],
    commonComorbidities: [],
    redFlags: [],
    lifestyleCategories: [],
    uncertainty: 0.12,
    notes: entry.definition
      ? `${entry.definition} (Every Cure registry · ${entry.mondo}${entry.orpha ? ` · ORPHA:${entry.orpha}` : ''})`
      : `Resolved from Every Cure disease registry (${entry.mondo}${entry.orpha ? ` · ORPHA:${entry.orpha}` : ''}).`,
    mondoId: entry.mondo,
    orphaId: entry.orpha || null,
    registrySlug: entry.slug,
    rare: !!entry.rare
  };
};
