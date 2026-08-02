// A second, independent search for agents that have been STUDIED for a
// condition but are not approved for it.
//
// Curated references and the trial registry alone cannot fill this section for
// most conditions. For idiopathic pulmonary fibrosis and ALS the curated
// landmark trials are trials OF THE APPROVED DRUGS (pirfenidone, nintedanib,
// edaravone), which are correctly skipped, leaving the section empty. A live
// web search finds the agents that were actually studied and did not reach
// approval — which is exactly what this section is for.
//
// Fails open in every failure mode: no key, timeout, bad JSON, or a provider
// error all return [], because a missing extra source must never take down a
// report.

import { safeErrorMessage } from './privacy-redaction.js';
import { fetchWithTimeout } from './fetch-timeout.js';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const TIMEOUT_MS = Number(process.env.PERPLEXITY_SEARCH_TIMEOUT_MS || 15_000);

const SYSTEM = 'You are a biomedical scout with live web access. You return STRICT JSON only — no prose, no markdown fences.';

const buildUser = (condition, exclude) => {
  const excludeLine = exclude?.length
    ? `\n\nAlready covered — do NOT return these: ${exclude.slice(0, 20).join(', ')}.`
    : '';
  return `Condition: ${condition}.

List drugs, supplements and other agents that have been STUDIED for this condition — in humans, animals, or the laboratory — but are NOT FDA-approved for it.

Include:
- repurposed medications approved for a DIFFERENT condition and then trialled in this one
- over-the-counter supplements and vitamins with a study in this condition
- agents whose trial for this condition FAILED or was negative (a negative result is still research, and is useful to the reader)

Exclude:
- anything already FDA-approved to treat this condition
- novel pipeline programmes identified only by a sponsor code (for example ABC-123), gene therapies and cell therapies${excludeLine}

Return a STRICT JSON array of at most 12 objects, each:
{"name": string (the agent, in the plain wording a patient would use), "url": string (a real resolvable URL to the study), "year": number, "evidence": one of "rct"|"observational"|"preclinical"|"case-report", "finding": string (one factual sentence on what the study found, including if it found no benefit)}

Rules:
- Only include an agent if you can cite a real URL for a study of it IN THIS CONDITION.
- Prefer PubMed, journal or ClinicalTrials.gov links.
- No duplicates. Output ONLY the JSON array.`;
};

const parseJsonArray = (text) => {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const EVIDENCE_TIER = {
  rct: 'SMALL_RCT',
  observational: 'OBSERVATIONAL',
  preclinical: 'PRECLINICAL',
  'case-report': 'CASE_REPORT'
};

/**
 * Returns seeds in the same shape as the curated and trial-derived ones, so
 * they merge straight into the researched-agent block.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const attemptSearch = async ({ condition, exclude, signal }) => {
  const key = process.env.PERPLEXITY_API_KEY;
  try {
    const response = await fetchWithTimeout(PPLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.PERPLEXITY_MODEL || 'sonar',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildUser(String(condition), exclude) }
        ],
        // Deliberately not 0: this is a discovery pass, and repeating the same
        // dozen agents on every run is the failure mode it exists to avoid.
        temperature: 0.4,
        max_tokens: 1600,
        return_citations: true
      }),
      signal
    }, { timeoutMs: TIMEOUT_MS, provider: 'Perplexity researched-agent search' });

    if (!response.ok) {
      console.warn(`[researched-agent-search] provider returned ${response.status}; continuing without it`);
      return [];
    }
    const data = await response.json();
    const items = parseJsonArray(data?.choices?.[0]?.message?.content) || [];
    return items
      .filter((item) => item && item.name && /^https?:\/\//i.test(String(item.url || '')))
      .map((item) => ({
        name: String(item.name).slice(0, 60).trim(),
        url: String(item.url).trim(),
        year: Number(item.year) || null,
        category: 'web',
        strength: EVIDENCE_TIER[String(item.evidence || '').toLowerCase()] || 'PRECLINICAL',
        title: String(item.finding || '').slice(0, 150),
        summary: String(item.finding || '').slice(0, 150)
      }));
  } catch (error) {
    console.warn('[researched-agent-search] attempt failed:', safeErrorMessage(error));
    return [];
  }
};

/**
 * The provider is intermittently flaky: identical calls returned 0 agents for
 * Duchenne muscular dystrophy and bipolar disorder one minute and 12 the next.
 * Failing open is right — a report must never depend on this — but a single
 * hiccup emptied the whole researched section, so a transient miss is retried
 * a couple of times before we accept the empty answer.
 */
export const searchResearchedAgents = async ({ condition, exclude = [], signal = null } = {}) => {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key || !String(condition || '').trim()) return [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await attemptSearch({ condition, exclude, signal });
    if (found.length) return found;
    if (attempt < 2) {
      console.warn(`[researched-agent-search] empty result, retrying (${attempt + 1}/2)`);
      await sleep(700 * (attempt + 1));
    }
  }
  return [];
};

const MECHANISTIC_SYSTEM = 'You are a translational pharmacologist with live web access. You return STRICT JSON only — no prose, no markdown fences.';

const buildMechanisticUser = (condition, exclude) => {
  const excludeLine = exclude?.length
    ? `\n\nAlready covered — do NOT return any of these: ${exclude.slice(0, 30).join(', ')}.`
    : '';
  return `Condition: ${condition}.

Suggest drugs and supplements that are NOT known to have been studied in this condition, but that a thoughtful clinician-scientist would consider plausible for it based on its specific biology.

Reason from THIS condition's mechanism — the cell type, pathway or process that actually goes wrong in it — and name agents whose known action engages that mechanism. Generic anti-inflammatories and generic vitamins that would apply to any disease are NOT useful answers.

Every agent must:
- already be approved or widely available for some OTHER condition
- have a plausible, stated mechanistic link to THIS condition's biology
- have NO published study in this condition (if it has been studied here, leave it out)${excludeLine}

Return a STRICT JSON array of at most 12 objects, each:
{"name": string (plain wording a patient would use), "mechanism": string (one sentence: the specific pathway in THIS condition the agent engages), "usualUse": string (what it is normally prescribed or taken for), "url": string (a real resolvable URL supporting the MECHANISM or the agent's usual use)}

Rules:
- Do not invent a study in this condition. The link supports the mechanism or the other-condition use, never a claim of benefit here.
- No duplicates. Output ONLY the JSON array.`;
};

const attemptMechanisticSearch = async ({ condition, exclude, signal }) => {
  const key = process.env.PERPLEXITY_API_KEY;
  try {
    const response = await fetchWithTimeout(PPLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.PERPLEXITY_MODEL || 'sonar',
        messages: [
          { role: 'system', content: MECHANISTIC_SYSTEM },
          { role: 'user', content: buildMechanisticUser(String(condition), exclude) }
        ],
        // Higher than the researched pass: this is the speculative half, and
        // the failure mode it exists to fix is returning the same six drugs
        // for every disease.
        temperature: 0.7,
        max_tokens: 1600,
        return_citations: true
      }),
      signal
    }, { timeoutMs: TIMEOUT_MS, provider: 'Perplexity mechanistic search' });
    if (!response.ok) {
      console.warn(`[mechanistic-search] provider returned ${response.status}; continuing without it`);
      return [];
    }
    const data = await response.json();
    const items = parseJsonArray(data?.choices?.[0]?.message?.content) || [];
    return items
      .filter((item) => item && item.name && item.mechanism)
      .map((item) => ({
        name: String(item.name).slice(0, 60).trim(),
        mechanism: String(item.mechanism).slice(0, 200).trim(),
        usualUse: String(item.usualUse || '').slice(0, 120).trim(),
        url: /^https?:\/\//i.test(String(item.url || '')) ? String(item.url).trim() : ''
      }));
  } catch (error) {
    console.warn('[mechanistic-search] attempt failed:', safeErrorMessage(error));
    return [];
  }
};

/**
 * The speculative half of the list. Without this the lanes drew from a static
 * drug registry at temperature 0 and returned the same agents regardless of
 * disease: mycophenolate, axatilimab, pexidartinib, spironolactone,
 * candesartan and sildenafil made up two thirds of the list for retinitis
 * pigmentosa, pulmonary fibrosis AND Huntington's alike. Reasoning from the
 * condition's own biology is the whole value of this section.
 */
export const searchMechanisticAgents = async ({ condition, exclude = [], signal = null } = {}) => {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key || !String(condition || '').trim()) return [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await attemptMechanisticSearch({ condition, exclude, signal });
    if (found.length) return found;
    if (attempt < 2) await sleep(700 * (attempt + 1));
  }
  return [];
};
