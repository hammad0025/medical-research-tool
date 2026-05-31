// Vercel Serverless Function for NCBI PubMed E-utilities.
//
// Returns a list of PubMed articles for a condition + optional treatment keyword.
// Each item includes PMID, title, authors, journal, year, abstract, and a direct
// clickable URL. This gives the UI real references to back any AI-generated
// recommendation — directly countering the most damaging failure mode of AI
// in medical research: citing papers that don't actually support the claim.
//
// No API key needed; NCBI recommends including a `tool` and `email` parameter,
// which we set below. For higher rate limits you can add NCBI_API_KEY env var.

import { requireAccess } from './access-gate.js';

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const TOOL = 'medical-research-assistant';
const EMAIL = 'shaque025@gmail.com';

const withAuth = (params) => {
  params.set('tool', TOOL);
  params.set('email', EMAIL);
  const key = process.env.NCBI_API_KEY;
  if (key) params.set('api_key', key);
  return params;
};

// Map loose affiliation strings to 2-letter ISO country codes. PubMed puts the
// country free-text at the end of each affiliation. We only try common forms
// we actually see in biomedical lit; anything unrecognised returns null and
// the downstream scorer treats it as unknown (no geographic penalty either way).
const COUNTRY_ALIASES = [
  // China & neighbours — explicit so we can penalise
  [/\b(P\.?\s?R\.?\s?China|People'?s Republic of China|\bChina\b|PRC\b)/i, 'CN'],
  [/\bHong Kong\b/i, 'HK'],
  [/\bTaiwan\b/i, 'TW'],
  [/\bSouth Korea\b|\bRepublic of Korea\b|\bKorea\b/i, 'KR'],
  [/\bJapan\b/i, 'JP'],
  [/\b(India|Bengaluru|Mumbai|Delhi|Chennai|Kolkata)\b/i, 'IN'],
  [/\b(Vietnam|Viet Nam)\b/i, 'VN'],
  [/\b(Russia|Russian Federation|Moscow|St\.?\s?Petersburg)\b/i, 'RU'],
  [/\bIran\b/i, 'IR'],
  [/\bPakistan\b/i, 'PK'],
  [/\bTurkey\b|\bT[üu]rkiye\b/i, 'TR'],
  [/\bMexico\b/i, 'MX'],
  [/\bBrazil\b|\bBrasil\b/i, 'BR'],
  [/\bSaudi Arabia\b/i, 'SA'],
  [/\bEgypt\b/i, 'EG'],
  // Western research centres — bonus
  [/\b(USA|United States|U\.S\.A?\.?|U\.S\.|America)\b/i, 'US'],
  [/\b(United Kingdom|U\.K\.?|England|Scotland|Wales|Northern Ireland|Britain)\b/i, 'GB'],
  [/\bGermany\b|\bDeutschland\b/i, 'DE'],
  [/\bFrance\b/i, 'FR'],
  [/\bNetherlands\b|\bHolland\b/i, 'NL'],
  [/\bSweden\b/i, 'SE'],
  [/\bSwitzerland\b/i, 'CH'],
  [/\bDenmark\b/i, 'DK'],
  [/\bNorway\b/i, 'NO'],
  [/\bFinland\b/i, 'FI'],
  [/\bIreland\b/i, 'IE'],
  [/\bBelgium\b/i, 'BE'],
  [/\bAustria\b/i, 'AT'],
  [/\bItaly\b/i, 'IT'],
  [/\bSpain\b|\bEspa[ñn]a\b/i, 'ES'],
  [/\bPortugal\b/i, 'PT'],
  [/\bGreece\b/i, 'GR'],
  [/\bPoland\b/i, 'PL'],
  [/\bCzech Republic\b|\bCzechia\b/i, 'CZ'],
  [/\bAustralia\b/i, 'AU'],
  [/\bNew Zealand\b/i, 'NZ'],
  [/\bCanada\b/i, 'CA'],
  [/\bIsrael\b/i, 'IL'],
  [/\bSingapore\b/i, 'SG']
];
const guessCountry = (text) => {
  if (!text) return null;
  for (const [re, code] of COUNTRY_ALIASES) if (re.test(text)) return code;
  return null;
};

// Parse one <PubmedArticle> XML block and pull:
//   - abstract (already working)
//   - publication types (RCT? Meta-analysis? Retracted?)
//   - author affiliations and best-guess institutional countries
//   - retraction flags (critical — a retracted paper must NEVER reach Claude)
const parsePubmedArticleXml = (block) => {
  const out = {};

  const absMatches = block.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
  if (absMatches) {
    out.abstract = absMatches
      .map((chunk) => chunk.replace(/<[^>]+>/g, ''))
      .join('\n\n')
      .trim();
  }

  // Publication types — PubMed uses these exact strings:
  //   "Retracted Publication"    = the original paper, later retracted (EXCLUDE)
  //   "Retraction of Publication" = the retraction notice itself (EXCLUDE)
  //   "Published Erratum"         = correction; usually fine but flag
  //   "Randomized Controlled Trial" / "Meta-Analysis" / "Systematic Review" = bonus
  const pubTypes = [];
  const ptList = block.match(/<PublicationTypeList>([\s\S]*?)<\/PublicationTypeList>/);
  if (ptList) {
    const pt = ptList[1].match(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g) || [];
    pt.forEach((tag) => pubTypes.push(tag.replace(/<[^>]+>/g, '').trim()));
  }
  out.publicationTypes = pubTypes;
  out.isRetracted =
    pubTypes.some((t) => /^Retracted Publication$/i.test(t)) ||
    // Fallback: PubMed flags retractions with <CommentsCorrectionsRefType="RetractionIn">
    /RefType="RetractionIn"/i.test(block);
  out.isRetractionNotice = pubTypes.some((t) => /^Retraction of Publication$/i.test(t));
  out.isErratum = pubTypes.some((t) => /^(Published )?Erratum$/i.test(t));
  out.isRCT = pubTypes.some((t) => /randomized controlled trial/i.test(t));
  out.isMetaAnalysis = pubTypes.some((t) => /meta[- ]analysis/i.test(t));
  out.isSystematicReview = pubTypes.some((t) => /systematic review/i.test(t));
  out.isPreprint = pubTypes.some((t) => /preprint/i.test(t));

  // Affiliations — PubMed wraps each author's affiliation in <AffiliationInfo>.
  // First-author country is the best single signal; we also collect the full
  // unique-country list because Chinese co-authorship on an otherwise-US paper
  // doesn't automatically make it suspect.
  const affBlocks = block.match(/<Affiliation>([^<]+)<\/Affiliation>/g) || [];
  const affiliations = affBlocks.map((m) => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  const countries = [...new Set(affiliations.map(guessCountry).filter(Boolean))];
  out.affiliations = affiliations.slice(0, 10);
  out.firstAuthorCountry = affiliations.length ? guessCountry(affiliations[0]) : null;
  out.countries = countries;

  return out;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Content-Type, X-Access-Passcode'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAccess(req, res)) return;

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const { query, limit = 10, sort = 'relevance', withAbstract = true } = body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }

    // Step 1: esearch for PMIDs
    const searchParams = withAuth(new URLSearchParams({
      db: 'pubmed',
      term: String(query),
      retmax: String(Math.min(Number(limit) || 10, 40)),
      retmode: 'json',
      sort
    }));
    const searchRes = await fetch(`${ESEARCH}?${searchParams.toString()}`);
    if (!searchRes.ok) {
      const text = await searchRes.text();
      return res.status(searchRes.status).json({ error: 'PubMed esearch failed', body: text.slice(0, 500) });
    }
    const searchJson = await searchRes.json();
    const pmids = searchJson?.esearchresult?.idlist || [];
    if (pmids.length === 0) {
      return res.status(200).json({ query, count: 0, articles: [] });
    }

    // Step 2: esummary for metadata
    const summaryParams = withAuth(new URLSearchParams({
      db: 'pubmed',
      id: pmids.join(','),
      retmode: 'json'
    }));
    const summaryRes = await fetch(`${ESUMMARY}?${summaryParams.toString()}`);
    if (!summaryRes.ok) {
      const text = await summaryRes.text();
      return res.status(summaryRes.status).json({ error: 'PubMed esummary failed', body: text.slice(0, 500) });
    }
    const summaryJson = await summaryRes.json();
    const result = summaryJson?.result || {};

    // Step 3: efetch is where the quality signals live — publication type,
    // author affiliations, retraction flags, erratum links. We call it by
    // default now (was opt-in) because the scoring layer depends on it.
    const enrichByPmid = {};
    if (withAbstract !== false) {
      const fetchParams = withAuth(new URLSearchParams({
        db: 'pubmed',
        id: pmids.join(','),
        rettype: 'abstract',
        retmode: 'xml'
      }));
      const fetchRes = await fetch(`${EFETCH}?${fetchParams.toString()}`);
      if (fetchRes.ok) {
        const xml = await fetchRes.text();
        const articleBlocks = xml.split(/<PubmedArticle[>\s]/).slice(1);
        articleBlocks.forEach(block => {
          const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
          if (!pmidMatch) return;
          enrichByPmid[pmidMatch[1]] = parsePubmedArticleXml(block);
        });
      }
    }

    const articles = pmids.map(pmid => {
      const r = result[pmid] || {};
      const authors = (r.authors || []).map(a => a.name).slice(0, 8);
      const doi = (r.articleids || []).find(x => x.idtype === 'doi')?.value;
      const enrich = enrichByPmid[pmid] || {};
      // esummary also returns a pubtype array; merge it with the XML one.
      const summaryPubTypes = Array.isArray(r.pubtype) ? r.pubtype : [];
      const publicationTypes = [...new Set([...(enrich.publicationTypes || []), ...summaryPubTypes])];
      return {
        pmid,
        title: r.title,
        journal: r.fulljournalname || r.source,
        pubDate: r.pubdate,
        year: r.pubdate ? String(r.pubdate).slice(0, 4) : null,
        authors,
        authorLine: authors.length
          ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ', et al.' : '')
          : '',
        doi,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        doiUrl: doi ? `https://doi.org/${doi}` : null,
        abstract: enrich.abstract || '',
        // Quality signals
        publicationTypes,
        isRetracted: !!enrich.isRetracted,
        isRetractionNotice: !!enrich.isRetractionNotice,
        isErratum: !!enrich.isErratum,
        isRCT: !!enrich.isRCT ||
          summaryPubTypes.some((t) => /randomized controlled trial/i.test(t)),
        isMetaAnalysis: !!enrich.isMetaAnalysis ||
          summaryPubTypes.some((t) => /meta-analysis/i.test(t)),
        isSystematicReview: !!enrich.isSystematicReview ||
          summaryPubTypes.some((t) => /systematic review/i.test(t)),
        isPreprint: !!enrich.isPreprint,
        affiliations: enrich.affiliations || [],
        firstAuthorCountry: enrich.firstAuthorCountry || null,
        countries: enrich.countries || []
      };
    });

    return res.status(200).json({ query, count: articles.length, articles });
  } catch (error) {
    console.error('pubmed.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
