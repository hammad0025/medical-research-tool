// "Has this agent actually been studied in this condition?"
//
// The no-study section already filters against the condition's trial list and
// its literature pack, but both are samples. A Parkinson report fetches ~103 of
// the registry's several thousand PD studies, so exenatide -- which has a
// Lancet Phase 2 and a completed Phase 3 in Parkinson disease -- was absent
// from all 185 interventions those studies named, and landed in the bucket that
// tells the reader no condition-specific study was found. So did nilotinib,
// ambroxol, nicotine, caffeine and rivastigmine.
//
// Asking the registry about the specific agent is exact where a sample is not,
// and it costs one small HTTP request per candidate with no model call.

import { fetchWithTimeout } from './fetch-timeout.js';

const CT_API = 'https://clinicaltrials.gov/api/v2/studies';
const TIMEOUT_MS = Number(process.env.MRT_STUDIED_CHECK_TIMEOUT_MS || 8000);

/**
 * True when the registry lists at least one study of `agent` in `condition`.
 * Returns false on any error: this gate only ever REMOVES a candidate from the
 * no-study section, so failing open leaves the previous behaviour rather than
 * silently emptying the section.
 */
export const agentStudiedInCondition = async (condition, agent, { signal } = {}) => {
  const cond = String(condition || '').trim();
  const name = String(agent || '').replace(/\([^)]*\)/g, ' ').trim();
  if (!cond || name.length < 4) return false;
  const url = `${CT_API}?query.cond=${encodeURIComponent(cond)}`
    + `&query.intr=${encodeURIComponent(name)}`
    + '&countTotal=true&pageSize=1&fields=NCTId';
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' }, signal },
      { timeoutMs: TIMEOUT_MS, provider: 'ClinicalTrials.gov studied-check' });
    if (!response.ok) return false;
    const data = await response.json();
    return Number(data?.totalCount || 0) > 0;
  } catch {
    return false;
  }
};

/**
 * The subset of `agents` the registry has studied in this condition.
 * Runs the checks concurrently -- these are independent lookups and doing them
 * in series would add seconds to a report that already takes minutes.
 */
export const agentsStudiedInCondition = async (condition, agents = [], { signal } = {}) => {
  const names = [...new Set((agents || []).map((a) => String(a || '').trim()).filter(Boolean))];
  if (!names.length) return new Set();
  const results = await Promise.all(
    names.map(async (name) => [name, await agentStudiedInCondition(condition, name, { signal })])
  );
  return new Set(results.filter(([, studied]) => studied).map(([name]) => name.toLowerCase()));
};
