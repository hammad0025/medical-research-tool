// Stable gather fingerprint — ties dossier/evidence/trials pools to a specific
// patient identity so synthesize cannot reuse stale data after profile edits.

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const buildGatherFingerprint = ({
  condition = '',
  resolvedSlug = '',
  gender = '',
  stage = '',
  age = ''
} = {}) => {
  const parts = [
    norm(resolvedSlug || condition),
    norm(gender),
    norm(stage),
    norm(String(age))
  ].filter(Boolean);
  return parts.join('|') || 'unknown';
};

export const buildGatherFingerprintFromPatient = (patient = {}, resolution = null) =>
  buildGatherFingerprint({
    condition: patient.condition,
    resolvedSlug: resolution?.resolvedSlug || resolution?.kbSlug || resolution?.resolved,
    gender: patient.gender,
    stage: patient.stage,
    age: patient.age
  });

export const fingerprintsMatch = (a, b) =>
  !!a && !!b && String(a) === String(b);
