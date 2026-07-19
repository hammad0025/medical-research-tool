const cleanToken = (value, fallback = '') => {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, 120) : fallback;
};

export const normalizeTrialProviderErrors = (errors) => {
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((error) => error && typeof error === 'object')
    .map((error) => ({
      provider: cleanToken(error.provider, 'ClinicalTrials.gov'),
      ...(cleanToken(error.query) ? { query: cleanToken(error.query) } : {}),
      reason: cleanToken(error.reason, 'unavailable')
    }));
};

export const normalizeTrialCoverage = (trials = {}) => {
  const providerErrors = normalizeTrialProviderErrors(trials?.providerErrors);
  const cancelled = trials?.cancelled === true ||
    trials?.status === 'cancelled' ||
    providerErrors.some((error) => error.reason === 'cancelled');
  const degraded = trials?.degraded === true || providerErrors.length > 0;
  return {
    status: cancelled ? 'cancelled' : degraded ? 'degraded' : 'complete',
    cancelled,
    degraded,
    providerErrors
  };
};

export const trialCoverageMessage = (trials = {}) => {
  const coverage = normalizeTrialCoverage(trials);
  if (coverage.cancelled) {
    return 'Trial search was cancelled before completion. The studies shown may be incomplete; run the search again before relying on this list.';
  }
  if (!coverage.degraded) return '';
  return 'Trial coverage is incomplete because one or more ClinicalTrials.gov searches were unavailable. The studies shown may not include every matching option; confirm current availability with the study team or your clinician.';
};

export const trialCollectionDescription = (trials = {}) => {
  const studies = Array.isArray(trials?.studies) ? trials.studies : [];
  const available = studies.filter(
    (study) => study?.acceptingNewPatients === true ||
      String(study?.status || study?.overallStatus || '').toUpperCase() === 'AVAILABLE'
  ).length;
  if (!studies.length) return 'ClinicalTrials.gov search results.';
  if (available === studies.length) return 'ClinicalTrials.gov studies; each row shows its current recruitment or access status.';
  return `ClinicalTrials.gov studies with mixed recruitment and access status (${available} of ${studies.length} currently accepting or available).`;
};
