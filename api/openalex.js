// OpenAlex search endpoint.
//
// OpenAlex is the closest free equivalent to Google Scholar: 250M+ scholarly
// works across every major publisher, with DOIs, open-access flags, citation
// counts, and institutional affiliations. This covers the long tail of
// reputable peer-reviewed journals that PubMed doesn't index.
//
// API docs: https://docs.openalex.org/

import { requireAccess } from '../lib/access-gate.js';

const API = 'https://api.openalex.org/works';

// Tier-A = top-quality peer-reviewed medical journals. We don't try to keep
// an impact-factor database in code — we just tag journals by recognised tier
// so the UI and AI layer can weight evidence by publication quality (impact
// factor, conflict-of-interest management, retraction policy stringency).
// OpenAlex distributes abstracts only as an inverted index
// ({ "word": [positions] }) — the publishers' licensing allows this form but
// not the raw string. Reconstructing is trivial and 100% legal.
const reconstructAbstract = (inv) => {
  if (!inv || typeof inv !== 'object') return '';
  const positions = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) positions[i] = word;
  }
  return positions.filter((w) => w != null).join(' ').trim();
};

const TIER = (name = '') => {
  const n = name.toLowerCase();
  if (/(new england journal of medicine|lancet|jama|bmj|nature medicine|nature$|cell$|science$|annals of internal medicine)/.test(n)) return 'A+';
  if (/(jama |lancet |nature |european respiratory journal|american journal of respiratory|thorax|chest|circulation|european heart journal|gut$|kidney international|blood$|diabetes care|cochrane)/.test(n)) return 'A';
  if (/(journal of |respir|pulmonology|clinical)/.test(n)) return 'B';
  return 'C';
};

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
    const {
      query, limit = 10, fromYear, onlyOA = false,
      perJournal = null
    } = body || {};
    if (!query || !String(query).trim())
      return res.status(400).json({ error: 'query is required' });

    // `abstract_inverted_index` is OpenAlex's legal distribution format for
    // abstracts — publishers allow redistribution of the inverted form but not
    // the raw abstract string. We reconstruct it below. This is the single
    // biggest lever for widening journal coverage beyond PubMed, because
    // OpenAlex indexes ~250M works across every publisher.
    const sp = new URLSearchParams({
      search: String(query),
      per_page: String(Math.min(Number(limit) || 10, 25)),
      // OpenAlex also gives us is_retracted + is_paratext; authorships include
      // institutions with country codes. We pull both for the quality-scoring
      // layer downstream.
      select: 'id,doi,title,publication_year,cited_by_count,type,open_access,primary_location,authorships,concepts,abstract_inverted_index,is_retracted,is_paratext'
    });
    const filters = [];
    if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
    if (onlyOA) filters.push('is_oa:true');
    if (perJournal) filters.push(`primary_location.source.display_name.search:${perJournal}`);
    if (filters.length) sp.set('filter', filters.join(','));
    sp.set('mailto', 'shaque025@gmail.com');

    const r = await fetch(`${API}?${sp.toString()}`);
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'OpenAlex failed', body: t.slice(0, 500) });
    }
    const data = await r.json();
    const works = data.results || [];

    const articles = works.map((w) => {
      const journal = w.primary_location?.source?.display_name || '';
      const publisher = w.primary_location?.source?.host_organization_name || '';
      const sourceType = w.primary_location?.source?.type || ''; // "journal" | "repository" | …
      const authorships = w.authorships || [];
      const authors = authorships.map((a) => a.author?.display_name).filter(Boolean).slice(0, 8);
      const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null;
      const abstract = reconstructAbstract(w.abstract_inverted_index);

      // Institutional country codes — 2-letter ISO. Empty when OpenAlex has
      // no affiliation data (common for older papers). First-author country
      // is the single best signal for "whose lab did this work."
      const institutions = [];
      const countrySet = new Set();
      for (const a of authorships) {
        for (const inst of (a.institutions || [])) {
          if (inst.country_code) countrySet.add(inst.country_code);
          if (inst.display_name) institutions.push({
            name: inst.display_name,
            country: inst.country_code || null
          });
        }
      }
      const firstAuthorCountry = authorships[0]?.institutions?.[0]?.country_code || null;

      return {
        source: 'OpenAlex',
        id: w.id,
        doi,
        title: w.title,
        journal,
        publisher,
        year: w.publication_year,
        type: w.type,
        sourceType,
        citedByCount: w.cited_by_count,
        authors,
        authorLine: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ', et al.' : ''),
        journalTier: TIER(journal),
        abstract,
        openAccess: w.open_access || null,
        oaUrl: w.open_access?.oa_url || null,
        doiUrl: doi ? `https://doi.org/${doi}` : null,
        landingUrl: w.primary_location?.landing_page_url || null,
        concepts: (w.concepts || []).filter((c) => c.score > 0.3).map((c) => c.display_name).slice(0, 6),
        // Quality signals — OpenAlex is the only upstream that ships
        // is_retracted directly, which is why we fold its flag into PubMed's
        // downstream too when de-duping.
        isRetracted: !!w.is_retracted,
        isParatext: !!w.is_paratext,
        isPreprint: sourceType === 'repository' || (w.type || '') === 'preprint',
        institutions: institutions.slice(0, 12),
        countries: [...countrySet],
        firstAuthorCountry
      };
    });

    return res.status(200).json({ query, count: articles.length, articles });
  } catch (e) {
    console.error('openalex.js', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
