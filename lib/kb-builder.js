// Grounded knowledge-base builder — shared by scripts/build-kb.mjs (offline)
// and the runtime dynamic-brain path (on-demand when a user searches a new
// condition). Every citation comes from real PubMed metadata; Claude only
// organizes papers by index. Perplexity supplies fresh pipeline hints.

import { DEFAULT_RESEARCH_MODEL } from './anthropic-models.js';
import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';

import pubmedHandler from './pubmed.js';
import perplexitySearchHandler from './perplexity-search.js';
import { asInternalReq } from './internal-call.js';

const EXTRACT_MODEL = DEFAULT_RESEARCH_MODEL;
const ANTHROPIC_TIMEOUT_MS = timeoutFor('anthropic', 120_000);

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
  const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
  }, { timeoutMs: ANTHROPIC_TIMEOUT_MS, provider: 'Anthropic KB extractor' });
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('extractor returned no JSON');
  return JSON.parse(m[0]);
};

// Tokens that indicate a model-authored identifier. The librarian extractor
// references papers ONLY by index — every DOI/PMID/URL has to come from real
// retrieved PubMed metadata (see EXTRACT_SYSTEM + the :185 grounding rule),
// never authored by the model into prose.
const AUTHORED_ID_RE = /(doi\.org|pubmed\.ncbi|ncbi\.nlm|https?:\/\/|www\.|\bPMID:?\s*\d|\b10\.\d{4,}\/\S+)/i;

// Strip a model-authored identifier out of a free-text field so it can never
// leak into a rendered summary, even when the build is graded validated:false.
const stripAuthoredIds = (s) =>
  String(s || '')
    .replace(/\(?\s*PMID:?\s*\d+\s*\)?/gi, '')
    .replace(/\(?\s*doi:?\s*10\.\d{4,}\/\S+\s*\)?/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

const buildRepairInstruction = (reasons) =>
  `\n\nYOUR PREVIOUS OUTPUT FAILED VALIDATION:\n${reasons.slice(0, 8).map((r) => `- ${r}`).join('\n')}\n` +
  'Return CORRECTED strict JSON only (no prose, no markdown fences). Reference papers ONLY by their numeric index from the PAPERS list above. NEVER write a DOI, PMID, or URL. Drop any excluded agent you cannot cite by a valid in-range ref.';

// Validate a parsed extractor object against the retrieved paper set.
// Returns { ok, reasons }. Gates the retry + the QA stamp (Pillar 2).
export function validateExtract(ex, papers) {
  const reasons = [];
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
    return { ok: false, reasons: ['extract is not a JSON object'] };
  }
  const n = Array.isArray(papers) ? papers.length : 0;
  const validRef = (r) => Number.isInteger(r) && r >= 0 && r < n;
  const arr = (v) => (Array.isArray(v) ? v : []);

  for (const key of ['pinnedItems', 'canonicalFacts', 'lifestyleRecommendations', 'redFlags', 'pipelineDrugs', 'excludedAgents']) {
    if (ex[key] != null && !Array.isArray(ex[key])) reasons.push(`${key} is not an array`);
  }

  const pinned = arr(ex.pinnedItems);
  if (!pinned.length) reasons.push('no pinnedItems');
  if (pinned.length && !pinned.some((p) => validRef(p?.ref))) {
    reasons.push('no pinnedItems ref resolves to a retrieved paper');
  }
  pinned.forEach((p, i) => {
    if (p?.ref != null && !validRef(p.ref)) reasons.push(`pinnedItems[${i}].ref ${p.ref} out of range`);
  });
  arr(ex.canonicalFacts).forEach((f, i) => arr(f?.refs).forEach((r) => {
    if (!validRef(r)) reasons.push(`canonicalFacts[${i}] ref ${r} out of range`);
  }));
  arr(ex.lifestyleRecommendations).forEach((l, i) => arr(l?.refs).forEach((r) => {
    if (!validRef(r)) reasons.push(`lifestyleRecommendations[${i}] ref ${r} out of range`);
  }));
  arr(ex.pipelineDrugs).forEach((d, i) => {
    if (d?.ref != null && d.ref !== '' && !validRef(d.ref)) reasons.push(`pipelineDrugs[${i}].ref ${d.ref} out of range`);
  });
  arr(ex.excludedAgents).forEach((x, i) => {
    if (!x?.name) reasons.push(`excludedAgents[${i}] missing name`);
    if (!x?.reason) reasons.push(`excludedAgents[${i}] missing reason`);
    if (!validRef(x?.ref)) reasons.push(`excludedAgents[${i}] ref does not resolve to a retrieved paper`);
  });

  const textFields = [
    ...pinned.map((p) => p?.summary),
    ...arr(ex.canonicalFacts).map((f) => f?.claim),
    ...arr(ex.lifestyleRecommendations).map((l) => l?.recommendation),
    ...arr(ex.redFlags),
    ...arr(ex.excludedAgents).map((x) => x?.reason),
    ...arr(ex.pipelineDrugs).flatMap((d) => [d?.mechanism, d?.sponsor, d?.status])
  ];
  if (textFields.some((t) => AUTHORED_ID_RE.test(String(t || '')))) {
    reasons.push('model authored a DOI/PMID/URL in a text field (must cite by ref only)');
  }

  return { ok: reasons.length === 0, reasons };
}

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

// Anti-contamination provenance (Pillar 3). A drug key is the normalized
// leading drug name — the stable identity we stamp on every drug-scoped item so
// a candidate's risks/sources can later be traced to the entity they belong to
// and a foreign drug's content can never be silently attributed to the wrong
// card. Matches drugBaseKey() in lib/report-polish.js so the build-time and
// render-time identities line up.
export const drugKeyFromName = (name) =>
  String(name || '')
    .replace(/\*/g, '')
    .replace(/\(.*?\)/g, ' ')
    .split(/[—–\-:|/]|\d/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();

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
      // Provenance tag: every KB item knows which condition build emitted it and
      // carries a stable provenance id (its own id). Threaded downstream so a
      // grounded row can be traced back to the source paper/condition it came
      // from — cross-condition/cross-drug contamination becomes detectable.
      conditionSlug: disease.slug,
      provenanceId: id,
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
    it.summary = stripAuthoredIds(pi.summary).slice(0, 400);
  });

  const canonicalFacts = (ex.canonicalFacts || []).map((f) => ({
    claim: String(f.claim || '').trim(),
    evidenceRefs: (f.refs || []).map(ensureItem).filter(Boolean)
  })).filter((f) => f.claim && f.evidenceRefs.length);

  const lifestyleRecommendations = (ex.lifestyleRecommendations || []).map((l) => ({
    recommendation: String(l.recommendation || '').trim(),
    evidenceRefs: (l.refs || []).map(ensureItem).filter(Boolean)
  })).filter((l) => l.recommendation);

  const redFlags = (ex.redFlags || []).map((r) => stripAuthoredIds(r)).filter(Boolean);

  const pipelineDrugs = (ex.pipelineDrugs || []).map((d) => ({
    name: String(d.name || '').trim(),
    drugKey: drugKeyFromName(d.name),
    conditionSlug: disease.slug,
    aliases: Array.isArray(d.aliases) ? d.aliases.filter(Boolean) : [],
    mechanism: d.mechanism || '',
    sponsor: d.sponsor || '',
    status: d.status || '',
    approvalStatus: d.approvalStatus === 'approved' ? 'approved' : 'investigational',
    evidenceRef: validRef(d.ref) ? ensureItem(d.ref) : ''
  })).filter((d) => d.name);

  const excludedAgents = (ex.excludedAgents || []).map((x) => ({
    name: String(x.name || '').trim(),
    drugKey: drugKeyFromName(x.name),
    conditionSlug: disease.slug,
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

  const user = buildExtractUser(disease, papers, webHints);

  // Extract → validate → retry ONCE → graceful fallback. A malformed or
  // unvalidated extract no longer crashes the whole build; we assemble what
  // structurally validates and stamp QA so the store/verifier knows the build
  // was not fully validated (Pillar 2).
  let ex = null;
  let validation = { ok: false, reasons: ['extract not attempted'] };
  let retried = false;
  try {
    ex = await callExtract(user);
    validation = validateExtract(ex, papers);
  } catch (e) {
    validation = { ok: false, reasons: [`extract error: ${e?.message || e}`] };
  }
  if (!validation.ok) {
    retried = true;
    try {
      const ex2 = await callExtract(user + buildRepairInstruction(validation.reasons));
      const v2 = validateExtract(ex2, papers);
      if (v2.ok || !ex) { ex = ex2; validation = v2; }
    } catch (e) {
      if (!ex) throw new Error(`extractor failed twice: ${e?.message || e}`);
    }
  }
  if (!ex) throw new Error('extractor returned no usable JSON');

  const kb = assembleKbFromExtract(disease, papers, ex);
  kb.qa = {
    schemaVersion: 1,
    validated: validation.ok,
    ...(validation.ok ? {} : { reason: validation.reasons.slice(0, 5).join('; ') }),
    retried,
    refsResolved: kb.items.length > 0,
    pinnedCount: kb.items.length,
    excludedAgentsCount: kb.excludedAgents.length,
    negativePaperCount: papers.filter((p) => p._neg).length,
    validatedAt: new Date().toISOString()
  };
  return kb;
}
