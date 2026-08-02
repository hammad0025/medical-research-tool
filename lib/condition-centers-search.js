// Centres, clinicians and advocacy organisations for conditions whose curated
// file has none.
//
// An audit of the 61 curated conditions found centres, experts and advocacy
// present for only 11. The other 50 — breast cancer, chronic kidney disease,
// COPD, asthma, ADHD among them — rendered those sections empty, because the
// renderer can only render data that exists.
//
// These are named real-world institutions and named clinicians, so the bar is
// higher than for a drug idea: every entry must carry a resolvable URL, and
// anything without one is dropped rather than shown. Fails open in every error
// path — a report never depends on this.

import { safeErrorMessage } from './privacy-redaction.js';
import { fetchWithTimeout } from './fetch-timeout.js';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const TIMEOUT_MS = Number(process.env.PERPLEXITY_SEARCH_TIMEOUT_MS || 15_000);

const SYSTEM = 'You are a medical referral researcher with live web access. You return STRICT JSON only — no prose, no markdown fences.';

const buildUser = (condition) => `Condition: ${condition}.

Identify academic medical centres and clinician-researchers recognised for treating and studying this condition, plus the patient advocacy organisations for it.

For centres, prefer institutions with a named programme, centre of excellence, or referral clinic for THIS condition. For clinicians, prefer people who lead trials or publish on it. For advocacy, prefer the established patient organisations and registries.

Return STRICT JSON:
{
 "centers": [{"name": string, "city": string, "country": string, "why": string (one sentence on their specific work in THIS condition), "url": string}],
 "experts": [{"name": string, "affiliation": string, "why": string (one sentence on their specific work in THIS condition), "url": string}],
 "advocacy": [{"name": string, "why": string (one sentence), "url": string}]
}

Rules:
- At most 8 centres, 8 experts, 5 advocacy organisations.
- Every entry MUST have a real, resolvable URL. Omit any entry you cannot link.
- Name real institutions and real people only. Never invent a name, a title or an affiliation.
- This is not a ranking and not a referral; "why" states what they work on, nothing more.
- Output ONLY the JSON object.`;

const parseJsonObject = (text) => {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const clean = (value, max = 160) => String(value || '').replace(/[|\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const linked = (entry) => entry && entry.name && /^https?:\/\//i.test(String(entry.url || ''));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const attempt = async ({ condition, signal }) => {
  const key = process.env.PERPLEXITY_API_KEY;
  try {
    const response = await fetchWithTimeout(PPLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.PERPLEXITY_MODEL || 'sonar',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildUser(String(condition)) }
        ],
        // Low: these are real institutions and real people, and invention here
        // is far more damaging than a repetitive list.
        temperature: 0.1,
        max_tokens: 2000,
        return_citations: true
      }),
      signal
    }, { timeoutMs: TIMEOUT_MS, provider: 'Perplexity centres search' });

    if (!response.ok) {
      console.warn(`[condition-centers-search] provider returned ${response.status}; continuing without it`);
      return null;
    }
    const parsed = parseJsonObject((await response.json())?.choices?.[0]?.message?.content);
    if (!parsed) return null;
    return {
      topCenters: (parsed.centers || []).filter(linked).slice(0, 8).map((c) => ({
        name: clean(c.name, 90),
        city: clean(c.city, 60),
        country: clean(c.country, 40),
        why: clean(c.why),
        url: String(c.url).trim()
      })),
      keyInvestigators: (parsed.experts || []).filter(linked).slice(0, 8).map((e) => ({
        name: clean(e.name, 70),
        affiliation: clean(e.affiliation, 90),
        why: clean(e.why),
        url: String(e.url).trim()
      })),
      patientAdvocacy: (parsed.advocacy || []).filter(linked).slice(0, 5).map((a) => ({
        name: clean(a.name, 90),
        why: clean(a.why),
        url: String(a.url).trim()
      }))
    };
  } catch (error) {
    console.warn('[condition-centers-search] attempt failed:', safeErrorMessage(error));
    return null;
  }
};

/** Returns null when nothing usable was found, so callers keep curated data. */
export const searchConditionCenters = async ({ condition, signal = null } = {}) => {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key || !String(condition || '').trim()) return null;
  for (let i = 0; i < 3; i += 1) {
    const found = await attempt({ condition, signal });
    if (found && (found.topCenters.length || found.keyInvestigators.length || found.patientAdvocacy.length)) {
      return found;
    }
    if (i < 2) await sleep(700 * (i + 1));
  }
  return null;
};
