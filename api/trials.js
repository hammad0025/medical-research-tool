// Vercel Serverless Function for live ClinicalTrials.gov v2 API queries.
//
// A user asking "what clinical trials should I look at for my dad with
// Parkinson's" wants THREE categories, not one:
//
//   1. RECRUITING trials — the default, "I want to join a trial"
//   2. EXPANDED ACCESS / COMPASSIONATE USE — "I don't qualify for a trial,
//      can I get the drug anyway?" These are separate studyType=EXPANDED_ACCESS
//      records on CT.gov and are NEVER returned by a recruiting filter.
//   3. OPEN-LABEL EXTENSION (OLE) — "I was in a trial, how do I keep getting
//      the drug?" These are separate NCT records, usually with "extension" or
//      "long-term follow-up" in the title, and recruit only prior-trial
//      participants.
//
// Prior to this fix we ran ONE query (recruiting-only, condition-only) and
// missed expanded access and OLE studies entirely. That is how a user
// researching Retinitis Pigmentosa never saw Johns Hopkins' NAC trial
// extensions or Ocugen's expanded-access pathway.
//
// We now fan out across 4 parallel queries per call:
//   a. Primary condition, recruiting (the old behavior)
//   b. Expanded Access / Compassionate Use for the condition
//   c. Open-Label Extension studies for the condition
//   d. Synonym-expanded query (RP -> retinitis pigmentosa -> rod-cone
//      dystrophy -> inherited retinal dystrophy), recruiting
//
// Results are de-duplicated by NCT ID and each trial is enriched with
// isExpandedAccess / isOpenLabelExtension / hasTopCenter flags.
//
// Public API, no key required. Docs: https://clinicaltrials.gov/data-api/api

import { isTopCenter, topCenterBoost, buildExtendedCenterMatcher } from '../lib/medical-lexicon.js';
import { getDossier } from '../lib/disease-dossier.js';
import { loadKb } from '../lib/kb.js';
import { requireAccess } from '../lib/access-gate.js';
import { ensureDynamicKb, isDynamicKbEnabled } from '../lib/kb-bootstrap.js';
import { parseExplicitBoolean, parsePageSize } from '../lib/normalize.js';

const CT_API = 'https://clinicaltrials.gov/api/v2/studies';

const FAST_TRACK_HINTS = ['fast track', 'fast-track'];
const BREAKTHROUGH_HINTS = ['breakthrough therapy', 'breakthrough designation'];
const ORPHAN_HINTS = ['orphan drug', 'orphan designation', 'orphan status'];
const EXPANDED_ACCESS_HINTS = ['expanded access', 'compassionate use', 'individual patient ind',
  'emergency ind', 'pre-approval access', 'named patient'];
const PTA_HINTS = ['post-trial access', 'post trial access', 'continued access',
  'continued availability', 'long-term access'];
const OLE_HINTS = ['open-label extension', 'open label extension', 'ole phase',
  'long-term extension', 'long-term follow-up', 'rollover study', 'extension study'];
const PAY_TO_ACCESS_HINTS = ['patient funded', 'participant funded', 'self-funded',
  'pay to participate', 'self-pay', 'enrollment fee', 'program fee'];

const containsAny = (text, hints) => {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return hints.some(h => lower.includes(h));
};

export const parseApprovalStatus = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (/\b(?:not|un|non)[- ]?(?:fda[- ]?)?approved\b|\bnot approved\b|\binvestigational\b|\bapproval (?:pending|withdrawn|revoked)\b/.test(text)) {
    return 'not-approved';
  }
  if (/\bapproved\b/.test(text) && /\b(?:other|another|different)\s+(?:use|condition|disease|indication)\b/.test(text)) {
    return 'approved-other-indication';
  }
  if (/\b(?:fda[- ]?)?approved\b|\bapproved for marketing\b/.test(text)) return 'approved';
  return 'unknown';
};

export const parseEligibilityCriteria = (raw) => {
  const fullText = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!fullText) return { fullText: '', inclusion: '', exclusion: '', reviewStatus: 'not-provided' };
  const inclusionMatch = fullText.match(/(?:^|\n)\s*inclusion criteria\s*:?\s*([\s\S]*?)(?=(?:\n\s*exclusion criteria\s*:?)|$)/i);
  const exclusionMatch = fullText.match(/(?:^|\n)\s*exclusion criteria\s*:?\s*([\s\S]*)$/i);
  return {
    fullText,
    inclusion: inclusionMatch?.[1]?.trim() || '',
    exclusion: exclusionMatch?.[1]?.trim() || '',
    reviewStatus: 'unchecked',
    caution: 'The full inclusion and exclusion criteria have not been checked against this patient; contact the study team before assuming eligibility.'
  };
};

// ---- Patient-facing "promise" score (0-100) -------------------------------
// The score rewards trials a patient can ACT on (recruiting / accepting /
// accessible). Non-enrolling statuses are penalised so a finished or stopped
// trial never outranks one still taking patients (Item 7). Stopped-for-harm /
// negative trials (incl. the PANTHER aza+pred+NAC arm) get a caution + penalty.
// NO_LONGER_AVAILABLE = the program (often an expanded-access protocol) can no
// longer be accessed, so penalise it like COMPLETED. UNKNOWN status means we
// cannot confirm a patient can act on it — penalise so it never outranks a
// confirmed-enrolling trial (Chronic Constipation defect: a defunct Domperidone
// expanded-access protocol at NO_LONGER_AVAILABLE outranked a live Phase 3).
export const NON_ENROLLING_PENALTY = { COMPLETED: -55, TERMINATED: -60, WITHDRAWN: -60, SUSPENDED: -60, NO_LONGER_AVAILABLE: -55, UNKNOWN: -40 };
export const ACTIVE_NOT_RECRUITING_PENALTY = -25;
// An age-ineligible trial (e.g. a pediatric study for a 64-year-old) is one
// the patient cannot enrol in — push it well below eligible options so it
// never ranks near the top of an adult's list.
export const AGE_INELIGIBLE_PENALTY = -70;
// A sex-ineligible trial (e.g. a Female Pattern Hair Loss study for a male
// patient with androgenetic alopecia) is one the patient cannot enrol in —
// push it well below eligible options, mirroring the age-ineligibility penalty.
export const SEX_INELIGIBLE_PENALTY = -70;
// Conservative title/condition signals that a trial is restricted to ONE sex.
// Only used when CT.gov's eligibility.sex is not explicitly MALE/FEMALE.
const FEMALE_RESTRICTED_TEXT = /\bfemale[- ]pattern\b|\bin women\b|\bwomen with\b|\bpost-?menopaus|\bpre-?menopaus|\bpregnan/i;
const MALE_RESTRICTED_TEXT = /\bmale[- ]pattern\b|\bin men\b|\bmen with\b|\bprostat/i;
const HARMFUL_PATTERN = /futilit|harm|safety concern|adverse|increased (mortalit|death|risk)|stopped (early|for)|lack of efficac|did not meet|negative (result|trial)/i;
// PANTHER-IPF prednisone+azathioprine+NAC arm — stopped for increased death
// and hospitalisation. Never let it rank as a promising option.
export const HARMFUL_NCTS = new Set(['NCT00650091']);
const ENROLLING_STATUSES = ['RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION'];
// Statuses a patient can actually act on: enrolling, or an open expanded-access
// program (AVAILABLE). Used to gate the access-designation bonuses below.
export const AVAILABLE_STATUSES = [...ENROLLING_STATUSES, 'AVAILABLE'];
export const programIsAvailable = (study = {}) => {
  const status = String(study.status || '').toUpperCase();
  return AVAILABLE_STATUSES.includes(status) || study.acceptingNewPatients === true;
};
// Expanded-access / open-label-extension bonuses help a patient ONLY when the
// program is currently available to join. A NO_LONGER_AVAILABLE or COMPLETED
// expanded-access/OLE program is a dead end and must not be rewarded (Chronic
// Constipation defect: a defunct Domperidone expanded-access protocol got the
// +20 bonus and outranked a live Phase 3 trial).
export const accessDesignationBonus = (study = {}) => {
  if (!programIsAvailable(study)) return 0;
  const d = study.designations || {};
  let bonus = 0;
  if (d.hasExpandedAccess) bonus += 20;
  if (d.hasOpenLabelExtension) bonus += 15;
  return bonus;
};

// CT.gov age strings look like "10 Years", "6 Months", "N/A". Convert to
// fractional years so we can compare against the patient's age.
export const parseAgeToYears = (raw) => {
  const m = String(raw || '').match(/(\d+(?:\.\d+)?)\s*(year|month|week|day)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('year')) return n;
  if (unit.startsWith('month')) return n / 12;
  if (unit.startsWith('week')) return n / 52;
  if (unit.startsWith('day')) return n / 365;
  return null;
};

// True when the patient's age falls outside the trial's eligible age window.
// Uses the numeric min/max when present; falls back to stdAges (a CHILD-only
// study excludes adults) so pediatric trials are caught even without numbers.
export const patientAgeIneligible = (study = {}, patientAge) => {
  const age = Number(patientAge);
  if (!Number.isFinite(age) || age <= 0) return false;
  const min = parseAgeToYears(study.minimumAge);
  const max = parseAgeToYears(study.maximumAge);
  if (min != null && age < min) return true;
  if (max != null && age > max) return true;
  if (min == null && max == null) {
    const stdAges = (study.stdAges || []).map((a) => String(a).toUpperCase());
    if (stdAges.length && !stdAges.includes('ADULT') && !stdAges.includes('OLDER_ADULT') && age >= 18) {
      return true; // CHILD-only study, adult patient
    }
    if (stdAges.length && !stdAges.includes('CHILD') && age < 18) {
      return true; // adult-only study, pediatric patient
    }
  }
  return false;
};

// Normalize the patient's sex/gender field ("Male"/"Female"/"M"/"woman"…) to
// MALE/FEMALE. Intersex/other/unknown returns null so we NEVER penalize them.
const normalizePatientSex = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('m')) return 'MALE';
  if (s.startsWith('f') || s.startsWith('w')) return 'FEMALE';
  return null;
};

// True when a trial is clearly restricted to the OPPOSITE sex of the patient
// (e.g. a Female Pattern Hair Loss study for a male AGA patient). Conservative:
// the explicit CT.gov eligibility.sex restriction is the primary signal; title/
// condition text is used only as a fallback and never fires on mixed-sex
// ("men and women") phrasing or when BOTH sexes are referenced.
export const patientSexIneligible = (study = {}, patientSex) => {
  const sex = normalizePatientSex(patientSex);
  if (!sex) return false;
  const opposite = sex === 'MALE' ? 'FEMALE' : 'MALE';
  const trialSex = String(study.sex || '').trim().toUpperCase();
  if (trialSex === 'MALE' || trialSex === 'FEMALE') return trialSex === opposite;
  const text = `${study.briefTitle || ''} ${study.officialTitle || ''} ${(study.conditions || []).join(' ')}`;
  if (/\bmen and women\b|\bwomen and men\b|\bmales? and females?\b|\bfemales? and males?\b|\bboth sexes\b|\ball sexes\b/i.test(text)) {
    return false;
  }
  const femaleOnly = FEMALE_RESTRICTED_TEXT.test(text);
  const maleOnly = MALE_RESTRICTED_TEXT.test(text);
  if (femaleOnly && maleOnly) return false;
  if (sex === 'MALE' && femaleOnly) return true;
  if (sex === 'FEMALE' && maleOnly) return true;
  return false;
};

// Linear map of the raw additive sum into a 0-100 scale (the UI shows "/100").
// Monotonic, so it preserves relative ranking order while keeping distinct
// trials distinct instead of clamping many of them at 100.
export const PROMISE_RAW_MIN = -80;
export const PROMISE_RAW_MAX = 150;
export const normalizePromise = (raw) => {
  const pct = ((Number(raw) || 0) - PROMISE_RAW_MIN) / (PROMISE_RAW_MAX - PROMISE_RAW_MIN) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
};

// Unified eligibility gate. ONE place that evaluates every hard patient-
// eligibility dimension (sex restriction, age out-of-range, pediatric/adult
// age-band) and returns the applicable penalties + per-dimension flags, instead
// of the checks being scattered through the score adjuster. Conservative: a
// dimension only contributes a penalty when the patient is CLEARLY ineligible.
// Returns { penalty, flags: [{ dimension, penalty, caution }], cautions }.
export const assessTrialEligibility = (study = {}, { patientAge = null, patientSex = null } = {}) => {
  const flags = [];
  if (patientAgeIneligible(study, patientAge)) {
    flags.push({
      dimension: 'age',
      penalty: AGE_INELIGIBLE_PENALTY,
      caution: `This trial only enrols ages ${study.minimumAge || '?'}–${study.maximumAge || '?'}, which does not include the patient's age — they likely cannot join.`
    });
  }
  if (patientSexIneligible(study, patientSex)) {
    flags.push({
      dimension: 'sex',
      penalty: SEX_INELIGIBLE_PENALTY,
      caution: 'This trial appears to enrol only patients of a different sex than the patient — they likely cannot join.'
    });
  }
  const penalty = flags.reduce((sum, f) => sum + f.penalty, 0);
  return { penalty, flags, cautions: flags.map((f) => f.caution) };
};

// Apply the status penalty + harmful-trial caution to an accumulated raw score.
export const applyPatientPromiseAdjustment = (rawScore, study = {}, { patientAge = null, patientSex = null } = {}) => {
  let score = Number(rawScore) || 0;
  const STATUS = String(study.status || '').toUpperCase();
  const nct = String(study.nctId || '').toUpperCase();
  if (NON_ENROLLING_PENALTY[STATUS] != null) score += NON_ENROLLING_PENALTY[STATUS];
  else if (STATUS === 'ACTIVE_NOT_RECRUITING') score += ACTIVE_NOT_RECRUITING_PENALTY;

  // A trial that is actively enrolling cannot have been "stopped"; only flag
  // it as stopped/negative when there's a real basis (a hardcoded harmful NCT,
  // or a non-enrolling status whose title/whyStopped matches the harm pattern).
  // Without this gate, boilerplate title text like "...Adverse Events (AEs)..."
  // falsely tagged RECRUITING trials as stopped (contradictory status flags).
  const enrolling = ENROLLING_STATUSES.includes(STATUS) || study.acceptingNewPatients === true;
  const stoppedHarmful = HARMFUL_NCTS.has(nct) ||
    (!enrolling && (
      (['TERMINATED', 'SUSPENDED', 'WITHDRAWN'].includes(STATUS) && HARMFUL_PATTERN.test(study.whyStopped || '')) ||
      HARMFUL_PATTERN.test(`${study.briefTitle || ''} ${study.whyStopped || ''}`)
    ));
  let caution = null;
  if (stoppedHarmful) {
    score -= 30;
    caution = HARMFUL_NCTS.has(nct)
      ? 'Stopped for harm — this regimen increased death/hospitalisation. Listed for context only, not as a recommended option.'
      : 'This trial was stopped or reported a negative result — discuss with your doctor before pursuing.';
  }

  // Penalise trials the patient is hard-ineligible for (age out-of-range,
  // pediatric/adult age-band, or opposite-sex restriction) via the single
  // eligibility gate so the dimensions can never silently drift apart. The
  // status caution (stopped-for-harm) keeps priority; otherwise the first
  // eligibility caution (age before sex) is surfaced.
  const eligibility = assessTrialEligibility(study, { patientAge, patientSex });
  score += eligibility.penalty;
  if (!caution && eligibility.cautions.length) caution = eligibility.cautions[0];
  return { score, caution };
};

const extractContacts = (contactsLocationsModule = {}) => {
  const centralContacts = contactsLocationsModule.centralContacts || [];
  const overallOfficials = contactsLocationsModule.overallOfficials || [];
  const locations = (contactsLocationsModule.locations || []).map(loc => ({
    facility: loc.facility,
    city: loc.city,
    state: loc.state,
    country: loc.country,
    status: loc.status,
    contacts: (loc.contacts || []).map(c => ({
      name: c.name,
      role: c.role,
      email: c.email,
      phone: c.phone
    }))
  }));
  return {
    centralContacts: centralContacts.map(c => ({
      name: c.name,
      role: c.role,
      email: c.email,
      phone: c.phone
    })),
    overallOfficials: overallOfficials.map(o => ({
      name: o.name,
      role: o.role,
      affiliation: o.affiliation
    })),
    locations
  };
};

// classifyTrial accepts an optional `isTopCenterFn` so callers can inject a
// dossier-extended top-center matcher (adds disease-specific centers like
// Joslin Diabetes Center for LADA, or Pittsburgh Simmons Center for ILD,
// on top of the Tier-1 safety-floor whitelist). If omitted, falls back to
// the global `isTopCenter` whitelist.
export const classifyTrial = (study, isTopCenterFn = isTopCenter) => {
  const protocol = study.protocolSection || {};
  const identification = protocol.identificationModule || {};
  const status = protocol.statusModule || {};
  const design = protocol.designModule || {};
  const arms = protocol.armsInterventionsModule || {};
  const eligibility = protocol.eligibilityModule || {};
  const oversight = protocol.oversightModule || {};
  const sponsor = protocol.sponsorCollaboratorsModule || {};
  const desc = protocol.descriptionModule || {};
  const outcomes = protocol.outcomesModule || {};

  const nctId = identification.nctId;
  const briefTitle = identification.briefTitle;
  const officialTitle = identification.officialTitle;
  const organization = identification.organization?.fullName;

  const overallStatus = status.overallStatus;
  const isRecruiting = ['RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION'].includes(overallStatus);
  const acceptingNew = overallStatus === 'RECRUITING' || overallStatus === 'ENROLLING_BY_INVITATION';
  const whyStopped = status.whyStopped || '';

  const studyType = design.studyType;
  const isTreatment = studyType === 'INTERVENTIONAL';
  const isExpandedAccessStudyType = studyType === 'EXPANDED_ACCESS';
  const phases = design.phases || [];
  const allocation = design.designInfo?.allocation;
  const masking = design.designInfo?.maskingInfo?.masking;
  const hasPlacebo = (arms.interventions || []).some(i =>
    i.type === 'OTHER' && /placebo/i.test(i.name || '')
  ) || /placebo/i.test(masking || '');

  // Expanded Access — ONLY definitive CT.gov signals. Text hints like
  // "compassionate use" in a regular trial description caused false
  // positives (trial mentions EA in passing ≠ an EA program record).
  const hasExpandedAccess =
    isExpandedAccessStudyType ||
    identification.expandedAccessInfo?.hasExpandedAccess === true;

  // Softer signal: trial text mentions EA/compassionate use (for notes only).
  const mentionsExpandedAccessInText =
    !hasExpandedAccess && (
      containsAny(desc.detailedDescription, EXPANDED_ACCESS_HINTS) ||
      containsAny(desc.briefSummary, EXPANDED_ACCESS_HINTS) ||
      containsAny(briefTitle, EXPANDED_ACCESS_HINTS) ||
      containsAny(officialTitle, EXPANDED_ACCESS_HINTS)
    );

  const hasPTA =
    containsAny(desc.detailedDescription, PTA_HINTS) ||
    containsAny(desc.briefSummary, PTA_HINTS);

  // OLE detection prioritises the title because that's where CT.gov
  // sponsors most reliably label extension studies.
  const hasOLE =
    containsAny(briefTitle, OLE_HINTS) ||
    containsAny(officialTitle, OLE_HINTS) ||
    containsAny(desc.detailedDescription, OLE_HINTS) ||
    containsAny(desc.briefSummary, OLE_HINTS);

  // Pay-to-Access detection is best-effort. Most patient-funded studies
  // disclose fees in the description. Many do NOT, especially company-run
  // "charitable access" programs. When we detect any signal we surface it
  // explicitly so the user knows to ask about cost.
  const hasPayToAccess =
    containsAny(desc.detailedDescription, PAY_TO_ACCESS_HINTS) ||
    containsAny(desc.briefSummary, PAY_TO_ACCESS_HINTS) ||
    containsAny(officialTitle, PAY_TO_ACCESS_HINTS);

  const fastTrack = containsAny(desc.detailedDescription, FAST_TRACK_HINTS) ||
                    containsAny(desc.briefSummary, FAST_TRACK_HINTS);
  const breakthrough = containsAny(desc.detailedDescription, BREAKTHROUGH_HINTS) ||
                       containsAny(desc.briefSummary, BREAKTHROUGH_HINTS);
  const orphan = containsAny(desc.detailedDescription, ORPHAN_HINTS) ||
                 containsAny(desc.briefSummary, ORPHAN_HINTS);

  const contacts = extractContacts(protocol.contactsLocationsModule);
  const countries = [...new Set(contacts.locations.map(l => l.country).filter(Boolean))];

  const conditionsModule = protocol.conditionsModule || {};
  const conditions = [...(conditionsModule.conditions || []), ...(conditionsModule.keywords || [])].filter(Boolean);

  // Top-center detection looks at sponsor, organization, every facility, and
  // every overall official affiliation. Any single match is enough to flag
  // the trial as "top center" for UI purposes, and matches stack (capped)
  // for scoring.
  const centerTexts = [
    sponsor.leadSponsor?.name,
    ...(sponsor.collaborators || []).map((c) => c.name),
    organization,
    ...contacts.locations.map((l) => l.facility),
    ...contacts.overallOfficials.map((o) => o.affiliation)
  ].filter(Boolean);
  const topCenters = [...new Set(centerTexts.filter(isTopCenterFn))];
  const hasTopCenter = topCenters.length > 0;
  // We still use the hardcoded-whitelist boost for the numeric score (the
  // dossier-extended list would let Claude inflate scores for obscure
  // centers); the dossier's contribution is surfacing whether ANY match
  // exists and naming the center in the UI / prompt context.
  const topCenterScore = topCenterBoost(centerTexts);

  const interventions = (arms.interventions || []).map(i => ({
    type: i.type,
    name: i.name,
    description: i.description
  }));

  const primaryOutcomes = (outcomes.primaryOutcomes || []).map(o => ({
    measure: o.measure,
    description: o.description,
    timeFrame: o.timeFrame
  }));

  const oversightFlags = {
    fdaRegulatedDrug: oversight.isFdaRegulatedDrug,
    fdaRegulatedDevice: oversight.isFdaRegulatedDevice,
    oversightHasDMC: oversight.oversightHasDmc,
    usExportStatus: oversight.isUsExport
  };
  const parsedCriteria = parseEligibilityCriteria(eligibility.eligibilityCriteria);

  return {
    nctId,
    url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : null,
    briefTitle,
    officialTitle,
    organization,
    sponsor: sponsor.leadSponsor?.name,
    collaborators: (sponsor.collaborators || []).map(c => c.name),

    status: overallStatus,
    acceptingNewPatients: acceptingNew,
    isRecruiting,
    whyStopped,
    startDate: status.startDateStruct?.date,
    completionDate: status.completionDateStruct?.date,
    lastUpdate: status.lastUpdatePostDateStruct?.date,

    studyType,
    isTreatmentStudy: isTreatment,
    isExpandedAccessStudy: isExpandedAccessStudyType,
    phases,
    allocation,
    masking,
    hasPlacebo,
    interventions,

    designations: {
      fastTrack,
      breakthrough,
      orphan,
      hasExpandedAccess,
      hasPostTrialAccess: hasPTA,
      hasOpenLabelExtension: hasOLE,
      hasPayToAccess
    },

    // Top-line boolean flags that frontend can badge without drilling into
    // designations{}. Redundant but useful.
    isExpandedAccess: hasExpandedAccess,
    mentionsExpandedAccessInText,
    isOpenLabelExtension: hasOLE,
    isPayToAccess: hasPayToAccess,
    hasTopCenter,
    topCenters,
    topCenterScore,

    oversight: oversightFlags,

    eligibilityCriteria: parsedCriteria.fullText,
    eligibility: parsedCriteria,
    eligibilityReviewStatus: parsedCriteria.reviewStatus,
    eligibilityCaution: parsedCriteria.caution || null,
    healthyVolunteers: eligibility.healthyVolunteers,
    sex: eligibility.sex,
    minimumAge: eligibility.minimumAge,
    maximumAge: eligibility.maximumAge,
    stdAges: eligibility.stdAges,

    briefSummary: desc.briefSummary,
    detailedDescription: desc.detailedDescription,
    primaryOutcomes,
    conditions,

    contacts,
    countries
  };
};

// Trials returned by CT.gov often include studies for a *different* disease
// that share a drug code or a broad search term. Score relevance from the
// dossier + KB terms for ANY condition — no hardcoded disease list.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const phraseMatches = (haystack, phrase) => {
  if (!haystack || !phrase) return false;
  const p = String(phrase).trim().toLowerCase();
  if (p.length <= 3) {
    return new RegExp(`\\b${escapeRegex(p)}\\b`, 'i').test(haystack);
  }
  return haystack.includes(p);
};

const buildRelevanceMatcher = (primary, aliases, meshTerms, kbMeta) => {
  const phrases = new Set();
  const add = (s) => {
    if (!s || typeof s !== 'string') return;
    const t = s.trim().toLowerCase();
    if (t.length >= 2) phrases.add(t);
  };
  add(primary);
  (aliases || []).forEach(add);
  (meshTerms || []).forEach(add);
  (kbMeta?.aliases || []).forEach(add);
  (kbMeta?.meshTerms || []).forEach(add);
  if (kbMeta?.condition) add(kbMeta.condition);
  return {
    primary: String(primary || '').trim().toLowerCase(),
    displayName: kbMeta?.condition || primary || 'your condition',
    phrases: [...phrases]
  };
};

const scoreTrialRelevance = (study, matcher) => {
  const text = [
    study.briefTitle,
    study.officialTitle,
    ...(study.conditions || []),
    ...(study.interventions || []).map((i) => i.name),
    study.briefSummary
  ].filter(Boolean).join(' ').toLowerCase();

  const listedConds = (study.conditions || []).map((c) => String(c).toLowerCase());
  const condBlob = listedConds.join(' ');

  let score = 0;
  for (const phrase of matcher.phrases) {
    if (phraseMatches(text, phrase)) {
      score += phrase.length >= 12 ? 18 : phrase.length >= 6 ? 12 : 8;
    }
  }
  if (matcher.primary && phraseMatches(text, matcher.primary)) score += 25;

  // When CT.gov lists explicit conditions, they are the strongest signal.
  if (listedConds.length > 0) {
    const condMatch = matcher.phrases.some((p) => {
      if (phraseMatches(condBlob, p)) return true;
      // Substring match: "pulmonary fibrosis" inside "idiopathic pulmonary fibrosis"
      if (p.length >= 5) {
        return listedConds.some((lc) => lc.includes(p) || p.includes(lc));
      }
      return false;
    });
    if (condMatch) score += 30;
    // Only flag wrong-disease when the title/summary also lacks any connection.
    // Previously score < 20 dropped too many valid trials (different CT.gov wording).
    else if (score < 5) {
      const named = listedConds.slice(0, 2).join('; ');
      return {
        score: -100,
        label: 'wrong disease',
        reason: `ClinicalTrials.gov lists this under "${named}" — not ${matcher.displayName}.`
      };
    }
  }

  if (score >= 45) {
    return {
      score,
      label: 'strong match',
      reason: `Title and listed conditions clearly match ${matcher.displayName}.`
    };
  }
  if (score >= 18) {
    return {
      score,
      label: 'likely match',
      reason: `Appears related to ${matcher.displayName} based on title and conditions on ClinicalTrials.gov.`
    };
  }
  if (score >= 8) {
    return {
      score,
      label: 'weak match',
      reason: `Only a loose connection to ${matcher.displayName} — confirm with the study team before assuming you qualify.`
    };
  }
  const ivText = (study.interventions || []).map((i) => i.name).join(' ');
  const cellGene = /\b(car[- ]?t|chimeric antigen|cell therapy|gene therapy|stem cell|gene[- ]edit)/i.test(
    `${study.briefTitle || ''} ${ivText}`
  );
  if (cellGene) {
    return {
      score: Math.max(score, 10),
      label: 'cell / gene therapy',
      reason: `Cell or gene therapy trial — may apply only to certain patients; confirm eligibility with the study team.`
    };
  }
  return {
    score,
    label: 'unlikely match',
    reason: `Does not clearly mention ${matcher.displayName} — may have appeared because of a shared drug name or broad search.`
  };
};

// Single CT.gov query wrapper. Returns raw studies[] array or throws.
const queryCtGov = async (paramsDict) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsDict)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  params.set('format', 'json');
  params.set('countTotal', 'true');
  const url = `${CT_API}?${params.toString()}`;
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`ClinicalTrials.gov ${response.status}: ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  return data.studies || [];
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, X-Access-Passcode'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAccess(req, res)) return;

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const {
      condition,
      recruitingOnly: recruitingOnlyRaw = true,
      treatmentOnly: treatmentOnlyRaw = true,
      excludePlacebo: excludePlaceboRaw = false,
      pageSize = 50,
      country,
      patientAge = null,
      patientSex = null
    } = body || {};
    const recruitingOnly = parseExplicitBoolean(recruitingOnlyRaw, true);
    const treatmentOnly = parseExplicitBoolean(treatmentOnlyRaw, true);
    const excludePlacebo = parseExplicitBoolean(excludePlaceboRaw, false);

    if (!condition || !String(condition).trim()) {
      return res.status(400).json({ error: 'condition is required' });
    }

    // Disease-intake agent. Returns a structured dossier with synonyms,
    // MeSH terms, top centers, etc. for ANY condition (no hardcoded map).
    // We accept a pre-fetched dossier from callers (research.js passes one
    // through so we don't double-call the agent for the same query).
    const dossier =
      (body && body.dossier && body.dossier.canonical)
        ? body.dossier
        : await getDossier(condition);

    const primary = dossier.canonical || condition;
    const aliases = (dossier.synonyms || [])
      .filter((s) => s && s.toLowerCase() !== primary.toLowerCase());
    // MeSH terms let us query CT.gov on controlled vocabulary when the
    // user's colloquial input doesn't match CT.gov's indexing (e.g. "LADA"
    // → "Diabetes Mellitus, Type 1").
    const meshTerms = (dossier.meshTerms || []).filter(Boolean);
    const perSource = parsePageSize(pageSize, { fallback: 50, max: 100 });
    // Extend the top-center matcher with dossier-supplied centers so
    // disease-specific leaders (Joslin for diabetes, Pittsburgh Simmons for
    // ILD, UCSF MAC for dementia) count alongside the global whitelist.
    const isTopCenterExtended = buildExtendedCenterMatcher(dossier.topCenters || []);

    // 4 parallel queries. Each returns raw studies[]; we merge + classify + dedupe later.
    //   (a) Primary condition, recruiting only (if recruitingOnly)
    //   (b) Synonym-fanout: first 3 aliases, recruiting only
    //   (c) Expanded Access — no recruiting filter (these have their own statuses:
    //       AVAILABLE, NO_LONGER_AVAILABLE, APPROVED_FOR_MARKETING, etc.)
    //   (d) Open-Label Extension / Long-Term Follow-Up studies — text search
    const queries = [];

    // (a) Primary recruiting
    queries.push(queryCtGov({
      'query.cond': primary,
      'pageSize': perSource,
      ...(recruitingOnly
        ? { 'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION' }
        : {})
    }));

    // (b) Synonym fan-out (first 3 dossier-supplied aliases)
    for (const alias of aliases.slice(0, 3)) {
      queries.push(queryCtGov({
        'query.cond': alias,
        'pageSize': Math.min(30, perSource),
        ...(recruitingOnly
          ? { 'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION' }
          : {})
      }));
    }

    // (b2) MeSH term fan-out. CT.gov's indexing is more reliable on MeSH
    // headings than on colloquial names (e.g. "Lou Gehrig's" misses plenty
    // of ALS trials that index under "Amyotrophic Lateral Sclerosis").
    for (const mesh of meshTerms.slice(0, 2)) {
      queries.push(queryCtGov({
        'query.term': `AREA[ConditionMeshTerm]"${mesh}"`,
        'pageSize': Math.min(30, perSource),
        ...(recruitingOnly
          ? { 'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION' }
          : {})
      }));
    }

    // (c) Expanded Access studies for the condition, ALL statuses.
    // CT.gov v2 filters Expanded Access via the advanced Essie query expression.
    queries.push(queryCtGov({
      'query.cond': primary,
      'filter.advanced': 'AREA[StudyType]EXPANDED_ACCESS',
      'pageSize': 40
    }));

    // (d) Open-Label Extension / Long-Term Follow-Up. Title search is the most
    // reliable signal (sponsors label extensions with these words by convention).
    queries.push(queryCtGov({
      'query.cond': primary,
      'query.titles': 'extension OR "long-term follow-up" OR rollover',
      'pageSize': 40
    }));

    // (e) Pipeline-drug fan-out. For every drug/NCT in the KB's
    // pipelineDrugs array we query CT.gov explicitly — either by NCT id
    // (most precise) or by drug name. This is what stops us missing
    // Nerandomilast's FIBRONEER trials for IPF or Ocugen's OCU400
    // liMeliGhT trial for RP even when the generic condition query
    // fails to surface them. NCTs queried directly always return the
    // exact trial record, bypassing relevance ranking.
    const kb = await loadKb(condition, {
      fallbackCanonical: primary,
      fallbackSynonyms: [...aliases, ...meshTerms]
    });
    if (!kb.matched && isDynamicKbEnabled()) {
      ensureDynamicKb(primary, dossier).catch(() => {});
    }
    const pipelineDrugs = Array.isArray(kb.meta?.pipelineDrugs) ? kb.meta.pipelineDrugs : [];
    const pipelineDrugQueryLabels = [];
    for (const drug of pipelineDrugs.slice(0, 6)) {
      if (drug.nct) {
        // Direct NCT lookup — guaranteed match.
        queries.push(queryCtGov({ 'query.id': drug.nct, 'pageSize': 5 }));
        pipelineDrugQueryLabels.push(`nct:${drug.nct}:${drug.name}`);
      }
      if (drug.name) {
        // Intervention-text search. CT.gov's `query.intr` is the
        // intervention field — guaranteed to hit trials that administer
        // this drug, regardless of whether the condition term matches.
        queries.push(queryCtGov({
          'query.cond': primary,
          'query.intr': drug.name,
          'pageSize': 10
        }));
        pipelineDrugQueryLabels.push(`drug:${drug.name}`);
      }
    }

    // Run all of the above in parallel. Any individual failure does NOT kill
    // the whole request — we return what we have and mark which sub-queries
    // failed in the response so the UI can warn.
    const settled = await Promise.allSettled(queries);
    const queryLabels = [
      'primary',
      ...aliases.slice(0, 3).map((a) => `synonym:${a}`),
      ...meshTerms.slice(0, 2).map((m) => `mesh:${m}`),
      'expanded-access',
      'ole-extension',
      ...pipelineDrugQueryLabels
    ];
    const subQueryStats = [];
    const allRaw = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        subQueryStats.push({ label: queryLabels[i], status: 'ok', count: r.value.length });
        allRaw.push(...r.value);
      } else {
        subQueryStats.push({ label: queryLabels[i], status: 'error', error: r.reason?.message });
      }
    });

    // Classify + dedupe by NCT
    const byNct = new Map();
    for (const raw of allRaw) {
      const nct = raw?.protocolSection?.identificationModule?.nctId;
      if (!nct || byNct.has(nct)) continue;
      byNct.set(nct, classifyTrial(raw, isTopCenterExtended));
    }
    let studies = [...byNct.values()];

    // Apply filters AFTER dedupe so we don't accidentally drop an expanded-
    // access record by the recruiting-only filter when the user clicked
    // "include all".
    if (treatmentOnly) {
      // Keep interventional AND expanded-access studies even when treatmentOnly
      // is on — both are "the patient actually gets a drug".
      studies = studies.filter((s) => s.isTreatmentStudy || s.isExpandedAccessStudy);
    }
    if (excludePlacebo) {
      studies = studies.filter((s) => !s.hasPlacebo);
    }
    if (country) {
      const target = String(country).toLowerCase();
      studies = studies.filter(s =>
        (s.countries || []).some(c => String(c).toLowerCase().includes(target))
      );
    }

    // Promise-score. Heavily revised from the previous single-query version:
    //   - Phase bonuses (existing)
    //   - Recruiting + no-placebo + designations (existing)
    //   - NEW: +20 if expanded-access available (it's literally "you can
    //     get the drug right now without winning a trial lottery")
    //   - NEW: +15 if OLE available
    //   - NEW: +3 per top center in sponsor/location/affiliation (capped 15)
    //   - NEW: -15 if the trial is in China/Vietnam/Mexico/India for
    //     the stem-cell safety reasons already used in evidence.js
    const WESTERN = new Set([
      'United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Italy',
      'Spain', 'Netherlands', 'Sweden', 'Denmark', 'Norway', 'Finland', 'Belgium',
      'Switzerland', 'Ireland', 'Austria', 'Australia', 'New Zealand', 'Japan'
    ]);
    const CHINA_LIKE = new Set(['China', 'Vietnam', 'Mexico', 'India']);

    const relevanceMatcher = buildRelevanceMatcher(
      primary,
      aliases,
      [...meshTerms, ...(kb.meta?.meshTerms || [])],
      kb.meta || {}
    );

    studies.forEach((s) => {
      const rel = scoreTrialRelevance(s, relevanceMatcher);
      s.relevanceScore = rel.score;
      s.relevanceLabel = rel.label;
      s.relevanceReason = rel.reason;

      let score = 0;
      if (rel.score >= 45) score += 12;
      else if (rel.score >= 15) score += 4;
      else if (rel.score < 0) score -= 50;

      const phase = (s.phases || []).join(',');
      if (phase.includes('PHASE3')) score += 40;
      else if (phase.includes('PHASE2')) score += 25;
      else if (phase.includes('PHASE1')) score += 10;
      if (s.acceptingNewPatients) score += 25;
      if (!s.hasPlacebo) score += 10;
      if (s.designations.fastTrack) score += 5;
      if (s.designations.breakthrough) score += 8;
      if (s.designations.orphan) score += 3;
      score += accessDesignationBonus(s);
      if (s.designations.hasPostTrialAccess) score += 6;
      score += s.topCenterScore || 0;
      const westernHit = (s.countries || []).some(c => WESTERN.has(c));
      const chinaHit = (s.countries || []).some(c => CHINA_LIKE.has(c));
      if (westernHit) score += 10;
      if (chinaHit) score -= 15;
      if (s.oversight?.oversightHasDMC) score += 4;
      const ivBlob = (s.interventions || []).map((i) => i.name).join(' ');
      if (/\b(car[- ]?t|chimeric antigen|cell therapy|gene therapy|stem cell|gene[- ]edit)/i.test(
        `${s.briefTitle || ''} ${ivBlob}`
      ) && (s.relevanceScore || 0) > -100) {
        score += 10;
      }

      // Rank patients toward trials they can actually join, flag stopped/harmful
      // ones, and rescale the raw sum to a clear 0-100 score (Item 7 + 0-100).
      const { score: adjustedScore, caution } = applyPatientPromiseAdjustment(score, s, { patientAge, patientSex });
      const eligibility = assessTrialEligibility(s, { patientAge, patientSex });
      s.caution = caution || s.eligibilityCaution || null;
      s.eligibilityAssessment = {
        status: eligibility.flags.length
          ? 'hard-mismatch'
          : s.eligibilityReviewStatus === 'not-provided'
            ? 'criteria-unavailable'
            : 'criteria-unchecked',
        reviewedCriteria: false,
        caution: s.eligibilityCaution ||
          'Full eligibility criteria were unavailable and were not checked against this patient.'
      };
      s.promiseScoreRaw = adjustedScore;
      s.promiseScore = normalizePromise(adjustedScore);
    });

    // Demographic HARD-GATE (patient-safety + eligibility). A study the patient
    // is hard-INELIGIBLE for by sex or age (a female-only study for a male
    // patient, a pediatric trial for an adult) is REMOVED from the surfaced
    // list — not merely penalized and shown "for completeness". Driven only by
    // the patient profile (sex/age) + CT.gov's own eligibility fields, so it is
    // condition-agnostic. Skipped entirely when the patient did not provide the
    // relevant field (patientSex/AgeIneligible return false), so we never gate a
    // patient we cannot assess.
    let droppedDemographic = 0;
    if (patientSex != null || patientAge != null) {
      const demoKept = studies.filter((s) => {
        if (patientSexIneligible(s, patientSex) || patientAgeIneligible(s, patientAge)) {
          droppedDemographic += 1;
          return false;
        }
        return true;
      });
      studies = demoKept;
    }

    // Drop clear wrong-disease trials; keep weak cell/gene therapy trials when not hard-mismatched.
    const beforeWrong = studies.length;
    const filtered = studies.filter((s) => {
      if ((s.relevanceScore || 0) <= -100) return false;
      const ivBlob = (s.interventions || []).map((i) => i.name).join(' ');
      const cellGene = /\b(car[- ]?t|chimeric antigen|cell therapy|gene therapy|stem cell|gene[- ]edit)/i.test(
        `${s.briefTitle || ''} ${ivBlob}`
      );
      if (cellGene && (s.relevanceScore || 0) > -80) return true;
      return (s.relevanceScore || 0) > -50;
    });
    const droppedWrong = beforeWrong - filtered.length;
    studies = filtered;

    studies.sort((a, b) => {
      const relDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
      if (relDiff !== 0 && Math.abs(relDiff) >= 30) return relDiff;
      return (b.promiseScore || 0) - (a.promiseScore || 0);
    });

    // Summary breakdowns so the UI can surface "we found 14 recruiting trials,
    // 3 expanded access programs, 2 open-label extensions, 8 at top centers".
    const breakdown = {
      total: studies.length,
      droppedWrongCondition: droppedWrong,
      droppedDemographic,
      recruiting: studies.filter((s) => s.acceptingNewPatients).length,
      expandedAccess: studies.filter((s) => s.designations.hasExpandedAccess).length,
      openLabelExtension: studies.filter((s) => s.designations.hasOpenLabelExtension).length,
      payToAccess: studies.filter((s) => s.designations.hasPayToAccess).length,
      atTopCenter: studies.filter((s) => s.hasTopCenter).length,
      phases: {
        phase1: studies.filter((s) => (s.phases || []).join(',').includes('PHASE1')).length,
        phase2: studies.filter((s) => (s.phases || []).join(',').includes('PHASE2')).length,
        phase3: studies.filter((s) => (s.phases || []).join(',').includes('PHASE3')).length,
        phase4: studies.filter((s) => (s.phases || []).join(',').includes('PHASE4')).length
      }
    };

    return res.status(200).json({
      query: { condition, recruitingOnly, treatmentOnly, excludePlacebo, country },
      dossier: {
        canonical: dossier.canonical,
        synonyms: dossier.synonyms,
        meshTerms: dossier.meshTerms,
        subspecialty: dossier.subspecialty,
        uncertainty: dossier.uncertainty,
        cacheHit: dossier.cacheHit,
        generatedBy: dossier.generatedBy
      },
      subQueries: subQueryStats,
      breakdown,
      kbContext: kb.matched
        ? {
            canonical: kb.meta?.condition,
            approvedDrugs: (kb.meta?.pipelineDrugs || [])
              .filter((d) => ['approved', 'approved-other-indication'].includes(parseApprovalStatus(d.approvalStatus || d.status)))
              .slice(0, 5)
              .map((d) => ({ name: d.name, status: d.approvalStatus || d.status, why: d.whyItMatters })),
            pipelineHighlights: (kb.meta?.pipelineDrugs || [])
              .filter((d) => !['approved', 'approved-other-indication'].includes(parseApprovalStatus(d.approvalStatus || d.status)))
              .slice(0, 4)
              .map((d) => ({ name: d.name, status: d.approvalStatus || d.status })),
            keyFacts: (kb.meta?.canonicalFacts || []).slice(0, 4).map((f) => f.claim || f)
          }
        : null,
      total: studies.length,
      returned: studies.length,
      studies
    });
  } catch (error) {
    console.error('trials.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
