// Grounded knowledge-base builder — shared by scripts/build-kb.mjs (offline)
// and the runtime dynamic-brain path (on-demand when a user searches a new
// condition). Every citation comes from real PubMed metadata; Claude only
// organizes papers by index. Perplexity supplies fresh pipeline hints.

import pubmedHandler from './pubmed.js';
import perplexitySearchHandler from './perplexity-search.js';
import { asInternalReq } from './internal-call.js';

const EXTRACT_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-4-20250514';

export const slugFromCondition = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const invokeHandler = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(c) { captured.status = c; return this; },
    end() {},
    json(o) { captured.body = o; return this; }
  };
  await handler(asInternalReq({ method: 'POST', body, headers: {}, query: {} }), res);
  return captured;
};

const pubmed = async (query, limit = 10) => {
  const res = await invokeHandler(pubmedHandler, {
    query,
    limit,
    withAbstract: true,
    sort: 'relevance'
  });
  return res.status === 200 ? (res.body?.articles || []) : [];
};

const perplexityHints = async (condition) => {
  if (!process.env.PERPLEXITY_API_KEY) return [];
  const res = await invokeHandler(perplexitySearchHandler, { condition, drugs: [] });
  return res.status === 200 ? (res.body?.articles || []) : [];
};

const EXTRACT_SYSTEM = `You are a medical librarian building a curated knowledge base for ONE disease. You are given a numbered list of REAL papers already retrieved from PubMed. Your job is to ORGANIZE them — never to add new sources.

STRICT RULES:
- Reference papers ONLY by their number (e.g. "ref": 3). NEVER write a DOI, PMID, or URL yourself.
- EXCLUDED AGENTS = drugs/treatments TESTED for THIS disease that FAILED — randomized trial, cohort, or meta-analysis found no efficacy, missed primary endpoint, withdrawn/discontinued, or net harm. Cite the paper by ref.
  * Do NOT exclude effective guideline drugs over a single case-report side effect.
  * Do NOT list uncertain/mixed results as failures.
  * HUMANS ONLY — ignore animal studies.
  * If no paper supports a genuine failure, return an empty list.
- PIPELINE DRUGS = approved or late-stage investigational drugs patients might ask about. Use WEB HINTS below only to know what to look for in the numbered papers — still cite papers by ref when possible.
- Summaries: one factual sentence each. Output STRICT JSON only — no prose, no markdown fences.`;

const buildExtractUser = (disease, papers, webHints = []) => {
  const paperLines = papers.map((p, i) =>
    `[${i}] (${p.year || '?'}) ${p.title || '(no title)'} — ${p.journal || '?'}${p.isRCT ? ' [RCT]' : ''}${p.isMetaAnalysis ? ' [META]' : ''}${p._neg ? ' [NEGATIVE-SEARCH]' : ''}\n    ${(p.abstract || '').slice(0, 650)}`
  ).join('\n');
  const webBlock = webHints.length
    ? `\n\nRECENT WEB HINTS (pipeline discovery only — cite numbered papers by ref, not these URLs directly):\n${webHints.map((w) => `- ${w.title}: ${(w.abstract || '').replace(/^Web-search finding: /, '')}`).join('\n')}`
    : '';
  return `DISEASE: ${disease.condition} (also: ${(disease.aliases || []).join(', ')})

PAPERS (cite by number only):
${paperLines || '(none)'}${webBlock}

Return JSON:
{
  "pinnedItems": [{ "ref": <#>, "category": "clinical-guideline|rct|negative-trial|review|fda-label|expert-consensus", "tier": "A+|A|B|C", "summary": "one factual sentence" }],
  "canonicalFacts": [{ "claim": "...", "refs": [<#>, ...] }],
  "lifestyleRecommendations": [{ "recommendation": "...", "refs": [<#>, ...] }],
  "redFlags": ["short safety warning", ...],
  "pipelineDrugs": [{ "name": "...", "aliases": ["..."], "mechanism": "...", "sponsor": "...", "status": "...", "approvalStatus": "approved|investigational", "ref": <# or null> }],
  "excludedAgents": [{ "name": "...", "reason": "plain-words why it failed", "ref": <#> }]
}
Pin 6-12 important papers.`;
};

const callExtract = async (user) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      temperature: 0,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: user }]
    })
  });
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('extractor returned no JSON');
  return JSON.parse(m[0]);
};

export async function gatherPubMedPapers(condition, { mode = 'fast' } = {}) {
  const c = condition;
  const positiveQueries = mode === 'full'
    ? [
        `${c} treatment`,
        `${c} clinical practice guideline`,
        `${c} randomized controlled trial`,
        `${c} systematic review meta-analysis`
      ]
    : [`${c} treatment`, `${c} systematic review`];
  const negativeQueries = mode === 'full'
    ? [
        `${c} "did not meet" primary endpoint randomized`,
        `${c} "no significant difference" placebo randomized trial`,
        `${c} drug withdrawn OR discontinued OR terminated lack of efficacy`,
        `${c} increased mortality OR harm randomized trial`,
        `${c} ineffective OR "no benefit" treatment trial`
      ]
    : [
        `${c} no benefit randomized trial`,
        `${c} withdrawn discontinued lack of efficacy`
      ];
  const limit = mode === 'full' ? 12 : 8;
  const maxPapers = mode === 'full' ? 36 : 24;
  const gapMs = mode === 'full' ? 700 : 400;

  const byPmid = new Map();
  const run = async (q, neg) => {
    const arts = await pubmed(q, limit);
    for (const a of arts) {
      if (!a.pmid || a.isRetracted) continue;
      if (byPmid.has(a.pmid)) {
        if (neg) byPmid.get(a.pmid)._neg = true;
        continue;
      }
      a._neg = !!neg;
      byPmid.set(a.pmid, a);
    }
    await sleep(gapMs);
  };

  await Promise.all([
    (async () => { for (const q of positiveQueries) await run(q, false); })(),
    (async () => { for (const q of negativeQueries) await run(q, true); })()
  ]);

  const all = [...byPmid.values()];
  const negs = all.filter((p) => p._neg);
  const pos = all.filter((p) => !p._neg);
  return [...negs, ...pos].slice(0, maxPapers);
}

export function assembleKbFromExtract(disease, papers, ex) {
  const validRef = (n) => Number.isInteger(n) && n >= 0 && n < papers.length;
  const items = [];
  const refToId = new Map();

  const itemFromPaper = (idx) => {
    const p = papers[idx];
    const id = `${disease.slug}-${items.length + 1}`;
    refToId.set(idx, id);
    items.push({
      id,
      category: 'review',
      tier: 'B',
      title: p.title || '(no title)',
      authors: p.authors || '',
      journal: p.journal || '',
      year: p.year || null,
      doi: p.doi || '',
      pmid: p.pmid || '',
      url: p.url || (p.doi ? `https://doi.org/${p.doi}` : (p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : '')),
      accessLevel: p.abstract ? 'abstract' : 'metadata-only',
      summary: '',
      keyPassages: []
    });
    return id;
  };

  const ensureItem = (idx) => (validRef(idx) ? (refToId.get(idx) || itemFromPaper(idx)) : null);

  (ex.pinnedItems || []).forEach((pi) => {
    if (!validRef(pi.ref) || refToId.has(pi.ref)) return;
    const id = itemFromPaper(pi.ref);
    const it = items.find((x) => x.id === id);
    it.category = pi.category || 'review';
    it.tier = pi.tier || 'B';
    it.summary = String(pi.summary || '').slice(0, 400);
  });

  const canonicalFacts = (ex.canonicalFacts || []).map((f) => ({
    claim: String(f.claim || '').trim(),
    evidenceRefs: (f.refs || []).map(ensureItem).filter(Boolean)
  })).filter((f) => f.claim && f.evidenceRefs.length);

  const lifestyleRecommendations = (ex.lifestyleRecommendations || []).map((l) => ({
    recommendation: String(l.recommendation || '').trim(),
    evidenceRefs: (l.refs || []).map(ensureItem).filter(Boolean)
  })).filter((l) => l.recommendation);

  const redFlags = (ex.redFlags || []).map((r) => String(r).trim()).filter(Boolean);

  const pipelineDrugs = (ex.pipelineDrugs || []).map((d) => ({
    name: String(d.name || '').trim(),
    aliases: Array.isArray(d.aliases) ? d.aliases.filter(Boolean) : [],
    mechanism: d.mechanism || '',
    sponsor: d.sponsor || '',
    status: d.status || '',
    approvalStatus: d.approvalStatus === 'approved' ? 'approved' : 'investigational',
    evidenceRef: validRef(d.ref) ? ensureItem(d.ref) : ''
  })).filter((d) => d.name);

  const excludedAgents = (ex.excludedAgents || []).map((x) => ({
    name: String(x.name || '').trim(),
    reason: String(x.reason || '').trim(),
    evidenceRef: validRef(x.ref) ? ensureItem(x.ref) : null
  })).filter((x) => x.name && x.reason && x.evidenceRef);

  return {
    condition: disease.condition,
    slug: disease.slug,
    aliases: disease.aliases || [],
    version: new Date().toISOString().slice(0, 7),
    curatedBy: 'dynamic-brain (PubMed + Perplexity + Claude)',
    generatedBy: 'lib/kb-builder.js',
    reviewed: false,
    lastUpdated: new Date().toISOString().slice(0, 10),
    dynamicBuiltAt: new Date().toISOString(),
    source: 'dynamic-brain',
    subspecialty: disease.subspecialty || '',
    meshTerms: disease.meshTerms || [],
    literatureSearchSeeds: [
      ...pipelineDrugs.map((d) => d.name),
      ...excludedAgents.map((x) => x.name)
    ].filter(Boolean).slice(0, 25),
    items,
    canonicalFacts,
    lifestyleRecommendations,
    redFlags,
    pipelineDrugs,
    excludedAgents
  };
}

export async function buildKnowledgeBase({
  condition,
  slug,
  aliases = [],
  dossier = null,
  mode = 'fast'
}) {
  const disease = {
    condition: String(condition || '').trim(),
    slug: slug || slugFromCondition(condition),
    aliases: [...new Set([...(aliases || []), ...(dossier?.synonyms || [])].filter(Boolean))],
    subspecialty: dossier?.subspecialty || '',
    meshTerms: dossier?.meshTerms || []
  };
  if (!disease.condition) throw new Error('condition required');

  const [papers, webHints] = await Promise.all([
    gatherPubMedPapers(disease.condition, { mode }),
    perplexityHints(disease.condition)
  ]);
  if (!papers.length) throw new Error('no PubMed papers retrieved');

  const ex = await callExtract(buildExtractUser(disease, papers, webHints));
  return assembleKbFromExtract(disease, papers, ex);
}
