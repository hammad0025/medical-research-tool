import { createGatherSeal, verifyGatherSeal } from './gather-seal.js';

const CT_API_ROOT = 'https://clinicaltrials.gov/api/v2/studies';
const TRIAL_REGISTRY_FINGERPRINT = 'clinical-trials-runtime-v1';

export const normalizeNctId = (value) => {
  const match = String(value || '').toUpperCase().match(/\bNCT\d{8}\b/);
  return match?.[0] || '';
};

export const nctIdFromUrl = (value) =>
  normalizeNctId(String(value || '').match(/clinicaltrials\.gov\/study\/(NCT\d{8})/i)?.[1]);

const normalize = (value) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const conditionTokens = (value) =>
  new Set(normalize(value).split(/\s+/).filter((word) => word.length >= 3));

const conditionMatches = (expectedNames, registryConditions) => {
  const expected = (expectedNames || []).map(normalize).filter(Boolean);
  const actual = (registryConditions || []).map(normalize).filter(Boolean);
  for (const name of expected) {
    if (name.length >= 2 && actual.some((condition) => condition.includes(name) || name.includes(condition))) {
      return true;
    }
  }
  for (const name of expected) {
    const compact = name.replace(/\s+/g, '');
    if (
      compact.length >= 2 &&
      compact.length <= 8 &&
      actual.some((condition) =>
        condition.split(/\s+/).filter(Boolean).map((word) => word[0]).join('') === compact
      )
    ) return true;
  }
  for (const name of expected) {
    const wanted = conditionTokens(name);
    for (const condition of actual) {
      const got = conditionTokens(condition);
      const overlap = [...wanted].filter((token) => got.has(token));
      if (wanted.size && overlap.length / wanted.size >= 0.6) return true;
    }
  }
  return false;
};

const phaseClaims = (value) => {
  const phases = new Set();
  const text = String(value || '');
  if (/\bearly\s+phase\s*1\b/i.test(text)) phases.add('EARLY_PHASE1');
  for (const match of text.matchAll(/(?<!early\s)\bphase\s*([1-4])(?:\s*[/–-]\s*([1-4]))?/gi)) {
    phases.add(`PHASE${match[1]}`);
    if (match[2]) phases.add(`PHASE${match[2]}`);
  }
  return phases;
};

const statusClaim = (value) => {
  const text = normalize(value);
  if (/\bno longer available\b/.test(text)) return new Set(['NO_LONGER_AVAILABLE']);
  if (/\bapproved for marketing\b/.test(text)) return new Set(['APPROVED_FOR_MARKETING']);
  if (/\bnot yet recruiting\b/.test(text)) return new Set(['NOT_YET_RECRUITING']);
  if (/\bactive not recruiting\b/.test(text)) return new Set(['ACTIVE_NOT_RECRUITING']);
  if (/\benrolling by invitation\b/.test(text)) return new Set(['ENROLLING_BY_INVITATION']);
  if (/\b(?:recruiting|enrolling|accepting patients)\b/.test(text)) {
    return new Set(['RECRUITING', 'ENROLLING_BY_INVITATION']);
  }
  if (/\bavailable\b/.test(text)) return new Set(['AVAILABLE']);
  if (/\bcompleted\b/.test(text)) return new Set(['COMPLETED']);
  if (/\bterminated\b/.test(text)) return new Set(['TERMINATED']);
  if (/\bwithdrawn\b/.test(text)) return new Set(['WITHDRAWN']);
  if (/\bsuspended\b/.test(text)) return new Set(['SUSPENDED']);
  return new Set();
};

export const registryFactsFromStudy = (study) => {
  const protocol = study?.protocolSection || {};
  const identification = protocol.identificationModule || {};
  const status = protocol.statusModule || {};
  const design = protocol.designModule || {};
  const conditions = protocol.conditionsModule || {};
  return {
    nctId: normalizeNctId(identification.nctId),
    title: identification.briefTitle || identification.officialTitle || '',
    status: String(status.overallStatus || '').toUpperCase(),
    phases: (design.phases || []).map((phase) => String(phase).toUpperCase()),
    conditions: conditions.conditions || [],
    studyType: String(design.studyType || '').toUpperCase()
  };
};

export const registryFactsFromStructuredTrial = (study) => ({
  nctId: normalizeNctId(study?.nctId),
  title: String(study?.briefTitle || study?.officialTitle || ''),
  status: String(study?.status || '').toUpperCase(),
  phases: (study?.phases || []).map((phase) => String(phase).toUpperCase()),
  conditions: study?.conditions || [],
  studyType: String(study?.studyType || '').toUpperCase()
});

export const validateTrialRecord = (record, facts) => {
  const issues = [];
  if (!record.nctId || !/^NCT\d{8}$/.test(record.nctId)) {
    return ['NCT_INVALID_FORMAT'];
  }
  if (!facts?.nctId) return ['NCT_NOT_FOUND'];
  if (facts.nctId !== record.nctId) issues.push('NCT_ID_MISMATCH');
  if (
    record.expectedConditions?.length &&
    !conditionMatches(record.expectedConditions, facts.conditions)
  ) issues.push('NCT_CONDITION_MISMATCH');
  const expectedPhases = phaseClaims(record.statusText);
  if (expectedPhases.size && ![...expectedPhases].every((phase) => facts.phases.includes(phase))) {
    issues.push('NCT_PHASE_MISMATCH');
  }
  const expectedStatuses = statusClaim(record.statusText);
  if (expectedStatuses.size && !expectedStatuses.has(facts.status)) {
    issues.push('NCT_STATUS_MISMATCH');
  }
  return issues;
};

const nctIdsInText = (value) =>
  [...new Set((String(value || '').toUpperCase().match(/\bNCT\d{8}\b/g) || []))];

const titleMatches = (claimed, authoritative) => {
  const expected = normalize(authoritative);
  const actual = normalize(claimed);
  return !actual || !expected || actual === expected;
};

const acceptingClaim = (value) => {
  const match = String(value || '').match(/^ACCEPTING:\s*(yes|no)\s*$/im);
  return match ? match[1].toLowerCase() === 'yes' : null;
};

const registryAccepting = (status) =>
  ['RECRUITING', 'ENROLLING_BY_INVITATION'].includes(String(status || '').toUpperCase());

const trialClaimIssues = (unit, factsByNct, expectedConditions) => {
  const ids = nctIdsInText(unit);
  if (!ids.length) return [];
  const issues = [];
  const urlIds = [...String(unit).matchAll(/clinicaltrials\.gov\/study\/(NCT\d{8})/gi)]
    .map((match) => match[1].toUpperCase());
  const declared = normalizeNctId(String(unit).match(/^NCT:\s*(NCT\d{8})\s*$/im)?.[1]);
  if (declared && urlIds.some((id) => id !== declared)) issues.push('NCT_URL_ID_MISMATCH');

  for (const nctId of ids) {
    const facts = factsByNct.get(nctId);
    issues.push(...validateTrialRecord({
      nctId,
      statusText: unit,
      expectedConditions
    }, facts));
    if (declared === nctId) {
      const title = String(unit).match(/^TRIAL:\s*(.+)$/im)?.[1]?.trim() || '';
      if (title && !titleMatches(title, facts?.title)) issues.push('NCT_TITLE_MISMATCH');
      const accepting = acceptingClaim(unit);
      if (accepting !== null && accepting !== registryAccepting(facts?.status)) {
        issues.push('NCT_STATUS_MISMATCH');
      }
    }
  }
  return [...new Set(issues)];
};

const isTrialBlockStart = (line) => /^TRIAL:\s*/i.test(line);
const isHeading = (line) => /^#{1,6}\s+/.test(line);

/**
 * Removes any patient-facing claim unit whose NCT, condition, phase, status,
 * title, URL identity, or accepting flag conflicts with the supplied
 * ClinicalTrials.gov structured studies. This is synchronous by design: the
 * trials API already fetched the authoritative records.
 */
export const enforceTrialRegistryNarrative = (
  text,
  trials,
  { expectedConditions = [] } = {}
) => {
  if (!text) return { text, removed: [], issues: [] };
  const factsByNct = new Map(
    (Array.isArray(trials?.studies) ? trials.studies : [])
      .map(registryFactsFromStructuredTrial)
      .filter((facts) => facts.nctId)
      .map((facts) => [facts.nctId, facts])
  );
  const lines = String(text).split('\n');
  const kept = [];
  const removed = [];
  const issues = [];

  for (let index = 0; index < lines.length;) {
    const start = index;
    let end = index + 1;
    if (isTrialBlockStart(lines[index])) {
      while (
        end < lines.length &&
        !isTrialBlockStart(lines[end]) &&
        !isHeading(lines[end]) &&
        lines[end].trim() !== ''
      ) end += 1;
    }
    const unit = lines.slice(start, end).join('\n');
    const unitIssues = trialClaimIssues(unit, factsByNct, expectedConditions);
    if (unitIssues.length) {
      removed.push(unit);
      issues.push(...unitIssues);
    } else {
      kept.push(...lines.slice(start, end));
    }
    index = end;
  }
  return {
    text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    removed,
    issues: [...new Set(issues)]
  };
};

const unsignedTrialPayload = (payload = {}) => ({
  query: {
    condition: String(payload?.query?.condition || '')
  },
  studies: (payload?.studies || []).map((study) => ({
    nctId: study?.nctId || '',
    briefTitle: study?.briefTitle || '',
    officialTitle: study?.officialTitle || '',
    status: study?.status || '',
    phases: study?.phases || [],
    conditions: study?.conditions || [],
    studyType: study?.studyType || '',
    acceptingNewPatients: study?.acceptingNewPatients === true,
    url: study?.url || ''
  }))
});

export const sealTrialRegistryPayload = (payload, { secret, now } = {}) =>
  createGatherSeal({
    gatherFingerprint: TRIAL_REGISTRY_FINGERPRINT,
    dossier: null,
    evidence: null,
    trials: unsignedTrialPayload(payload),
    secret,
    now
  });

export const verifyTrialRegistryPayload = (payload, { secret, now } = {}) =>
  verifyGatherSeal({
    seal: payload?.registrySeal,
    gatherFingerprint: TRIAL_REGISTRY_FINGERPRINT,
    dossier: null,
    evidence: null,
    trials: unsignedTrialPayload(payload),
    secret,
    now
  });

export const fetchTrialRegistryFacts = async (nctId, { fetchImpl = fetch } = {}) => {
  const normalized = normalizeNctId(nctId);
  if (!normalized) return null;
  const response = await fetchImpl(`${CT_API_ROOT}/${normalized}?format=json`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ClinicalTrials.gov request failed: HTTP ${response.status}`);
  return registryFactsFromStudy(await response.json());
};
