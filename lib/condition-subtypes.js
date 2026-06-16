// Subtype families — numbered / gene-specific forms of a parent condition.
// Powers the optional Profile dropdown (EveryCure-style), not a blocking gate.

import { loadDiseaseRegistry } from './disease-registry.js';
import { isConditionSubtypePickerEnabled } from './condition-intake-flags.js';
import { normalize } from './normalize.js';

const extractGene = (entry) => {
  const blob = [entry?.name, ...(entry?.synonyms || [])].join(' ');
  const mut = blob.match(/mutation in ([A-Z0-9]+)/i);
  if (mut) return String(mut[1]).toUpperCase();
  const geneSyn = (entry?.synonyms || []).find((s) => /^[A-Z0-9]{2,8}$/.test(String(s).trim()));
  if (geneSyn) return String(geneSyn).trim().toUpperCase();
  return null;
};

const FAMILIES = [
  {
    id: 'retinitis-pigmentosa',
    parentLabel: 'Retinitis Pigmentosa',
    kbSlug: 'rp',
    match: (n) =>
      /\bretinitis pigmentosa\b/.test(n) ||
      n === 'rp' ||
      /\brp\s*(?:type\s*)?\d/.test(n) ||
      /^rp\d{1,3}$/.test(n.replace(/\s/g, '')) ||
      /\b(inherited retinal|ird|rod cone dystrophy|rcd)\b/.test(n) ||
      /\b(cerkl|rpe65|rpgr|cnga1|cngb1|ush2a)\b/.test(n),
    loadSubtypes: async (diseases) => {
      const rows = diseases
        .filter((d) => /^retinitis pigmentosa \d+$/i.test(d.name))
        .map((d) => {
          const num = Number(d.name.match(/(\d+)/)?.[1]);
          const gene = extractGene(d);
          return {
            id: d.slug,
            slug: d.slug,
            number: num,
            gene,
            label: gene
              ? `Retinitis pigmentosa ${num} (${gene})`
              : `Retinitis pigmentosa ${num}`,
            resolved: gene
              ? `Retinitis pigmentosa ${num} (${gene} mutation)`
              : d.name,
            shortLabel: gene ? `RP${num} · ${gene}` : `RP${num}`
          };
        })
        .filter((r) => Number.isFinite(r.number))
        .sort((a, b) => a.number - b.number);
      return rows;
    }
  },
  {
    id: 'leber-congenital-amaurosis',
    parentLabel: 'Leber Congenital Amaurosis',
    kbSlug: 'lca',
    match: (n) => /\b(leber congenital amaurosis|lca)\b/.test(n),
    loadSubtypes: async (diseases) =>
      diseases
        .filter((d) => /^leber congenital amaurosis \d+$/i.test(d.name))
        .map((d) => {
          const num = Number(d.name.match(/(\d+)/)?.[1]);
          const gene = extractGene(d);
          return {
            id: d.slug,
            slug: d.slug,
            number: num,
            gene,
            label: gene ? `LCA ${num} (${gene})` : `LCA ${num}`,
            resolved: gene ? `Leber congenital amaurosis ${num} (${gene})` : d.name,
            shortLabel: gene ? `LCA${num} · ${gene}` : `LCA${num}`
          };
        })
        .filter((r) => Number.isFinite(r.number))
        .sort((a, b) => a.number - b.number)
  }
];

const matchFamily = (query) => {
  const n = normalize(query);
  if (!n) return null;
  return FAMILIES.find((f) => f.match(n)) || null;
};

let cachedByFamily = new Map();

/** @returns {Promise<object>} */
export async function listConditionSubtypes(query = '') {
  if (!isConditionSubtypePickerEnabled()) {
    return { ok: true, matched: false, parent: null, subtypes: [], general: null, disabled: true };
  }

  const family = matchFamily(query);
  if (!family) {
    return { ok: true, matched: false, parent: null, subtypes: [], general: null };
  }

  if (!cachedByFamily.has(family.id)) {
    const reg = await loadDiseaseRegistry();
    const subtypes = await family.loadSubtypes(reg.diseases || []);
    cachedByFamily.set(family.id, subtypes);
  }

  const subtypes = cachedByFamily.get(family.id) || [];
  const n = normalize(query);
  const numFilter = n.match(/\b(?:rp|type)?\s*(\d{1,3})\b/);
  const geneFilter = n.match(/\b([a-z]{2,8}\d?)\b/gi);

  let filtered = subtypes;
  if (numFilter) {
    const want = Number(numFilter[1]);
    filtered = subtypes.filter((s) => s.number === want);
  } else if (geneFilter) {
    const genes = geneFilter.map((g) => g.toUpperCase());
    const geneHits = subtypes.filter((s) => s.gene && genes.includes(s.gene));
    if (geneHits.length) filtered = geneHits;
  }

  const general = {
    label: `${family.parentLabel} (general — any subtype)`,
    resolved: family.parentLabel,
    kbSlug: family.kbSlug
  };

  return {
    ok: true,
    matched: true,
    familyId: family.id,
    parent: family.parentLabel,
    kbSlug: family.kbSlug,
    general,
    subtypes: filtered.length ? filtered : subtypes,
    total: subtypes.length
  };
}

export async function resolveSubtypeSelection(subtypeId, query = '') {
  const listing = await listConditionSubtypes(query);
  if (!listing.matched) return null;
  if (subtypeId === '__general__') return listing.general;
  const hit = (listing.subtypes || []).find((s) => s.id === subtypeId || s.slug === subtypeId);
  if (!hit) return null;
  return {
    label: hit.label,
    resolved: hit.resolved,
    kbSlug: listing.kbSlug,
    gene: hit.gene || null,
    subtype: hit.shortLabel || hit.label
  };
}
