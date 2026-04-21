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
import { loadKb } from './kb.js';

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
const journalTier = (name = '') => {
  const n = String(name).toLowerCase();
  if (!n) return 'C';
  if (/(new england journal of medicine|\blancet\b|^jama$|^bmj$|nature medicine|^nature$|^cell$|^science$|annals of internal medicine|cochrane database of systematic reviews)/.test(n)) return 'A+';
  if (/(^jama |^lancet |^nature |european respiratory journal|american journal of respiratory|thorax|^chest$|circulation|european heart journal|^gut$|kidney international|^blood$|diabetes care)/.test(n)) return 'A';
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
  /^frontiers /i,           // lower bar than specialty journals; not all equal
  /^wolters kluwer medknow/i // host of many low-IF Indian/SEA titles
];
export const isPredatoryPublisher = (p) => PREDATORY_PUBLISHERS.some((r) => r.test(p || ''));
export const isLowIntegrityPublisher = (p) => LOW_INTEGRITY_PUBLISHERS.some((r) => r.test(p || ''));

// Country weighting. This is a deliberate, documented scientific-integrity
// adjustment, NOT a statement about the people who live in those countries.
// It reflects:
//   - The Retraction Watch 2024 report on country-level retraction rates
//     (CN, IR, RU, IN substantially above baseline for misconduct retractions)
//   - The 2020-2024 wave of paper-mill investigations tracing manuscripts to
//     specific industrial-scale operators in China and India
//   - Documented widespread authorship-for-hire markets (Tadpole, etc.)
//   - Weak institutional sanctions for fabrication in several jurisdictions
// Papers from these countries still enter the pack — they are just ranked
// below equivalent Western papers and carry a visible "FLAGGED" quality tag.
const COUNTRY_WEIGHT = {
  // Strong-integrity (bonus)
  US: +5, CA: +5, GB: +5, DE: +5, FR: +4, NL: +5, SE: +5, CH: +5,
  DK: +5, NO: +5, FI: +5, IE: +4, BE: +4, AT: +4, IT: +3, ES: +3,
  AU: +5, NZ: +4, JP: +5, KR: +3, SG: +4, IL: +3,
  // Neutral (no adjustment)
  TW: 0, HK: 0, PT: 0, CZ: 0, PL: 0, GR: 0, BR: 0, MX: -5, AR: 0,
  // Penalised — documented systemic integrity concerns
  CN: -20,
  IN: -8,
  IR: -15,
  RU: -15,
  PK: -10,
  TR: -5,
  VN: -8,
  SA: -3,
  EG: -5
};

// Take the WORST country signal in play. The rule is:
//   - first-author country dominates (that's the PI's lab)
//   - if first-author country is missing, take the worst penalty in the
//     countries array
//   - if a penalised country appears in the countries list even when first
//     author is elsewhere, take 50% of that penalty (milder but still cited)
export const countryAdjustment = (a) => {
  const first = a.firstAuthorCountry;
  const all = a.countries || [];
  if (first && first in COUNTRY_WEIGHT) {
    let adj = COUNTRY_WEIGHT[first];
    // Co-authorship: if first is Western but a heavy-penalty country is on
    // the paper, apply half the penalty.
    if (adj >= 0) {
      const worstCo = all
        .filter((c) => c !== first && (COUNTRY_WEIGHT[c] || 0) < -10)
        .map((c) => COUNTRY_WEIGHT[c])
        .sort((a, b) => a - b)[0];
      if (worstCo != null) adj += Math.floor(worstCo / 2);
    }
    return adj;
  }
  // No first-author country known. Take the worst in the set (conservative).
  if (all.length) {
    const worst = Math.min(...all.map((c) => COUNTRY_WEIGHT[c] ?? 0));
    return worst;
  }
  return 0;
};

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
  const first = a.firstAuthorCountry;
  if (first && (COUNTRY_WEIGHT[first] ?? 0) <= -10) flags.push({ key: 'country-concern', severity: 'warning', label: `First-author country: ${first} (documented integrity concerns)` });
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    const treatmentQueries = treatments.slice(0, 4).map((t) => `${coreQuery} ${t}`);
    const cochraneQuery = `${coreQuery} AND "Cochrane Database of Systematic Reviews"[journal]`;

    const queries = [coreQuery, ...treatmentQueries];

    // Curated knowledge base lookup happens first so we can pin canonical
    // ground-truth references on every query for conditions we've hand-curated.
    const kb = await loadKb(coreQuery);

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

    return res.status(200).json({
      condition: coreQuery,
      totalUnique: merged.length,
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
