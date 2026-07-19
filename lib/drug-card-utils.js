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

const labelNames = (entry) => [
  entry?.drug,
  entry?.label?.brandName,
  entry?.label?.genericName,
  entry?.label?.openfda?.brand_name,
  entry?.label?.openfda?.generic_name,
  entry?.label?.openfda?.substance_name
].flat().filter(Boolean);

const exactLabelForDrug = (drug, fdaLabels) => {
  const variants = drugNameVariants(drug).map(drugBaseKey).filter(Boolean);
  return (Array.isArray(fdaLabels) ? fdaLabels : []).find((entry) => {
    const url = String(entry?.label?.url || entry?.url || '');
    if (!/^https:\/\/dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=/i.test(url)) return false;
    return labelNames(entry).map(drugBaseKey).filter(Boolean).some((labelKey) =>
      variants.some((variant) => drugKeysMatch(variant, labelKey))
    );
  }) || null;
};

export const injectApprovedTreatmentStubs = (parsed, pipelineDrugs, fdaLabels = []) => {
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
    const labelEntry = exactLabelForDrug(drug, fdaLabels);
    if (!labelEntry) continue;
    const labelUrl = String(labelEntry?.label?.url || labelEntry?.url || '');
    added.add(key);
    stubs.push({
      _type: 'treatment',
      _approvedStub: true,
      treatment: drug.name,
      fda_status: 'FDA-approved',
      provider: '',
      references: `[FDA label — ${drug.name}](${labelUrl})`,
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
