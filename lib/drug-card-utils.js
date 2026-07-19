export const drugBaseKey = (name) => {
  let value = String(name || '').replace(/\*/g, '');
  value = value.replace(/\(.*?\)/g, ' ');
  value = value.split(/[—–\-:|/]|\d/)[0];
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
};

export const drugKeysMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  return !!(a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
};

const approvedPipelineDrugs = (pipelineDrugs) =>
  (Array.isArray(pipelineDrugs) ? pipelineDrugs : [])
    .filter((drug) => /^approved/i.test(String(drug?.approvalStatus || '')));

const drugNameVariants = (drug) =>
  [drug?.name, ...(Array.isArray(drug?.aliases) ? drug.aliases : [])];

export const injectApprovedTreatmentStubs = (parsed, pipelineDrugs) => {
  const list = Array.isArray(parsed) ? parsed : [];
  const approved = approvedPipelineDrugs(pipelineDrugs);
  if (!approved.length) return list;
  const cardKeys = list.map((treatment) => drugBaseKey(treatment?.treatment)).filter(Boolean);
  const stubs = [];
  const added = new Set();
  for (const drug of approved) {
    const key = drugBaseKey(drug?.name);
    if (!key || added.has(key)) continue;
    const already = drugNameVariants(drug).some((name) => {
      const variant = drugBaseKey(name);
      return variant && cardKeys.some((cardKey) => drugKeysMatch(variant, cardKey));
    });
    if (already) continue;
    added.add(key);
    stubs.push({
      _type: 'treatment',
      _approvedStub: true,
      treatment: drug.name,
      fda_status: 'FDA-approved',
      provider: drug.mechanism ? `Mechanism: ${drug.mechanism}` : '',
      efficacy_pct: null,
      safety_pct: null
    });
  }
  return [...list, ...stubs];
};

export const allApprovedDrugsRendered = (pipelineDrugs, treatments) => {
  const approved = approvedPipelineDrugs(pipelineDrugs);
  if (!approved.length) return true;
  const cardKeys = (Array.isArray(treatments) ? treatments : [])
    .map((treatment) => drugBaseKey(treatment?.treatment))
    .filter(Boolean);
  return approved.every((drug) =>
    drugNameVariants(drug).some((name) => {
      const key = drugBaseKey(name);
      return key && cardKeys.some((cardKey) => drugKeysMatch(key, cardKey));
    })
  );
};
