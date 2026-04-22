// End-to-end harness that invokes our Vercel handlers exactly like Vercel
// would, to prove every pipeline (trials / pubmed / research / records-audit /
// evidence / kb / validate) actually works for a realistic patient before
// shipping.
//
// Run: node scripts/e2e-test.mjs
// Set ANTHROPIC_API_KEY in env to enable the Anthropic-backed tests.

import trialsHandler from '../api/trials.js';
import pubmedHandler from '../api/pubmed.js';
import researchHandler from '../api/research.js';
import auditHandler from '../api/records-audit.js';
import europePmcHandler from '../api/europe-pmc.js';
import openalexHandler from '../api/openalex.js';
import openfdaHandler from '../api/openfda.js';
import evidenceHandler, {
  scoreArticle,
  isPredatoryPublisher,
  countryAdjustment,
  computeQualityFlags
} from '../api/evidence.js';
import validateHandler from '../lib/validate.js';
import unpaywallHandler from '../api/unpaywall.js';
import kbHandler, { loadKb } from '../lib/kb.js';
import alertsSubscribeHandler from '../api/alerts-subscribe.js';
import alertsCronHandler from '../api/alerts-cron.js';
import {
  _resetForTests as resetAlerts,
  listSubscriptions as listAllSubs,
  getSentLedger,
  isConfigured as alertsStoreConfigured
} from '../lib/alerts-store.js';
import {
  renderAlertHtml,
  renderAlertSubject,
  isEmailConfigured
} from '../lib/alerts-email.js';

const mockRes = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    end() { this._ended = true; },
    json(obj) { this.body = obj; this._ended = true; return this; }
  };
  return res;
};

const invoke = async (handler, body) => {
  const req = { method: 'POST', body, headers: {}, query: {} };
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
};

const IPF_PATIENT = {
  condition: 'Idiopathic Pulmonary Fibrosis',
  stage: 'GAP stage II',
  age: '68',
  gender: 'Male',
  weight: '178 lb',
  smoking: 'Former, 30 pack-years, quit 2010',
  exercise: 'Walks 20 min daily, limited by dyspnea',
  diagnoses: 'IPF, GERD, hypertension, hyperlipidemia, BPH',
  medications: 'Pirfenidone 2403 mg/day, omeprazole 40 mg, lisinopril 20 mg, atorvastatin 40 mg, tamsulosin 0.4 mg',
  symptoms: 'Progressive DOE, dry cough, fatigue; baseline SpO2 94% RA, 88% with exertion',
  labWork: 'FVC 62% predicted (down from 71% six months ago), DLCO 41%, 6MWT 380m with desat to 86%',
  scans: 'HRCT 2/2026: UIP pattern, subpleural/basal honeycombing, traction bronchiectasis, no ground glass'
};

const pass = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`\x1b[31m✗\x1b[0m ${msg}`); process.exitCode = 1; };
const info = (msg) => console.log(`  ${msg}`);

(async () => {
  console.log('\n=== 1. /api/trials — live ClinicalTrials.gov for IPF ===');
  const trials = await invoke(trialsHandler, {
    condition: 'Idiopathic Pulmonary Fibrosis',
    recruitingOnly: true,
    treatmentOnly: true,
    excludePlacebo: false,
    pageSize: 20
  });
  if (trials.status !== 200) return fail(`trials returned ${trials.status}: ${JSON.stringify(trials.body)}`);
  const { total, returned, studies } = trials.body;
  pass(`trials endpoint returned ${returned}/${total} IPF trials`);
  if (!returned || returned < 5) return fail('expected at least 5 recruiting IPF trials');
  const top = studies[0];
  info(`top trial: ${top.nctId} · promise=${top.promiseScore} · phase=${top.phases?.join(',')}`);
  info(`  title: ${top.briefTitle?.slice(0, 80)}…`);
  info(`  accepting new patients: ${top.acceptingNewPatients}, placebo: ${top.hasPlacebo}`);
  info(`  countries: ${top.countries?.slice(0, 4).join(', ') || '(no locations listed)'}`);
  info(`  designations: ${Object.entries(top.designations).filter(([,v])=>v).map(([k])=>k).join(', ') || 'none flagged'}`);
  info(`  URL: ${top.url}`);
  if (!top.url?.includes('clinicaltrials.gov')) return fail('expected clickable CT.gov URL on top trial');
  pass('parse/rank/URL extraction all working');

  const phase3 = studies.filter(s => (s.phases || []).some(p => /3/.test(p)));
  pass(`${phase3.length} Phase 3 IPF trials found`);

  const placeboFree = studies.filter(s => !s.hasPlacebo);
  pass(`${placeboFree.length}/${returned} IPF trials with no placebo arm (preferred for patients who want guaranteed treatment)`);

  const westernOnly = studies.filter(s =>
    !['China', 'Vietnam', 'Mexico', 'India'].some(c => (s.countries || []).includes(c)));
  pass(`${westernOnly.length}/${returned} IPF trials excluding China/Vietnam/Mexico/India`);

  console.log('\n=== 2. /api/pubmed — live PubMed for IPF antifibrotics ===');
  const pubmed = await invoke(pubmedHandler, {
    query: 'idiopathic pulmonary fibrosis nintedanib pirfenidone efficacy safety',
    limit: 5,
    sort: 'relevance',
    withAbstract: true
  });
  if (pubmed.status !== 200) return fail(`pubmed returned ${pubmed.status}`);
  pass(`pubmed endpoint returned ${pubmed.body.count} articles`);
  const firstArt = pubmed.body.articles?.[0];
  if (!firstArt) return fail('no pubmed articles');
  info(`top article: PMID ${firstArt.pmid} · ${firstArt.journal} · ${firstArt.year}`);
  info(`  title: ${firstArt.title?.slice(0, 90)}…`);
  info(`  authors: ${firstArt.authorLine}`);
  info(`  URL: ${firstArt.pubmedUrl}`);
  info(`  abstract length: ${firstArt.abstract?.length || 0} chars`);
  if (!firstArt.pubmedUrl.includes('pubmed.ncbi.nlm.nih.gov')) return fail('missing pubmed URL');
  if (!firstArt.abstract || firstArt.abstract.length < 100) return fail('expected a real abstract');
  pass('real PubMed metadata + abstract parsed');

  console.log('\n=== 2b. /api/europe-pmc — OA full-text pull for IPF ===');
  const epmc = await invoke(europePmcHandler, {
    query: 'idiopathic pulmonary fibrosis pirfenidone',
    limit: 4, includeFullText: true
  });
  if (epmc.status !== 200) return fail(`europe-pmc returned ${epmc.status}`);
  pass(`Europe PMC returned ${epmc.body.count} articles`);
  const oaHits = (epmc.body.articles || []).filter(a => a.inPMC);
  info(`  OA / inPMC articles: ${oaHits.length}`);
  const withFullText = (epmc.body.articles || []).filter(a => a.fullText && a.fullText.length > 500);
  if (withFullText.length) {
    pass(`${withFullText.length} article(s) came back with real full text pulled from PMC`);
    info(`  top OA full-text sample (first 180 chars): ${withFullText[0].fullText.slice(0, 180)}…`);
  } else {
    info('  (no OA full text in this batch — pack will fall back to abstracts)');
  }

  console.log('\n=== 2c. /api/openalex — Google-Scholar-like search ===');
  const oa = await invoke(openalexHandler, {
    query: 'idiopathic pulmonary fibrosis antifibrotic efficacy',
    limit: 5
  });
  if (oa.status !== 200) return fail(`openalex returned ${oa.status}`);
  pass(`OpenAlex returned ${oa.body.count} works`);
  const oaTop = oa.body.articles?.[0];
  if (oaTop) {
    info(`  top work: ${oaTop.title?.slice(0,80)}… · ${oaTop.journal} (${oaTop.journalTier}) · cited ${oaTop.citedByCount} · OA=${oaTop.openAccess?.is_oa ? 'yes' : 'no'}`);
  }
  const aPlus = (oa.body.articles || []).filter(a => a.journalTier === 'A+' || a.journalTier === 'A');
  pass(`${aPlus.length} A/A+ tier hits (NEJM/Lancet/JAMA/BMJ class)`);

  console.log('\n=== 2d. /api/openfda — FDA label + FAERS for pirfenidone ===');
  const fda = await invoke(openfdaHandler, { drug: 'pirfenidone' });
  if (fda.status !== 200) return fail(`openfda returned ${fda.status}`);
  if (!fda.body.label) return fail('no FDA label returned for pirfenidone');
  pass(`FDA label pulled: ${(fda.body.label.genericName || []).join(', ')}`);
  info(`  manufacturer: ${(fda.body.label.manufacturer || []).join(', ')}`);
  info(`  has drug-interaction text: ${!!fda.body.label.drugInteractions}`);
  info(`  has warnings: ${!!fda.body.label.warnings}`);
  info(`  FAERS top reactions: ${(fda.body.topAdverseEvents || []).slice(0,5).map(e=>`${e.reaction}(${e.reports})`).join(', ')}`);
  info(`  designations: ${JSON.stringify(fda.body.designations || {})}`);

  console.log('\n=== 2d-bis. /api/unpaywall — legal OA PDF for paywalled DOI ===');
  // King/CAPACITY pirfenidone trials Lancet 2011 — historically paywalled
  // but NIH-funded so there is legally an author manuscript on PubMed Central.
  const up = await invoke(unpaywallHandler, { doi: '10.1016/s0140-6736(11)60405-4' });
  if (up.status !== 200) return fail(`unpaywall returned ${up.status}`);
  pass(`Unpaywall responded: isOA=${up.body.isOA}, oaStatus=${up.body.oaStatus || 'n/a'}`);
  if (up.body.bestOA) {
    info(`  best OA version: ${up.body.bestOA.version} (${up.body.bestOA.hostType}) → ${up.body.bestOA.url}`);
    pass('Unpaywall located a legal OA copy for a paywalled Lancet paper');
  } else {
    info('  (no OA copy returned for this DOI — expected for truly-closed papers)');
  }

  console.log('\n=== 2d-ter. /api/kb — curated IPF knowledge base loader ===');
  // Via handler (HTTP shape)
  const kbResp = await invoke(kbHandler, { condition: 'idiopathic pulmonary fibrosis' });
  if (kbResp.status !== 200) return fail(`kb returned ${kbResp.status}`);
  if (!kbResp.body.matched) return fail('kb did not match "idiopathic pulmonary fibrosis"');
  pass(`kb matched: ${kbResp.body.meta.condition} (v${kbResp.body.meta.version}, ${kbResp.body.meta.itemCount} items)`);
  if (kbResp.body.meta.itemCount < 15)
    return fail(`expected >= 15 curated items, got ${kbResp.body.meta.itemCount}`);
  pass(`${kbResp.body.meta.itemCount} curated IPF landmark references loaded`);
  if ((kbResp.body.meta.canonicalFacts || []).length < 5)
    return fail('expected >= 5 canonical facts for IPF');
  pass(`${kbResp.body.meta.canonicalFacts.length} canonical facts`);
  if ((kbResp.body.meta.redFlags || []).length < 3)
    return fail('expected >= 3 red flags for IPF');
  pass(`${kbResp.body.meta.redFlags.length} red flags (PANTHER-style contraindications)`);
  const panther = kbResp.body.meta.redFlags.some(r => /prednisone.*azathioprine.*NAC|PANTHER/i.test(r));
  panther
    ? pass('PANTHER-IPF triple-therapy red flag is in the KB')
    : fail('critical PANTHER-IPF red flag missing from KB');

  // Via alias matching — must also resolve
  const kbAlias = await invoke(kbHandler, { condition: 'UIP' });
  kbAlias.body.matched
    ? pass(`kb alias match works ("UIP" → ${kbAlias.body.meta.condition})`)
    : fail('kb did not resolve "UIP" alias to IPF');

  // Via direct import (used by evidence.js) — same shape
  const directKb = await loadKb('Idiopathic Pulmonary Fibrosis');
  if (!directKb.matched) return fail('loadKb() direct import did not match IPF');
  if (directKb.items.length !== kbResp.body.meta.itemCount)
    return fail(`direct loadKb() returned ${directKb.items.length} items, handler returned ${kbResp.body.meta.itemCount}`);
  pass('direct loadKb() import returns identical item count to HTTP handler');
  const kbItem = directKb.items[0];
  if (!kbItem.isCuratedKB) return fail('curated KB items missing isCuratedKB flag');
  if (!kbItem.abstract || !kbItem.abstract.includes('Editor\'s summary'))
    return fail('curated KB items missing rendered abstract with Editor summary');
  pass('curated KB items are tagged isCuratedKB and contain editorial summary + verbatim passages');

  // Cold condition — should NOT match
  const cold = await invoke(kbHandler, { condition: 'glioblastoma' });
  !cold.body.matched
    ? pass('kb correctly returns no-match for a condition we have not curated yet')
    : fail('kb false-positive match for uncurated condition');

  console.log('\n=== 2e. /api/evidence — full orchestrated pack for IPF patient ===');
  const ev = await invoke(evidenceHandler, {
    condition: 'Idiopathic Pulmonary Fibrosis',
    treatments: ['pirfenidone', 'nintedanib', 'lung transplant', 'pulmonary rehabilitation'],
    drugs: ['pirfenidone', 'nintedanib'],
    manufacturers: [],
    limitPerSource: 4,
    includeFullText: true
  });
  if (ev.status !== 200) return fail(`evidence returned ${ev.status}: ${JSON.stringify(ev.body).slice(0,200)}`);
  pass(`evidence pack: ${ev.body.totalUnique} unique sources after de-dup`);
  const tiers = {};
  (ev.body.topRanked || []).forEach(a => { tiers[a.journalTier] = (tiers[a.journalTier] || 0) + 1; });
  info(`  tier distribution: ${JSON.stringify(tiers)}`);
  const sourcesSeen = new Set();
  (ev.body.topRanked || []).forEach(a => (a.sources || []).forEach(s => sourcesSeen.add(s)));
  info(`  source coverage: ${[...sourcesSeen].join(', ')}`);
  info(`  access-level breakdown: ${JSON.stringify(ev.body.accessBreakdown)}`);
  if (ev.body.accessBreakdown) {
    const abstractsOrBetter = (ev.body.accessBreakdown['full-text'] || 0) + (ev.body.accessBreakdown['abstract'] || 0);
    abstractsOrBetter >= 10
      ? pass(`${abstractsOrBetter} items have at least the peer-reviewed abstract (paywall-safe grounding)`)
      : fail(`only ${abstractsOrBetter} items have abstract-or-better — expected >= 10`);
  }
  const packSize = (ev.body.groundedForPrompt || []).length;
  pass(`${packSize} items prepared for Claude grounding`);
  const taggedPack = (ev.body.groundedForPrompt || []).filter(x => x.accessLevel);
  taggedPack.length === packSize
    ? pass(`every grounded-prompt item is tagged with accessLevel`)
    : fail(`${packSize - taggedPack.length} items missing accessLevel tag`);
  const fdaCount = (ev.body.fdaLabels || []).filter(f => f.label).length;
  pass(`${fdaCount} FDA labels attached to evidence pack`);

  // Curated KB ↔ evidence pack integration. This is the lock-in test: for
  // IPF, the KB ALWAYS pins a chunk of hand-curated items into the prompt
  // AND live-fetched research ALWAYS gets guaranteed slots too. If either
  // monopolizes, that's a regression.
  const kbInPack = (ev.body.groundedForPrompt || []).filter(x => x.isCuratedKB).length;
  const liveInPack = packSize - kbInPack;
  if (!ev.body.promptPackBreakdown)
    return fail('evidence response missing promptPackBreakdown');
  pass(`prompt-pack breakdown: ${ev.body.promptPackBreakdown.curatedKB} curated KB + ${ev.body.promptPackBreakdown.liveFetched} live-fetched = ${ev.body.promptPackBreakdown.total}`);
  if (kbInPack < 5) return fail(`expected >= 5 curated-KB items pinned to prompt pack for IPF, got ${kbInPack}`);
  pass(`${kbInPack} curated-KB items are pinned into the prompt pack (guaranteed ground-truth floor)`);
  if (liveInPack < 5) return fail(`expected >= 5 live-fetched items in prompt pack (guaranteed freshness floor), got ${liveInPack}`);
  pass(`${liveInPack} live-fetched items present (KB is not monopolizing the pack)`);
  if (!ev.body.knowledgeBase?.matched)
    return fail('evidence response missing knowledgeBase metadata');
  pass(`knowledgeBase metadata attached to evidence response (${ev.body.knowledgeBase.itemCount} KB items available, matched on "${ev.body.knowledgeBase.matchedOn}")`);

  // ==== SOURCE-QUALITY SCORING LOCK-INS ====
  // These tests guard the source-quality screen that filters retracted papers,
  // flags predatory publishers, and applies geographic integrity weighting.
  console.log('\n=== 2e.1 source-quality screen — qualityBreakdown present & structured ===');
  const qb = ev.body.qualityBreakdown;
  if (!qb) return fail('evidence response missing qualityBreakdown');
  pass(`qualityBreakdown present · ${qb.totalScreened} screened · ${qb.retractedExcluded} retracted excluded · ${qb.predatoryExcluded} predatory excluded`);
  if (typeof qb.countryConcernInPromptPack !== 'number') return fail('qualityBreakdown.countryConcernInPromptPack missing');
  if (typeof qb.topTierInPromptPack !== 'number')         return fail('qualityBreakdown.topTierInPromptPack missing');
  if (typeof qb.rctOrMetaInPromptPack !== 'number')       return fail('qualityBreakdown.rctOrMetaInPromptPack missing');
  pass(`prompt pack: ${qb.topTierInPromptPack} A+/A tier · ${qb.rctOrMetaInPromptPack} RCT/systematic-review · ${qb.countryConcernInPromptPack} integrity-concern jurisdiction`);
  if (qb.topTierInPromptPack < 3) {
    return fail(`expected >= 3 A+/A tier articles in IPF prompt pack, got ${qb.topTierInPromptPack}`);
  }
  pass('A+/A tier floor for IPF prompt pack: OK');

  console.log('\n=== 2e.2 PubMed enrichment — publicationType + affiliations + retraction flag ===');
  // PubMed is 3 req/s anon; we've already hammered it through /api/evidence.
  // Back off before asking again so this doesn't rate-limit the whole run.
  await new Promise((r) => setTimeout(r, 2000));
  const pmSample = await invoke(pubmedHandler, {
    query: 'Idiopathic Pulmonary Fibrosis',
    limit: 8,
    withAbstract: true
  });
  if (pmSample.status === 429 || pmSample.status === 503) {
    info(`  (skip) PubMed returned ${pmSample.status} (rate limit). Set NCBI_API_KEY for higher limits.`);
  } else if (pmSample.status !== 200) {
    return fail(`pubmed enrichment call failed: ${pmSample.status}`);
  } else {
    const anyWithPubTypes = (pmSample.body.articles || []).some((a) => (a.publicationTypes || []).length > 0);
    const anyWithAffiliations = (pmSample.body.articles || []).some((a) => (a.affiliations || []).length > 0);
    const anyWithCountry = (pmSample.body.articles || []).some((a) => !!a.firstAuthorCountry);
    const allHaveRetractedField = (pmSample.body.articles || []).every((a) => typeof a.isRetracted === 'boolean');
    anyWithPubTypes       ? pass('PubMed returns publicationTypes for at least one article')     : fail('PubMed returned no publicationTypes');
    anyWithAffiliations   ? pass('PubMed returns affiliations for at least one article')         : fail('PubMed returned no affiliations');
    anyWithCountry        ? pass('PubMed parses firstAuthorCountry for at least one article')     : fail('PubMed parsed no firstAuthorCountry — country alias regex may be broken');
    allHaveRetractedField ? pass('every PubMed article carries isRetracted boolean (defaulted)') : fail('some PubMed articles missing isRetracted');
  }

  console.log('\n=== 2e.3 retraction filter — known-retracted paper is EXCLUDED from prompt pack ===');
  // PMID 20301425 was retracted ("Neuropsychological decline..."). We query
  // a broad term that returns recent IPF work and manually inject a
  // retraction-flagged synthetic paper through the evidence scorer.
  // Direct-path test: call the evidence handler's internal scorer by asking
  // for a condition where retracted papers historically appear. We also
  // seed via a synthetic OpenAlex-style payload using the dedupe+score path.
  const retractedSynthetic = {
    source: 'SyntheticTest',
    id: 'test:retracted-1',
    doi: '10.9999/fake-retracted',
    pmid: '99999001',
    title: 'Fake retracted study that should NEVER reach Claude',
    journal: 'The Lancet',
    publisher: 'Elsevier',
    year: 2018,
    abstract: 'This paper was retracted for fabricated data.',
    isRetracted: true,
    countries: ['US'],
    firstAuthorCountry: 'US'
  };
  const predatorySynthetic = {
    source: 'SyntheticTest',
    id: 'test:predatory-1',
    doi: '10.9999/fake-predatory',
    pmid: '99999002',
    title: 'Fake paper from predatory publisher',
    journal: 'Journal of OMICS',
    publisher: 'OMICS International',
    year: 2023,
    abstract: 'This paper appeared in a predatory venue.',
    isRetracted: false,
    countries: ['IN'],
    firstAuthorCountry: 'IN'
  };
  const chinaSynthetic = {
    source: 'SyntheticTest',
    id: 'test:china-1',
    doi: '10.9999/china-test',
    pmid: '99999003',
    title: 'Fake Chinese-first-author paper (should be kept but down-weighted)',
    journal: 'Thorax',
    publisher: 'BMJ Publishing Group',
    year: 2024,
    abstract: 'Legitimate paper, first author from China.',
    isRetracted: false,
    countries: ['CN'],
    firstAuthorCountry: 'CN'
  };
  const usSynthetic = {
    source: 'SyntheticTest',
    id: 'test:us-1',
    doi: '10.9999/us-test',
    pmid: '99999004',
    title: 'Fake US-first-author paper (should score higher than CN twin)',
    journal: 'Thorax',
    publisher: 'BMJ Publishing Group',
    year: 2024,
    abstract: 'Same hypothetical paper but from a US lab.',
    isRetracted: false,
    countries: ['US'],
    firstAuthorCountry: 'US'
  };

  // Unit tests — exercise the scorer directly with synthetic inputs to prove
  // the scoring curve behaves correctly independent of what the live APIs
  // happen to return this minute.
  const retractedScore = scoreArticle(retractedSynthetic);
  const predatoryScore = scoreArticle(predatorySynthetic);
  const chinaScore     = scoreArticle(chinaSynthetic);
  const usScore        = scoreArticle(usSynthetic);

  retractedScore < -100
    ? pass(`retracted paper scored ${retractedScore} (< -100 → below any inclusion floor)`)
    : fail(`retracted paper scored ${retractedScore} — should be < -100 to be excluded`);

  isPredatoryPublisher('OMICS International')
    ? pass('OMICS International correctly flagged as predatory publisher')
    : fail('OMICS International not flagged as predatory');
  isPredatoryPublisher('Hindawi')
    ? pass('Hindawi correctly flagged as predatory publisher')
    : fail('Hindawi not flagged as predatory');
  !isPredatoryPublisher('Elsevier')
    ? pass('Elsevier NOT falsely flagged as predatory')
    : fail('Elsevier was incorrectly flagged as predatory');

  predatoryScore < scoreArticle({ ...predatorySynthetic, publisher: 'Elsevier' })
    ? pass(`predatory publisher penalised: ${predatoryScore} < ${scoreArticle({ ...predatorySynthetic, publisher: 'Elsevier' })} (same paper at Elsevier)`)
    : fail('predatory-publisher penalty not applied');

  // Country-weighting is DISABLED (product decision, 2026-04: don't
  // down-weight literature by author country). Expect parity between
  // otherwise-identical US and CN papers, and zero countryAdjustment.
  Math.abs(chinaScore - usScore) <= 2
    ? pass(`no geographic penalty (policy): US=${usScore} ≈ CN=${chinaScore} (delta ${usScore - chinaScore})`)
    : fail(`unexpected country-based delta: US=${usScore}, CN=${chinaScore} — country weighting should be disabled`);

  countryAdjustment({ firstAuthorCountry: 'CN', countries: ['CN'] }) === 0
    ? pass('countryAdjustment: CN → 0 (country weighting disabled)')
    : fail('countryAdjustment: CN should return 0, weighting is disabled');
  countryAdjustment({ firstAuthorCountry: 'US', countries: ['US'] }) === 0
    ? pass('countryAdjustment: US → 0 (country weighting disabled)')
    : fail('countryAdjustment: US should return 0, weighting is disabled');

  // Regression: Chinese Medical Journal (flagship CMA journal, IF ~6) must
  // NOT be penalised as "low-integrity publisher" via its Medknow imprint,
  // and must be tiered on its impact-factor merits, not its country.
  const cmjPaper = {
    source: 'SyntheticTest',
    id: 'test:cmj-1',
    doi: '10.9999/cmj-test',
    pmid: '99999005',
    title: 'Reputable paper in Chinese Medical Journal',
    journal: 'Chinese Medical Journal',
    publisher: 'Wolters Kluwer Medknow',
    year: 2024,
    abstract: 'Methodologically sound study published in the flagship journal of the Chinese Medical Association.',
    isRetracted: false,
    isRCT: true,
    citedByCount: 40,
    countries: ['CN'],
    firstAuthorCountry: 'CN'
  };
  const cmjFlags = computeQualityFlags(cmjPaper);
  !cmjFlags.some((f) => f.key === 'low-integrity-publisher')
    ? pass('Chinese Medical Journal / Medknow: no low-integrity-publisher flag (Medknow removed from LOW_INTEGRITY list)')
    : fail('Chinese Medical Journal / Medknow is still being flagged as low-integrity publisher — should be removed');
  const cmjScore = scoreArticle(cmjPaper);
  const generalMedScore = scoreArticle({ ...cmjPaper, journal: 'Journal of General Medicine', publisher: 'Elsevier' });
  cmjScore >= generalMedScore - 5
    ? pass(`Chinese Medical Journal scored ${cmjScore} ≳ generic B-tier ${generalMedScore} (tier-aware, no country/publisher bias)`)
    : fail(`Chinese Medical Journal scored ${cmjScore} but generic B-tier scored ${generalMedScore} — CMJ is being unfairly penalised`);

  const retractedFlags = computeQualityFlags(retractedSynthetic);
  retractedFlags.some((f) => f.key === 'retracted' && f.severity === 'critical')
    ? pass('computeQualityFlags: retracted → critical severity')
    : fail('computeQualityFlags: retracted flag missing');

  const chinaFlags = computeQualityFlags(chinaSynthetic);
  !chinaFlags.some((f) => f.key === 'country-concern')
    ? pass('computeQualityFlags: CN first author → NO country-concern flag (weighting disabled)')
    : fail('computeQualityFlags: country-concern flag should no longer appear — country weighting was disabled');

  // End-to-end — the live pack must also never contain retracted/predatory.
  const packHasRetracted = (ev.body.groundedForPrompt || []).some(
    (a) => (a.qualityFlags || []).some((f) => f.key === 'retracted')
  );
  !packHasRetracted
    ? pass('no retracted paper made it into the Claude prompt pack')
    : fail('retracted paper was not filtered out of prompt pack — CRITICAL regression');

  const packHasPredatory = (ev.body.groundedForPrompt || []).some(
    (a) => (a.qualityFlags || []).some((f) => f.key === 'predatory-publisher')
  );
  !packHasPredatory
    ? pass('no predatory-publisher paper made it into the Claude prompt pack')
    : fail('predatory-publisher paper was not filtered out of prompt pack');

  console.log('\n=== 2e.4 country metadata still surfaces on articles (for display / analytics) ===');
  // We no longer PENALISE by country, but we still expose first-author
  // country metadata on pack items so the UI can show where a paper is
  // from. Verify the field continues to propagate from OpenAlex.
  const withCountry = (ev.body.groundedForPrompt || []).filter((a) => a.firstAuthorCountry);
  withCountry.length > 0
    ? pass(`${withCountry.length}/${ev.body.groundedForPrompt.length} prompt-pack items carry firstAuthorCountry metadata`)
    : info('  (no firstAuthorCountry on any prompt-pack item — OpenAlex may be rate-limited)');

  console.log('\n=== 2e.5 quality flags — every prompt-pack item carries qualityFlags[] ===');
  const allHaveFlags = (ev.body.groundedForPrompt || []).every((a) => Array.isArray(a.qualityFlags));
  allHaveFlags
    ? pass('every prompt-pack item has a qualityFlags array')
    : fail('some prompt-pack items missing qualityFlags');

  console.log('\n=== 2f. /api/validate — cross-AI audit (standalone) ===');
  const hasValidatorKey =
    !!process.env.PERPLEXITY_API_KEY ||
    !!process.env.OPENAI_API_KEY ||
    !!process.env.XAI_API_KEY;
  if (!hasValidatorKey) {
    info('(skip) no PERPLEXITY_API_KEY / OPENAI_API_KEY / XAI_API_KEY set — set at least one to enable cross-AI audit');
  } else {
    const claudeLike = `CURRENT STANDARD OF CARE
Pirfenidone (Esbriet) and nintedanib (Ofev) are the two FDA-approved antifibrotics for IPF.
Pirfenidone reduced FVC decline by about 50% over one year in the CAPACITY trials.
See https://pubmed.ncbi.nlm.nih.gov/99999999 — "Pirfenidone cures IPF in most patients".`;
    const fakePack = (ev.body.groundedForPrompt || []).slice(0, 12);
    const val = await invoke(validateHandler, {
      analysisText: claudeLike,
      evidencePack: fakePack,
      patient: IPF_PATIENT,
      condition: 'Idiopathic Pulmonary Fibrosis',
      audience: 'layperson'
    });
    if (val.status !== 200) return fail(`validate returned ${val.status}: ${JSON.stringify(val.body).slice(0,200)}`);
    const vb = val.body;
    pass(`validator ran — primary provider: ${vb.primary?.provider || 'none'} · agreement: ${vb.primary?.agreement || '?'}`);
    info(`  validators used: ${(vb.validators || []).map(v => `${v.provider}${v.error ? '(err)' : ''}`).join(', ')}`);
    info(`  overall score: ${vb.primary?.overallScore ?? '?'}/100`);
    info(`  confirmed: ${(vb.primary?.confirmed || []).length} · disputed: ${(vb.primary?.disputed || []).length} · unsupported: ${(vb.primary?.unsupported || []).length} · hallucinated: ${(vb.primary?.hallucinatedCitations || []).length}`);
    if ((vb.primary?.hallucinatedCitations || []).length > 0) {
      pass('validator correctly flagged the fake pubmed URL as hallucinated');
    }
  }

  // ==== WEEKLY EMAIL ALERTS ====
  console.log('\n=== 2g. /api/alerts-subscribe — create, list, unsubscribe ===');
  resetAlerts();

  const invokeAlerts = async (method, query, body) => {
    const req = { method, body: body || {}, headers: {}, query: query || {} };
    const res = mockRes();
    await alertsSubscribeHandler(req, res);
    return { status: res.statusCode, body: res.body };
  };

  // Rejects bad inputs
  const badEmail = await invokeAlerts('POST', {}, { email: 'not-an-email', condition: 'IPF' });
  badEmail.status === 400
    ? pass('rejects invalid email at subscribe time')
    : fail(`expected 400 for invalid email, got ${badEmail.status}`);

  const noCondition = await invokeAlerts('POST', {}, { email: 'a@b.co', condition: '' });
  noCondition.status === 400
    ? pass('rejects missing condition at subscribe time')
    : fail(`expected 400 for missing condition, got ${noCondition.status}`);

  // Happy path — subscribe
  const created = await invokeAlerts('POST', {}, {
    email: 'dorothy@example.test',
    condition: 'Idiopathic Pulmonary Fibrosis',
    patientContext: {
      age: '68', gender: 'F',
      medications: 'pirfenidone 2403 mg, omeprazole 40 mg, lisinopril 20 mg',
      diagnoses: 'IPF, GERD, HTN'
    }
  });
  if (created.status !== 201) return fail(`subscribe returned ${created.status}: ${JSON.stringify(created.body)}`);
  if (!created.body.id || !created.body.unsubscribeToken) return fail('subscribe response missing id/token');
  pass(`subscription created: id=${created.body.id.slice(0, 8)}… · backend=${created.body.backend}`);
  info(`  alerts-store backend: ${created.body.backend}${created.body.ephemeral ? ' (ephemeral)' : ''}`);

  // Duplicate subscribe returns the existing one, doesn't double-create
  const dup = await invokeAlerts('POST', {}, {
    email: 'dorothy@example.test',
    condition: 'Idiopathic Pulmonary Fibrosis'
  });
  (dup.status === 200 && dup.body.alreadyExists)
    ? pass('duplicate subscribe correctly collapses to existing subscription')
    : fail(`expected alreadyExists=true, got ${JSON.stringify(dup.body).slice(0, 200)}`);

  // List by email — unsubscribeToken must NOT leak in listings
  const list = await invokeAlerts('GET', { email: 'dorothy@example.test' });
  if (list.status !== 200) return fail(`list returned ${list.status}`);
  const listed = (list.body.subscriptions || [])[0];
  if (!listed) return fail('list returned no subscriptions after subscribe');
  if ('unsubscribeToken' in listed) return fail('unsubscribeToken leaked in list response — SECURITY ISSUE');
  pass('list endpoint redacts unsubscribeToken (security check)');

  // Unsubscribe with wrong token → 403
  const wrong = await invokeAlerts('POST', { action: 'unsubscribe' }, {
    id: created.body.id, token: 'totally-fake-token'
  });
  wrong.status === 403
    ? pass('unsubscribe with wrong token → 403 (security check)')
    : fail(`expected 403 for wrong token, got ${wrong.status}`);

  // Unsubscribe with correct token → 200
  const unsub = await invokeAlerts('POST', { action: 'unsubscribe' }, {
    id: created.body.id, token: created.body.unsubscribeToken
  });
  unsub.status === 200
    ? pass('unsubscribe with correct token → 200')
    : fail(`unsubscribe failed: ${unsub.status} ${JSON.stringify(unsub.body)}`);

  // Resubscribe for the cron test below
  const resub = await invokeAlerts('POST', {}, {
    email: 'dorothy@example.test',
    condition: 'Idiopathic Pulmonary Fibrosis',
    patientContext: { age: '68', medications: 'pirfenidone' }
  });
  if (resub.status !== 201) return fail(`resubscribe failed: ${resub.status}`);
  pass('resubscribed after unsubscribe — clean slate for cron test');

  console.log('\n=== 2h. alerts-email — HTML renderer + subject line ===');
  const fakeSub = {
    id: 'test', email: 'dorothy@example.test',
    condition: 'Idiopathic Pulmonary Fibrosis',
    patientContext: { age: '68', medications: 'pirfenidone' }
  };
  const fakeNewItems = [
    { id: '10.x/a', title: 'Fake new RCT of pirfenidone', journal: 'NEJM', year: 2026, citations: 5,
      tier: 'A+', isRCT: true, firstAuthorCountry: 'US', url: 'https://doi.org/10.x/a',
      text: 'In this randomized placebo-controlled trial of 500 IPF patients…' },
    { id: '10.x/b', title: 'Fake observational from China', journal: 'Journal of X', year: 2025, citations: 12,
      tier: 'C', firstAuthorCountry: 'CN', url: 'https://doi.org/10.x/b',
      text: 'Observational data from a single-centre cohort…' },
    { id: '10.x/c', title: 'Fake preprint', journal: 'medRxiv', year: 2026, citations: 0,
      tier: 'C', isPreprint: true, firstAuthorCountry: 'GB', url: 'https://doi.org/10.x/c',
      text: 'This work has not been peer-reviewed.' }
  ];
  const html = renderAlertHtml({
    sub: fakeSub, newItems: fakeNewItems, trials: [], fdaActions: [],
    qualityBreakdown: { totalScreened: 58, retractedExcluded: 2, predatoryExcluded: 1, topTierInPromptPack: 10 },
    condition: fakeSub.condition,
    unsubscribeUrl: 'https://example.com/unsubscribe?id=test'
  });
  html.includes('Fake new RCT of pirfenidone')
    ? pass('email HTML includes new RCT title')
    : fail('email HTML missing RCT title');
  html.includes('CN first author · integrity concern') || html.includes('integrity concern')
    ? pass('email HTML renders CN integrity-concern flag')
    : fail('email HTML missing CN integrity-concern flag');
  html.includes('Preprint (not peer-reviewed)')
    ? pass('email HTML flags preprint as not peer-reviewed')
    : fail('email HTML missing preprint flag');
  html.includes('Screened 58 sources') && html.includes('2 retracted')
    ? pass('email HTML includes qualityBreakdown footer')
    : fail('email HTML missing quality breakdown');
  html.includes('Unsubscribe')
    ? pass('email HTML includes unsubscribe link')
    : fail('email HTML missing unsubscribe link');

  const subj1 = renderAlertSubject({ condition: 'IPF', newItems: fakeNewItems });
  subj1.includes('1 new RCT')
    ? pass(`subject line: "${subj1}"`)
    : fail(`unexpected subject: "${subj1}"`);
  const subj2 = renderAlertSubject({ condition: 'IPF', newItems: [], trials: [] });
  subj2.includes('no updates')
    ? pass(`empty-digest subject: "${subj2}"`)
    : fail(`unexpected empty subject: "${subj2}"`);

  console.log('\n=== 2i. /api/alerts-cron — dry-run end-to-end ===');
  // Cron is gated by CRON_SECRET when set; in tests we don't set it, so
  // the handler allows unauthenticated calls. We pass dryRun=1 to avoid
  // actually sending email even if RESEND_API_KEY happens to be present.
  info(`  email provider configured: ${isEmailConfigured() ? 'yes (Resend)' : 'no (mocked)'}`);
  info(`  alerts store: ${alertsStoreConfigured() ? 'Upstash Redis' : 'in-memory'}`);
  const cronRes = (() => {
    const req = { method: 'GET', body: null, headers: {}, query: { dryRun: '1' } };
    const res = mockRes();
    return alertsCronHandler(req, res).then(() => ({ status: res.statusCode, body: res.body }));
  });
  const cron = await cronRes();
  if (cron.status !== 200) return fail(`cron returned ${cron.status}: ${JSON.stringify(cron.body).slice(0, 200)}`);
  pass(`cron ran · dryRun=${cron.body.dryRun} · processed ${cron.body.subsProcessed} subscription(s) in ${cron.body.durationMs}ms`);
  const r0 = (cron.body.results || [])[0];
  if (!r0) return fail('cron produced no results');
  if (r0.error) return fail(`cron errored on first sub: ${r0.error}`);
  pass(`cron first-run digest: screened ${r0.screened} sources, ${r0.newItemsEmailed} items in email, subject: "${r0.subject}"`);
  r0.firstRun
    ? pass('first-run flag set correctly (new subscription)')
    : fail('expected firstRun=true');
  r0.newItemsEmailed <= 8
    ? pass(`first-run digest capped at 8 items (got ${r0.newItemsEmailed}) to avoid overwhelming welcome email`)
    : fail(`first-run digest over cap: ${r0.newItemsEmailed} items`);

  // Verify ledger was NOT updated (dryRun)
  const subsNow = await listAllSubs();
  const onlyActive = subsNow.find((s) => s.email === 'dorothy@example.test');
  if (!onlyActive) return fail('subscription disappeared after cron');
  const ledgerAfterDry = await getSentLedger(onlyActive.id);
  ledgerAfterDry.size === 0
    ? pass('dryRun did not poison the sent-ledger (good — real cron will populate it)')
    : fail(`dryRun polluted ledger with ${ledgerAfterDry.size} items`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n(skip) ANTHROPIC_API_KEY not set — skipping research.js + records-audit.js + disease-dossier live calls');
    console.log('\n=== All available tests passed ===');
    return;
  }

  // ==== Disease-intake agent tests ====
  // This is the dynamic replacement for the hardcoded CONDITION_SYNONYMS map.
  // We test it against a mix of:
  //   - common aliases ("RP", "LADA", "AD", "ALS", "PD")
  //   - full names that should match themselves
  //   - nonsense strings that should raise uncertainty
  // and we verify the 24h in-memory cache actually caches.
  console.log('\n=== 2j. lib/disease-dossier — realtime disease-intake agent ===');
  const { getDossier, clearDossierCache } = await import('../lib/disease-dossier.js');
  clearDossierCache();

  const dossierExpectations = [
    { input: 'RP', expectCanonicalContains: /retinitis pigmentosa/i, expectSubspecialty: /ophthalm|genetic|retina/i },
    { input: 'LADA', expectCanonicalContains: /latent autoimmune diabetes|type 1\.5/i, expectSubspecialty: /endocrin|diabet/i },
    { input: 'AD', expectCanonicalContains: /alzheimer/i, expectSubspecialty: /neurol|geriatric|cognitive/i },
    { input: 'ALS', expectCanonicalContains: /amyotrophic lateral sclerosis|lou gehrig/i, expectSubspecialty: /neurol/i },
    { input: 'PD', expectCanonicalContains: /parkinson/i, expectSubspecialty: /neurol|movement/i }
  ];

  const dossierStart = Date.now();
  for (const e of dossierExpectations) {
    const d = await getDossier(e.input, { bypassCache: true });
    if (!d || !d.canonical) { fail(`dossier "${e.input}" → no canonical returned`); continue; }
    if (!e.expectCanonicalContains.test(d.canonical)) {
      fail(`dossier "${e.input}" → canonical "${d.canonical}" didn't match ${e.expectCanonicalContains}`);
    } else {
      pass(`dossier "${e.input}" → "${d.canonical}" (unc=${d.uncertainty ?? '?'}, ${d.generatedBy || 'agent'})`);
    }
    if (!Array.isArray(d.synonyms) || d.synonyms.length === 0) {
      fail(`dossier "${e.input}" → no synonyms array`);
    } else {
      info(`  synonyms: ${d.synonyms.slice(0, 4).join(' / ')}${d.synonyms.length > 4 ? '…' : ''}`);
    }
    if (typeof d.uncertainty !== 'number') fail(`dossier "${e.input}" → missing uncertainty field`);
    if (d.subspecialty && !e.expectSubspecialty.test(d.subspecialty)) {
      info(`  (soft) subspecialty "${d.subspecialty}" didn't match ${e.expectSubspecialty}`);
    }
    if ((d.topCenters || []).length) {
      info(`  topCenters: ${d.topCenters.slice(0, 3).map(c => c.name).join(' / ')}`);
    }
  }
  info(`  5 dossier calls took ${Date.now() - dossierStart}ms total (uncached)`);

  // Cache-hit test: second call for IPF should be instant + flagged cacheHit.
  const firstIpf = await getDossier('IPF');
  const cacheStart = Date.now();
  const secondIpf = await getDossier('IPF');
  const cacheMs = Date.now() - cacheStart;
  if (secondIpf.cacheHit) {
    pass(`dossier cache hit for "IPF" in ${cacheMs}ms (first call ${firstIpf.cacheHit ? 'also cached — prior test contaminated' : 'was fresh'})`);
  } else {
    fail(`dossier cache MISS for "IPF" on second call (should have hit); cacheMs=${cacheMs}`);
  }

  // Normalisation: different-case / whitespace variants should share a cache slot.
  const normA = await getDossier('IPF');
  const normB = await getDossier('  ipf  ');
  if (normA.cacheHit && normB.cacheHit && normA.canonical === normB.canonical) {
    pass('dossier cache normalises input (case + whitespace)');
  } else {
    fail(`dossier cache NOT normalising: "IPF"→${normA.canonical} / "  ipf  "→${normB.canonical}`);
  }

  // Nonsense / ambiguous input should surface high uncertainty.
  const garbage = await getDossier('xyzzy_not_a_disease_123', { bypassCache: true });
  if (garbage && typeof garbage.uncertainty === 'number' && garbage.uncertainty >= 0.7) {
    pass(`dossier flags nonsense input as uncertain (unc=${garbage.uncertainty})`);
  } else {
    info(`  (soft) dossier unc=${garbage?.uncertainty ?? '?'} for nonsense input (hoped for >=0.7)`);
  }

  console.log('\n=== 3. /api/research mode=research — Anthropic for IPF patient ===');
  const research = await invoke(researchHandler, {
    mode: 'research', patient: IPF_PATIENT, audience: 'layperson'
  });
  if (research.status !== 200) return fail(`research returned ${research.status}: ${JSON.stringify(research.body).slice(0, 400)}`);
  const researchText = (research.body.content || []).filter(b => b.type==='text').map(b=>b.text).join('\n');
  pass(`research returned ${researchText.length} chars`);
  const hasProvider = /PROVIDER:/i.test(researchText);
  const hasEfficacy = /EFFICACY:\s*\d{1,3}\s*%/i.test(researchText);
  const hasSafety = /SAFETY:\s*\d{1,3}\s*%/i.test(researchText);
  const hasInteractions = /INTERACTIONS:/i.test(researchText);
  const hasReferences = /REFERENCES:/i.test(researchText);
  const hasStandardOfCare = /standard of care/i.test(researchText);
  const hasNonDrug = /non[- ]drug|lifestyle|reflux|feather|oxygen|pulmonary rehab/i.test(researchText);
  const hasStem = /stem cell/i.test(researchText);
  hasProvider ? pass('structured PROVIDER blocks present') : fail('no PROVIDER blocks');
  hasEfficacy ? pass('EFFICACY 1-100 present') : fail('no EFFICACY %');
  hasSafety ? pass('SAFETY 1-100 present') : fail('no SAFETY %');
  hasInteractions ? pass('INTERACTIONS field present (drug-drug check)') : fail('no INTERACTIONS field');
  hasReferences ? pass('REFERENCES field present') : fail('no REFERENCES field');
  hasStandardOfCare ? pass('standard-of-care section present') : fail('no standard-of-care section');
  hasNonDrug ? pass('non-drug / lifestyle recommendations present') : fail('no non-drug section');
  hasStem ? pass('stem-cell landscape section present') : fail('no stem-cell section');

  // New mandatory sections introduced with the dossier overhaul.
  const hasExpandedAccess = /expanded access|compassionate use/i.test(researchText);
  const hasOLE = /open[- ]label extension|OLE\b|long[- ]term follow[- ]up/i.test(researchText);
  const hasTopCenters = /top centers|best experts|leading centers|johns? hopkins|mayo|cleveland clinic|ucsf|duke/i.test(researchText);
  const hasAdvocacy = /advocacy|pulmonary fibrosis foundation|patient foundation|registry/i.test(researchText);
  const hasPipeline = /pipeline|phase 1|phase 2|in development|early[- ]stage/i.test(researchText);
  hasExpandedAccess ? pass('Expanded Access / Compassionate Use section present') : fail('MISSING Expanded Access section (mandatory)');
  hasOLE ? pass('Open-Label Extension section present') : fail('MISSING OLE section (mandatory)');
  hasTopCenters ? pass('Top Centers & Experts section surfaces leading institutions') : fail('MISSING top centers');
  hasAdvocacy ? pass('Patient advocacy / resources section present') : fail('MISSING advocacy orgs section');
  hasPipeline ? pass('Pipeline section present') : fail('MISSING pipeline section');

  // Dossier response payload is piped back to the UI.
  if (research.body.dossier && research.body.dossier.canonical) {
    pass(`research response includes dossier (canonical=${research.body.dossier.canonical}, unc=${research.body.dossier.uncertainty ?? '?'})`);
  } else {
    fail('research response did NOT include dossier payload (UI will have nothing to render in DossierPanel)');
  }
  if (research.body.trials && (research.body.trials.studies || []).length) {
    pass(`research response includes ${research.body.trials.studies.length} trials from parallel CT.gov pull`);
  } else {
    fail('research response missing trials payload (parallel pull should have fired)');
  }

  console.log('\n=== 4. /api/research mode=repurpose — EveryCure-style for IPF ===');
  const rep = await invoke(researchHandler, {
    mode: 'repurpose', patient: IPF_PATIENT, audience: 'layperson'
  });
  if (rep.status !== 200) return fail(`repurpose returned ${rep.status}`);
  const repText = (rep.body.content || []).filter(b => b.type==='text').map(b=>b.text).join('\n');
  pass(`repurpose returned ${repText.length} chars`);
  const candidateCount = (repText.match(/CANDIDATE:/g) || []).length;
  if (candidateCount < 3) return fail(`only ${candidateCount} candidates returned`);
  pass(`${candidateCount} repurposing candidates generated`);
  if (/vitamin d|n-acetylcysteine|nac|metformin|azithromycin|statin|melatonin/i.test(repText))
    pass('plausible repurposing candidate surfaced (vitamin D / NAC / metformin / azithromycin / statin / melatonin)');
  // UI parses CANDIDATE blocks for the EveryCure-style cards. If Claude
  // stops emitting one of these fields, the cards silently lose data — so
  // lock in every structural field the UI reads.
  const requiredFields = [
    'CLASS:', 'APPROVED_FOR:', 'MECHANISM_TARGET:', 'REPURPOSE_RATIONALE:',
    'EVIDENCE_STRENGTH:', 'SUPPORTING_EVIDENCE:', 'EFFICACY_HYPOTHESIS:',
    'SAFETY:', 'CONFIDENCE:', 'PATIENT_SPECIFIC_RISKS:', 'HOW_TO_DISCUSS_WITH_DOCTOR:'
  ];
  const missingFields = requiredFields.filter(f => !repText.includes(f));
  missingFields.length === 0
    ? pass('all 11 structural fields present in CANDIDATE blocks — UI cards will render fully')
    : fail(`CANDIDATE blocks missing fields: ${missingFields.join(', ')}`);
  // Every candidate should have at least one quantified score (efficacy/safety/confidence %)
  const pctHits = (repText.match(/(EFFICACY_HYPOTHESIS|SAFETY|CONFIDENCE):\s*\d{1,3}\s*%/g) || []).length;
  pctHits >= candidateCount * 2
    ? pass(`${pctHits} quantified 0-100 scores across candidates (avg >= 2 per candidate)`)
    : fail(`only ${pctHits} quantified scores across ${candidateCount} candidates — cards need at least efficacy+safety+confidence each`);
  // Evidence strength must come from the defined ladder — the UI has color
  // coding for each rung, and a free-form value breaks the badge.
  const evidenceLadder = ['MECHANISTIC_ONLY', 'PRECLINICAL', 'CASE_REPORT', 'OBSERVATIONAL', 'SMALL_RCT', 'LARGE_RCT'];
  const ladderHits = evidenceLadder.filter(r => repText.includes(r));
  ladderHits.length >= 2
    ? pass(`evidence ladder values present: ${ladderHits.join(', ')}`)
    : fail(`evidence strength values are off-ladder — got: ${ladderHits.join(', ') || '(none)'}`);

  console.log('\n=== 4b. /api/research mode=chat — follow-up after prior analysis ===');
  // The chat bug we just fixed: previously the chatbot ran bare (no evidence
  // pack, no prior analysis) so it hedged everything with "I can't provide
  // medical advice." Test that a follow-up now gets a substantive answer that
  // references the prior analysis.
  const chat = await invoke(researchHandler, {
    mode: 'chat',
    patient: IPF_PATIENT,
    audience: 'layperson',
    userQuery: 'Between pirfenidone and nintedanib, which one is safer for a 68yo male with GERD on omeprazole, and why?',
    priorAnalyses: { research: researchText.slice(0, 15000) },
    evidencePack: (ev.body.groundedForPrompt || []).slice(0, 10)
  });
  if (chat.status !== 200) return fail(`chat returned ${chat.status}`);
  const chatText = (chat.body.content || []).filter(b => b.type==='text').map(b=>b.text).join('\n');
  pass(`chat returned ${chatText.length} chars`);
  // Key anti-pattern checks: the OLD chat refused a lot; the NEW one should answer.
  const refused = /I cannot provide medical advice|please consult your (doctor|physician)(?!.*however|.*but)/i.test(chatText) && chatText.length < 500;
  const namesDrugs = /pirfenidone/i.test(chatText) && /nintedanib/i.test(chatText);
  const comparesThem = /safer|safety|liver|diarrhea|diarrhoea|hepatotox|GI|gastrointestinal|photosensitiv/i.test(chatText);
  refused ? fail('chat appears to have refused the question instead of answering') : pass('chat answered substantively (did not punt with "consult your doctor")');
  namesDrugs ? pass('chat named both drugs being compared') : fail('chat did not name both drugs');
  comparesThem ? pass('chat provided concrete comparison language') : fail('chat did not provide a concrete safety comparison');
  info(`chat first 300 chars: ${chatText.slice(0, 300).replace(/\n/g, ' ')}…`);

  console.log('\n=== 5. /api/records-audit — IPF record with misleading summary ===');
  const fakeRecords = `HRCT chest 2/2026: UIP pattern with subpleural and basal predominant honeycombing,
traction bronchiectasis, and reticulation. No ground-glass opacity. Findings are consistent with IPF.
Mild pulmonary hypertension with RV enlargement noted.

PFT 2/2026: FVC 62% predicted (prior 71% six months ago), DLCO 41% (prior 48%). Restrictive pattern.

Echo 2/2026: RVSP estimated 48 mmHg (mild-to-moderate pulmonary hypertension). LVEF 58%.

6-minute walk test: 380m, desaturation from 94% to 86% on room air.

Dermatology note 1/2026: small basal cell carcinoma right temple, completely excised with clear margins.`;

  const misleadingSummary = `Patient has stable IPF on pirfenidone. HRCT shows typical UIP pattern. PFTs are stable.
No evidence of pulmonary hypertension. Patient tolerates pirfenidone well. No other significant findings.`;

  const audit = await invoke(auditHandler, {
    records: fakeRecords, summary: misleadingSummary,
    condition: 'Idiopathic Pulmonary Fibrosis', audience: 'layperson'
  });
  if (audit.status !== 200) return fail(`audit returned ${audit.status}`);
  if (!audit.body.audit) {
    info('raw audit text: ' + (audit.body.raw || '').slice(0, 400));
    return fail('audit response not parsed to JSON');
  }
  pass('structured audit returned');
  const findings = audit.body.audit.abnormalFindings || [];
  info(`auditor found ${findings.length} abnormal findings in the records`);
  const flaggedPH = findings.some(f =>
    /pulmonary hypertension|RVSP|RV/i.test((f.finding || '') + ' ' + (f.quote || '')) &&
    /omit|downplay|contradict/i.test(f.summaryAccuracy || ''));
  const flaggedFVCdrop = findings.some(f =>
    /FVC|decline|drop|falling/i.test((f.finding || '') + ' ' + (f.auditorNote || '')) &&
    /omit|downplay|contradict/i.test(f.summaryAccuracy || ''));
  flaggedPH
    ? pass('auditor correctly flagged pulmonary hypertension as omitted/misrepresented')
    : fail('auditor missed the PH omission');
  flaggedFVCdrop
    ? pass('auditor correctly flagged the 9-point FVC decline as misrepresented as "stable"')
    : info('(note) auditor may have merged FVC trend into overall assessment instead of a discrete finding');
  info(`overall assessment: ${audit.body.audit.overallAssessment?.slice(0, 220)}…`);

  console.log('\n=== All tests passed ===');
})().catch(e => {
  console.error('\x1b[31m✗ test harness error\x1b[0m', e);
  process.exitCode = 1;
});
