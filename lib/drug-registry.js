// Curated FDA-tracked drug library (~1,800 drugs) for repurpose mode seeding.
// Built by scripts/build-drug-registry.mjs (CC-BY-4.0 open data).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'drug-registry.json');

let registry = null;
let loadedAt = 0;
const TTL_MS = 10 * 60 * 1000;

const SPECIALTY_TO_AREAS = {
  respiratory: ['respiratory', 'pulmonary', 'lung'],
  neurological: ['central nervous system', 'neurolog', 'psychiatric'],
  psychiatric: ['central nervous system', 'psychiatric', 'antipsychotic'],
  endocrine: ['endocrine', 'metabolic', 'diabetes', 'hormon'],
  cardiovascular: ['cardiovascular', 'cardiac', 'heart'],
  hematologic: ['hematology', 'blood', 'coagul'],
  immune: ['immune', 'immunosuppress', 'autoimmune'],
  neoplasm: ['cancer', 'antineoplastic', 'oncolog', 'chemotherapy'],
  dermatologic: ['dermatolog', 'skin', 'psoriasis'],
  eye_and_adnexa: ['ophthalm', 'retinal', 'eye'],
  gastrointestinal: ['gastro', 'intestinal', 'hepat', 'liver'],
  renal_and_urinary: ['renal', 'kidney', 'urinary'],
  musculoskeletal: ['musculoskeletal', 'rheumat', 'arthritis', 'bone'],
  metabolic: ['metabolic', 'endocrine', 'lipid'],
  infection: ['antimicrobial', 'antiviral', 'antibacterial', 'infect']
};

const laneFilter = (lane, drug) => {
  const blob = `${drug.drugClass} ${drug.therapeuticArea} ${drug.drugFunction} ${drug.atcL2}`.toLowerCase();
  const f = drug.flags || {};
  switch (lane) {
    case 0:
      return (
        f.steroid ||
        /immun|jak|btk|interleukin|anti-inflam|suppressant|biologic|monoclonal|tnf|il-/i.test(blob) ||
        /immunosuppressants|antineoplastic agents|antipsoriatics/i.test(drug.atcL2)
      );
    case 1:
      return (
        f.glucoseRegulator ||
        f.cardiovascular ||
        /metabolic|endocrine|cardiovascular|fibrosis|antifibrotic|hormon|lipid|diabetes|hypertens/i.test(blob)
      );
    case 2:
      return (
        /vitamin|supplement|antioxid|mineral|omega|folate|coenzyme|herbal|botanical|misc/i.test(blob) ||
        /vitamins|minerals|diet/i.test(drug.atcL2)
      );
    case 3:
      return false;
    default:
      return true;
  }
};

// DETERMINISTIC tie-breaker (Fix 3 — run-to-run reproducibility). The scorer
// previously added `Math.random() * 0.01` to break ties between equally-scored
// drugs, so the SAME condition produced a DIFFERENT drug ordering (and thus
// different candidates) on every run — exactly the non-determinism Dorothy
// complained about. We replace it with a stable function of the drug name: a
// small FNV-1a hash normalized into a tiny epsilon in [0, 0.01). Identical
// input now always yields identical ordering, while ties are still broken in a
// well-distributed (non-alphabetical) way.
const stableTieBreak = (name) => {
  const s = String(name || '').toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 → unsigned; divide by 2^32 → [0,1); scale to [0, 0.01).
  return ((h >>> 0) / 0xffffffff) * 0.01;
};

const specialtyBoost = (drug, dossier) => {
  const specialty = String(dossier?.subspecialty || dossier?.registrySpecialty || '').toLowerCase();
  const group = String(dossier?.registryGroup || '').toLowerCase();
  const blob = `${drug.therapeuticArea} ${drug.drugClass}`.toLowerCase();
  let score = drug.approvedUsa ? 2 : 0;
  for (const [key, terms] of Object.entries(SPECIALTY_TO_AREAS)) {
    if (!specialty.includes(key.replace(/_/g, ' ')) && !group.includes(key.replace(/_/g, ' '))) continue;
    if (terms.some((t) => blob.includes(t))) score += 3;
  }
  if (drug.drugClass) score += 1;
  return score;
};

export const loadDrugRegistry = async () => {
  const now = Date.now();
  if (registry && now - loadedAt < TTL_MS) return registry;
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    registry = JSON.parse(raw);
    loadedAt = now;
    return registry;
  } catch (e) {
    console.warn('[drug-registry] not loaded:', e?.message || e);
    registry = { count: 0, drugs: [] };
    loadedAt = now;
    return registry;
  }
};

export const registryStats = async () => {
  const r = await loadDrugRegistry();
  return {
    loaded: (r.drugs || []).length > 0,
    count: r.count || (r.drugs || []).length,
    approvedCount: r.approvedCount || 0,
    version: r.version,
    builtAt: r.builtAt
  };
};

const toPipelineShape = (drug) => ({
  name: drug.name,
  aliases: drug.synonyms || [],
  mechanism: drug.drugClass || drug.drugFunction || '',
  sponsor: '',
  status: drug.approvedUsa ? 'FDA-approved (USA)' : 'investigational / not US-approved',
  approvalStatus: drug.approvedUsa ? 'approved' : 'investigational',
  source: 'drug-registry'
});

// Pick drugs from the open library for repurpose synthesis.
export const selectRepurposeDrugs = async (dossier = {}, { lane = null, limit = 16 } = {}) => {
  const r = await loadDrugRegistry();
  const drugs = (r.drugs || []).filter((d) => d.name && d.approvedUsa);
  if (!drugs.length) return [];

  const laneNum = lane == null ? null : Number(lane);
  let pool = drugs;
  if (laneNum === 3) {
    return [];
  }
  if (laneNum != null && !Number.isNaN(laneNum)) {
    pool = drugs.filter((d) => laneFilter(laneNum, d));
    if (pool.length < 4) pool = drugs;
  }

  const scored = pool
    .map((d) => ({ drug: d, score: specialtyBoost(d, dossier) + stableTieBreak(d.name) }))
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const out = [];
  for (const { drug } of scored) {
    const key = drug.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toPipelineShape(drug));
    if (out.length >= limit) break;
  }
  return out;
};

export const buildRepurposeDrugScreen = async (dossier = {}, selectedDrugs = null) => {
  const r = await loadDrugRegistry();
  const pool = selectedDrugs || (await selectRepurposeDrugs(dossier, { limit: 24 }));
  const libraryTotal = r.count || (r.drugs || []).length;
  const approvedTotal =
    r.approvedCount || (r.drugs || []).filter((d) => d.approvedUsa).length;
  return {
    libraryTotal,
    approvedTotal,
    selectedCount: pool.length,
    selectedNames: pool.map((d) => d.name),
    condition: dossier?.canonical || ''
  };
};

export const buildRepurposeDrugLibraryBlock = (drugs, { lane = null, condition = '' } = {}) => {
  if (!Array.isArray(drugs) || !drugs.length) return '';
  const laneLabel = lane != null ? ` (lane ${Number(lane) + 1} focus)` : '';
  const lines = drugs.map((d) => {
    const aliases = (d.aliases || []).length ? ` (${d.aliases.slice(0, 3).join(' / ')})` : '';
    const mech = d.mechanism ? ` — ${d.mechanism}` : '';
    const status = d.approvalStatus === 'approved' ? 'FDA-approved' : 'investigational';
    return `- **${d.name}**${aliases} — ${status}${mech}`;
  });
  return `=== REPURPOSE DRUG LIBRARY${laneLabel} ===
Curated open library of ${drugs.length} FDA-tracked drugs selected for ${condition || 'this condition'} biology. Use these as starting hypotheses — still ground every claim in the evidence pack below. Drugs with no human data for THIS condition must be labeled MECHANISTIC_ONLY or PRECLINICAL.

${lines.join('\n')}

=== END REPURPOSE DRUG LIBRARY ===
`;
};
