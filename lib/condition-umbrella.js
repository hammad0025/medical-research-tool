// Ontology validator for umbrella / subtype information.
//
// Universal resolution is agent-primary: the LLM dossier resolves ANY input to a
// canonical disease and, when the term is broad (diabetes, tuberculosis,
// leukemia), reports `isUmbrella` + a clean `subtypes` list. An LLM disambiguates
// polysemy that pure string matching cannot — "celiac disease" vs "celiac artery"
// — so it is the right generator.
//
// This module is the deterministic HALF that grounds the agent: it cross-checks
// each agent-named subtype against the ~19k Mondo registry, attaching a real
// MONDO id when the name is a known disease and flagging the rest as unconfirmed.
// It never invents names; it only confirms.

import { normalize } from './normalize.js';
import { loadDiseaseRegistry } from './disease-registry.js';

let indexPromise = null;
// name/alias (normalized) -> { canonical, mondo }
const buildIndex = async () => {
  const index = new Map();
  let diseases = [];
  try {
    const reg = await loadDiseaseRegistry();
    diseases = reg?.diseases || [];
  } catch {
    diseases = [];
  }
  for (const entry of diseases) {
    if (!entry?.name) continue;
    const record = { canonical: entry.name, mondo: entry.mondo || null };
    const keys = [entry.name, ...(entry.synonyms || [])];
    for (const k of keys) {
      const nk = normalize(k);
      if (nk && !index.has(nk)) index.set(nk, record);
    }
  }
  return index;
};

const getIndex = () => {
  if (!indexPromise) indexPromise = buildIndex();
  return indexPromise;
};

/**
 * Confirm a single disease/subtype name against the ontology.
 * @returns {Promise<{name:string, ontologyConfirmed:boolean, mondo:string|null, canonical:string|null}>}
 */
export const ontologyConfirm = async (name) => {
  const nk = normalize(name);
  const out = { name: String(name || ''), ontologyConfirmed: false, mondo: null, canonical: null };
  if (!nk) return out;
  const index = await getIndex();
  const hit = index.get(nk);
  if (hit) {
    out.ontologyConfirmed = true;
    out.mondo = hit.mondo;
    out.canonical = hit.canonical;
  }
  return out;
};

/**
 * Validate an agent-provided subtype list. Returns each subtype annotated with
 * ontology confirmation, preserving order and never dropping unconfirmed ones
 * (an LLM may legitimately know a subtype the flattened registry lacks).
 */
export const confirmSubtypes = async (subtypes = []) => {
  const list = Array.isArray(subtypes) ? subtypes : [];
  return Promise.all(list.map((s) => ontologyConfirm(typeof s === 'string' ? s : s?.name)));
};

// Test hook.
export const _resetOntologyIndex = () => { indexPromise = null; };
