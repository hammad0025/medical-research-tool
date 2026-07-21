// Safety-floor whitelist of world-class academic medical centers.
//
// Architectural note (READ ME BEFORE EDITING)
// -------------------------------------------
// Earlier revisions of this file contained a giant hardcoded CONDITION_SYNONYMS
// map and a condition-specific TOP_CENTERS regex list. Both were obsolete the
// day they shipped. Disease ontology work is now done dynamically at query
// time by api/disease-dossier.js, which asks Claude Haiku to build a
// structured dossier (synonyms, MeSH terms, top centers, investigators,
// advocacy orgs, red flags) for ANY disease string.
//
// This file is now ONLY a tiny safety floor: a regex list of globally-
// recognised academic medical centers that should be scored as "top tier"
// regardless of what the dossier says. This guarantees:
//   - Even if the dossier call fails for some rare disease, "Mayo Clinic"
//     in a trial sponsor field still gets the top-center boost.
//   - Even if Claude hallucinates or misses a center for an obscure disease,
//     the generic whitelist catches Johns Hopkins / Harvard / etc.
//
// KEEP THIS LIST SHORT. If you find yourself adding > 60 entries, the right
// fix is to expand the dossier prompt, not this regex.

export const TOP_CENTERS = [
  // Tier-1 US academic medical centers (universally recognised)
  /johns? hopkins/i,
  /mass(?:achusetts)? general/i,
  /brigham and women/i,
  /\bharvard\b/i,
  /mayo clinic/i,
  /cleveland clinic/i,
  /\bstanford\b/i,
  /\bucsf\b|university of california,? san francisco/i,
  /\bduke\b/i,
  /university of pennsylvania|upenn|penn medicine/i,
  /columbia university|new ?york.?presbyterian/i,
  /\bnyu\b|nyu langone/i,
  /memorial sloan.?kettering|mskcc/i,
  /md anderson/i,
  /\bucla\b|university of california,? los angeles/i,
  /northwestern (medicine|memorial|university)/i,
  /university of michigan|michigan medicine/i,
  /university of chicago/i,
  /vanderbilt/i,
  /\byale\b/i,
  /washington university (in )?st\.? louis|wustl|barnes.?jewish/i,
  /university of washington|uw medicine/i,
  /university of pittsburgh|upmc/i,
  /emory (university|healthcare)/i,
  /cedars.?sinai/i,
  /mount sinai/i,
  /ohsu|oregon health (and|&) science/i,
  /nih clinical center/i,
  /children'?s hospital of philadelphia|\bchop\b/i,
  /boston children'?s hospital/i,
  /dana.?farber/i,
  /fred hutch(?:inson)?/i,

  // Tier-1 UK / EU / RoW flagships
  /\boxford\b/i,
  /\bcambridge\b/i,
  /imperial college london/i,
  /moorfields eye hospital/i,
  /royal marsden/i,
  /great ormond street/i,
  /\bkarolinska\b/i,
  /max planck/i,
  /institut pasteur/i,
  /charité/i,
  /leiden university medical/i,
  /erasmus (mc|medical)/i,
  /the (hospital|institute) for sick children|sickkids/i
];

export const isTopCenter = (text) => {
  if (!text) return false;
  const s = String(text);
  return TOP_CENTERS.some((r) => r.test(s));
};

// Score boost when trials touch premier centers. `centers` must already be
// the caller's CONFIRMED top-center matches (e.g. classifyTrial's
// topCenters), not raw location text — this does not re-filter through the
// base isTopCenter list, so a dossier-specific center matched via the
// extended matcher (e.g. Joslin for LADA) counts the same as a hardcoded
// Tier-1 center, matching the intent of buildExtendedCenterMatcher above.
// Small per-match (so a trial with 5 top centers doesn't 5x a trial with 1);
// capped at 15.
export const topCenterBoost = (centers) => {
  const arr = (Array.isArray(centers) ? centers : [centers]).filter(Boolean);
  return Math.min(15, arr.length * 3);
};

// Helper: extend the safety-floor whitelist with the disease-specific centers
// the dossier agent returned. Returns a combined `isTopCenterExtended` fn.
// Use from trials.js so the dossier's disease-specific centers (e.g. Joslin
// for LADA) get the same boost as the hardcoded Tier-1 centers.
export const buildExtendedCenterMatcher = (dossierCenters = []) => {
  const names = (dossierCenters || [])
    .map((c) => (typeof c === 'string' ? c : c?.name))
    .filter((n) => n && String(n).length >= 6);

  const extraRegex = names.map(
    (n) => new RegExp(String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  );

  return (text) => {
    if (!text) return false;
    const s = String(text);
    if (TOP_CENTERS.some((r) => r.test(s))) return true;
    return extraRegex.some((r) => r.test(s));
  };
};
