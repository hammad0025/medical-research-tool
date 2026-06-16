// Block obvious condition/gender mismatches before gather — fail loud, no AI disclaimer.

const norm = (s) => String(s || '').trim().toLowerCase();

const MALE_BREAST_RE = /\bmale[\s-]*breast\b/i;
const FEMALE_BREAST_RE = /\bfemale[\s-]*breast\b/i;

export const checkProfileCoherence = (patient = {}) => {
  const condition = String(patient.condition || '').trim();
  const gender = norm(patient.gender);
  if (!condition || !gender) return { ok: true };

  const condLower = condition.toLowerCase();
  const isMaleBreastCond = MALE_BREAST_RE.test(condLower);
  const isFemaleBreastCond = FEMALE_BREAST_RE.test(condLower);

  if (isMaleBreastCond && gender === 'female') {
    return {
      ok: false,
      code: 'PROFILE_INCOHERENT',
      message:
        'Condition says male breast cancer but profile gender is Female. Update the condition or gender, then run again.'
    };
  }

  if (isFemaleBreastCond && gender === 'male') {
    return {
      ok: false,
      code: 'PROFILE_INCOHERENT',
      message:
        'Condition says female breast cancer but profile gender is Male. Update the condition or gender, then run again.'
    };
  }

  return { ok: true };
};

/** Dossier canonical vs patient sex tokens — catches stale pools on synthesize. */
export const checkDossierProfileCoherence = (patient = {}, dossier = null, evidence = null) => {
  const profileCheck = checkProfileCoherence(patient);
  if (!profileCheck.ok) return profileCheck;

  const canonical = String(dossier?.canonical || evidence?.condition || '').toLowerCase();
  const gender = norm(patient.gender);
  if (!canonical || !gender) return { ok: true };

  if (MALE_BREAST_RE.test(canonical) && gender === 'female') {
    const condSaysMale = MALE_BREAST_RE.test(String(patient.condition || '').toLowerCase());
    if (!condSaysMale) {
      return {
        ok: false,
        code: 'GATHER_STALE',
        message: 'Research data does not match this profile (male breast vs Female). Re-gathering.'
      };
    }
  }

  if (FEMALE_BREAST_RE.test(canonical) && gender === 'male') {
    const condSaysFemale = FEMALE_BREAST_RE.test(String(patient.condition || '').toLowerCase());
    if (!condSaysFemale) {
      return {
        ok: false,
        code: 'GATHER_STALE',
        message: 'Research data does not match this profile (female breast vs Male). Re-gathering.'
      };
    }
  }

  return { ok: true };
};
