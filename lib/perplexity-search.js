// Perplexity live-web freshness layer for the evidence pack.
//
// The core pipeline (PubMed / Europe PMC / OpenAlex / Cochrane / openFDA) is
// authoritative but lags: brand-new approvals, just-published negative trials,
// and guideline updates can take days/weeks to surface and rank in those APIs.
// Perplexity's `sonar` model has built-in live web search, so we use it as a
// FRESHNESS SCOUT: it returns the most recent decision-relevant studies and
// regulatory actions for the condition (and any named drugs), which we fold
// into the evidence pack as additional, clearly-labeled items.
//
// IMPORTANT — these are NOT treated as peer-reviewed gospel:
//   - every item is tagged `isWebSearch: true` and gets a score penalty so it
//     never outranks an equivalent peer-reviewed paper,
//   - the synthesis prompt labels them "[WEB SOURCE — recent, verify]" so
//     Claude flags them as leads to confirm, not authoritative citations,
//   - we still require a real URL for every item.
//
// Fails open: no PERPLEXITY_API_KEY → returns []; any error/timeout → returns
// [] so the pipeline behaves exactly as before.

import { safeErrorMessage } from './privacy-redaction.js';
import { fetchWithTimeout } from './fetch-timeout.js';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const TIMEOUT_MS = Number(process.env.PERPLEXITY_SEARCH_TIMEOUT_MS || 12_000);

const SYSTEM = `You are a biomedical literature scout with live web access. You find the most recent, decision-relevant peer-reviewed studies, regulatory approvals, and guideline updates for a medical condition. You return STRICT JSON only — no prose, no markdown fences.`;

const buildUser = (condition, drugs) => {
  const drugLine = drugs && drugs.length
    ? ` Pay special attention to these named drugs/agents and surface any human studies (including negative or null results) for them: ${drugs.join(', ')}.`
    : '';
  return `Condition: ${condition}.${drugLine}

Find the most recent and most decision-relevant items for this condition. Prioritise 2024-2026. Include regulatory approvals (FDA/EMA), pivotal trial readouts, systematic reviews, and important negative/safety findings.

Return a STRICT JSON array of at most 8 objects, each:
{"title": string, "year": number, "sourceName": string (journal or organisation), "url": string (a real, resolvable URL), "type": one of "rct"|"meta-analysis"|"systematic-review"|"observational"|"guideline"|"approval"|"review"|"news", "finding": string (one sentence, factual)}

Rules:
- Only include an item if you can cite a real URL for it.
- Prefer primary sources (journal articles, FDA pages, ClinicalTrials.gov) over secondary news.
- No duplicates. No commentary. Output ONLY the JSON array.`;
};

const extractJsonArray = (text) => {
  if (!text) return null;
  // Strip code fences if present.
  const cleaned = String(text).replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
};

// Pull a DOI or PMID out of a citation URL so web items dedupe-merge with the
// peer-reviewed copy when the same paper also came back from PubMed/EPMC. When
// they merge, the peer-reviewed metadata wins (longer abstract, real flags).
const identifiersFromUrl = (url = '') => {
  const out = { doi: null, pmid: null };
  const doiMatch = url.match(/(10\.\d{4,9}\/[^\s?#]+)/i);
  if (doiMatch) out.doi = doiMatch[1].replace(/[).,;]+$/, '');
  const pmMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{6,9})/i);
  if (pmMatch) out.pmid = pmMatch[1];
  return out;
};

const mapType = (type = '') => {
  const t = String(type).toLowerCase();
  return {
    isRCT: t === 'rct',
    isMetaAnalysis: t === 'meta-analysis',
    isSystematicReview: t === 'systematic-review',
  };
};

// Default-export a handler matching the invoke(handler, body) interface used
// by evidence.js, returning { articles } just like the other source handlers.
export default async function handler(req, res) {
  const respond = (articles) => res.status(200).json({ articles });
  try {
    const key = process.env.PERPLEXITY_API_KEY;
    if (!key) return respond([]);

    const { condition, drugs = [] } = req.body || {};
    if (!condition || !String(condition).trim()) return respond([]);

    const body = {
      model: process.env.PERPLEXITY_MODEL || 'sonar',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(String(condition), drugs.slice(0, 6)) },
      ],
      temperature: 0.1,
      max_tokens: 1400,
      return_citations: true,
    };

    const r = await fetchWithTimeout(PPLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: req.signal
    }, {
      timeoutMs: TIMEOUT_MS,
      provider: 'Perplexity freshness search'
    });
    if (!r.ok) {
      console.warn(`[perplexity-search] provider request failed with status ${r.status}; response body suppressed`);
      return respond([]);
    }
    const data = await r.json();

    const text = data?.choices?.[0]?.message?.content || '';
    const items = extractJsonArray(text) || [];

    const articles = items
      .filter((it) => it && it.title && it.url && /^https?:\/\//i.test(it.url))
      .slice(0, 8)
      .map((it) => {
        const { doi, pmid } = identifiersFromUrl(it.url);
        const flags = mapType(it.type);
        const yearNum = parseInt(it.year, 10);
        return {
          id: doi || (pmid ? `pmid:${pmid}` : it.url),
          source: 'PerplexityWeb',
          isWebSearch: true,
          webType: it.type || null,
          title: String(it.title).slice(0, 300),
          journal: it.sourceName || 'Web source',
          year: Number.isFinite(yearNum) ? String(yearNum) : null,
          doi,
          pmid,
          url: it.url,
          doiUrl: doi ? `https://doi.org/${doi}` : null,
          pubmedUrl: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
          // The one-sentence finding is the only content we have; mark it as
          // abstract-level so Claude may quote it but knows it is a summary.
          abstract: it.finding ? `Web-search finding: ${it.finding}` : '',
          accessLevel: it.finding ? 'abstract' : 'metadata-only',
          ...flags,
        };
      });

    return respond(articles);
  } catch (err) {
    console.warn('[perplexity-search] failed:', safeErrorMessage(err));
    return res.status(200).json({ articles: [] });
  }
}
