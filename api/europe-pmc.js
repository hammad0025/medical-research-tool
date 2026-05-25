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

import { requireAccess } from '../lib/access-gate.js';

const SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const FULLTEXT = (id) =>
  `https://www.ebi.ac.uk/europepmc/webservices/rest/${id}/fullTextXML`;

const stripXml = (xml) =>
  String(xml || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Passcode');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAccess(req, res)) return;

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const { query, limit = 10, includeFullText = false } = body || {};
    if (!query || !String(query).trim())
      return res.status(400).json({ error: 'query is required' });

    const sp = new URLSearchParams({
      query: String(query),
      resultType: 'core',
      format: 'json',
      pageSize: String(Math.min(Number(limit) || 10, 25))
    });

    const r = await fetch(`${SEARCH}?${sp.toString()}`, {
      headers: { 'User-Agent': 'medical-research-assistant/1.0' }
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Europe PMC search failed', body: t.slice(0, 500) });
    }
    const data = await r.json();
    const results = data?.resultList?.result || [];

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
        fullText: null
      };
    });

    if (includeFullText) {
      const candidates = articles.filter((a) => a.inPMC && a.pmcid).slice(0, 3);
      await Promise.all(
        candidates.map(async (a) => {
          try {
            const ft = await fetch(FULLTEXT(a.pmcid), {
              headers: { 'User-Agent': 'medical-research-assistant/1.0' }
            });
            if (!ft.ok) return;
            const xml = await ft.text();
            a.fullText = stripXml(xml).slice(0, 25000);
          } catch {}
        })
      );
    }

    return res.status(200).json({ query, count: articles.length, articles });
  } catch (e) {
    console.error('europe-pmc.js', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
