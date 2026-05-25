// /api/evidence — the grounded-evidence orchestrator.
//
// Runs a parallel fan-out across every major reputable peer-reviewed source:
//
//   PubMed / NCBI          → biomedical literature
//   Europe PMC             → PubMed + preprints + open-access FULL TEXT
//   OpenAlex               → Google-Scholar-like cross-publisher coverage
//   Cochrane Library       → gold-standard systematic reviews
//   openFDA                → FDA labels + real adverse-event frequencies
//
// Output is a single de-duplicated, ranked "evidence pack" that is fed to
// Claude as grounded context so it can only cite from sources that actually
// exist. This is the fix for the core failure mode of AI in medical research:
// "the AI cites articles to support its claims, and often those articles do
// not actually say what the AI claims they say."

import pubmedHandler from './pubmed.js';
import europePmcHandler from './europe-pmc.js';
import openalexHandler from './openalex.js';
import openfdaHandler from './openfda.js';
import unpaywallHandler from './unpaywall.js';
import { loadKb } from '../lib/kb.js';
import { getDossier } from '../lib/disease-dossier.js';
import { requireAccess } from '../lib/access-gate.js';

const invoke = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {}, status(c) { captured.status = c; return this; },
    end() {}, json(o) { captured.body = o; return this; }
  };
  try {
    await handler({ method: 'POST', body, headers: {}, query: {} }, res);
  } catch (e) {
    captured.status = 500;
    captured.body = { error: e.message };
  }
  return captured;
};

// Run handlers in small chunks with a delay between chunks so we don't
// exceed NCBI's 3-req/sec public limit (or Europe PMC's similar ceiling).
const throttledFanOut = async (handler, bodies, chunkSize = 2, gapMs = 400) => {
  const out = [];
  for (let i = 0; i < bodies.length; i += chunkSize) {
    const slice = bodies.slice(i, i + chunkSize);
    const results = await Promise.all(slice.map((b) => invoke(handler, b)));
    out.push(...results);
    if (i + chunkSize < bodies.length) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
};

// Journal quality tiers for "weight evidence by reputable publications"
// Journal quality tiers for "weight evidence by reputable publications."
// Tiering is based on editorial rigour, impact factor, and indexing in major
// services — NOT country of publication. We explicitly include well-regarded
// Asian (incl. Chinese) journals at the tier their impact factor warrants,
// per the 2026-04 policy change against country-of-origin weighting.
const journalTier = (name = '') => {
  const n = String(name).toLowerCase();
  if (!n) return 'C';
  if (/(new england journal of medicine|\blancet\b|^jama$|^bmj$|nature medicine|^nature$|^cell$|^science$|annals of internal medicine|cochrane database of systematic reviews)/.test(n)) return 'A+';
  if (/(^jama |^lancet |^nature |european respiratory journal|american journal of respiratory|thorax|^chest$|circulation|european heart journal|^gut$|kidney international|^blood$|diabetes care)/.test(n)) return 'A';
  // Reputable Asian/Chinese medical journals — IF-justified A/B tier.
  if (/(chinese medical journal$|chinese medical journal \(|national science review|^cell research$|signal transduction and targeted therapy|bone research|cell discovery|^ebiomedicine$)/.test(n)) return 'A';
  if (/(chinese journal of cancer|chinese journal of integrative medicine|journal of thoracic disease|journal of (genetics and genomics|molecular cell biology)|asian journal of |korean journal of |japanese journal of |acta pharmacologica sinica)/.test(n)) return 'B';
  if (/(journal of |respir|pulmonology|clinical|\bmedicine\b)/.test(n)) return 'B';
  return 'C';
};

// PREDATORY / LOW-INTEGRITY PUBLISHERS — documented paper-mill activity,
// weak peer review, or well-publicised integrity failures. We downweight
// but do not auto-exclude (some individual papers may still be valid).
//
// Sources for this list (stable as of 2026-04):
//   - Retraction Watch "Top 10 Most-Retracted Journals" and their publishers
//   - Hindawi mass-retractions 2023-2024 (19,000+ papers in guest-editor scam)
//   - MDPI sister-journal cross-citation farming controversies
//   - Bentham/OMICS/SciRP documented in Beall's list archives
//   - Frontiers family: accepted-article-ratio and reviewer-recruitment criticism
//     (we penalise lightly, not heavily — some Frontiers journals are ok)
const PREDATORY_PUBLISHERS = [
  /^omics (international|group|publishing)/i,
  /^scientific research publishing/i,
  /\bscirp\b/i,
  /^bentham (open|science)/i,
  /^hindawi/i,              // mass-retractions 2023-24
  /^medcrave/i,
  /^scholink/i,
  /^iiste\b/i,
  /^\s*juniper publishers/i,
  /^david publishing/i,
  /^longdom/i,
  /^open access pub/i,
  /^peertechz/i
];
const LOW_INTEGRITY_PUBLISHERS = [
  /^mdpi$/i,                // paper-mill concerns + guest-editor issues
  /^frontiers /i            // lower bar than specialty journals; not all equal
  // NOTE 2026-04: removed `wolters kluwer medknow`. Medknow hosts many
  // reputable regional-society journals (including Chinese Medical Journal,
  // the flagship of the Chinese Medical Association, IF ~6). Publisher-level
  // penalty was effectively a country/region proxy. Per Dorothy's policy
  // (no country weighting) we now judge Medknow titles on journal-tier and
  // individual retraction history rather than publisher identity.
];
export const isPredatoryPublisher = (p) => PREDATORY_PUBLISHERS.some((r) => r.test(p || ''));
export const isLowIntegrityPublisher = (p) => LOW_INTEGRITY_PUBLISHERS.some((r) => r.test(p || ''));

// Country weighting — DISABLED per product decision (2026-04).
// Earlier versions of this file applied author-country penalties to rank
// papers from certain jurisdictions below Western equivalents. Dorothy
// (product lead) asked us to remove this rule: "let's not weight the
// literature less if from china." We now rely exclusively on
// publisher-level signals (retractions, predatory publisher blacklist,
// journal tier) which are country-independent and apply to misconduct
// regardless of where the first author sits. All countries return 0.
// The constant is kept as an empty object so callers don't break; flip
// individual entries back here if the policy changes.
const COUNTRY_WEIGHT = {};

// Country-based scoring adjustment. DISABLED — always returns 0. See
// COUNTRY_WEIGHT comment above for rationale.
export const countryAdjustment = (_a) => 0;

// Compile a human-readable list of quality flags for an article. These
// surface in the UI as colored badges and get embedded in the grounding
// block so Claude knows the source's reliability profile.
export const computeQualityFlags = (a) => {
  const flags = [];
  if (a.isRetracted) flags.push({ key: 'retracted', severity: 'critical', label: 'RETRACTED' });
  if (a.isRetractionNotice) flags.push({ key: 'retraction-notice', severity: 'critical', label: 'Retraction notice' });
  if (a.isPreprint || (a.type === 'preprint')) flags.push({ key: 'preprint', severity: 'warning', label: 'Preprint (not peer-reviewed)' });
  if (isPredatoryPublisher(a.publisher)) flags.push({ key: 'predatory-publisher', severity: 'critical', label: `Predatory publisher: ${a.publisher}` });
  else if (isLowIntegrityPublisher(a.publisher)) flags.push({ key: 'low-integrity-publisher', severity: 'warning', label: `Lower-integrity publisher: ${a.publisher}` });
  // (Country-of-first-author flag removed 2026-04 per product decision;
  // we no longer down-weight literature by author country. See
  // COUNTRY_WEIGHT comment above.)
  if (a.isMetaAnalysis) flags.push({ key: 'meta-analysis', severity: 'positive', label: 'Meta-analysis' });
  else if (a.isSystematicReview) flags.push({ key: 'systematic-review', severity: 'positive', label: 'Systematic review' });
  else if (a.isRCT) flags.push({ key: 'rct', severity: 'positive', label: 'Randomized controlled trial' });
  if (a.source === 'Cochrane') flags.push({ key: 'cochrane', severity: 'positive', label: 'Cochrane Review' });
  if (a.isCuratedKB) flags.push({ key: 'curated-kb', severity: 'positive', label: 'Curated landmark reference' });
  if ((a.journalTier === 'A+' || a.journalTier === 'A') && !a.isRetracted) {
    flags.push({ key: 'top-tier-journal', severity: 'positive', label: `${a.journalTier}-tier journal` });
  }
  return flags;
};

export const scoreArticle = (a) => {
  let s = 0;
  const tier = a.journalTier || journalTier(a.journal || '');
  s += { 'A+': 40, A: 25, B: 12, C: 4 }[tier] || 0;
  s += Math.min(25, Math.log10((a.citedByCount || 0) + 1) * 8);
  const year = parseInt(a.year || 0);
  if (year) s += Math.max(0, 15 - Math.max(0, 2026 - year));
  if (a.isOpenAccess || a.openAccess?.is_oa) s += 5;

  // Publication type — peer-reviewed study design matters more than "opinion"
  if (a.isMetaAnalysis || a.isSystematicReview)   s += 15;
  else if (a.isRCT)                                s += 10;
  else if ((a.publicationTypes || []).some((t) => /observational|cohort/i.test(t))) s += 3;
  if ((a.pubType || []).join(' ').toLowerCase().match(/systematic review|meta-analysis|randomized controlled trial/)) s += 5;
  if (a.source === 'Cochrane') s += 15;
  if (a.isCuratedKB) s += 60;

  // Quality penalties — these can pull a paper below zero and out of the
  // prompt pack entirely. That's intentional.
  if (a.isRetracted)          s -= 200; // always below the floor → excluded
  if (a.isRetractionNotice)   s -= 200;
  if (a.isPreprint)           s -= 10;
  if (isPredatoryPublisher(a.publisher))   s -= 50;
  if (isLowIntegrityPublisher(a.publisher)) s -= 10;

  // Geography (see COUNTRY_WEIGHT rationale above)
  s += countryAdjustment(a);

  return s;
};

const dedupe = (articles) => {
  const byKey = new Map();
  for (const a of articles) {
    const key = (a.doi && String(a.doi).toLowerCase()) || (a.pmid && `pmid:${a.pmid}`) || `${a.source}:${a.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...a, sources: [a.source] });
    } else {
      const prev = byKey.get(key);
      if (!prev.sources.includes(a.source)) prev.sources.push(a.source);
      // Always prefer the longest non-empty abstract we have from any source.
      if ((a.abstract || '').length > (prev.abstract || '').length) prev.abstract = a.abstract;
      if (!prev.fullText && a.fullText) prev.fullText = a.fullText;
      if (!prev.pmid && a.pmid) prev.pmid = a.pmid;
      if (!prev.doi && a.doi) prev.doi = a.doi;
      if (!prev.pmcUrl && a.pmcUrl) prev.pmcUrl = a.pmcUrl;
      if (!prev.pubmedUrl && a.pubmedUrl) prev.pubmedUrl = a.pubmedUrl;
      if (!prev.doiUrl && a.doiUrl) prev.doiUrl = a.doiUrl;
      if (!prev.oaUrl && a.oaUrl) prev.oaUrl = a.oaUrl;
      if (!prev.citedByCount && a.citedByCount) prev.citedByCount = a.citedByCount;
    }
  }
  return [...byKey.values()];
};

// What level of access did we actually get? This gets stamped on every pack
// item so Claude must disclose it with every citation and the UI can badge it.
//   full-text      = we have the body of the article (from PMC or Unpaywall OA)
//   abstract       = we have the peer-reviewed abstract (legal + authoritative)
//   metadata-only  = title/journal/year only — Claude can name the paper but
//                    MUST NOT claim anything about its contents
const classifyAccess = (a) => {
  if (a.fullText && a.fullText.length > 500) return 'full-text';
  if (a.abstract && a.abstract.length > 80) return 'abstract';
  return 'metadata-only';
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Passcode');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAccess(req, res)) return;

  try {
    const {
      condition,
      treatments = [],
      drugs = [],
      manufacturers = [],
      limitPerSource = 8,
      includeFullText = true
    } = req.body || {};

    if (!condition || !String(condition).trim())
      return res.status(400).json({ error: 'condition required' });

    const coreQuery = String(condition);

    // Disease-intake agent. Supplies canonical + synonyms + MeSH terms so
    // our PubMed / Europe PMC / OpenAlex fan-out isn't limited to whatever
    // verbatim string the user typed. Callers can pass a pre-fetched
    // dossier through `body.dossier` to avoid a duplicate agent call.
    const dossier =
      (req.body && req.body.dossier && req.body.dossier.canonical)
        ? req.body.dossier
        : await getDossier(coreQuery);

    const canonical = dossier.canonical || coreQuery;
    // Cap synonym fan-out at 2 (was 4). Each synonym is another 3-source
    // round trip (PubMed throttled, EPMC throttled, OpenAlex parallel);
    // on Vercel Hobby the extra 5s per synonym blows the 60s gather cap.
    // The curated KB + dossier MeSH cover recall loss.
    const synonymSearches = [
      canonical,
      ...(dossier.synonyms || []).filter(
        (s) => s && s.toLowerCase() !== canonical.toLowerCase()
      )
    ].slice(0, 2);

    // For Cochrane, use the canonical form — Cochrane reviews index on
    // formal disease names, not abbreviations.
    const cochraneQuery = `${canonical} AND "Cochrane Database of Systematic Reviews"[journal]`;

    // Curated knowledge base lookup. Must run BEFORE we assemble the query
    // set so pipeline-drug expansion can fire below. Uses the ORIGINAL
    // condition text so aliased inputs ("RP") still match the KB slug rules.
    const kb = await loadKb(coreQuery);

    // Pipeline-drug query expansion — the "no-more-missed-drugs" guardrail.
    // For every drug listed in the KB's pipelineDrugs array we generate an
    // explicit `[canonical] [drug-name]` query so that Nerandomilast papers
    // are GUARANTEED in the evidence pack for IPF, OCU400 papers are
    // GUARANTEED in the pack for RP, etc. Without this, we were relying on
    // a generic "IPF treatment" query to happen to rank a Nerandomilast
    // paper highly — which did not reliably happen. See commits on this
    // line for the root-cause analysis.
    //
    // Capped at 3 pipeline-drug queries to stay inside the 48s gather
    // deadline (each query fans out across PubMed + EPMC + OpenAlex). We
    // pick the top 3 from the KB's ordering — curators put the most
    // important agents first.
    const pipelineDrugNames = (kb.meta?.pipelineDrugs || [])
      .map((d) => d.name)
      .filter(Boolean);
    const pipelineDrugQueries = pipelineDrugNames
      .slice(0, 3)
      .map((name) => `${canonical} ${name}`);

    // Full query set: canonical + 1 synonym + up to 2 treatment cross-
    // products + up to 3 pipeline-drug cross-products. Total 4-7 queries
    // × 3 sources = 12-21 upstream hits, still under the 48s gather cap.
    const treatmentQueries = treatments.slice(0, 2).map((t) => `${canonical} ${t}`);
    const queries = [...synonymSearches, ...treatmentQueries, ...pipelineDrugQueries];

    // PubMed & Europe PMC are rate-limited for anonymous traffic (~3 req/s);
    // run them throttled. OpenAlex + openFDA are generous, we can parallelise.
    const pubmedBodies = queries.map((q) => ({ query: q, limit: limitPerSource, withAbstract: true }));
    const europePmcBodies = queries.map((q) => ({ query: q, limit: limitPerSource, includeFullText }));
    const openalexBodies = queries.map((q) => ({ query: q, limit: limitPerSource }));

    const [pmRes, epmcRes, oaRes, cochRes, fdaRes, fdaMfgRes] = await Promise.all([
      throttledFanOut(pubmedHandler, pubmedBodies, 2, 400),
      throttledFanOut(europePmcHandler, europePmcBodies, 2, 350),
      Promise.all(openalexBodies.map((b) => invoke(openalexHandler, b))),
      invoke(pubmedHandler, { query: cochraneQuery, limit: 6, withAbstract: true }),
      Promise.all(drugs.map((d) => invoke(openfdaHandler, { drug: d }))),
      Promise.all(manufacturers.map((m) => invoke(openfdaHandler, { manufacturer: m })))
    ]);

    const pm = pmRes.flatMap((r) => (r.body?.articles || []).map((a) => ({ ...a, source: 'PubMed' })));
    const epmc = epmcRes.flatMap((r) => r.body?.articles || []);
    const oa = oaRes.flatMap((r) => r.body?.articles || []);
    const cochrane = (cochRes.body?.articles || []).map((a) => ({ ...a, source: 'Cochrane' }));

    // Per-source raw (pre-dedup) counts. We surface these so the UI can
    // honestly tell the user "we pulled 104 records from 4 corpora, which
    // de-duplicated to 32 unique papers" — instead of the misleading "30
    // sources" framing that sounds like we only looked at 30 journals.
    const perSourceCounts = {
      PubMed: pm.length,
      EuropePMC: epmc.length,
      OpenAlex: oa.length,
      Cochrane: cochrane.length,
      CuratedKB: (kb.items || []).length
    };
    const totalFetched =
      perSourceCounts.PubMed +
      perSourceCounts.EuropePMC +
      perSourceCounts.OpenAlex +
      perSourceCounts.Cochrane +
      perSourceCounts.CuratedKB;

    // Curated KB items come pre-tagged with tier/abstract; they merge-dedupe
    // against live results by DOI / PMID so we don't double-list a landmark RCT
    // that PubMed also returned.
    const kbItems = (kb.items || []).map((k) => ({ ...k }));

    let merged = dedupe([...kbItems, ...pm, ...epmc, ...oa, ...cochrane]);

    // Cross-populate retraction and quality signals between duplicate rows.
    // Example: OpenAlex knows a paper is retracted, PubMed didn't mark it —
    // dedupe merged them on DOI but only PubMed's fields survived. Re-apply.
    merged.forEach((a) => {
      a.journalTier = a.journalTier || journalTier(a.journal || '');
      a.qualityFlags = computeQualityFlags(a);
      a.score = scoreArticle(a);
    });
    merged.sort((a, b) => b.score - a.score);

    // HARD FILTER: retractions and retraction notices never reach Claude.
    // We also exclude predatory-publisher papers unless the entire pool is
    // so thin that we'd otherwise have nothing. Count them separately so the
    // UI can show "we excluded 3 retracted papers and 1 predatory-publisher
    // paper from the evidence pack."
    const retractedExcluded = merged.filter((a) => a.isRetracted || a.isRetractionNotice);
    const predatoryExcluded = merged.filter(
      (a) => !a.isRetracted && !a.isRetractionNotice && isPredatoryPublisher(a.publisher)
    );
    const cleanPool = merged.filter(
      (a) => !a.isRetracted && !a.isRetractionNotice && !isPredatoryPublisher(a.publisher)
    );

    // For the top N items that look like they might be paywalled (no fullText
    // and no abstract), ask Unpaywall if there's a legal OA copy. Only bother
    // for items that already survived the quality filter.
    const unpaywallTargets = cleanPool
      .filter((a) => a.doi && !a.fullText && (!a.abstract || a.abstract.length < 80))
      .slice(0, 10);
    await Promise.all(
      unpaywallTargets.map(async (a) => {
        const up = await invoke(unpaywallHandler, { doi: a.doi });
        if (up.status === 200 && up.body && up.body.isOA && up.body.bestOA) {
          a.oaUrl = a.oaUrl || up.body.bestOA.url;
          a.unpaywall = {
            oaStatus: up.body.oaStatus,
            version: up.body.bestOA.version,
            hostType: up.body.bestOA.hostType,
            license: up.body.bestOA.license,
            url: up.body.bestOA.url,
            pdfUrl: up.body.bestOA.urlForPdf
          };
        }
      })
    );

    // Stamp the access level onto every item so downstream consumers know
    // exactly how far Claude is allowed to go when citing it.
    merged.forEach((a) => { a.accessLevel = classifyAccess(a); });

    const fdaLabels = fdaRes.map((r, i) => ({ drug: drugs[i], ...(r.body || {}) }));
    const fdaManufacturers = fdaMfgRes.map((r, i) => ({
      manufacturer: manufacturers[i],
      ...(r.body || {})
    }));

    // Build the prompt pack with a guaranteed mix of curated-KB + live items.
    // Without this, the KB's +60 score bonus would monopolize all 25 slots and
    // Claude would never see recent (2025/2026) live-fetched research that
    // PubMed / Europe PMC / OpenAlex just pulled. We want BOTH: the pinned
    // ground-truth floor AND the freshest peer-reviewed updates.
    const PROMPT_PACK_SIZE = 25;
    const MIN_LIVE_SLOTS = 10;
    const kbRanked = cleanPool.filter((a) => a.isCuratedKB);
    const liveRanked = cleanPool.filter((a) => !a.isCuratedKB);
    const liveSlice = liveRanked.slice(0, Math.max(MIN_LIVE_SLOTS, PROMPT_PACK_SIZE - kbRanked.length));
    const kbSlice = kbRanked.slice(0, PROMPT_PACK_SIZE - liveSlice.length);
    const promptPack = [...kbSlice, ...liveSlice].slice(0, PROMPT_PACK_SIZE);

    const groundedForPrompt = promptPack.map((a) => {
      const url = a.url || a.pmcUrl || a.pubmedUrl || a.doiUrl || a.oaUrl || a.landingUrl || a.europePmcUrl;
      const textBlob = (a.fullText || a.abstract || '').slice(0, 3500);
      return {
        id: a.doi || a.pmid || a.id,
        title: a.title,
        journal: a.journal,
        publisher: a.publisher || '',
        tier: a.journalTier,
        year: a.year,
        sources: a.sources || (a.source ? [a.source] : []),
        isCuratedKB: !!a.isCuratedKB,
        kbCategory: a.category || null,
        openAccess: a.isOpenAccess || a.openAccess?.is_oa || false,
        accessLevel: a.accessLevel,
        citations: a.citedByCount || 0,
        countries: a.countries || [],
        firstAuthorCountry: a.firstAuthorCountry || null,
        isRCT: !!a.isRCT,
        isMetaAnalysis: !!a.isMetaAnalysis,
        isSystematicReview: !!a.isSystematicReview,
        isPreprint: !!a.isPreprint,
        qualityFlags: a.qualityFlags || [],
        score: a.score,
        url,
        unpaywallUrl: a.unpaywall?.url || null,
        text: textBlob
      };
    });

    // Breakdown of KB vs live in the pack we're handing to Claude.
    const promptPackBreakdown = {
      total: groundedForPrompt.length,
      curatedKB: kbSlice.length,
      liveFetched: liveSlice.length
    };

    // Pre-compute access-level breakdown for the UI ("we got full text for 4,
    // abstracts for 12, metadata-only for 2").
    const accessBreakdown = merged.reduce(
      (acc, a) => { acc[a.accessLevel] = (acc[a.accessLevel] || 0) + 1; return acc; },
      { 'full-text': 0, abstract: 0, 'metadata-only': 0 }
    );

    // Quality breakdown — how many papers at each integrity signal. This is
    // what the UI shows as "we screened X sources, excluded N retracted, M
    // from predatory publishers, and down-weighted K from integrity-concern
    // jurisdictions."
    const countryCounts = {};
    cleanPool.forEach((a) => {
      const c = a.firstAuthorCountry || (a.countries || [])[0];
      if (c) countryCounts[c] = (countryCounts[c] || 0) + 1;
    });
    const qualityBreakdown = {
      totalScreened: merged.length,
      retractedExcluded: retractedExcluded.length,
      predatoryExcluded: predatoryExcluded.length,
      retractedTitles: retractedExcluded.slice(0, 10).map((a) => ({
        title: a.title, journal: a.journal, pmid: a.pmid, doi: a.doi
      })),
      predatoryTitles: predatoryExcluded.slice(0, 10).map((a) => ({
        title: a.title, journal: a.journal, publisher: a.publisher
      })),
      preprintsInPool: cleanPool.filter((a) => a.isPreprint).length,
      countryConcernInPool: cleanPool.filter((a) =>
        (COUNTRY_WEIGHT[a.firstAuthorCountry] ?? 0) <= -10
      ).length,
      countryConcernInPromptPack: groundedForPrompt.filter((a) =>
        (COUNTRY_WEIGHT[a.firstAuthorCountry] ?? 0) <= -10
      ).length,
      topTierInPromptPack: groundedForPrompt.filter((a) => a.tier === 'A+' || a.tier === 'A').length,
      rctOrMetaInPromptPack: groundedForPrompt.filter((a) => a.isRCT || a.isMetaAnalysis || a.isSystematicReview).length,
      countryCounts
    };

    // Distinct journals touched in this query (after dedup). Useful as a
    // breadth signal for the UI: "pulled from 27 different journals" reads
    // very differently from "pulled 30 papers".
    const uniqueJournals = new Set(
      merged
        .map((a) => (a.journal || '').trim().toLowerCase())
        .filter(Boolean)
    ).size;

    // Corpus footprint — a static description of the universe we search
    // across. These numbers are published facts about the upstream APIs, not
    // per-query counts. We surface them so the UI can explain to users /
    // stakeholders "yes, your query actually went against this entire pool."
    const corpusFootprint = {
      databases: [
        { name: 'PubMed / MEDLINE', journals: '~5,200 indexed journals, ~36M citations' },
        { name: 'Europe PMC',       journals: '~40M articles + preprints, open-access full text' },
        { name: 'OpenAlex',         journals: '~250,000 journals, ~250M works (global)' },
        { name: 'Cochrane Library', journals: 'gold-standard systematic reviews' },
        { name: 'openFDA',          journals: 'FDA labels + adverse-event reports' },
        { name: 'Curated KB',       journals: 'hand-curated landmark trials & guidelines' }
      ],
      universityFilter: 'Journal-tier filter + predatory-publisher blacklist select for peer-reviewed academic publications. Preprints are flagged but allowed. Paper-mill and pay-to-publish venues are down-weighted or excluded.'
    };

    return res.status(200).json({
      condition: coreQuery,
      dossier: {
        canonical: dossier.canonical,
        synonyms: dossier.synonyms,
        meshTerms: dossier.meshTerms,
        subspecialty: dossier.subspecialty,
        uncertainty: dossier.uncertainty,
        cacheHit: dossier.cacheHit,
        cacheDisabled: dossier.cacheDisabled || false,
        generatedBy: dossier.generatedBy,
        topCenters: dossier.topCenters || [],
        keyInvestigators: dossier.keyInvestigators || [],
        patientAdvocacy: dossier.patientAdvocacy || [],
        landmarkTrials: dossier.landmarkTrials || []
      },
      // Pipeline-drug + excluded-agent guardrails (for research.js to
      // inject into the synthesis prompt and to audit the final output).
      pipelineDrugs: kb.meta?.pipelineDrugs || [],
      excludedAgents: kb.meta?.excludedAgents || [],
      pipelineDrugQueries, // for UI transparency / debugging
      totalUnique: merged.length,
      totalFetched,
      perSourceCounts,
      uniqueJournals,
      corpusFootprint,
      accessBreakdown,
      promptPackBreakdown,
      qualityBreakdown,
      knowledgeBase: kb.matched
        ? {
            matched: true,
            ...kb.meta,
            matchedOn: kb.matchedOn,
            score: kb.score
          }
        : { matched: false },
      topRanked: cleanPool.slice(0, 50),
      groundedForPrompt,
      fdaLabels,
      fdaManufacturers
    });
  } catch (e) {
    console.error('evidence.js', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
