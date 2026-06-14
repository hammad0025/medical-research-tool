// Auto-generate curated knowledge-base files for common diseases, GROUNDED in
// real PubMed literature so we never introduce hallucinated citations.
//
// Lean + reliable by design: pulls real papers straight from PubMed (NCBI
// E-utilities, no key needed, very stable) with targeted queries that include
// negative-trial terms, then asks the LLM ONLY to (a) pick which real papers
// to pin and classify them and (b) extract canonical facts / lifestyle / red
// flags / pipeline drugs / EXCLUDED (studied-and-failed) agents — referencing
// papers by index. Every citation is rebuilt from the REAL PubMed metadata,
// so the model can never invent a DOI/PMID/URL. Every excluded agent must
// point to a real paper or it is dropped. Files are written reviewed:false.
//
// Usage:
//   node scripts/build-kb.mjs                       # all in kb-disease-list.json
//   node scripts/build-kb.mjs type-2-diabetes copd  # only these slugs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Only the Anthropic key is needed (PubMed needs none). Do NOT pull prod
// secrets — keeps the access gate out of the picture and the run reproducible.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch {}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EXTRACT_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-4-20250514';
if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env.local'); process.exit(1); }

const pubmedHandler = (await import('../lib/pubmed.js')).default;
const KB_DIR = path.join(ROOT, 'data', 'kb');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mockRes = () => ({ statusCode: 200, body: null, setHeader() {}, status(c){this.statusCode=c;return this;}, end(){}, json(o){this.body=o;return this;} });
const pubmed = async (query, limit = 12) => {
  const res = mockRes();
  await pubmedHandler({ method: 'POST', body: { query, limit, withAbstract: true, sort: 'relevance' }, headers: {}, query: {} }, res);
  return res.statusCode === 200 ? (res.body?.articles || []) : [];
};

const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb-disease-list.json'), 'utf8')).diseases;
const onlySlugs = process.argv.slice(2);
const targets = onlySlugs.length ? list.filter(d => onlySlugs.includes(d.slug)) : list;

const EXTRACT_SYSTEM = `You are a medical librarian building a curated knowledge base for ONE disease. You are given a numbered list of REAL papers already retrieved from PubMed. Your job is to ORGANIZE them — never to add new sources.

STRICT RULES:
- Reference papers ONLY by their number (e.g. "ref": 3). NEVER write a DOI, PMID, or URL yourself.
- EXCLUDED AGENTS = drugs/treatments that were TESTED for THIS disease and FAILED to work — i.e. a randomized trial, cohort study, or meta-analysis found no efficacy benefit, the drug missed its primary endpoint, it was withdrawn/discontinued for this disease, or it caused net harm/increased mortality in a trial. Point "ref" at that paper.
  * Do NOT list a drug just because a CASE REPORT describes a side effect. A guideline-recommended, effective drug that has a rare adverse event does NOT belong here (e.g. do not exclude a standard, working medication over one hepatitis case report).
  * Do NOT list "uncertain"/"mixed"/"more research needed" results as failures — only clear no-benefit / harm / withdrawal.
  * Base every exclusion on a trial/cohort/meta-analysis, not a single patient.
  * HUMANS ONLY. Ignore any study performed in animals (dogs/canine, cats/feline, mice, rats, murine, equine, porcine, bovine, zebrafish). A drug that failed in dogs does NOT belong here.
  * If no provided paper supports a genuine efficacy failure, return an empty list. This is safety-critical: do not guess.
- PIPELINE DRUGS = approved or late-stage investigational drugs for this disease a patient might ask about.
- Summaries: one factual sentence each. Output STRICT JSON only — no prose, no markdown fences.`;

const buildExtractUser = (disease, papers) => {
  const paperLines = papers.map((p, i) =>
    `[${i}] (${p.year || '?'}) ${p.title || '(no title)'} — ${p.journal || '?'}${p.isRCT ? ' [RCT]' : ''}${p.isMetaAnalysis ? ' [META]' : ''}${p.isSystematicReview ? ' [SR]' : ''}${p._neg ? ' [NEGATIVE-SEARCH]' : ''}\n    ${(p.abstract || '').slice(0, 650)}`
  ).join('\n');
  return `DISEASE: ${disease.condition} (also: ${(disease.aliases||[]).join(', ')})

PAPERS (cite by number only). Papers tagged [NEGATIVE-SEARCH] were retrieved specifically because they may report a treatment that did NOT work — mine them (and any other paper) for EXCLUDED AGENTS:
${paperLines || '(none)'}

For EXCLUDED AGENTS: read the abstracts carefully. A drug belongs here ONLY if a TRIAL, COHORT, or META-ANALYSIS shows it failed to improve outcomes, showed no significant difference vs placebo, missed its primary endpoint, was withdrawn/discontinued for this disease, or increased harm/mortality. Name the specific drug (not the class) and cite the exact paper. Do NOT exclude an effective/guideline-recommended drug just because a case report notes a side effect; do NOT exclude on "uncertain/mixed" results. Only include clear efficacy failures the abstracts actually support — never guess.

Return JSON with EXACTLY this shape:
{
  "pinnedItems": [{ "ref": <#>, "category": "clinical-guideline|rct|negative-trial|review|fda-label|expert-consensus", "tier": "A+|A|B|C", "summary": "one factual sentence" }],
  "canonicalFacts": [{ "claim": "...", "refs": [<#>, ...] }],
  "lifestyleRecommendations": [{ "recommendation": "...", "refs": [<#>, ...] }],
  "redFlags": ["short safety warning", ...],
  "pipelineDrugs": [{ "name": "...", "aliases": ["..."], "mechanism": "...", "sponsor": "...", "status": "...", "approvalStatus": "approved|investigational", "ref": <# or null> }],
  "excludedAgents": [{ "name": "...", "reason": "plain-words why it failed for this disease", "ref": <#> }]
}
Pin 6-15 of the most important papers. Be thorough on excludedAgents, but ONLY when a provided paper supports the failure.`;
};

const callExtract = async (user) => {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: EXTRACT_MODEL, max_tokens: 4000, temperature: 0, system: EXTRACT_SYSTEM, messages: [{ role: 'user', content: user }] })
  });
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('extractor returned no JSON');
  return JSON.parse(m[0]);
};

async function gatherPapers(disease) {
  const c = disease.condition;
  const positiveQueries = [
    `${c} treatment`,
    `${c} clinical practice guideline`,
    `${c} randomized controlled trial`,
    `${c} systematic review meta-analysis`
  ];
  // Queries aimed at surfacing studied-but-FAILED treatments so the curated
  // excludedAgents list (the metformin-style guardrail) has real papers to cite.
  const negativeQueries = [
    `${c} "did not meet" primary endpoint randomized`,
    `${c} "no significant difference" placebo randomized trial`,
    `${c} drug withdrawn OR discontinued OR terminated lack of efficacy`,
    `${c} increased mortality OR harm randomized trial`,
    `${c} ineffective OR "no benefit" treatment trial`
  ];
  const byPmid = new Map();
  const run = async (q, neg) => {
    const arts = await pubmed(q, neg ? 8 : 12);
    for (const a of arts) {
      if (!a.pmid || a.isRetracted) continue;
      if (byPmid.has(a.pmid)) { if (neg) byPmid.get(a.pmid)._neg = true; continue; }
      a._neg = !!neg;
      byPmid.set(a.pmid, a);
    }
    await sleep(700); // NCBI rate-limit politeness (no API key → 3 req/s cap)
  };
  for (const q of positiveQueries) await run(q, false);
  for (const q of negativeQueries) await run(q, true);
  // Keep negatives first so they survive the cap, then fill with positives.
  const all = [...byPmid.values()];
  const negs = all.filter(p => p._neg);
  const pos = all.filter(p => !p._neg);
  return [...negs, ...pos].slice(0, 36);
}

async function buildOne(disease) {
  process.stdout.write(`\n[${disease.slug}] pubmed… `);
  let papers;
  try { papers = await gatherPapers(disease); }
  catch (e) { console.log(`PUBMED FAILED: ${e.message}`); return { slug: disease.slug, ok: false, error: e.message }; }
  if (!papers.length) { console.log('no papers'); return { slug: disease.slug, ok: false, error: 'no papers' }; }
  process.stdout.write(`${papers.length} papers → extract… `);

  let ex;
  try { ex = await callExtract(buildExtractUser(disease, papers)); }
  catch (e) { console.log(`EXTRACT FAILED: ${e.message}`); return { slug: disease.slug, ok: false, error: e.message }; }

  const validRef = (n) => Number.isInteger(n) && n >= 0 && n < papers.length;
  const items = [];
  const refToId = new Map();
  const itemFromPaper = (idx) => {
    const p = papers[idx];
    const id = `${disease.slug}-${items.length + 1}`;
    refToId.set(idx, id);
    items.push({
      id, category: 'review', tier: 'B', title: p.title || '(no title)', authors: p.authors || '',
      journal: p.journal || '', year: p.year || null, doi: p.doi || '', pmid: p.pmid || '',
      url: p.url || (p.doi ? `https://doi.org/${p.doi}` : (p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : '')),
      accessLevel: p.abstract ? 'abstract' : 'metadata-only', summary: '', keyPassages: []
    });
    return id;
  };
  const ensureItem = (idx) => validRef(idx) ? (refToId.get(idx) || itemFromPaper(idx)) : null;

  (ex.pinnedItems || []).forEach((pi) => {
    if (!validRef(pi.ref) || refToId.has(pi.ref)) return;
    const id = itemFromPaper(pi.ref);
    const it = items.find(x => x.id === id);
    it.category = pi.category || 'review';
    it.tier = pi.tier || 'B';
    it.summary = String(pi.summary || '').slice(0, 400);
  });

  const canonicalFacts = (ex.canonicalFacts || []).map(f => ({
    claim: String(f.claim || '').trim(),
    evidenceRefs: (f.refs || []).map(ensureItem).filter(Boolean)
  })).filter(f => f.claim && f.evidenceRefs.length);

  const lifestyleRecommendations = (ex.lifestyleRecommendations || []).map(l => ({
    recommendation: String(l.recommendation || '').trim(),
    evidenceRefs: (l.refs || []).map(ensureItem).filter(Boolean)
  })).filter(l => l.recommendation);

  const redFlags = (ex.redFlags || []).map(r => String(r).trim()).filter(Boolean);

  const pipelineDrugs = (ex.pipelineDrugs || []).map(d => ({
    name: String(d.name || '').trim(),
    aliases: Array.isArray(d.aliases) ? d.aliases.filter(Boolean) : [],
    mechanism: d.mechanism || '', sponsor: d.sponsor || '', status: d.status || '',
    approvalStatus: d.approvalStatus === 'approved' ? 'approved' : 'investigational',
    evidenceRef: validRef(d.ref) ? ensureItem(d.ref) : ''
  })).filter(d => d.name);

  // SAFETY-CRITICAL: each excluded agent must cite a real retrieved paper.
  const excludedAgents = (ex.excludedAgents || []).map(x => ({
    name: String(x.name || '').trim(),
    reason: String(x.reason || '').trim(),
    evidenceRef: validRef(x.ref) ? ensureItem(x.ref) : null
  })).filter(x => x.name && x.reason && x.evidenceRef);

  const kb = {
    condition: disease.condition,
    slug: disease.slug,
    aliases: disease.aliases || [],
    version: new Date().toISOString().slice(0, 7),
    curatedBy: 'auto-grounded generator',
    generatedBy: 'build-kb.mjs (grounded in real PubMed literature)',
    reviewed: false,
    lastUpdated: new Date().toISOString().slice(0, 10),
    literatureSearchSeeds: [...pipelineDrugs.map(d => d.name), ...excludedAgents.map(x => x.name)].filter(Boolean).slice(0, 25),
    items,
    canonicalFacts,
    lifestyleRecommendations,
    redFlags,
    pipelineDrugs,
    excludedAgents
  };

  fs.writeFileSync(path.join(KB_DIR, `${disease.slug}.json`), JSON.stringify(kb, null, 2));
  console.log(`OK items=${items.length} facts=${canonicalFacts.length} pipeline=${pipelineDrugs.length} excluded=${excludedAgents.length}`);
  return { slug: disease.slug, ok: true, items: items.length, excluded: excludedAgents.length };
}

const results = [];
for (const d of targets) {
  try { results.push(await buildOne(d)); }
  catch (e) { console.log(`\n[${d.slug}] ERROR ${e.message}`); results.push({ slug: d.slug, ok: false, error: e.message }); }
}

console.log('\n\n=== BUILD SUMMARY ===');
const ok = results.filter(r => r.ok);
console.log(`built ${ok.length}/${results.length}`);
results.filter(r => !r.ok).forEach(r => console.log(`  FAILED ${r.slug}: ${r.error}`));
console.log(`total excluded agents across KBs: ${ok.reduce((n, r) => n + (r.excluded || 0), 0)}`);
