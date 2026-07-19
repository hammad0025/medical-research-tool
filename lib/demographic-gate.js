// ===========================================================================
// Demographic / eligibility gate (condition-agnostic, patient-profile driven).
//
// WHY THIS EXISTS — the "female-only study shown to a male patient" failure:
//   Reports surface studies and trials that the patient CANNOT fit — a
//   Female Pattern Hair Loss trial for a male AGA patient, a pediatric study
//   for a 64-year-old, a pregnancy trial for a man. The trials RANKER already
//   penalizes these (api/trials.js assessTrialEligibility), but a penalized
//   study still appeared in the table "for completeness", and prose mentions
//   of such studies were never gated at all. The client's rule is: REMOVE or
//   hard-gate them, do not merely label.
//
// This module is the DETERMINISTIC fail-safe that holds the line even when the
// second-AI validator errors or returns nothing. It is driven ONLY by patient
// profile fields (sex, age) + the study's own eligibility text — never by a
// hardcoded disease/drug list — so it works for ANY condition, including the
// no-KB runtime path.
// ===========================================================================

// Normalize a free-text sex/gender field ("Male"/"woman"/"F") to MALE/FEMALE.
// Intersex/other/unspecified → null so we NEVER gate them (bias toward keeping).
export const normalizePatientSex = (raw) => {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('m')) return 'MALE';
  if (s.startsWith('f') || s.startsWith('w')) return 'FEMALE';
  return null;
};

// Parse a patient age field to a number of years, or null when unusable.
export const parsePatientAge = (raw) => {
  const n = Number(String(raw == null ? '' : raw).match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Text signals that a line is restricted to ONE sex. Conservative: the mixed-sex
// phrasing ("men and women", "both sexes") negates a same-line single-sex hit so
// an inclusive study is never dropped.
const FEMALE_ONLY_TEXT =
  /\bfemale[- ]pattern\b|\bwomen[- ]only\b|\bfemale[- ]only\b|\bpost-?menopaus|\bpre-?menopaus|\bpregnan|\bfemales? only\b/i;
const MALE_ONLY_TEXT =
  /\bmale[- ]pattern\b|\bmen[- ]only\b|\bmale[- ]only\b|\bprostat|\bmales? only\b/i;
const MIXED_SEX_TEXT =
  /\bmen and women\b|\bwomen and men\b|\bmales? and females?\b|\bfemales? and males?\b|\bboth sexes\b|\ball sexes\b|\bregardless of sex\b|\bany sex\b/i;

// Text signals that a line describes a study restricted to an age band the
// patient falls outside of. Deliberately narrow — only fires on explicit
// pediatric/adult-only study language, never on incidental age mentions.
const PEDIATRIC_ONLY_TEXT =
  /\b(pediatric|paediatric|children only|in children\b|infants?\b|adolescents? only|childhood-onset only)\b/i;
const ADULT_ONLY_TEXT =
  /\badults?[- ]only\b|\bin adults\b|\b(?:18|21) years and older\b/i;
const PEDIATRIC_AGE_TEXT =
  /\b(?:pediatric|paediatric|children|child|infants?|adolescents?|minors?)\b/i;
const ADULT_AGE_TEXT = /\badults?\b/i;
const ADULT_EXCLUDED_TEXT =
  /\b(?:no|not|exclude(?:s|d)?|excluding)\s+(?:eligible\s+)?adults?\b|\badults?\s+(?:are\s+)?(?:excluded|ineligible|not eligible)\b/i;
const PEDIATRIC_EXCLUDED_TEXT =
  /\b(?:no|not|exclude(?:s|d)?|excluding)\s+(?:eligible\s+)?(?:children|pediatric|paediatric|adolescents?|minors?)\b|\b(?:children|pediatric|paediatric|adolescents?|minors?)\s+(?:patients?\s+)?(?:are\s+)?(?:excluded|ineligible|not eligible)\b/i;

const hasCrossBandAgeRange = (text) => {
  const t = String(text || '');
  const patterns = [
    /\bages?\s+(\d{1,3})\s*(?:-|–|—|to|through)\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*(?:-|–|—|to|through)\s*(\d{1,3})\s+years?\b/i,
    /\bbetween\s+(\d{1,3})\s+and\s+(\d{1,3})\s+years?\b/i
  ];
  return patterns.some((pattern) => {
    const match = t.match(pattern);
    return match && Number(match[1]) < 18 && Number(match[2]) >= 18;
  });
};

const hasInclusiveAgeWording = (text) => {
  const t = String(text || '');
  if (hasCrossBandAgeRange(t)) return true;
  if (!PEDIATRIC_AGE_TEXT.test(t) || !ADULT_AGE_TEXT.test(t)) return false;
  if (ADULT_EXCLUDED_TEXT.test(t) || PEDIATRIC_EXCLUDED_TEXT.test(t)) return false;
  return /\b(?:pediatric|paediatric|children|child|infants?|adolescents?|minors?)\b[\s\S]{0,45}(?:,|\/|&|\band\b|\bor\b|\bthrough\b|\bto\b)[\s\S]{0,25}\badults?\b/i.test(t) ||
    /\badults?\b[\s\S]{0,25}(?:,|\/|&|\band\b|\bor\b|\bthrough\b|\bto\b)[\s\S]{0,45}\b(?:pediatric|paediatric|children|child|infants?|adolescents?|minors?)\b/i.test(t) ||
    /\bnot\s+(?:limited\s+to\s+)?(?:pediatric|paediatric)[- ]only\b[\s\S]{0,60}\badults?\b/i.test(t);
};

// Does the text restrict to the OPPOSITE sex of the patient?
export const textOppositeSexOnly = (text, patientSex) => {
  const sex = normalizePatientSex(patientSex);
  if (!sex) return false;
  const t = String(text || '');
  if (MIXED_SEX_TEXT.test(t)) return false;
  const femaleOnly = FEMALE_ONLY_TEXT.test(t);
  const maleOnly = MALE_ONLY_TEXT.test(t);
  if (femaleOnly && maleOnly) return false; // ambiguous — keep
  if (sex === 'MALE' && femaleOnly) return true;
  if (sex === 'FEMALE' && maleOnly) return true;
  return false;
};

// Does the text restrict to an age band the patient falls outside of?
export const textWrongAgeBand = (text, patientAge) => {
  const age = parsePatientAge(patientAge);
  if (age == null) return false;
  const t = String(text || '');
  if (hasInclusiveAgeWording(t)) return false;
  const pediatricOnly = PEDIATRIC_ONLY_TEXT.test(t) &&
    (!ADULT_ONLY_TEXT.test(t) || ADULT_EXCLUDED_TEXT.test(t));
  const adultOnly = ADULT_ONLY_TEXT.test(t) ||
    (ADULT_AGE_TEXT.test(t) && PEDIATRIC_EXCLUDED_TEXT.test(t));
  if (age >= 18 && pediatricOnly && !adultOnly) return true;
  if (age < 18 && adultOnly && !pediatricOnly) return true;
  return false;
};

// Does a line actually describe a STUDY / TRIAL (as opposed to prose that
// happens to mention a sex)? Required before we drop a line, so a general
// epidemiology sentence ("more common in women") is never mistaken for a study
// the patient was wrongly shown.
const STUDY_MENTION_RE =
  /\b(trial|study|studies|cohort|randomi[sz]ed|phase\s*(?:i|ii|iii|iv|1|2|3|4)\b|\bNCT\d{8}\b|enroll|recruit|participants?|arm\b)/i;

export const lineMentionsStudy = (line) => STUDY_MENTION_RE.test(String(line || ''));

// Deterministic fail-safe: remove prose lines that surface a study/trial the
// patient demographically cannot fit (opposite-sex-only or wrong age band).
// Headings are always preserved. Returns { text, removed:[reason...] }.
export const stripDemographicMismatchLines = (text, patient = {}) => {
  if (!text) return { text, removed: [] };
  const sex = normalizePatientSex(patient?.gender ?? patient?.sex);
  const age = parsePatientAge(patient?.age);
  if (!sex && age == null) return { text, removed: [] };
  const removed = [];
  const out = String(text)
    .split('\n')
    .filter((line) => {
      if (/^\s{0,3}#{1,6}\s/.test(line)) return true; // never drop a heading
      if (!lineMentionsStudy(line)) return true;
      if (textOppositeSexOnly(line, sex)) {
        removed.push('opposite-sex-only study');
        return false;
      }
      if (textWrongAgeBand(line, age)) {
        removed.push('wrong-age-band study');
        return false;
      }
      return true;
    })
    .join('\n');
  return { text: out, removed };
};

// Given a validator-flagged demographic-mismatch finding (a verbatim quote of
// the offending study line) confirm it against the patient profile before we
// act, so a hallucinated flag cannot delete a legitimate line. Returns true
// only when the quoted text genuinely restricts to the wrong sex / age band OR
// the quote is long enough to be a real report line (the validator saw the same
// snapshot, so we trust an explicit demographic-mismatch flag on a study line).
export const findingIsDemographicMismatch = (quote, patient = {}) => {
  const t = String(quote || '').trim();
  if (t.length < 8) return false;
  const sex = normalizePatientSex(patient?.gender ?? patient?.sex);
  const age = parsePatientAge(patient?.age);
  // A validator saying "demographic mismatch" is not enough to delete text:
  // independently verify an explicit mismatch against the supplied patient.
  return textOppositeSexOnly(t, sex) || textWrongAgeBand(t, age);
};
