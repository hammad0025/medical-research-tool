// Europe PMC search endpoint.
//
// Europe PMC indexes PubMed, preprint servers (bioRxiv, medRxiv), and patents,
// and crucially exposes open-access FULL TEXT for articles in PMC. This lets
// us answer the question "does the AI actually read the whole article, or
// just the abstract?" honestly — for open-access articles we return the full
// body text for grounded context; for paywalled ones we stay at abstract
// level and tag it so the AI cannot overreach.
//
// API docs: https://europepmc.org/RestfulWebService

import { requireAccess } from './access-gate.js';
import { parseExplicitBoolean, parsePageSize } from './normalize.js';
import { fetchWithTimeout, isTimeoutError, timeoutFor } from './fetch-timeout.js';
import { setSameOriginCors } from './cors.js';
import { logError } from './privacy-redaction.js';

const SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const FULLTEXT = (id) =>
  `https://www.ebi.ac.uk/europepmc/webservices/rest/${id}/fullTextXML`;
const EUROPE_PMC_TIMEOUT_MS = timeoutFor('europe_pmc', 12_000);

export const stripXml = (xml) =>
  String(xml || '')
    .replace(/<xref\b[^>]*>([\s\S]*?)<\/xref>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(parseInt(value, 10)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

export const isValidArticleXml = (xml) => {
  const text = String(xml || '').trim();
  return /^<\?xml\b[\s\S]*?<article\b/i.test(text) || /^<article\b/i.test(text);
};

export const europePmcRecordIsRetracted = (record = {}) => {
  const types = Array.isArray(record.pubTypeList?.pubType)
    ? record.pubTypeList.pubType
    : [record.pubTypeList?.pubType].filter(Boolean);
  return record.isRetracted === 'Y' ||
    record.isRetracted === true ||
    record.retracted === 'Y' ||
    types.some((type) => /\bretract(?:ed|ion)\b/i.test(String(type)));
};

export default async function handler(req, res) {
  if (!setSameOriginCors(req, res, {
    methods: 'POST,GET,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAccess(req, res)) return;

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const { query, limit = 10, includeFullText: includeFullTextRaw = false } = body || {};
    const includeFullText = parseExplicitBoolean(includeFullTextRaw, false);
    if (!query || !String(query).trim())
      return res.status(400).json({ error: 'query is required' });

    const sp = new URLSearchParams({
      query: String(query),
      resultType: 'core',
      format: 'json',
      pageSize: String(parsePageSize(limit, { fallback: 10, max: 25 }))
    });

    const r = await fetchWithTimeout(`${SEARCH}?${sp.toString()}`, {
      headers: { 'User-Agent': 'medical-research-assistant/1.0' },
      signal: req.signal
    }, {
      timeoutMs: EUROPE_PMC_TIMEOUT_MS,
      provider: 'Europe PMC search'
    });
    if (!r.ok) {
      await r.text().catch(() => '');
      return res.status(r.status).json({
        error: 'The literature search service is temporarily unavailable.',
        code: 'LITERATURE_SEARCH_UNAVAILABLE'
      });
    }
    const data = await r.json();
    const results = (data?.resultList?.result || []).filter((record) => !europePmcRecordIsRetracted(record));

    const articles = results.map((a) => {
      const pmid = a.pmid;
      const pmcid = a.pmcid;
      const doi = a.doi;
      const isOA = a.isOpenAccess === 'Y';
      const inPMC = a.inPMC === 'Y';
      return {
        source: 'Europe PMC',
        id: a.id,
        pmid,
        pmcid,
        doi,
        title: a.title,
        journal: a.journalTitle || a.journalInfo?.journal?.title || a.bookTitle,
        year: a.pubYear,
        authors: (a.authorString || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8),
        pubType: a.pubTypeList?.pubType,
        isOpenAccess: isOA,
        inPMC,
        abstract: a.abstractText || '',
        citedByCount: a.citedByCount,
        pubmedUrl: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
        europePmcUrl: a.id ? `https://europepmc.org/article/${a.source}/${a.id}` : null,
        pmcUrl: pmcid ? `https://europepmc.org/article/PMC/${pmcid}` : null,
        doiUrl: doi ? `https://doi.org/${doi}` : null,
        fullText: null,
        fullTextStatus: 'not-requested',
        retractionStatus: 'checked'
      };
    });

    if (includeFullText) {
      const candidates = articles.filter((a) => a.inPMC && a.pmcid).slice(0, 3);
      await Promise.all(
        candidates.map(async (a) => {
          try {
            const ft = await fetchWithTimeout(FULLTEXT(a.pmcid), {
              headers: { 'User-Agent': 'medical-research-assistant/1.0' },
              signal: req.signal
            }, {
              timeoutMs: EUROPE_PMC_TIMEOUT_MS,
              provider: 'Europe PMC full text'
            });
            if (!ft.ok) {
              a.fullTextStatus = 'unavailable';
              return;
            }
            const xml = await ft.text();
            if (!isValidArticleXml(xml)) {
              a.fullTextStatus = 'invalid-xml';
              return;
            }
            a.fullText = stripXml(xml).slice(0, 25000);
            a.fullTextStatus = a.fullText ? 'available' : 'invalid-xml';
          } catch (error) {
            a.fullTextStatus = isTimeoutError(error) ? 'timeout' : 'unavailable';
          }
        })
      );
    }

    return res.status(200).json({ query, count: articles.length, articles });
  } catch (e) {
    logError('[europe-pmc] request failed', e);
    return res.status(isTimeoutError(e) ? 504 : 500).json({
      error: isTimeoutError(e)
        ? 'The literature search took too long. Please try again.'
        : 'The literature search service is temporarily unavailable.',
      code: isTimeoutError(e) ? 'LITERATURE_SEARCH_TIMEOUT' : 'LITERATURE_SEARCH_UNAVAILABLE',
      ...(isTimeoutError(e) ? { degraded: true, timeout: true } : {})
    });
  }
}
