// Evidence-derived, deterministic safety-concern classification.
//
// The old flow asked the model to eyeball FDA text and emit "SAFETY: <NN>%".
// That number was neither reproducible nor traceable — the exact defect the
// efficacy fix already closed. This module derives a Low / Moderate / High
// concern band from FDA-label facts (boxed warning, contraindications, and drug
// interactions) and returns the SPECIFIC facts that produced it, each
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

// Higher level means MORE concern. This direction is explicit and consistent
// in deterministic scoring, UI, and exports.
export const SAFETY_LEVELS = { Unknown: 0, Low: 1, Moderate: 2, High: 3 };
export const SAFETY_BANDS = ['Unknown', 'Low', 'Moderate', 'High'];

const bandFromLevel = (level) =>
  level >= 3 ? 'High' : level === 2 ? 'Moderate' : 'Low';

// Retained for import compatibility only. Spontaneous report counts are not
// incidence, do not establish causation, and are not a validated overall grade.
export const FAERS_SERIOUS_MIN_REPORTS = 1000;

const hasText = (s) => !!String(s || '').trim();

const ROUTE_TERMS = ['oral', 'topical', 'inhalation', 'inhaled', 'intravenous', 'intramuscular', 'subcutaneous', 'ophthalmic', 'nasal', 'rectal', 'vaginal', 'transdermal'];
const FORMULATION_TERMS = [
  'tablet', 'capsule', 'cream', 'ointment', 'gel', 'solution', 'suspension',
  'injection', 'powder', 'patch', 'spray', 'inhaler', 'drops', 'suppository'
];
const STRENGTH_RE = /\b(\d+(?:\.\d+)?)\s*(mcg|μg|ug|mg|g|ml|iu|%)\b/i;

const normalizedStrength = (value) => {
  const match = String(value || '').match(STRENGTH_RE);
  if (!match) return '';
  const unit = match[2].toLowerCase().replace('μg', 'mcg').replace('ug', 'mcg');
  return `${Number(match[1])}${unit}`;
};

const candidateIdentityKey = (name) => {
  let value = String(name || '').replace(/\*/g, '').replace(/\(.*?\)/g, ' ');
  value = value.split(/[—–|:]|\s-\s/)[0].replace(STRENGTH_RE, ' ');
  for (const term of [...ROUTE_TERMS, ...FORMULATION_TERMS]) {
    value = value.replace(new RegExp(`\\b${term}s?\\b`, 'ig'), ' ');
  }
  return safetyDrugKey(value);
};

const labelNames = (label, labelDrugName) => [
  labelDrugName,
  ...(Array.isArray(label.genericName) ? label.genericName : [label.genericName]),
  ...(Array.isArray(label.brandName) ? label.brandName : [label.brandName])
].filter(Boolean);

export const labelMatchesDrugContext = (drugName, label = {}, labelDrugName = '') => {
  const requested = String(drugName || '').toLowerCase();
  const requestedIdentity = candidateIdentityKey(drugName);
  const identityMatch = requestedIdentity && labelNames(label, labelDrugName)
    .map(candidateIdentityKey)
    .some((name) => name && drugKeysMatch(name, requestedIdentity));
  if (!identityMatch) return false;

  const requestedRoute = ROUTE_TERMS.find((route) => requested.includes(route));
  const labelContext = [
    ...(Array.isArray(label.route) ? label.route : [label.route]),
    ...(Array.isArray(label.dosageForm) ? label.dosageForm : [label.dosageForm]),
    label.productType
  ].filter(Boolean).join(' ').toLowerCase();
  if (requestedRoute && (!labelContext ||
    !(labelContext.includes(requestedRoute) ||
      (requestedRoute === 'inhaled' && labelContext.includes('inhalation'))))) return false;

  const requestedForm = FORMULATION_TERMS.find((form) =>
    new RegExp(`\\b${form}s?\\b`, 'i').test(requested));
  if (requestedForm && (!labelContext || !new RegExp(`\\b${requestedForm}s?\\b`, 'i').test(labelContext))) {
    return false;
  }

  const requestedStrength = normalizedStrength(requested);
  if (requestedStrength) {
    const strengthContext = [
      label.strength,
      label.activeIngredient,
      label.dosage
    ].flatMap((value) => Array.isArray(value) ? value : [value])
      .filter(Boolean)
      .join(' ');
    const labelStrengths = [...strengthContext.matchAll(new RegExp(STRENGTH_RE.source, 'ig'))]
      .map((match) => normalizedStrength(match[0]));
    if (!labelStrengths.includes(requestedStrength)) return false;
  }

  return true;
};

const PATIENT_CONTEXT_FIELDS = {
  allergies: ['allergies', 'drugAllergies'],
  pregnancy: ['pregnancy', 'pregnancyStatus', 'pregnant'],
  renal: ['renal', 'renalStatus', 'renalFunction', 'kidneyStatus', 'kidneyFunction'],
  hepatic: ['hepatic', 'hepaticStatus', 'hepaticFunction', 'liverStatus', 'liverFunction'],
  priorTreatments: ['medicationHistory', 'priorTreatments', 'treatmentHistory'],
  relevantLabs: ['labWork', 'labs', 'relevantLabs']
};

const hasKnownContext = (patientContext, fields) =>
  !!patientContext && typeof patientContext === 'object' &&
  fields.some((field) =>
    Object.prototype.hasOwnProperty.call(patientContext, field) &&
    patientContext[field] !== null &&
    patientContext[field] !== undefined &&
    String(patientContext[field]).trim() !== ''
  );

export const missingMaterialPatientContexts = (patientContext) =>
  Object.entries(PATIENT_CONTEXT_FIELDS)
    .filter(([, fields]) => !hasKnownContext(patientContext, fields))
    .map(([name]) => name);

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
 *   band    : 'Low' | 'Moderate' | 'High' concern, or Unknown when there
 *             is no citable FDA evidence at all (caller drops the meter).
 *   level   : 1..3 internal bucket for color, or null.
 *   factors : [{ text, url }] — the SPECIFIC FDA facts behind the band, each
 *             with a clickable FDA source link so the band is auditable.
 *
 * Deterministic rules (from REAL FDA facts):
 *   - Boxed (black-box) warning present → High concern.
 *   - A contraindication or interaction matching a current medicine → High.
 *   - Other explicit warning/contraindication text → Moderate.
 *   - Complete label screen without those signals → Low concern.
 *   - Spontaneous report counts never determine the band.
 */
export const scoreSafety = ({
  drugName,
  labelDrugName,
  patientMeds,
  patientContext,
  fdaLabel,
  faers
} = {}) => {
  const url = fdaLabel && fdaLabel.url;
  // No FDA label (or no citable source) → no traceable evidence → no band.
  if (!fdaLabel || !url) return { band: 'Unknown', level: SAFETY_LEVELS.Unknown, factors: [] };
  if (!labelMatchesDrugContext(drugName, fdaLabel, labelDrugName)) {
    return {
      band: 'Unknown',
      level: SAFETY_LEVELS.Unknown,
      factors: [{ text: 'FDA label identity, strength, route, or formulation does not match the treatment described', url }]
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
  const missingContexts = missingMaterialPatientContexts(patientContext);
  if (missingContexts.length) {
    return {
      band: 'Unknown',
      level: SAFETY_LEVELS.Unknown,
      factors: [{ text: `Patient ${missingContexts.join(', ')} context is missing; safety concern cannot be classified`, url }]
    };
  }

  const factors = [];
  let level = SAFETY_LEVELS.Low;
  const cite = (text) => ({ text, url });
  const completeLabelScreen = hasText(fdaLabel.warnings) &&
    hasText(fdaLabel.contraindications) &&
    hasText(fdaLabel.drugInteractions);

  // 1. A candidate that matches a recorded allergy is always high concern.
  const candidateKey = candidateIdentityKey(drugName);
  const matchingAllergy = normalizePatientMeds(
    patientContext?.allergies || patientContext?.drugAllergies
  ).find((allergy) => {
    const allergyKey = candidateIdentityKey(allergy);
    return allergyKey && candidateKey && drugKeysMatch(allergyKey, candidateKey);
  });
  if (matchingAllergy) {
    level = SAFETY_LEVELS.High;
    factors.push(cite(`This candidate matches your recorded ${matchingAllergy} allergy`));
  }

  // 2. A boxed warning is the highest concern band.
  if (hasText(fdaLabel.boxedWarning)) {
    level = SAFETY_LEVELS.High;
    const summary = String(fdaLabel.boxedWarning).replace(/\s+/g, ' ').trim().slice(0, 120);
    factors.push(cite(`FDA boxed (black-box) warning: ${summary}${summary.length >= 120 ? '…' : ''}`));
  }

  // 3. Patient-specific contraindications / serious drug interactions.
  const meds = normalizePatientMeds(patientMeds);
  const contra = fdaLabel.contraindications;
  const interactions = fdaLabel.drugInteractions;
  for (const med of meds) {
    if (wordHit(contra, med)) {
      level = SAFETY_LEVELS.High;
      factors.push(cite(`FDA label lists a contraindication involving your ${med}`));
    } else if (wordHit(interactions, med)) {
      level = SAFETY_LEVELS.High;
      factors.push(cite(`FDA label lists a drug interaction with your ${med}`));
    }
  }

  // 4. Explicit non-boxed label warnings/contraindications raise concern.
  const contraindications = String(fdaLabel.contraindications || '');
  const warnings = String(fdaLabel.warnings || '');
  const explicitContraindication = hasText(contraindications) &&
    !/\b(?:none|no known|not applicable)\b/i.test(contraindications);
  const explicitWarning = hasText(warnings) &&
    !/\b(?:no warnings?|none|no known|not applicable)\b/i.test(warnings);
  if (level < SAFETY_LEVELS.High && completeLabelScreen &&
    (explicitContraindication || explicitWarning)) {
    level = SAFETY_LEVELS.Moderate;
    factors.push(cite('The FDA label includes warnings or contraindications that require clinician review'));
  }
  // 5. "Low concern" requires the core label sections needed for a screen.
  // Missing sections are unknown, not evidence that no risk exists.
  if (!factors.length) {
    if (!completeLabelScreen) {
      return {
        band: 'Unknown',
        level: SAFETY_LEVELS.Unknown,
        factors: [cite('FDA label sections were incomplete; low safety concern cannot be established')]
      };
    }
    factors.push(cite(
      'No FDA boxed warning, and no contraindication or interaction with your current medicines found in the FDA label'
    ));
  }
  if (Array.isArray(faers) && faers.length) {
    factors.push(cite(
      'FDA spontaneous report counts are not incidence rates, do not prove causation, and do not determine this safety-concern band'
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
  `SAFETY: Safety concern: ${band} — ${factors
    .map((f) => `${f.text} [FDA label](${f.url})`)
    .join('; ')}`;

const DRUG_NAME_RE = /^\s*(?:TREATMENT|CANDIDATE):\s*(.+)$/i;
const SAFETY_LINE_RE = /^\s*\**\s*SAFETY:\s*/i;

export const injectSafetyBands = (text, { fdaLabels, patientMeds, patientContext } = {}) => {
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
  let currentDrugName = null;
  for (const line of lines) {
    const nameMatch = line.match(DRUG_NAME_RE);
    if (nameMatch) {
      currentDrugName = nameMatch[1];
      currentDrugKey = safetyDrugKey(currentDrugName);
    }
    if (SAFETY_LINE_RE.test(line)) {
      const entry = findLabelEntry(index, currentDrugKey);
      if (!entry) continue; // no FDA label for this drug → drop the meter
      const scored = scoreSafety({
        drugName: currentDrugName,
        labelDrugName: entry.drug,
        patientMeds,
        patientContext,
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
