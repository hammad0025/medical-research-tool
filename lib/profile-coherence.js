// Block obvious condition/sex mismatches before gather — fail loud, no AI
// disclaimer. This is a soft data-entry reconcile nudge ("update the condition
// or the sex"), never a hard medical judgment about the patient.

const norm = (s) => String(s || '').trim().toLowerCase();

const MALE_BREAST_RE = /\bmale[\s-]*breast\b/i;
const FEMALE_BREAST_RE = /\bfemale[\s-]*breast\b/i;

// Conditions anatomically specific to one sex. Breast is intentionally EXCLUDED
// (both sexes develop breast cancer — handled by the male/female-breast
// qualifiers above). "cervical" is matched ONLY in a cervix-cancer context so a
// cervical SPINE / neck condition never trips it.
const FEMALE_SPECIFIC_RE =
  /\bovar(?:y|ian)\b|\bcervix\b|\bcervical (?:cancer|carcinoma|dysplasia|intraepithelial)\b|\buter(?:us|ine)\b|\bendometri(?:al|osis|um)\b|\bvulvar?\b|\bvaginal\b|\bfallopian\b|\bpre[-\s]?eclampsia\b|\beclampsia\b|\bpcos\b|\bpolycystic ovar/i;
const MALE_SPECIFIC_RE =
  /\bprostat(?:e|ic)\b|\btesticular\b|\btest(?:is|es)\b|\bepididym|\bpenile\b|\bseminal vesicle\b/i;

// The sex a condition is anatomically specific to, or null. Male markers are
// checked first; the two sets do not overlap.
const conditionSex = (text) => {
  const t = norm(text);
  if (!t) return null;
  if (MALE_BREAST_RE.test(t) || MALE_SPECIFIC_RE.test(t)) return 'male';
  if (FEMALE_BREAST_RE.test(t) || FEMALE_SPECIFIC_RE.test(t)) return 'female';
  return null;
};

// Mismatch descriptor when a sex-specific condition contradicts the profile sex.
const sexConditionMismatch = (conditionText, gender) => {
  const g = norm(gender);
  const diseaseSex = conditionSex(conditionText);
  if (!diseaseSex || !g) return null;
  if (diseaseSex === 'male' && g === 'female') return { diseaseSex: 'male', profileSex: 'Female' };
  if (diseaseSex === 'female' && g === 'male') return { diseaseSex: 'female', profileSex: 'Male' };
  return null;
};

export const checkProfileCoherence = (patient = {}) => {
  const condition = String(patient.condition || '').trim();
  const gender = norm(patient.gender);
  if (!condition || !gender) return { ok: true };

  const mismatch = sexConditionMismatch(condition, gender);
  if (mismatch) {
    return {
      ok: false,
      code: 'PROFILE_INCOHERENT',
      message:
        `The condition "${condition}" is typically ${mismatch.diseaseSex}-specific, but the profile sex ` +
        `is ${mismatch.profileSex}. Update the condition or the sex, then run again.`
    };
  }

  return { ok: true };
};

/** Dossier canonical vs patient sex — catches stale pools on synthesize. */
export const checkDossierProfileCoherence = (patient = {}, dossier = null, evidence = null) => {
  const profileCheck = checkProfileCoherence(patient);
  if (!profileCheck.ok) return profileCheck;

  const canonical = String(dossier?.canonical || evidence?.condition || '');
  const gender = norm(patient.gender);
  if (!canonical || !gender) return { ok: true };

  // profileCheck already passed, so the patient's own condition is coherent with
  // their sex; a sex mismatch on the DOSSIER canonical therefore means the
  // gathered research grounded on the wrong-sex disease (stale/contaminated pool).
  const mismatch = sexConditionMismatch(canonical, gender);
  if (mismatch) {
    return {
      ok: false,
      code: 'GATHER_STALE',
      message:
        `Research data does not match this profile (${mismatch.diseaseSex}-specific vs ` +
        `${mismatch.profileSex}). Re-gathering.`
    };
  }

  return { ok: true };
};
