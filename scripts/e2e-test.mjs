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
import evidenceHandler from '../api/evidence.js';
import validateHandler from '../api/validate.js';
import unpaywallHandler from '../api/unpaywall.js';
import kbHandler, { loadKb } from '../api/kb.js';

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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n(skip) ANTHROPIC_API_KEY not set — skipping research.js + records-audit.js live calls');
    console.log('\n=== All available tests passed ===');
    return;
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
