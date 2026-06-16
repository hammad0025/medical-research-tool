// Gene + subtype notation — "RP 26" → Retinitis pigmentosa 26 (CERKL).
// Runs before generic acronym/KB matching so RP never becomes the wrong disease.

let cachedDiseases = null;

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const findBySlug = (diseases, slug) =>
  (diseases || []).find((d) => d.slug === slug) || null;

const extractGeneFromEntry = (entry) => {
  const blob = [entry?.name, ...(entry?.synonyms || [])].join(' ');
  const mut = blob.match(/mutation in ([A-Z0-9]+)/i);
  if (mut) return String(mut[1]).toUpperCase();
  if (/cerkl/i.test(blob)) return 'CERKL';
  if (/rpe65/i.test(blob)) return 'RPE65';
  if (/rpgr/i.test(blob)) return 'RPGR';
  return null;
};

const rheumPulmContext = (n) =>
  /\b(rheum|rheumatoid|arthritis|lupus|scleroderma|joint|pulmon|pneum|bronch|valve|cardiac|heart)\b/.test(n) ||
  /\brheumat/i.test(n);

const GENE_SLUGS = {
  cerkl: 'retinitis-pigmentosa-26',
  rpe65: 'rpe65-related-recessive-retinopathy',
  rpgr: 'retinitis-pigmentosa-3',
  cep290: 'leber-congenital-amaurosis-10',
  ush2a: 'usher-syndrome-type-2a',
  abca4: 'stargardt-disease-1',
  cnga1: 'retinitis-pigmentosa-49',
  cngb1: 'retinitis-pigmentosa-45',
  rdh12: 'leber-congenital-amaurosis-13',
  crb1: 'leber-congenital-amaurosis-8',
  gucy2d: 'leber-congenital-amaurosis-1',
  rp1: 'retinitis-pigmentosa-1',
  rp2: 'retinitis-pigmentosa-2'
};

const rpSubtypeNumber = (n) => {
  const spaced = n.match(/\brp\s*(?:type\s*)?(\d{1,3})\b/);
  if (spaced) return Number(spaced[1]);
  const compact = n.match(/^rp(\d{1,3})$/);
  if (compact) return Number(compact[1]);
  return null;
};

const formatResolved = (entry, num, gene) => {
  if (gene && num) return `Retinitis pigmentosa ${num} (${gene} mutation)`;
  if (gene && entry?.name) return entry.name.includes(gene) ? entry.name : `${entry.name} (${gene})`;
  return entry?.name || (num ? `Retinitis pigmentosa ${num}` : 'Retinitis Pigmentosa');
};

const buildHit = (entry, { id, num, gene, kbSlug = 'rp', score = 100 }) => ({
  id,
  resolved: formatResolved(entry, num, gene),
  registrySlug: entry?.slug || null,
  kbSlug,
  subtype: num ? `RP${num}` : gene ? `${gene}-related` : null,
  gene: gene || null,
  score,
  source: 'gene-notation',
  nextBrainLayer: kbSlug ? 'curated-kb' : 'disease-registry',
  resolutionPath: kbSlug ? 'gene-notation→curated-kb' : 'gene-notation→disease-registry'
});

async function getDiseases() {
  if (cachedDiseases) return cachedDiseases;
  const { loadDiseaseRegistry } = await import('./disease-registry.js');
  const reg = await loadDiseaseRegistry();
  cachedDiseases = reg.diseases || [];
  return cachedDiseases;
}

/** @returns {Promise<object | null>} */
export async function matchGeneNotation(input) {
  const raw = String(input || '').trim();
  const n = normalize(input);
  if (!n) return null;

  const diseases = await getDiseases();

  const rpNum = rpSubtypeNumber(n);
  if (rpNum != null && !Number.isNaN(rpNum)) {
    const slug = `retinitis-pigmentosa-${rpNum}`;
    const entry = findBySlug(diseases, slug) || { name: `Retinitis pigmentosa ${rpNum}`, slug };
    const gene = extractGeneFromEntry(entry) || (rpNum === 26 ? 'CERKL' : null);
    return { ...buildHit(entry, { id: `rp-subtype-${rpNum}`, num: rpNum, gene }), userInput: raw };
  }

  const tokens = [...new Set(n.split(' ').filter(Boolean))];
  for (const tok of tokens) {
    const slug = GENE_SLUGS[tok];
    if (!slug) continue;
    const entry = findBySlug(diseases, slug);
    if (!entry) continue;
    const gene = tok.toUpperCase();
    const numMatch = entry.slug?.match(/retinitis-pigmentosa-(\d+)/);
    const num = numMatch ? Number(numMatch[1]) : null;
    return { ...buildHit(entry, { id: `gene-${tok}`, num, gene }), userInput: raw };
  }

  const isBareRp = n === 'rp' || /^rp$/i.test(raw);
  const mentionsRp = /\brp\b/.test(n) && rpSubtypeNumber(n) == null;
  if ((isBareRp || (mentionsRp && tokens.length <= 3)) && !rheumPulmContext(n)) {
    return {
      id: 'rp-ophthalmology-default',
      resolved: 'Retinitis Pigmentosa',
      registrySlug: null,
      kbSlug: 'rp',
      subtype: null,
      gene: null,
      score: 100,
      source: 'gene-notation',
      nextBrainLayer: 'curated-kb',
      resolutionPath: 'gene-notation→curated-kb',
      userInput: raw
    };
  }

  return null;
}
