// Evidence-derived, deterministic safety scoring.
//
// The old flow asked the model to eyeball FDA text and emit "SAFETY: <NN>%".
// That number was neither reproducible nor traceable — the exact defect the
// efficacy fix already closed (Dorothy: "those %s are made-up; show the real,
// clickable evidence"). This module derives a Low / Moderate / High band from
// REAL FDA facts (boxed warning, contraindications, drug interactions, FAERS
// post-market reactions) and returns the SPECIFIC facts that produced it, each
// with a clickable FDA source link, so the band is fully auditable.
//
// Same inputs → same band every run (no model call, no randomness), matching
// the determinism work already in the codebase (FIX 3 in the regression suite).

import { drugKeysMatch } from './report-polish.js';

// Identity key for a drug name — leading name phrase (parenthetical brand/alias
// dropped, dose/em-dash suffix stripped), lowercased, non-alphanumerics removed.
// Unlike report-polish's drugBaseKey it does NOT split on an in-word hyphen, so
// hyphenated generics ("N-acetylcysteine") survive intact for matching.
export const safetyDrugKey = (name) => {
  let s = String(name || '').replace(/\*/g, '');
  s = s.replace(/\(.*?\)/g, ' ');
  s = s.split(/[—–|:]|\s-\s/)[0];
  s = s.replace(/\s+\d.*$/, '');
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
};

// High = safest. Internal numeric level is used only for color bucketing in the
// UI; the user-facing value is the band word, never a fake percent.
export const SAFETY_LEVELS = { Unknown: 0, Low: 1, Moderate: 2, High: 3 };
export const SAFETY_BANDS = ['Unknown', 'Low', 'Moderate', 'High'];

const bandFromLevel = (level) =>
  level >= 3 ? 'High' : level === 2 ? 'Moderate' : 'Low';

// A FAERS reaction term is treated as SERIOUS when it names a life-threatening
// or organ-failure event. FAERS aggregates by reaction term (not seriousness),
// so we approximate "serious signal" by matching against this documented list.
// NOTE: bare "death" / "sudden death" are intentionally EXCLUDED. FAERS
 // "Death" aggregate counts are reporting-biased and read as scare stats
 // ("DEATH (3,059 reports)") without a causal rate — Dorothy / demo failure
 // mode. We still floor on organ-failure and acute life-threatening events.
const SERIOUS_FAERS_TERMS = [
  'cardiac arrest', 'cardiac failure', 'myocardial infarction',
  'respiratory failure', 'respiratory arrest', 'hepatic failure', 'hepatotoxicity',
  'renal failure', 'acute kidney injury', 'sepsis', 'septic shock', 'anaphylactic',
  'anaphylaxis', 'stevens-johnson', 'toxic epidermal necrolysis', 'agranulocytosis',
  'pancytopenia', 'neutropenia', 'rhabdomyolysis', 'suicidal', 'suicide',
  'seizure', 'convulsion', 'haemorrhage', 'hemorrhage', 'cerebrovascular accident',
  'stroke', 'pulmonary embolism', 'multi-organ failure', 'liver injury'
];

// A single FAERS reaction with at least this many aggregated post-market reports
// is a substantial safety signal. Chosen as a documented, deterministic
// threshold: openFDA's aggregate reaction counts are in the thousands for
// heavily-used drugs, and a serious reaction clearing 1,000 reports is a real
// post-market signal rather than incidental noise.
export const FAERS_SERIOUS_MIN_REPORTS = 1000;

const hasText = (s) => !!String(s || '').trim();

const ROUTE_TERMS = ['oral', 'topical', 'inhalation', 'intravenous', 'intramuscular', 'subcutaneous', 'ophthalmic', 'nasal', 'rectal', 'vaginal', 'transdermal'];
export const labelMatchesDrugContext = (drugName, label = {}) => {
  const requested = String(drugName || '').toLowerCase();
  const requestedRoute = ROUTE_TERMS.find((route) => requested.includes(route));
  if (!requestedRoute) return true;
  const labelContext = [
    ...(Array.isArray(label.route) ? label.route : [label.route]),
    ...(Array.isArray(label.dosageForm) ? label.dosageForm : [label.dosageForm]),
    label.productType
  ].filter(Boolean).join(' ').toLowerCase();
  // Missing route/formulation metadata cannot establish a match.
  return !!labelContext && labelContext.includes(requestedRoute);
};

// Normalize the patient's current-medications field (a comma/semicolon/newline
// list, possibly with doses) into distinct lowercase drug-name tokens.
export const normalizePatientMeds = (meds) => {
  if (!meds) return [];
  const raw = Array.isArray(meds) ? meds : String(meds).split(/[,;\n]/);
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    // Leading word(s) before a dose/number; keep the drug name, drop "81 mg".
    const name = String(m || '').trim().replace(/\s*\d.*$/, '').trim();
    const key = name.toLowerCase();
    if (name.length >= 3 && !seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out;
};

const wordHit = (haystack, needle) => {
  if (!hasText(haystack) || !hasText(needle)) return false;
  const esc = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(haystack);
};

/**
 * scoreSafety({ drugName, patientMeds, fdaLabel, faers }) → { band, level, factors }
 *
 *   band    : 'Low' | 'Moderate' | 'High' (High = safest), or null when there
 *             is no citable FDA evidence at all (caller drops the meter).
 *   level   : 1..3 internal bucket for color, or null.
 *   factors : [{ text, url }] — the SPECIFIC FDA facts behind the band, each
 *             with a clickable FDA source link so the band is auditable.
 *
 * Deterministic rules (from REAL FDA facts):
 *   - Boxed (black-box) warning present  → capped at "Moderate".
 *   - Each contraindication OR serious drug-interaction matching one of THIS
 *     patient's medications → drop one level (floor "Low").
 *   - A serious FAERS reaction ≥ threshold → floor "Moderate"; ≥3 → floor "Low".
 *   - No negative signal in the FDA data  → "High".
 */
export const scoreSafety = ({ drugName, patientMeds, fdaLabel, faers } = {}) => {
  const url = fdaLabel && fdaLabel.url;
  // No FDA label (or no citable source) → no traceable evidence → no band.
  if (!fdaLabel || !url) return { band: 'Unknown', level: SAFETY_LEVELS.Unknown, factors: [] };
  if (!labelMatchesDrugContext(drugName, fdaLabel)) {
    return {
      band: 'Unknown',
      level: SAFETY_LEVELS.Unknown,
      factors: [{ text: 'FDA label route or formulation does not match the treatment described', url }]
    };
  }
  const hasSafetyContent = [
    fdaLabel.boxedWarning,
    fdaLabel.warnings,
    fdaLabel.contraindications,
    fdaLabel.drugInteractions,
    fdaLabel.adverseReactions
  ].some(hasText) || (Array.isArray(faers) && faers.length > 0);
  if (!hasSafetyContent) {
    return {
      band: 'Unknown',
      level: SAFETY_LEVELS.Unknown,
      factors: [{ text: 'FDA safety sections were unavailable; safety cannot be rated', url }]
    };
  }

  const factors = [];
  let level = SAFETY_LEVELS.High;
  const cite = (text) => ({ text, url });

  // 1. Boxed warning caps the band at Moderate.
  if (hasText(fdaLabel.boxedWarning)) {
    level = Math.min(level, SAFETY_LEVELS.Moderate);
    const summary = String(fdaLabel.boxedWarning).replace(/\s+/g, ' ').trim().slice(0, 120);
    factors.push(cite(`FDA boxed (black-box) warning: ${summary}${summary.length >= 120 ? '…' : ''}`));
  }

  // 2. Patient-specific contraindications / serious drug interactions.
  const meds = normalizePatientMeds(patientMeds);
  const contra = fdaLabel.contraindications;
  const interactions = fdaLabel.drugInteractions;
  for (const med of meds) {
    if (wordHit(contra, med)) {
      level = Math.max(SAFETY_LEVELS.Low, level - 1);
      factors.push(cite(`FDA label lists a contraindication involving your ${med}`));
    } else if (wordHit(interactions, med)) {
      level = Math.max(SAFETY_LEVELS.Low, level - 1);
      factors.push(cite(`FDA label lists a drug interaction with your ${med}`));
    }
  }

  // 3. High-frequency serious FAERS post-market reactions.
  const seriousHits = (Array.isArray(faers) ? faers : [])
    .filter((e) => {
      const reports = Number(e && e.reports) || 0;
      const term = String((e && e.reaction) || '').toLowerCase();
      return reports >= FAERS_SERIOUS_MIN_REPORTS &&
        SERIOUS_FAERS_TERMS.some((t) => term.includes(t));
    })
    .sort((a, b) => (Number(b.reports) || 0) - (Number(a.reports) || 0));
  if (seriousHits.length) {
    const floor = seriousHits.length >= 3 ? SAFETY_LEVELS.Low : SAFETY_LEVELS.Moderate;
    level = Math.min(level, floor);
    const named = seriousHits.slice(0, 3)
      .map((e) => `${e.reaction} (${Number(e.reports).toLocaleString()} reports)`)
      .join(', ');
    factors.push(cite(`High-frequency serious FDA post-market reports: ${named}`));
  }

  // 4. "High" requires the core label sections needed for a negative screen.
  // Missing sections are unknown, not evidence that no risk exists.
  if (!factors.length) {
    const completeNegativeScreen = hasText(fdaLabel.warnings) &&
      hasText(fdaLabel.contraindications) &&
      hasText(fdaLabel.drugInteractions);
    if (!completeNegativeScreen) {
      return {
        band: 'Unknown',
        level: SAFETY_LEVELS.Unknown,
        factors: [cite('FDA label sections were incomplete; absence of a captured warning cannot establish high safety')]
      };
    }
    factors.push(cite(
      'No FDA boxed warning, and no contraindication or interaction with your current medicines found in the FDA label'
    ));
  }

  return { band: bandFromLevel(level), level, factors };
};

// ---------------------------------------------------------------------------
// Injection into report text.
//
// Each treatment / repurpose card carries a "SAFETY:" line. We rewrite that
// line with the code-computed band + its FDA-sourced factor list so the model
// never invents a safety percent. A card whose drug has NO matching FDA label
// degrades gracefully: the SAFETY line is DROPPED (no unsourced rating) exactly
// like a Confidence meter with no citable evidence.
// ---------------------------------------------------------------------------

// entry shape (from lib/evidence.js): { drug, label: {...}, topAdverseEvents }
const labelIndexEntry = (entry) => {
  const keys = new Set();
  const add = (name) => { const k = safetyDrugKey(name); if (k) keys.add(k); };
  add(entry && entry.drug);
  const gn = entry && entry.label && entry.label.genericName;
  const bn = entry && entry.label && entry.label.brandName;
  (Array.isArray(gn) ? gn : [gn]).forEach(add);
  (Array.isArray(bn) ? bn : [bn]).forEach(add);
  return { keys: [...keys], entry };
};

export const buildFdaLabelIndex = (fdaLabels) =>
  (Array.isArray(fdaLabels) ? fdaLabels : [])
    .filter((e) => e && e.label && e.label.url)
    .map(labelIndexEntry)
    .filter((x) => x.keys.length);

const findLabelEntry = (index, drugKey) => {
  if (!drugKey) return null;
  for (const x of index) {
    if (x.keys.some((k) => drugKeysMatch(k, drugKey))) return x.entry;
  }
  return null;
};

// Format a computed band into a SAFETY: line whose factors each carry a
// clickable FDA source link (mirrors how efficacy ends with [source](url)).
export const formatSafetyLine = ({ band, factors }) =>
  `SAFETY: ${band} — ${factors
    .map((f) => `${f.text} [FDA label](${f.url})`)
    .join('; ')}`;

const DRUG_NAME_RE = /^\s*(?:TREATMENT|CANDIDATE):\s*(.+)$/i;
const SAFETY_LINE_RE = /^\s*\**\s*SAFETY:\s*/i;

export const injectSafetyBands = (text, { fdaLabels, patientMeds } = {}) => {
  if (!text) return text;
  const index = buildFdaLabelIndex(fdaLabels);
  if (!index.length) {
    // No labels at all → every SAFETY line is unsourced → drop them all so no
    // eyeballed percent survives (graceful degrade, traceable-evidence rule).
    return String(text)
      .split('\n')
      .filter((line) => !SAFETY_LINE_RE.test(line))
      .join('\n');
  }
  const lines = String(text).split('\n');
  const out = [];
  let currentDrugKey = null;
  for (const line of lines) {
    const nameMatch = line.match(DRUG_NAME_RE);
    if (nameMatch) currentDrugKey = safetyDrugKey(nameMatch[1]);
    if (SAFETY_LINE_RE.test(line)) {
      const entry = findLabelEntry(index, currentDrugKey);
      if (!entry) continue; // no FDA label for this drug → drop the meter
      const scored = scoreSafety({
        drugName: nameMatch ? nameMatch[1] : currentDrugKey,
        patientMeds,
        fdaLabel: entry.label,
        faers: entry.topAdverseEvents
      });
      if (!scored.band) continue;
      out.push(formatSafetyLine(scored));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};
