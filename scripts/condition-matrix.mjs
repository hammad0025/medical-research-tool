#!/usr/bin/env node
// Condition-matrix invariant test — curated AND dynamic (non-curated) conditions.
//
// Two modes:
//   OFFLINE STRUCTURAL (default): no server, no LLM, no network. Validates
//     - I5: KB JSON schema for data/kb/*.json (refs resolve, honest accessLevel,
//           no model-authored DOIs/URLs in summaries, unique ids)
//     - I3: lib/kb.js loadKb serves excludedAgents + redFlags regardless of the
//           `reviewed` flag (via a synthetic reviewed:false dynamic KB)
//     - I1: excluded/failed agents never survive as repurpose CANDIDATE blocks
//     - I2: one candidate's data can never overwrite another's when a CANDIDATE:
//           delimiter is dropped (the Magnesium/Lumateperone field-bleed bug)
//     - I4: trials scoring — age-ineligible penalty, 0-100 bounds, no
//           enrolling-trial "stopped" flag
//   LIVE (--live, when localhost:3000 + keys reachable): gather+synthesize per
//     condition and assert I1-I5 against the produced report. NOT run here.
//
// Run:
//   node scripts/condition-matrix.mjs            # offline structural
//   node scripts/condition-matrix.mjs --live     # live matrix (needs server+keys)
//   MRT_BASE_URL=http://localhost:3000 node scripts/condition-matrix.mjs --live
//
// Exits non-zero on any invariant failure. Degrades gracefully with clear skips.

import './test-helpers/isolate-persistent-stores.mjs';

import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

import { loadKb, listKbs } from '../lib/kb.js';
import { putDynamicKb, _resetDynamicKbForTests } from '../lib/kb-store.js';
import {
  filterExcludedRepurposeCandidates,
  filterExcludedAgentMentions,
  excludedAgentNames,
  assertNoForeignEntities
} from '../lib/report-polish.js';
import {
  applyPatientPromiseAdjustment,
  normalizePromise
} from '../api/trials.js';
import {
  assessGroundingSufficiency,
  buildEvidenceGradeBlock
} from '../api/research.js';
import { validateExtract, assembleKbFromExtract, drugKeyFromName } from '../lib/kb-builder.js';
import { loadProductionReportParsers } from './test-helpers/production-report-parsers.mjs';

const pass = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
const skip = (m) => console.log(`\x1b[90m∅ skip\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const KB_DIR = path.join(ROOT, 'data', 'kb');

const LIVE = process.argv.includes('--live');
const BASE_URL = process.env.MRT_BASE_URL || 'http://localhost:3000';
const { parseCandidates } = loadProductionReportParsers();

// ---------------------------------------------------------------------------
// Condition matrix — both curated and genuinely non-curated/dynamic entries.
// `requiresServer` rows are only exercised in --live mode.
// ---------------------------------------------------------------------------
const CONDITION_MATRIX = [
  { name: 'Idiopathic Pulmonary Fibrosis', kind: 'curated', kbSlug: 'ipf', requiresServer: true },
  { name: 'Breast Cancer', kind: 'curated', kbSlug: 'breast-cancer', requiresServer: true },
  { name: 'Bipolar Disorder', kind: 'curated', kbSlug: 'bipolar-disorder', requiresServer: true },
  // Genuinely non-curated Mondo registry entries (no data/kb/*.json file) — the
  // dynamic-brain path. These MUST exercise the build/fallback ladder live.
  { name: 'Tuberculous fibrosis of lung', kind: 'dynamic', kbSlug: null, requiresServer: true },
  { name: 'Alkaptonuria', kind: 'dynamic', kbSlug: null, requiresServer: true },
  { name: 'Niemann-Pick disease type C', kind: 'dynamic', kbSlug: null, requiresServer: true }
];

console.log('\n=== Condition matrix — invariant test ===');
console.log(`mode: ${LIVE ? 'LIVE' : 'OFFLINE STRUCTURAL'}  base=${LIVE ? BASE_URL : '(n/a)'}\n`);

// ===========================================================================
// SYNTAX GUARD — a SyntaxError in research.js kills every gather/synth call.
// ===========================================================================
try {
  execSync('node --check api/research.js', { cwd: ROOT, stdio: 'pipe' });
  pass('api/research.js parses');
} catch (e) {
  fail(`api/research.js SyntaxError: ${String(e.stderr || e.message).split('\n')[0]}`);
}

// ===========================================================================
// I5 — KB JSON schema validation (data/kb/*.json)
// ===========================================================================
head('I5 — KB JSON schema (data/kb/*.json)');

const ACCESS_LEVELS = new Set(['full-text', 'abstract', 'metadata-only', 'dossier']);
const ID_TOKEN = /(doi\.org|pubmed\.ncbi|https?:\/\/|\bpmid\b)/i;

const validateKbSchema = (kb, file) => {
  const errs = [];
  if (!kb.condition) errs.push('missing condition');
  if (!kb.slug) errs.push('missing slug');
  if (!Array.isArray(kb.items)) { errs.push('items not an array'); return errs; }

  const ids = new Set();
  for (const it of kb.items) {
    if (!it.id) { errs.push('item missing id'); continue; }
    if (ids.has(it.id)) errs.push(`duplicate item id ${it.id}`);
    ids.add(it.id);
    if (!it.title) errs.push(`item ${it.id} missing title`);
    if (it.accessLevel && !ACCESS_LEVELS.has(it.accessLevel)) {
      errs.push(`item ${it.id} bad accessLevel "${it.accessLevel}"`);
    }
    // Editorial summary must not contain a raw DOI/URL/PMID token — those belong
    // in the structured doi/pmid/url fields, never authored into prose.
    if (it.summary && ID_TOKEN.test(it.summary)) {
      errs.push(`item ${it.id} summary contains a raw identifier/URL`);
    }
  }

  const refResolves = (ref) => typeof ref === 'string' && ids.has(ref);
  for (const f of kb.canonicalFacts || []) {
    for (const r of f.evidenceRefs || []) {
      if (!refResolves(r)) errs.push(`canonicalFact ref "${r}" does not resolve`);
    }
  }
  for (const l of kb.lifestyleRecommendations || []) {
    for (const r of l.evidenceRefs || []) {
      if (!refResolves(r)) errs.push(`lifestyle ref "${r}" does not resolve`);
    }
  }
  for (const x of kb.excludedAgents || []) {
    if (!x.name) errs.push('excludedAgent missing name');
    if (!x.reason) errs.push(`excludedAgent ${x.name || '?'} missing reason`);
    if (x.evidenceRef && !refResolves(x.evidenceRef)) {
      errs.push(`excludedAgent ${x.name || '?'} ref "${x.evidenceRef}" does not resolve`);
    }
  }
  for (const d of kb.pipelineDrugs || []) {
    if (!d.name) errs.push('pipelineDrug missing name');
    if (d.evidenceRef && d.evidenceRef !== '' && !refResolves(d.evidenceRef)) {
      errs.push(`pipelineDrug ${d.name || '?'} ref "${d.evidenceRef}" does not resolve`);
    }
  }
  return errs;
};

{
  const files = readdirSync(KB_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  if (!files.length) {
    fail('no KB JSON files found in data/kb');
  } else {
    let bad = 0;
    for (const f of files) {
      let kb;
      try {
        kb = JSON.parse(readFileSync(path.join(KB_DIR, f), 'utf8'));
      } catch (e) {
        fail(`${f}: invalid JSON (${e.message})`);
        bad++;
        continue;
      }
      const errs = validateKbSchema(kb, f);
      if (errs.length) {
        bad++;
        fail(`${f}: ${errs.slice(0, 4).join('; ')}${errs.length > 4 ? ` (+${errs.length - 4} more)` : ''}`);
      }
    }
    if (!bad) pass(`${files.length} curated KB files pass schema (refs resolve, honest accessLevel, no authored identifiers)`);
  }
}

// ===========================================================================
// I3 — loadKb serves excludedAgents + redFlags regardless of `reviewed`
// Uses a synthetic reviewed:false dynamic KB pushed through the in-memory store
// (no Upstash needed) and resolved via lib/kb.js loadKb -> dynamic lookup path.
// ===========================================================================
head('I3 — guardrail serving regardless of review status (lib/kb.js)');

{
  _resetDynamicKbForTests();
  const synthCondition = 'Tuberculous fibrosis of lung'; // real registry entry, no data/kb file
  const synthKb = {
    condition: synthCondition,
    slug: 'tuberculous-fibrosis-of-lung',
    aliases: ['TB lung fibrosis'],
    reviewed: false,                       // <- the key: unreviewed dynamic build
    source: 'dynamic-brain',
    version: '2026-06',
    items: [
      { id: 'tfl-1', category: 'review', tier: 'B', title: 'A review', accessLevel: 'abstract', summary: 'x' }
    ],
    canonicalFacts: [],
    lifestyleRecommendations: [],
    redFlags: ['Seek urgent care for massive hemoptysis.'],
    pipelineDrugs: [],
    excludedAgents: [
      { name: 'SomeFailedDrug', reason: 'Phase 3 missed primary endpoint with excess harm.', evidenceRef: 'tfl-1' }
    ]
  };

  try {
    await putDynamicKb(synthKb);
    const res = await loadKb(synthCondition, { fallbackCanonical: synthCondition });
    if (!res?.matched) {
      fail('I3: loadKb did not match the synthetic dynamic KB (dynamic lookup path broken)');
    } else {
      const meta = res.meta || {};
      const okExcluded = Array.isArray(meta.excludedAgents) && meta.excludedAgents.length === 1;
      const okRedFlags = Array.isArray(meta.redFlags) && meta.redFlags.length === 1;
      const wasUnreviewed = meta.reviewed === false;
      if (okExcluded && okRedFlags) {
        pass(`I3: excludedAgents (${meta.excludedAgents.length}) + redFlags (${meta.redFlags.length}) served for reviewed=${meta.reviewed} KB`);
      } else {
        fail(`I3: guardrails suppressed (excludedAgents=${meta.excludedAgents?.length} redFlags=${meta.redFlags?.length} reviewed=${meta.reviewed})`);
      }
      if (!wasUnreviewed) fail('I3: served KB did not surface reviewed=false (check meta mapping)');
    }
  } catch (e) {
    fail(`I3: loadKb threw (${e.message})`);
  } finally {
    _resetDynamicKbForTests();
  }
}

// ===========================================================================
// I1 — excluded/failed agents never survive as repurpose CANDIDATE blocks
// Uses the REAL filterExcludedRepurposeCandidates / filterExcludedAgentMentions.
// ===========================================================================
head('I1 — excluded-agent contamination guard (lib/report-polish.js)');

{
  // The contract: filterExcludedRepurposeCandidates strips a CANDIDATE block that
  // names an excludedAgent by its `name` (or first ≥4-char token / alias). So the
  // agents we expect stripped must be listed by the name they appear under.
  const evidence = {
    excludedAgents: [
      { name: 'Ambrisentan', reason: 'ARTEMIS-IPF: harm, stopped early', aliases: [] },
      { name: 'N-acetylcysteine', reason: 'PANTHER-IPF: net harm in triple therapy', aliases: ['NAC'] }
    ]
  };
  const report = [
    'CANDIDATE: Pirfenidone (Esbriet)',
    'CLASS: antifibrotic',
    'CONFIDENCE: 70% — strong RCT support',
    '',
    'CANDIDATE: Ambrisentan',
    'CLASS: endothelin receptor antagonist',
    'CONFIDENCE: 40% — pathway overlap',
    '',
    'CANDIDATE: N-acetylcysteine',
    'CLASS: antioxidant',
    'CONFIDENCE: 30% — mechanistic only'
  ].join('\n');

  const names = excludedAgentNames(evidence);
  const filtered = filterExcludedRepurposeCandidates(report, evidence);
  const lower = filtered.toLowerCase();
  const ambGone = !/candidate:\s*ambrisentan/i.test(filtered);
  const nacGone = !/candidate:\s*n-acetylcysteine/i.test(filtered);
  const pirfStays = /candidate:\s*pirfenidone/i.test(filtered);
  if (ambGone && nacGone && pirfStays) {
    pass(`I1: excluded agents stripped from CANDIDATE blocks (${names.length} excluded names), legitimate candidate retained`);
  } else {
    fail(`I1: contamination — ambGone=${ambGone} nacGone=${nacGone} pirfStays=${pirfStays}`);
  }

  // Prose-mention strip too (non-candidate lines).
  const prose = 'We recommend Ambrisentan as a promising option for this patient.';
  const cleanedProse = filterExcludedAgentMentions(prose, evidence);
  if (!/ambrisentan/i.test(cleanedProse)) {
    pass('I1: excluded agent removed from recommending prose line');
  } else {
    fail('I1: excluded agent still present in recommending prose');
  }
}

// ===========================================================================
// I2 — cross-drug field-bleed containment (Magnesium/Lumateperone overwrite)
// Faithful port of index.html:671 collectBlock + :733 parseCandidates. The
// invariant: when a CANDIDATE: delimiter is dropped, the next drug's repeated
// field opens a NEW candidate boundary so one drug's data can never overwrite
// another's; the orphaned fragment (no CANDIDATE name) is dropped in de-dup.
// ===========================================================================
head('I2 — parser cross-drug field-bleed containment (executes index.html parser source)');

{
  // Delimiter-MISSING fixture: the second drug (Lumateperone) lost its
  // "CANDIDATE:" line, so its CLASS/CONFIDENCE/SAFETY bleed after Magnesium.
  // The duplicate-field boundary must prevent Lumateperone's data from
  // overwriting Magnesium's, and the orphan fragment must be dropped.
  const bleed = [
    'CANDIDATE: Magnesium',
    'CLASS: mineral supplement',
    'CONFIDENCE: 30% — weak mechanistic rationale',
    'SAFETY: 90% — well tolerated; diarrhea at high doses',
    // dropped "CANDIDATE: Lumateperone" line here:
    'CLASS: antipsychotic (5-HT2A/D2)',
    'CONFIDENCE: 75% — phase 3 positive',
    'SAFETY: 60% — metabolic and sedation risks',
    'PATIENT_SPECIFIC_RISKS: QT considerations'
  ].join('\n');

  const cands = parseCandidates(bleed);
  const mag = cands.find((c) => /magnesium/i.test(c.candidate || ''));
  const magOk = mag && /30/.test(String(mag.confidence || '')) && /90/.test(String(mag.safety || ''));
  // Lumateperone's data must NOT have overwritten Magnesium's fields.
  const noOverwrite = mag && !/75/.test(String(mag.confidence || '')) && !/antipsychotic/i.test(String(mag.class || ''));
  // No orphan candidate (no real CANDIDATE name) leaked through.
  const noOrphan = cands.every((c) => String(c.candidate || '').trim().length > 0);
  if (magOk && noOverwrite && noOrphan) {
    pass(`I2: dropped-delimiter contained — Magnesium keeps its own 30%/90% data; Lumateperone fields did not overwrite; orphan dropped (${cands.length} clean candidate(s))`);
  } else {
    fail(`I2: field-bleed regression — magOk=${magOk} noOverwrite=${noOverwrite} noOrphan=${noOrphan}`);
  }

  // Sanity: a well-formed two-candidate block parses to exactly two.
  const clean = [
    'CANDIDATE: Magnesium', 'CONFIDENCE: 30% — weak',
    'CANDIDATE: Lumateperone', 'CONFIDENCE: 75% — strong'
  ].join('\n');
  const cleanCands = parseCandidates(clean);
  if (cleanCands.length === 2) pass('I2: well-formed two-candidate block parses to exactly two');
  else fail(`I2: clean parse regression (${cleanCands.length} candidates)`);
}

// ===========================================================================
// I4 — trial ordering compatibility (age-ineligible penalty, internal bounds,
// no "stopped" flag on an enrolling trial).
// ===========================================================================
head('I4 — trials scoring fixtures (api/trials.js)');

{
  // 0-100 bounds.
  const hi = normalizePromise(250);
  const lo = normalizePromise(-300);
  const mid = normalizePromise(35);
  if (hi === 100 && lo === 0 && mid > 0 && mid < 100) {
    pass(`I4: internal compatibility value clamped to 0-100 (hi=${hi} lo=${lo} mid=${mid})`);
  } else {
    fail(`I4: 0-100 bounds regression (hi=${hi} lo=${lo} mid=${mid})`);
  }

  // Age-ineligible penalty: a pediatric-only trial ranks below an adult-eligible
  // one for an older patient, and carries an age caution.
  const RAW = 90;
  const pediatric = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT_PED',
    minimumAge: '10 Years', maximumAge: '17 Years', stdAges: ['CHILD']
  }, { patientAge: 64 });
  const adult = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT_ADULT',
    minimumAge: '18 Years', maximumAge: '85 Years', stdAges: ['ADULT', 'OLDER_ADULT']
  }, { patientAge: 64 });
  const pedNorm = normalizePromise(pediatric.score);
  const adultNorm = normalizePromise(adult.score);
  const pedCaution = /age|enrol/i.test(pediatric.eligibilityCaution || '');
  if (pedNorm < adultNorm && pedCaution && !adult.eligibilityCaution) {
    pass(`I4: age-ineligible trial penalized + cautioned and ranks below adult-eligible (${pedNorm} < ${adultNorm})`);
  } else {
    fail(`I4: age-ineligibility regression (ped=${pedNorm} adult=${adultNorm} pedCaution=${pedCaution} adultCaution=${!!adult.eligibilityCaution})`);
  }

  // No "stopped/negative" flag on an actively-enrolling trial whose title merely
  // contains adverse-event boilerplate; a genuinely terminated-for-harm trial IS flagged.
  const recruitingAdverse = applyPatientPromiseAdjustment(80, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT04777357',
    briefTitle: 'A Study to Assess Change in Disease Activity and Adverse Events (AEs)'
  });
  const terminatedHarm = applyPatientPromiseAdjustment(80, {
    status: 'TERMINATED', acceptingNewPatients: false, nctId: 'NCT_T',
    briefTitle: 'Trial', whyStopped: 'Stopped for safety concern (increased adverse events)'
  });
  if (!recruitingAdverse.caution && terminatedHarm.caution) {
    pass('I4: enrolling trial NOT flagged stopped; terminated-for-harm still flagged');
  } else {
    fail(`I4: stopped-flag regression (recruiting caution=${!!recruitingAdverse.caution} terminated caution=${!!terminatedHarm.caution})`);
  }
}

// ===========================================================================
// I6 — grounding-sufficiency grade (Pillar 1). The gate must classify thin /
// dossier-only / strong evidence WITHOUT blocking, and the prompt block must
// only fire (instruct the model to hedge) when grounding is not strong.
// Uses the REAL assessGroundingSufficiency / buildEvidenceGradeBlock.
// ===========================================================================
head('I6 — grounding-sufficiency grade (api/research.js, Pillar 1)');

{
  const paper = (i, extra = {}) => ({
    title: `Paper ${i}`, accessLevel: 'abstract', pmid: `${1000 + i}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/${1000 + i}/`, sources: ['PubMed'], ...extra
  });

  // dossier-only: every row is a manufactured accessLevel:'dossier' record.
  const dossierEv = {
    groundedForPrompt: [
      { title: 'Landmark — X', accessLevel: 'dossier', source: 'DossierIntake', sources: ['DossierIntake'] },
      { title: 'Clinical caution', accessLevel: 'dossier', source: 'DossierIntake', sources: ['DossierIntake'] }
    ],
    knowledgeBase: { matched: false, degraded: true, source: 'dossier-llm' }
  };
  const gDossier = assessGroundingSufficiency(dossierEv);
  if (gDossier.tier === 'dossier-only' && gDossier.realPaperCount === 0) {
    pass(`I6: dossier-only evidence graded "${gDossier.tier}" (0 real papers)`);
  } else {
    fail(`I6: dossier-only misgraded (tier=${gDossier.tier} real=${gDossier.realPaperCount})`);
  }

  // thin: a couple of real abstract papers but below the strong bar.
  const thinEv = {
    groundedForPrompt: [paper(1), paper(2)],
    knowledgeBase: { matched: true, degraded: true, source: 'dynamic-brain' }
  };
  const gThin = assessGroundingSufficiency(thinEv);
  if (gThin.tier === 'thin' && gThin.realPaperCount === 2) {
    pass(`I6: thin evidence graded "${gThin.tier}" (${gThin.realPaperCount} real papers)`);
  } else {
    fail(`I6: thin misgraded (tier=${gThin.tier} real=${gThin.realPaperCount})`);
  }

  // strong: ≥3 real papers incl. an RCT/meta from ≥2 sources.
  const strongEv = {
    groundedForPrompt: [
      paper(1, { isRCT: true, sources: ['PubMed'] }),
      paper(2, { isMetaAnalysis: true, sources: ['EuropePMC'] }),
      paper(3, { sources: ['OpenAlex'] }),
      paper(4, { sources: ['PubMed'] })
    ],
    knowledgeBase: { matched: false }
  };
  const gStrong = assessGroundingSufficiency(strongEv);
  if (gStrong.tier === 'strong' && gStrong.topTierCount >= 1 && gStrong.distinctSources >= 2) {
    pass(`I6: well-grounded evidence graded "${gStrong.tier}" (${gStrong.realPaperCount} papers, ${gStrong.topTierCount} top-tier, ${gStrong.distinctSources} sources)`);
  } else {
    fail(`I6: strong misgraded (tier=${gStrong.tier} top=${gStrong.topTierCount} src=${gStrong.distinctSources})`);
  }

  // A matched, non-degraded curated KB is authoritative even with few rows.
  const curatedEv = {
    groundedForPrompt: [paper(1)],
    knowledgeBase: { matched: true, degraded: false, source: 'curated' }
  };
  const gCurated = assessGroundingSufficiency(curatedEv);
  if (gCurated.tier === 'strong') {
    pass('I6: matched non-degraded curated KB graded "strong"');
  } else {
    fail(`I6: curated KB misgraded (tier=${gCurated.tier})`);
  }

  // The hedge-instruction block fires ONLY when not strong, and never blocks.
  const strongBlock = buildEvidenceGradeBlock(gStrong);
  const thinBlock = buildEvidenceGradeBlock(gThin);
  const dossierBlock = buildEvidenceGradeBlock(gDossier);
  if (!strongBlock && /EVIDENCE GRADE/.test(thinBlock) && /EVIDENCE GRADE/.test(dossierBlock) &&
      /limited|thin|starting point/i.test(thinBlock)) {
    pass('I6: evidence-grade prompt block fires for thin/dossier-only only, with an honest hedge instruction');
  } else {
    fail(`I6: grade block regression (strongEmpty=${!strongBlock} thin=${!!thinBlock} dossier=${!!dossierBlock})`);
  }
}

// ===========================================================================
// I7 — builder schema validation + retry gate (lib/kb-builder.js, Pillar 2).
// validateExtract must accept a clean extract and reject out-of-range refs,
// model-authored identifiers, and malformed excludedAgents. Uses REAL
// validateExtract.
// ===========================================================================
head('I7 — builder schema validation (lib/kb-builder.js, Pillar 2)');

{
  const papers = [
    { pmid: '1', title: 'A', _neg: false },
    { pmid: '2', title: 'B', _neg: true },
    { pmid: '3', title: 'C', _neg: false }
  ];

  const goodExtract = {
    pinnedItems: [
      { ref: 0, category: 'rct', tier: 'A', summary: 'A randomized trial showed benefit.' },
      { ref: 2, category: 'review', tier: 'B', summary: 'A review of the field.' }
    ],
    canonicalFacts: [{ claim: 'It is a rare disease.', refs: [0] }],
    lifestyleRecommendations: [{ recommendation: 'Stay hydrated.', refs: [2] }],
    redFlags: ['Seek urgent care for acute symptoms.'],
    pipelineDrugs: [{ name: 'DrugX', aliases: [], approvalStatus: 'investigational', ref: 0 }],
    excludedAgents: [{ name: 'FailedDrug', reason: 'Phase 3 missed endpoint.', ref: 1 }]
  };
  const vGood = validateExtract(goodExtract, papers);
  if (vGood.ok) pass('I7: a clean extract with resolvable refs validates');
  else fail(`I7: clean extract rejected (${vGood.reasons.join('; ')})`);

  // Out-of-range ref must fail.
  const badRef = validateExtract({ ...goodExtract, pinnedItems: [{ ref: 9, summary: 'x' }] }, papers);
  if (!badRef.ok && badRef.reasons.some((r) => /out of range/.test(r))) {
    pass('I7: out-of-range pinned ref rejected');
  } else {
    fail(`I7: out-of-range ref not rejected (${JSON.stringify(badRef)})`);
  }

  // Model-authored DOI/PMID/URL in a text field must fail.
  const authored = validateExtract({
    ...goodExtract,
    pinnedItems: [{ ref: 0, summary: 'See https://doi.org/10.1056/NEJMoa123 for details.' }]
  }, papers);
  if (!authored.ok && authored.reasons.some((r) => /authored a DOI\/PMID\/URL/.test(r))) {
    pass('I7: model-authored identifier in a summary rejected');
  } else {
    fail(`I7: authored identifier not rejected (${JSON.stringify(authored)})`);
  }

  // excludedAgent missing reason or with non-resolving ref must fail.
  const badExcluded = validateExtract({
    ...goodExtract,
    excludedAgents: [{ name: 'NoReason', ref: 9 }]
  }, papers);
  if (!badExcluded.ok &&
      badExcluded.reasons.some((r) => /missing reason/.test(r)) &&
      badExcluded.reasons.some((r) => /ref does not resolve/.test(r))) {
    pass('I7: excludedAgent without reason + unresolved ref rejected (name+reason+resolvable ref required)');
  } else {
    fail(`I7: malformed excludedAgent not rejected (${JSON.stringify(badExcluded.reasons)})`);
  }

  // Non-object extract (e.g. a truncated parse) fails cleanly, not crashes.
  const notObj = validateExtract(null, papers);
  if (!notObj.ok) pass('I7: null/garbled extract fails validation gracefully (drives the retry)');
  else fail('I7: null extract incorrectly validated');
}

// ===========================================================================
// I8 — end-to-end anti-contamination provenance (lib/kb-builder.js +
// lib/report-polish.js, Pillar 3).
//   (a) Every KB item / pipeline drug / excluded agent assembled from an
//       extract carries a provenance tag (conditionSlug + provenanceId/drugKey)
//       so a downstream claim can be traced to the entity it came from.
//   (b) assertNoForeignEntities drops a candidate field whose subject is a
//       DIFFERENT drug (the Magnesium-card-showing-Lumateperone bug) — even
//       when the contaminating field is NOT a duplicate the parser would split
//       on — while preserving legitimate fields and self-referential interactions.
// ===========================================================================
head('I8 — anti-contamination provenance (Pillar 3)');

{
  const papers = [
    { pmid: '11', title: 'Magnesium RCT', abstract: 'A trial.', _neg: false },
    { pmid: '22', title: 'Failed drug trial', abstract: 'No benefit.', _neg: true }
  ];
  const disease = { condition: 'Bipolar Disorder', slug: 'bipolar-disorder', aliases: [] };
  const extract = {
    pinnedItems: [{ ref: 0, category: 'rct', tier: 'A', summary: 'A randomized trial.' }],
    canonicalFacts: [{ claim: 'It is a mood disorder.', refs: [0] }],
    pipelineDrugs: [{ name: 'Lumateperone (Caplyta)', aliases: [], approvalStatus: 'approved', ref: 0 }],
    excludedAgents: [{ name: 'FailedDrug', reason: 'Phase 3 missed endpoint.', ref: 1 }]
  };
  const kb = assembleKbFromExtract(disease, papers, extract);
  const itemTagged = kb.items.length > 0 &&
    kb.items.every((it) => it.conditionSlug === 'bipolar-disorder' && it.provenanceId === it.id);
  const drugTagged = kb.pipelineDrugs.every((d) => d.conditionSlug === 'bipolar-disorder' && d.drugKey) &&
    kb.excludedAgents.every((x) => x.conditionSlug === 'bipolar-disorder' && x.drugKey);
  const drugKeyOk = drugKeyFromName('Lumateperone (Caplyta)') === 'lumateperone';
  if (itemTagged && drugTagged && drugKeyOk) {
    pass(`I8a: provenance tags stamped (items conditionSlug+provenanceId; pipeline/excluded drugKey+conditionSlug; drugKey="${drugKeyFromName('Lumateperone (Caplyta)')}")`);
  } else {
    fail(`I8a: provenance tagging incomplete (items=${itemTagged} drugs=${drugTagged} drugKey=${drugKeyOk})`);
  }

  // Foreign-field bleed WITHOUT a duplicate field (parser cannot catch this):
  // Lumateperone's risk text lands in Magnesium's PATIENT_SPECIFIC_RISKS.
  const contaminated = [
    'CANDIDATE: Magnesium',
    'CLASS: mineral supplement',
    'CONFIDENCE: 30% — weak mechanistic rationale',
    'SAFETY: 90% — well tolerated; diarrhea at high doses',
    'PATIENT_SPECIFIC_RISKS: Lumateperone can prolong the QT interval and cause heavy sedation in this patient.',
    '',
    'CANDIDATE: Lumateperone (Caplyta)',
    'CLASS: antipsychotic',
    'CONFIDENCE: 75% — phase 3 positive',
    'SAFETY: 60% — metabolic and sedation risks',
    'PATIENT_SPECIFIC_RISKS: Lumateperone may cause weight gain.'
  ].join('\n');

  const { text: cleaned, flags } = assertNoForeignEntities(contaminated);
  const magBlock = cleaned.split(/(?=CANDIDATE:)/i).find((b) => /^CANDIDATE:\s*Magnesium/i.test(b.trim())) || '';
  const lumaBlock = cleaned.split(/(?=CANDIDATE:)/i).find((b) => /^CANDIDATE:\s*Lumateperone/i.test(b.trim())) || '';
  const foreignDropped = !/lumateperone/i.test(magBlock) && !/QT interval/i.test(magBlock);
  const ownKept = /30/.test(magBlock) && /90/.test(magBlock);
  const otherIntact = /weight gain/i.test(lumaBlock) && /75/.test(lumaBlock);
  if (foreignDropped && ownKept && otherIntact && flags.length >= 1) {
    pass(`I8b: foreign risk field dropped from Magnesium card (flags: ${flags.length}); Magnesium 30%/90% + Lumateperone's own card intact`);
  } else {
    fail(`I8b: contamination not contained (foreignDropped=${foreignDropped} ownKept=${ownKept} otherIntact=${otherIntact} flags=${flags.length})`);
  }

  // False-positive guard: a field that names another candidate but ALSO names
  // the host (a legitimate drug-drug interaction note) must be preserved.
  const legit = [
    'CANDIDATE: Magnesium',
    'PATIENT_SPECIFIC_RISKS: Magnesium may reduce absorption of Lumateperone if taken at the same time.',
    'CANDIDATE: Lumateperone',
    'CONFIDENCE: 75% — strong'
  ].join('\n');
  const { text: legitOut, flags: legitFlags } = assertNoForeignEntities(legit);
  if (/Magnesium may reduce absorption of Lumateperone/i.test(legitOut) && legitFlags.length === 0) {
    pass('I8c: legitimate self-named interaction note (host + foreign drug) preserved — no over-stripping');
  } else {
    fail(`I8c: over-stripped a legitimate self-referential interaction (flags=${legitFlags.length})`);
  }
}

// ===========================================================================
// LIVE MATRIX — gather+synthesize per condition, assert I1-I5 on the report.
// Skipped unless --live AND the server is reachable. Never runs LLM here by default.
// ===========================================================================
head('LIVE matrix (gather + synthesize per condition)');

const serverReachable = async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/health`, { method: 'GET' });
    return r.ok;
  } catch {
    return false;
  }
};

if (!LIVE) {
  skip('live matrix not requested (pass --live to run gather+synthesize against a server)');
  for (const c of CONDITION_MATRIX.filter((x) => x.requiresServer)) {
    skip(`  needs server: ${c.name} (${c.kind})`);
  }
} else {
  const up = await serverReachable();
  if (!up) {
    fail(`live mode requested but ${BASE_URL} is unreachable`);
  } else {
    pass(`server reachable at ${BASE_URL}`);
    for (const c of CONDITION_MATRIX) {
      try {
        const gatherRes = await fetch(`${BASE_URL}/api/research`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'research', phase: 'gather', patient: { condition: c.name } })
        });
        if (!gatherRes.ok) { fail(`LIVE ${c.name}: gather HTTP ${gatherRes.status}`); continue; }
        const gathered = await gatherRes.json();
        if (!gathered.gatherFingerprint || !gathered.gatherSeal) {
          fail(`LIVE ${c.name}: gather response missing gatherFingerprint/gatherSeal`);
          continue;
        }

        const synthRes = await fetch(`${BASE_URL}/api/research`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'research', phase: 'synthesize',
            patient: { condition: c.name },
            gatherFingerprint: gathered.gatherFingerprint,
            gatherSeal: gathered.gatherSeal,
            providedDossier: gathered.dossier,
            providedEvidence: gathered.evidence,
            providedTrials: gathered.trials
          })
        });
        if (!synthRes.ok) { fail(`LIVE ${c.name}: synthesize HTTP ${synthRes.status}`); continue; }
        const out = await synthRes.json();
        const text = (out.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
        const ev = out.evidence || {};

        // I-live: report produced and grounded.
        if (!text || text.length < 200) { fail(`LIVE ${c.name}: empty/short report`); continue; }
        const grounded = (ev.groundedForPrompt || []).length;
        if (grounded > 0) pass(`LIVE ${c.name}: report produced, ${grounded} grounded refs`);
        else fail(`LIVE ${c.name}: report produced but ungrounded (0 refs)`);

        // I1-live: no excluded agent surfaced as a recommended candidate.
        const exNames = excludedAgentNames(ev);
        const leaked = exNames.filter((n) => n.length >= 5 && new RegExp(`CANDIDATE:[^\\n]*${n}`, 'i').test(text));
        if (!leaked.length) pass(`LIVE ${c.name}: I1 — no excluded agent in CANDIDATE blocks`);
        else fail(`LIVE ${c.name}: I1 — excluded agent leaked as candidate: ${leaked.join(', ')}`);

        // I5-live: condition coherence — report names the resolved condition.
        const canon = (out.dossier?.canonical || c.name).toLowerCase();
        if (text.toLowerCase().includes(canon.split(' ')[0])) {
          pass(`LIVE ${c.name}: I5 — report references the resolved condition`);
        } else {
          fail(`LIVE ${c.name}: I5 — resolved condition token not found in report (possible wrong-disease grounding)`);
        }

        // I6-live: grounding-sufficiency grade (Pillar 1). The grade must be
        // present and never block. Curated conditions should grade `strong`;
        // genuinely rare dynamic conditions should grade thin/dossier-only and
        // the report should carry an honest evidence-limitation hedge.
        const grade = out.evidenceGrade;
        if (!grade || !grade.tier) {
          fail(`LIVE ${c.name}: I6 — response carries no evidenceGrade`);
        } else if (c.kind === 'curated') {
          if (grade.tier === 'strong') pass(`LIVE ${c.name}: I6 — curated condition graded "strong" (no banner)`);
          else fail(`LIVE ${c.name}: I6 — curated condition graded "${grade.tier}" (expected strong)`);
        } else {
          // dynamic / non-curated
          if (grade.tier === 'thin' || grade.tier === 'dossier-only') {
            const hedged = /limited|thin|starting point|not a vetted|discuss with/i.test(text);
            if (hedged) pass(`LIVE ${c.name}: I6 — graded "${grade.tier}" (${grade.realPaperCount} real papers) and report carries an honest hedge`);
            else fail(`LIVE ${c.name}: I6 — graded "${grade.tier}" but no hedge phrase detected in report text`);
          } else {
            fail(`LIVE ${c.name}: I6 — dynamic condition graded "${grade.tier}" (${grade.realPaperCount} real papers), expected thin/dossier-only`);
          }
        }
      } catch (e) {
        fail(`LIVE ${c.name}: ${e.message}`);
      }
    }
  }
}

console.log(process.exitCode
  ? '\n\x1b[31mCondition matrix FAILED\x1b[0m\n'
  : '\n\x1b[32mCondition matrix passed\x1b[0m\n');
