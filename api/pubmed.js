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

const parseAbstractXml = (xml) => {
  const out = {};
  const match = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
  if (match) {
    out.abstract = match
      .map(chunk => chunk.replace(/<[^>]+>/g, ''))
      .join('\n\n')
      .trim();
  }
  return out;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Content-Type'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    // Step 3 (optional): efetch for abstracts
    let abstractsByPmid = {};
    if (withAbstract) {
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
          const pmid = pmidMatch[1];
          abstractsByPmid[pmid] = parseAbstractXml(block).abstract || '';
        });
      }
    }

    const articles = pmids.map(pmid => {
      const r = result[pmid] || {};
      const authors = (r.authors || []).map(a => a.name).slice(0, 8);
      const doi = (r.articleids || []).find(x => x.idtype === 'doi')?.value;
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
        abstract: abstractsByPmid[pmid] || ''
      };
    });

    return res.status(200).json({ query, count: articles.length, articles });
  } catch (error) {
    console.error('pubmed.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
