#!/usr/bin/env node
// Platform robustness regression — offline, no Anthropic spend.
// Run: node scripts/regression-platform.mjs

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadKb, listKbs } from '../lib/kb.js';
import { buildSupplementDiscoveryBlock, isSupplementEvidenceItem } from '../lib/supplement-discovery.js';
import {
  REPURPOSE_MIN_TOTAL,
  REPURPOSE_TARGET_TOTAL,
  REPURPOSE_LANE_COUNT,
  REPURPOSE_PER_LANE,
  countCandidateBlocks,
  assessRepurposeQuality
} from '../lib/repurpose-quality.js';
import {
  buildGatherFingerprint,
  buildGatherFingerprintFromPatient,
  fingerprintsMatch,
  gatherFingerprintAccepted,
  poolBoundSynthValid
} from '../lib/gather-fingerprint.js';
import { checkProfileCoherence, checkDossierProfileCoherence } from '../lib/profile-coherence.js';
import { resolveCondition } from '../lib/condition-resolver.js';
import { getInfraStatus } from '../lib/infra-status.js';
import {
  applyValidationFixes,
  injectApprovedTreatmentStubs,
  allApprovedDrugsRendered,
  stripApprovedTreatmentsSection,
  drugBaseKey,
  parseHeadlinePercent,
  clampToCompleteSentence,
  finalizeReportText,
  assertNoForeignEntities,
  detectStructuralLeak,
  auditCardFields
} from '../lib/report-polish.js';
import { drugKeyFromName } from '../lib/kb-builder.js';
import {
  normalizePromise,
  applyPatientPromiseAdjustment,
  assessTrialEligibility,
  NON_ENROLLING_PENALTY,
  accessDesignationBonus,
  programIsAvailable
} from '../api/trials.js';

const pass = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);

console.log('\n=== Platform robustness regression ===\n');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
try {
  execSync('node --check api/research.js', { cwd: repoRoot, stdio: 'pipe' });
  pass('api/research.js parses — SyntaxError would kill every gather/synth call');
} catch (e) {
  fail(`api/research.js SyntaxError: ${String(e.stderr || e.message).split('\n')[0]}`);
}

// 1. Repurpose quality constants wired
if (REPURPOSE_LANE_COUNT * REPURPOSE_PER_LANE >= REPURPOSE_TARGET_TOTAL) {
  pass(`Repurpose target: ${REPURPOSE_LANE_COUNT}×${REPURPOSE_PER_LANE} = ${REPURPOSE_LANE_COUNT * REPURPOSE_PER_LANE} (floor ${REPURPOSE_MIN_TOTAL})`);
} else {
  fail('Lane count × per-lane does not reach target total');
}

// 2. Batch token budget — must be high enough for up to 7 candidates/lane
const researchSrc = readFileSync(new URL('../api/research.js', import.meta.url), 'utf8');
if (/isBatch\)\s*return\s+isOpus\s*\?\s*4400\s*:\s*5600/.test(researchSrc)) {
  pass('Repurpose lane max_tokens = 5600 (Sonnet) — fits up to 7 candidates/lane');
} else {
  fail('Repurpose batch max_tokens may be too low — check resolveMaxTokens in api/research.js');
}

// 3. No hardcoded otcRepurposeSeeds band-aid
if (/otcRepurposeSeeds/.test(researchSrc)) {
  fail('api/research.js still references otcRepurposeSeeds — use live supplement discovery');
} else {
  pass('No hardcoded otcRepurposeSeeds in research pipeline');
}

// 4. Supplement discovery module present
if (researchSrc.includes('buildSupplementDiscoveryBlock')) {
  pass('Supplement discovery block wired into synthesis');
} else {
  fail('buildSupplementDiscoveryBlock not imported in api/research.js');
}

// 5. Repurpose gather runs supplement queries
const evidenceSrc = readFileSync(new URL('../lib/evidence.js', import.meta.url), 'utf8');
if (/repurposeSupplementQueries/.test(evidenceSrc) && /isRepurpose/.test(evidenceSrc)) {
  pass('Evidence gather expands queries for repurpose (OTC/supplement/combination)');
} else {
  fail('Evidence.js missing repurpose supplement query expansion');
}

// 6. RP KB — landmark papers + search seeds (not Latin seed list)
const rp = JSON.parse(readFileSync(new URL('../data/kb/rp.json', import.meta.url), 'utf8'));
if (rp.otcRepurposeSeeds?.length) {
  fail('rp.json still has otcRepurposeSeeds — remove hardcoded must-include list');
} else {
  pass('RP KB uses live search seeds, not hardcoded OTC seed objects');
}
const rpItems = rp.items || [];
const mustHave = ['goji', 'tudca', 'taurine', 'lipoic'];
for (const term of mustHave) {
  const hit = rpItems.some((it) =>
    `${it.title} ${it.summary || ''}`.toLowerCase().includes(term)
  );
  if (hit) pass(`RP KB anchors ${term} literature`);
  else warn(`RP KB missing ${term} anchor item (gather may still find via PubMed)`);
}
if ((rp.literatureSearchSeeds || []).length >= 4) {
  pass(`RP literatureSearchSeeds: ${rp.literatureSearchSeeds.length} live query topics`);
} else {
  fail('RP literatureSearchSeeds too sparse');
}

// 7. Supplement discovery from mock RP pack
const mockRpEvidence = {
  groundedForPrompt: rpItems.map((it) => ({
    title: it.title,
    year: it.year,
    url: it.url,
    summary: it.summary,
    text: it.summary
  }))
};
const suppHits = mockRpEvidence.groundedForPrompt.filter(isSupplementEvidenceItem);
if (suppHits.length >= 5) {
  pass(`Supplement discovery finds ${suppHits.length} items in RP KB pack`);
} else {
  fail(`Supplement discovery only ${suppHits.length} hits in RP KB — expected ≥5`);
}
const block = buildSupplementDiscoveryBlock(mockRpEvidence);
if (/Goji berries|plain-English|TUDCA|taurine/i.test(block)) {
  pass('Supplement discovery block instructs plain-English candidate names');
} else {
  fail('Supplement discovery block missing plain-English guidance');
}

// 8. Client lane retry (index.html)
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
if (/Retrying.*incomplete drug batch/i.test(html) || /MIN_PER_LANE|laneNeedsRetry|truncated/i.test(html)) {
  pass('Frontend retries incomplete repurpose lanes');
} else {
  warn('Frontend lane retry not detected — add orchestration in index.html');
}

// 8b. Citation tagging + soft cap (index.html). Uncited candidates are KEPT
//     (tagged `_uncited`) and routed to the logic-based section, not dropped;
//     cited candidates rank ahead and the list is trimmed to the soft cap.
const keepsUncited = /_uncited/.test(html) && /hasCitation/.test(html);
const capsList = /SOFT_CAP/.test(html) && /ranked\.slice\(0, SOFT_CAP\)/.test(html);
const routesUncited = /if \(c\._uncited\) \{ mechanistic\.push\(c\); return; \}/.test(html);
const threeTiers = /const human = \[\];/.test(html) && /const preclinical = \[\];/.test(html);
if (keepsUncited && capsList && routesUncited && threeTiers) {
  pass('Repurpose candidates: three tiers (human/preclinical/logic-based), uncited kept as hypotheses, cited ranked first, capped to soft cap (index.html)');
} else {
  fail(`Citation/tier wiring missing in index.html (keepsUncited=${keepsUncited} caps=${capsList} routes=${routesUncited} threeTiers=${threeTiers})`);
}

// 9. Health endpoint
try {
  const healthSrc = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  if (healthSrc.includes('repurpose')) pass('/api/health endpoint exists with repurpose targets');
  else fail('/api/health missing repurpose metadata');
} catch {
  fail('/api/health.js missing');
}

// 10. KB catalog size
const slugs = await listKbs();
if (slugs.length >= 11) pass(`${slugs.length} curated KB conditions registered`);
else fail(`Only ${slugs.length} KBs — expected ≥11`);

// 11. Quality assessor sanity
const q = assessRepurposeQuality(['CANDIDATE: a\n', 'CANDIDATE: b\nCANDIDATE: c\n', 'CANDIDATE: d\n'.repeat(5)]);
if (q.total >= 8 && !q.ok) pass(`Quality assessor: ${q.total} candidates flagged below floor (${REPURPOSE_MIN_TOTAL})`);
else if (q.ok) pass(`Quality assessor OK at ${q.total} candidates`);
else fail('Quality assessor broken');

// 12. Infra (local env — warn only)
const infra = getInfraStatus();
if (infra.productionReady) pass('Local infra: production-ready env vars');
else warn(`Local infra missing: ${infra.missing.map((m) => m.id).join(', ')}`);

// 13. Chat must be grounded — not "use your own medical knowledge"
const researchSrcChat = readFileSync(new URL('../api/research.js', import.meta.url), 'utf8');
if (/Answer from the dossier, prior analyses if present, and your own medical knowledge|answer from your own clinical knowledge|Use your own medical knowledge to answer/i.test(researchSrcChat)) {
  fail('Chat prompt still tells model to use unconstrained medical knowledge');
} else {
  pass('Chat prompt forbids unconstrained medical knowledge');
}
if (/chatGroundingRules|CHAT GROUNDING RULES|buildCanonicalFactsBlock/.test(researchSrcChat) &&
    /mode === 'chat' && effectiveCondition/.test(researchSrcChat)) {
  pass('Chat loads KB evidence + canonical facts on every turn');
} else {
  fail('Chat KB bootstrap missing');
}
if (/CAR-T, CAR cell therapy|NOT gold standard/i.test(researchSrcChat)) {
  pass('Chat has explicit anti-hallucination guard for CAR/cell therapy vs IPF standard of care');
} else {
  fail('Chat missing CAR/cell therapy guardrail');
}

const indexSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
if (/reuseGather:\s*true/.test(indexSrc) && /lastGathered\.mode === mode \|\| extra\.reuseGather/.test(indexSrc)) {
  pass('chainRepurpose reuses research gather (reuseGather) — prevents cross-condition contamination');
} else {
  fail('chainRepurpose missing reuseGather — repurpose may re-gather wrong condition');
}
if (/reuseGather:\s*true/.test(indexSrc) && /lastGathered\.gatherFingerprint/.test(indexSrc)) {
  pass('chainRepurpose reuses gatherFingerprint + reuseGather');
} else {
  fail('chainRepurpose missing reuseGather — repurpose may re-gather wrong condition');
}
if (/gatherFingerprint/.test(indexSrc) && /buildGatherFingerprint/.test(indexSrc)) {
  pass('skipGather gated on gatherFingerprint — stale pools cannot reuse after profile edit');
} else {
  fail('lastGathered missing gatherFingerprint guard — stale gather can bleed across profile edits');
}
if (/buildProfileIdentityKey/.test(indexSrc) && /clearRunStateForProfileChange/.test(indexSrc)) {
  pass('Profile identity change clears lastGathered + report state (condition/gender/stage/age)');
} else {
  fail('Missing profile-key state clear — gender/stage edits can leave stale dossier');
}

const fpA = buildGatherFingerprint({ condition: 'Breast Cancer', gender: 'Female', stage: 'II', age: '68' });
const fpB = buildGatherFingerprint({ condition: 'Breast Cancer', gender: 'Male', stage: 'II', age: '68' });
if (fpA !== fpB && fingerprintsMatch(fpA, fpA)) {
  pass('gatherFingerprint changes when gender changes (same condition string)');
} else {
  fail('gatherFingerprint does not distinguish gender — stale pool reuse possible');
}

const incoherent = checkProfileCoherence({ condition: 'Male breast carcinoma', gender: 'Female' });
if (!incoherent.ok && incoherent.code === 'PROFILE_INCOHERENT') {
  pass('profileCoherence blocks male breast + Female before gather');
} else {
  fail('profileCoherence failed to flag male breast + Female mismatch');
}

const stalePool = checkDossierProfileCoherence(
  { condition: 'Breast Cancer', gender: 'Female' },
  { canonical: 'Male breast carcinoma' },
  null
);
if (!stalePool.ok && stalePool.code === 'GATHER_STALE') {
  pass('dossier/profile coherence rejects male breast dossier for Female patient');
} else {
  fail('dossier canonical mismatch not detected on synthesize path');
}

const poolGatherFp = 'ipf|male|gap stage ii|68';
const liveServerFp = 'idiopathic pulmonary fibrosis|male|gap stage ii|68';
if (
  gatherFingerprintAccepted(poolGatherFp, liveServerFp, poolGatherFp) &&
  !fingerprintsMatch(poolGatherFp, liveServerFp)
) {
  pass('synth accepts gather fingerprint via dossier poolsFingerprint when live profile re-resolve drifts');
} else {
  fail('synth rejects valid pools when server profile fingerprint drifts within same run');
}

if (/gatherFingerprintAccepted/.test(researchSrc)) {
  pass('synth accepts pool-bound gatherFingerprint via dossier.poolsFingerprint');
} else {
  fail('synth only compares live profile fingerprint — false GATHER_STALE on canonicalize drift');
}

if (/poolBoundSynthValid/.test(researchSrc) && /hasProvidedPools/.test(researchSrc)) {
  pass('synth pool-bound path trusts dossier.poolsFingerprint only — skips live profile re-resolve');
} else {
  fail('synth still requires live profile fingerprint when client provides gathered pools');
}

const ipfPatient = { condition: 'IPF', gender: 'Male', stage: 'GAP Stage II', age: '68' };
const ipfResolution = await resolveCondition('IPF');
const ipfGatherFp = buildGatherFingerprintFromPatient(ipfPatient, ipfResolution);
const ipfDriftServerFp = buildGatherFingerprintFromPatient(
  { ...ipfPatient, condition: 'Idiopathic Pulmonary Fibrosis' },
  null
);
if (
  poolBoundSynthValid(ipfGatherFp, ipfGatherFp) &&
  ipfGatherFp !== ipfDriftServerFp &&
  !gatherFingerprintAccepted(ipfGatherFp, ipfDriftServerFp, null)
) {
  pass(`IPF gather→synth: pool stamp ${ipfGatherFp} survives live re-resolve drift`);
} else {
  fail('IPF pool-bound gather→synth fingerprint regression failed');
}

if (/poolsFingerprint:\s*runGatherFingerprint/.test(indexSrc)) {
  pass('client stamps poolsFingerprint on dossier before synthesize');
} else {
  fail('client may send dossier without poolsFingerprint — false GATHER_STALE on synth');
}

if (/busyRef\.current/.test(indexSrc)) {
  pass('profile identity clear skipped during active research run');
} else {
  fail('clearRunState can fire mid-run when canonical profile applies');
}

if (/pendingPatientCanonical/.test(indexSrc) && !/setPatient\(runPatient\)/.test(indexSrc)) {
  pass('canonical profile update deferred until run completes');
} else {
  fail('setPatient mid-run can clear lastGathered and drift gather vs synth fingerprints');
}

if (!/autoFocus/.test(indexSrc.match(/Ask a follow-up question[\s\S]{0,1200}/)?.[0] || '')) {
  pass('follow-up chat input no longer autoFocus-scrolls Research tab to bottom');
} else {
  fail('Research tab follow-up chat autoFocus still scrolls page to bottom on tab switch');
}

if (/Note on patient profile/.test(researchSrc) && /NEVER write "Note on patient profile"/.test(researchSrc)) {
  pass('Prompt forbids dossier/profile mismatch disclaimers in report prose');
} else if (/NEVER write "Note on patient profile"/.test(researchSrc)) {
  pass('Prompt forbids dossier/profile mismatch disclaimers in report prose');
} else {
  fail('Missing prompt guardrail against dossier/profile mismatch disclaimers');
}

const polishSrc = readFileSync(new URL('../lib/report-polish.js', import.meta.url), 'utf8');
if (/pipelineDrugs/.test(polishSrc) && /groundedForPrompt/.test(polishSrc)) {
  pass('collectAllowedUrls merges grounded pack + pipeline drug links');
} else {
  fail('collectAllowedUrls too narrow — CANMAT/NCT links get stripped');
}

if (/Pipeline Watch \(Investigational Programs Only\)/.test(researchSrc)) {
  pass('Pipeline Watch prompt excludes already-approved drugs (olanzapine, Lybalvi, etc.)');
} else {
  fail('Pipeline Watch prompt still tells model to list approved drugs — wrong section');
}
if (/buildPipelineWatchBlock/.test(researchSrc)) {
  pass('Investigational-only PIPELINE WATCH block injected on back half');
} else {
  fail('Missing buildPipelineWatchBlock — approved drugs bleed into Pipeline Watch');
}

if (/replaceClaimWithCorrection|stripApprovedTreatmentsSection/.test(polishSrc)) {
  pass('Validation applies corrections + strips duplicate approved-treatment section');
} else {
  fail('report-polish missing validation rewrite helpers');
}

if (/cellGene && \(s\.relevanceScore/.test(readFileSync(new URL('../api/trials.js', import.meta.url), 'utf8'))) {
  pass('Trials filter keeps relevant cell/gene therapy trials');
} else {
  fail('Trials missing cell/gene therapy relevance boost');
}

if (/TreatmentCard|stripApprovedTreatmentsSection/.test(indexSrc)) {
  pass('UI consolidates approved treatments into linked cards');
} else {
  fail('Research tab missing TreatmentCard consolidation');
}

if (/parseCombos|ComboCard/.test(indexSrc)) {
  pass('UI parses and renders COMBO blocks with links');
} else {
  fail('Missing combo card UI');
}

if (!/CostMeter meta=\{runMeta\}/.test(indexSrc)) {
  pass('Research run cost meter removed from UI');
} else {
  fail('CostMeter still rendered in UI');
}

if (/Pipeline Watch \(Investigational Programs Only\)/.test(researchSrc)) {
  pass('Section 5 is Pipeline Watch only — repurposing cards are not duplicated in report body');
} else {
  fail('Section 5 still asks for repurposing bullets + cards — causes NAC/combo duplication');
}

// 13b. GENERAL FAILED-TRIAL DISQUALIFIER lives in the repurpose prompt as a
//      condition-agnostic reasoning rule — NOT a per-drug hardcoded blocklist.
if (/FAILED-TRIAL DISQUALIFIER/.test(researchSrc) &&
    /applies to EVERY condition and EVERY agent/i.test(researchSrc) &&
    /COMPLETED clinical trial for THIS exact condition and FAILED/i.test(researchSrc)) {
  pass('Repurpose prompt has a GENERAL failed-trial disqualifier (drug OR supplement, every condition)');
} else {
  fail('Repurpose prompt missing the general FAILED-TRIAL DISQUALIFIER reasoning rule');
}
if (/"it's just a supplement" is NOT a loophole/i.test(researchSrc)) {
  pass('Failed-trial rule closes the supplement loophole (failed supplement is disqualified like any drug)');
} else {
  fail('Failed-trial rule does not close the supplement carve-out loophole');
}
if (/SUBGROUP \/ BIOMARKER EXCEPTION/i.test(researchSrc) &&
    /never a fresh card/i.test(researchSrc)) {
  pass('Failed-trial rule allows biomarker/genotype subgroup ONLY as context, never a fresh candidate card');
} else {
  fail('Failed-trial rule missing the subgroup/genotype context-only exception');
}
{
  const validateSrc = readFileSync(new URL('../lib/validate.js', import.meta.url), 'utf8');
  if (/FAILED-AGENT-AS-NEW-IDEA CHECK/.test(validateSrc)) {
    pass('Second-AI validator flags a known failed agent presented as a new repurposing idea');
  } else {
    fail('Second-AI validator missing the failed-agent-as-new-idea check');
  }
}
// 13c. No per-drug NAC hardcoding was bolted onto the IPF excludedAgents list as
//      the "fix" — the reasoning layer is the primary safeguard. (Pre-existing
//      curated entries are fine; we only guard against a new standalone
//      "N-acetylcysteine (NAC)" repurposing-blocklist entry being the fix.)
{
  const ipfKb = JSON.parse(readFileSync(new URL('../data/kb/ipf.json', import.meta.url), 'utf8'));
  const excluded = Array.isArray(ipfKb.excludedAgents) ? ipfKb.excludedAgents : [];
  const standaloneNac = excluded.some((x) => /^n[- ]?acetylcysteine\s*\(nac\)$/i.test(String(x?.name || '').trim()));
  if (!standaloneNac) {
    pass('IPF excludedAgents has no standalone hardcoded "N-acetylcysteine (NAC)" repurposing-blocklist entry');
  } else {
    fail('A standalone hardcoded NAC excludedAgents entry was added — fix belongs in the reasoning layer, not a per-drug blocklist');
  }
}

// 14. BEHAVIORAL: "Second AI check" applies the FULL correction from a
//     verbatim quote — not a no-op, not a truncated/garbled snippet.
{
  const quote = 'Nintedanib reverses pulmonary fibrosis and restores normal lung tissue in every patient.';
  const correction = 'Nintedanib slows the rate of lung-function (FVC) decline; it does not reverse fibrosis or restore lung tissue.';
  const report = [
    '## 2. Background',
    'IPF is a progressive scarring lung disease.',
    quote,
    'Patients should discuss options with their pulmonologist.'
  ].join('\n');
  const validation = {
    primary: {
      disputed: [{ claim: 'overstated nintedanib benefit', quote, reason: 'No drug reverses IPF fibrosis.', correction }]
    }
  };
  const fixed = applyValidationFixes(report, validation, null, null);
  const fullCorrectionPresent = fixed.includes(correction);
  const originalGone = !fixed.includes('reverses pulmonary fibrosis and restores normal lung tissue');
  const notTruncated = fixed.includes('restore lung tissue.');
  if (fullCorrectionPresent && originalGone && notTruncated) {
    pass('Second AI check applies the verbatim-quote correction IN FULL (no truncation/garble)');
  } else {
    fail(`Second AI check correction broken (full=${fullCorrectionPresent} origGone=${originalGone} notTrunc=${notTruncated})`);
  }
}

// 15. BEHAVIORAL: a disputed claim with NO correction must NOT delete report
//     lines (paraphrased-claim line nuking was a corruption landmine).
{
  const keep = 'Pirfenidone is an oral antifibrotic approved for IPF.';
  const report = ['## 2. Background', keep, 'It can cause photosensitivity and GI upset.'].join('\n');
  const validation = { primary: { disputed: [{ claim: 'Pirfenidone is an oral antifibrotic approved for IPF', reason: 'wording nit' }] } };
  const fixed = applyValidationFixes(report, validation, null, null);
  if (fixed.includes(keep)) {
    pass('Second AI check no longer deletes report lines on a no-correction disputed claim');
  } else {
    fail('Second AI check deleted a report line on a no-correction disputed claim');
  }
}

// 16. BEHAVIORAL: an approved drug that appears only as prose still surfaces as
//     an approved treatment (the "only nerandomilast" regression).
{
  const pipelineDrugs = [
    { name: 'Nerandomilast', approvalStatus: 'approved' },
    { name: 'Nintedanib', aliases: ['Ofev'], approvalStatus: 'approved', mechanism: 'tyrosine kinase inhibitor' },
    { name: 'Pirfenidone', aliases: ['Esbriet'], approvalStatus: 'approved' },
    { name: 'BI 1015550', approvalStatus: 'investigational' }
  ];
  // Only nerandomilast parsed as a structured card; the rest are prose-only.
  const parsedCards = [{ _type: 'treatment', treatment: 'Nerandomilast', fda_status: 'FDA-approved' }];
  const merged = injectApprovedTreatmentStubs(parsedCards, pipelineDrugs);
  const names = merged.map((t) => String(t.treatment || '').toLowerCase());
  const hasNintedanib = names.some((n) => n.includes('nintedanib'));
  const hasPirfenidone = names.some((n) => n.includes('pirfenidone'));
  const noInvestigational = !names.some((n) => n.includes('bi 1015550'));
  const noDupeNeran = names.filter((n) => n.includes('nerandomilast')).length === 1;
  if (hasNintedanib && hasPirfenidone && noInvestigational && noDupeNeran) {
    pass('Approved-treatment injection: prose-only approved drugs render as cards; no dupes; investigational excluded');
  } else {
    fail(`Approved-treatment injection regression (nint=${hasNintedanib} pirf=${hasPirfenidone} noInv=${noInvestigational} noDupe=${noDupeNeran})`);
  }

  // De-dupe by alias: a card already rendered under a brand name must not be
  // injected again under the generic name (or vice-versa).
  const mergedAlias = injectApprovedTreatmentStubs(
    [{ _type: 'treatment', treatment: 'Ofev (nintedanib)' }],
    [{ name: 'Nintedanib', aliases: ['Ofev'], approvalStatus: 'approved' }]
  );
  const ninCount = mergedAlias.filter((t) => /nintedanib|ofev/i.test(t.treatment || '')).length;
  if (ninCount === 1) {
    pass('Approved-treatment injection de-dupes by alias (Ofev == nintedanib)');
  } else {
    fail('Approved-treatment injection duplicated an already-rendered drug by alias');
  }

  // Strip guard: Section 3 prose stays until EVERY approved drug has a card.
  const beforeAll = allApprovedDrugsRendered(pipelineDrugs, parsedCards);
  const afterAll = allApprovedDrugsRendered(pipelineDrugs, merged);
  if (!beforeAll && afterAll) {
    pass('Approved-treatment guard: Section 3 prose retained until every approved drug is rendered');
  } else {
    fail(`Approved-treatment strip guard regression (before=${beforeAll} after=${afterAll})`);
  }
}

// 17. BEHAVIORAL (Item 1): a dose/brand-suffixed approved drug card must NOT be
//     duplicated by its KB stub. The dedup key derives from the leading drug
//     name only ("Pirfenidone (Esbriet) — 2,403 mg/day" → "pirfenidone").
{
  if (drugBaseKey('Pirfenidone (Esbriet) — 2,403 mg/day') === 'pirfenidone' &&
      drugBaseKey('**Nintedanib (Ofev)** — 150 mg twice daily') === 'nintedanib') {
    pass('drugBaseKey strips dose/brand/markdown to the leading drug name');
  } else {
    fail(`drugBaseKey did not isolate the leading drug name (got "${drugBaseKey('Pirfenidone (Esbriet) — 2,403 mg/day')}")`);
  }

  const pipelineDrugs = [
    { name: 'Pirfenidone', aliases: ['Esbriet'], approvalStatus: 'approved' },
    { name: 'Nerandomilast', approvalStatus: 'approved' },
    { name: 'Nintedanib', aliases: ['Ofev'], approvalStatus: 'approved' }
  ];
  // Rich cards already parsed WITH dose suffixes — must not be re-stubbed.
  const richCards = [
    { _type: 'treatment', treatment: 'Pirfenidone (Esbriet) — 2,403 mg/day' },
    { _type: 'treatment', treatment: '**Nerandomilast (Jascayd)** — 18 mg twice daily' },
    { _type: 'treatment', treatment: 'Nintedanib (Ofev) — 150 mg twice daily' }
  ];
  const merged = injectApprovedTreatmentStubs(richCards, pipelineDrugs);
  const dupePirf = merged.filter((t) => /pirfenidone/i.test(t.treatment || '')).length;
  const dupeNeran = merged.filter((t) => /nerandomilast/i.test(t.treatment || '')).length;
  const dupeNint = merged.filter((t) => /nintedanib|ofev/i.test(t.treatment || '')).length;
  if (dupePirf === 1 && dupeNeran === 1 && dupeNint === 1 && merged.length === 3) {
    pass('Dose-suffixed approved cards are NOT duplicated by KB stubs (Item 1)');
  } else {
    fail(`Dose-suffixed dedup regression (pirf=${dupePirf} neran=${dupeNeran} nint=${dupeNint} total=${merged.length})`);
  }

  // A stub-only approved drug (no rich card yet) still surfaces exactly once.
  const stubOnly = injectApprovedTreatmentStubs(
    richCards,
    [...pipelineDrugs, { name: 'Inhaled treprostinil', aliases: ['Yutrepia', 'Tyvaso'], approvalStatus: 'approved' }]
  );
  const trep = stubOnly.filter((t) => /treprostinil/i.test(t.treatment || '')).length;
  if (trep === 1 && stubOnly.length === 4) {
    pass('Stub-only approved drug still renders once alongside rich cards (Item 1)');
  } else {
    fail(`Stub-only injection regression (treprostinil=${trep} total=${stubOnly.length})`);
  }
}

// 18. BEHAVIORAL (Item 4): the headline efficacy/safety percent is parsed even
//     when bolded, and an incidental later percent is not grabbed instead.
{
  const efficacy = parseHeadlinePercent('**70**% — slows FVC decline; ~10% of patients see GI upset');
  const safety = parseHeadlinePercent('82% — higher = safer; serious AEs in 5%');
  const noPct = parseHeadlinePercent('Mechanism: tyrosine kinase inhibitor');
  if (efficacy === 70 && safety === 82 && noPct === null) {
    pass('parseHeadlinePercent reads the bolded headline percent, not a later incidental one (Item 4)');
  } else {
    fail(`Headline percent parse regression (efficacy=${efficacy} safety=${safety} noPct=${noPct})`);
  }
}

// 19. BEHAVIORAL (Item 2): stripping Section 3 prose leaves a "## 3. Approved
//     Treatments" placeholder so report numbering stays 1, 2, 3, 4.
{
  const report = [
    '## 2. Top Centers',
    'Some centers.',
    '## 3. Approved Treatments (Backed by Research)',
    'PROVIDER: ...long prose card content...',
    'TREATMENT: Pirfenidone',
    '## 4. Clinical Trials',
    'Trials prose.'
  ].join('\n\n');
  const stripped = stripApprovedTreatmentsSection(report);
  const hasPlaceholderHeading = /^##\s*3\.\s*Approved Treatments\s*$/im.test(stripped);
  const hasSeeCardsLine = /See the treatment cards above/i.test(stripped);
  const stillHas4 = /##\s*4\.\s*Clinical Trials/i.test(stripped);
  const proseGone = !/PROVIDER: \.\.\.long prose/.test(stripped);
  if (hasPlaceholderHeading && hasSeeCardsLine && stillHas4 && proseGone) {
    pass('Section 3 placeholder retained after stripping prose — numbering stays continuous (Item 2)');
  } else {
    fail(`Section 3 placeholder regression (heading=${hasPlaceholderHeading} line=${hasSeeCardsLine} sec4=${stillHas4} proseGone=${proseGone})`);
  }
}

// 20. BEHAVIORAL (Item 3): a card field cut mid-word is clamped to the last
//     complete sentence; a clean field is left untouched.
{
  const truncated = clampToCompleteSentence(
    'Slows lung-function decline. Risk of bleeding is increased — nint'
  );
  const clean = clampToCompleteSentence('Slows FVC decline; generally well tolerated.');
  const noFalseChop = clampToCompleteSentence('Pirfenidone (Esbriet) — 2,403 mg/day');
  if (truncated === 'Slows lung-function decline.' &&
      clean === 'Slows FVC decline; generally well tolerated.' &&
      noFalseChop === 'Pirfenidone (Esbriet) — 2,403 mg/day') {
    pass('clampToCompleteSentence drops mid-word fragments without chopping clean fields (Item 3)');
  } else {
    fail(`Mid-word clamp regression (truncated="${truncated}" clean="${clean}" noFalseChop="${noFalseChop}")`);
  }
}

// 21. BEHAVIORAL (Item 7): a recruiting trial ranks ABOVE an otherwise-identical
//     completed trial, and the PANTHER aza+pred+NAC arm is flagged + sunk.
{
  const RAW = 80; // identical accumulated raw before status adjustment
  const recruiting = applyPatientPromiseAdjustment(RAW, { status: 'RECRUITING', nctId: 'NCT_REC' });
  const completed = applyPatientPromiseAdjustment(RAW, { status: 'COMPLETED', nctId: 'NCT_DONE' });
  const recNorm = normalizePromise(recruiting.score);
  const doneNorm = normalizePromise(completed.score);
  if (recNorm > doneNorm && !recruiting.caution && doneNorm > 0) {
    pass(`Recruiting outranks completed at equal raw (${recNorm}/100 > ${doneNorm}/100), completed not hidden (Item 7)`);
  } else {
    fail(`Trial ranking regression (recruiting=${recNorm} completed=${doneNorm})`);
  }

  const panther = applyPatientPromiseAdjustment(60, {
    status: 'TERMINATED', nctId: 'NCT00650091', briefTitle: 'Prednisone Azathioprine NAC IPF (PANTHER)'
  });
  if (panther.caution && /harm/i.test(panther.caution) && normalizePromise(panther.score) < doneNorm) {
    pass('PANTHER aza+pred+NAC arm (NCT00650091) flagged with caution and ranked low (Item 7)');
  } else {
    fail(`PANTHER caution/ranking regression (caution=${!!panther.caution} score=${normalizePromise(panther.score)})`);
  }
}

// 21b. BEHAVIORAL (Chronic Constipation defect): a NO_LONGER_AVAILABLE trial
//      (e.g. a defunct expanded-access protocol) must rank BELOW an otherwise-
//      identical RECRUITING trial, and an UNKNOWN-status trial must be
//      penalised. Previously these statuses skipped NON_ENROLLING_PENALTY
//      entirely, so a dead program (60/100) outranked a live Phase 3 (33/100).
{
  const RAW = 80;
  const recruiting = applyPatientPromiseAdjustment(RAW, { status: 'RECRUITING', nctId: 'NCT_REC' });
  const noLonger = applyPatientPromiseAdjustment(RAW, { status: 'NO_LONGER_AVAILABLE', nctId: 'NCT_GONE' });
  const unknown = applyPatientPromiseAdjustment(RAW, { status: 'UNKNOWN', nctId: 'NCT_UNK' });
  const recNorm = normalizePromise(recruiting.score);
  const goneNorm = normalizePromise(noLonger.score);
  const unkNorm = normalizePromise(unknown.score);
  const penaltyWired = NON_ENROLLING_PENALTY.NO_LONGER_AVAILABLE < 0 && NON_ENROLLING_PENALTY.UNKNOWN < 0;
  if (penaltyWired && goneNorm < recNorm && unkNorm < recNorm && noLonger.score < RAW && unknown.score < RAW) {
    pass(`NO_LONGER_AVAILABLE (${goneNorm}/100) and UNKNOWN (${unkNorm}/100) rank below RECRUITING (${recNorm}/100) at equal raw (Chronic Constipation defect)`);
  } else {
    fail(`NO_LONGER_AVAILABLE/UNKNOWN penalty regression (rec=${recNorm} gone=${goneNorm} unk=${unkNorm} wired=${penaltyWired})`);
  }
}

// 21c. BEHAVIORAL (Chronic Constipation defect): the expanded-access / OLE
//      bonus is granted ONLY to a program a patient can actually join. A
//      NO_LONGER_AVAILABLE or COMPLETED expanded-access program gets NO bonus;
//      a RECRUITING / AVAILABLE one does. Previously the +20/+15 bonuses were
//      unconditional, lifting a defunct program above live trials.
{
  const ea = { designations: { hasExpandedAccess: true } };
  const ole = { designations: { hasOpenLabelExtension: true } };
  const recruitingEA = accessDesignationBonus({ status: 'RECRUITING', ...ea });
  const availableEA = accessDesignationBonus({ status: 'AVAILABLE', ...ea });
  const acceptingEA = accessDesignationBonus({ status: 'NO_LONGER_AVAILABLE', acceptingNewPatients: true, ...ea });
  const deadEA = accessDesignationBonus({ status: 'NO_LONGER_AVAILABLE', ...ea });
  const completedEA = accessDesignationBonus({ status: 'COMPLETED', ...ea });
  const recruitingOLE = accessDesignationBonus({ status: 'RECRUITING', ...ole });
  const deadOLE = accessDesignationBonus({ status: 'NO_LONGER_AVAILABLE', ...ole });
  const gatedOff = deadEA === 0 && completedEA === 0 && deadOLE === 0;
  const grantedOn = recruitingEA === 20 && availableEA === 20 && acceptingEA === 20 && recruitingOLE === 15;
  if (gatedOff && grantedOn && !programIsAvailable({ status: 'NO_LONGER_AVAILABLE' }) && programIsAvailable({ status: 'RECRUITING' })) {
    pass(`Access-designation bonus gated on availability (recruiting EA=+${recruitingEA}, available EA=+${availableEA}, dead EA=+${deadEA}, completed EA=+${completedEA}, dead OLE=+${deadOLE})`);
  } else {
    fail(`Access-designation gating regression (recEA=${recruitingEA} availEA=${availableEA} acceptEA=${acceptingEA} deadEA=${deadEA} compEA=${completedEA} recOLE=${recruitingOLE} deadOLE=${deadOLE})`);
  }
}

// 22. BEHAVIORAL (0-100 scale): normalized promise score never exceeds 100 or
//     drops below 0, and the UI labels the trial score "/100".
{
  const hi = normalizePromise(250);
  const lo = normalizePromise(-300);
  const mid = normalizePromise(35);
  const labelled = /Score \/100/.test(indexSrc) && /\{trial\.promiseScore\}\/100|promiseScore\}<span[^>]*>\/100/.test(indexSrc);
  if (hi === 100 && lo === 0 && mid > 0 && mid < 100 && labelled) {
    pass('Promise score clamped/scaled to 0-100 and UI labels it "/100"');
  } else {
    fail(`0-100 scale regression (hi=${hi} lo=${lo} mid=${mid} labelled=${labelled})`);
  }
}

// 23. BEHAVIORAL (Bipolar defect 4a): a RECRUITING trial whose title contains
//     boilerplate like "...Adverse Events (AEs)..." must NOT be flagged as
//     stopped/negative (contradictory "Stopped" + "RECRUITING" status flags).
{
  const recruitingAdverse = applyPatientPromiseAdjustment(80, {
    status: 'RECRUITING',
    acceptingNewPatients: true,
    nctId: 'NCT04777357',
    briefTitle: 'A Study to Assess Change in Disease Activity and Adverse Events (AEs) With Cariprazine'
  });
  // A genuinely terminated trial with a harm signal still IS flagged.
  const terminatedHarm = applyPatientPromiseAdjustment(80, {
    status: 'TERMINATED', acceptingNewPatients: false, nctId: 'NCT_T',
    briefTitle: 'Trial', whyStopped: 'Stopped for safety concern (increased adverse events)'
  });
  if (!recruitingAdverse.caution && terminatedHarm.caution) {
    pass('Recruiting trial w/ "Adverse Events" title NOT flagged stopped; terminated-for-harm still flagged (defect 4a)');
  } else {
    fail(`Stopped/negative flag regression (recruiting caution=${!!recruitingAdverse.caution} terminated caution=${!!terminatedHarm.caution})`);
  }
}

// 24. BEHAVIORAL (Bipolar defect 4b): a pediatric trial (ages 10-17) is
//     penalized + age-cautioned for a 64-year-old, and ranks below an
//     otherwise-identical adult-eligible trial.
{
  const RAW = 90;
  const pediatric = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT_PED',
    minimumAge: '10 Years', maximumAge: '17 Years', stdAges: ['CHILD']
  }, { patientAge: 64 });
  const adult = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT_ADULT',
    minimumAge: '18 Years', maximumAge: '65 Years', stdAges: ['ADULT', 'OLDER_ADULT']
  }, { patientAge: 64 });
  const pedNorm = normalizePromise(pediatric.score);
  const adultNorm = normalizePromise(adult.score);
  const pedCaution = /age|enrol/i.test(pediatric.caution || '');
  if (pedNorm < adultNorm && pedCaution && !adult.caution) {
    pass(`Age-ineligible pediatric trial penalized + cautioned and ranks below adult-eligible (${pedNorm}/100 < ${adultNorm}/100) (defect 4b)`);
  } else {
    fail(`Age-ineligibility regression (ped=${pedNorm} adult=${adultNorm} pedCaution=${pedCaution} adultCaution=${!!adult.caution})`);
  }
}

// 25. SOURCE (Bipolar defect 1): the candidate parser must split a merged block
//     on a duplicate field so one drug's risks/sources can't overwrite another.
if (/duplicate key as a fresh candidate boundary/i.test(indexSrc) &&
    /key === 'CANDIDATE:' \|\| \(cur && cur\[field\] !== undefined\)/.test(indexSrc)) {
  pass('parseCandidates splits a delimiter-less merged block (Magnesium-carrying-Lumateperone contamination guard, defect 1)');
} else {
  fail('parseCandidates missing duplicate-field block-split guard — wrong-drug field contamination can recur');
}

// 26. SOURCE (Bipolar defect 2): card titles strip markdown bold/links via
//     InlineTitle (no raw "**Quetiapine**" or "[..](..)" in headings).
if (/const InlineTitle = /.test(indexSrc) &&
    /<InlineTitle text=\{t\.treatment/.test(indexSrc) &&
    /<InlineTitle text=\{c\.combo/.test(indexSrc) &&
    /<InlineTitle text=\{c\.candidate/.test(indexSrc)) {
  pass('Approved, combo, and candidate titles render via InlineTitle (markdown bold/link stripped, defect 2)');
} else {
  fail('Card titles not routed through InlineTitle — raw markdown can leak into headings');
}

// 27. SOURCE (Bipolar defect 3): KB-injected approved stubs render as an honest
//     "also FDA-approved" reference list, not fake cards with empty "—" meters.
if (/_approvedStub/.test(indexSrc) &&
    /stubTreatments/.test(indexSrc) &&
    /Also FDA-approved for this condition/i.test(indexSrc)) {
  pass('Empty approved stubs render as an honest reference list (no fake "—" efficacy/safety cards, defect 3)');
} else {
  fail('Approved stubs still render as empty cards — header overstates detailed approved-treatment cards');
}

// 28. PILLAR 3 (anti-contamination provenance): a candidate field carrying a
//     DIFFERENT drug's content is dropped at render time, even when it is not a
//     duplicate field the parser would split on. This is the end-to-end guard
//     that makes the "Magnesium card shows Lumateperone's risks/sources"
//     contamination impossible to render rather than merely unlikely.
{
  const contaminated = [
    'CANDIDATE: Magnesium',
    'CONFIDENCE: 30% — weak mechanistic rationale',
    'SAFETY: 90% — well tolerated',
    'PATIENT_SPECIFIC_RISKS: Lumateperone prolongs the QT interval and causes sedation in this patient.',
    'CANDIDATE: Lumateperone (Caplyta)',
    'CONFIDENCE: 75% — phase 3 positive',
    'PATIENT_SPECIFIC_RISKS: Lumateperone may cause weight gain.'
  ].join('\n');
  const { text: cleaned, flags } = assertNoForeignEntities(contaminated);
  const magBlock = cleaned.split(/(?=CANDIDATE:)/i).find((b) => /^CANDIDATE:\s*Magnesium/i.test(b.trim())) || '';
  const lumaBlock = cleaned.split(/(?=CANDIDATE:)/i).find((b) => /^CANDIDATE:\s*Lumateperone/i.test(b.trim())) || '';
  const foreignGone = !/lumateperone/i.test(magBlock) && !/QT interval/i.test(magBlock);
  const ownKept = /30/.test(magBlock) && /90/.test(magBlock);
  const otherIntact = /weight gain/i.test(lumaBlock);
  if (foreignGone && ownKept && otherIntact && flags.length >= 1) {
    pass('assertNoForeignEntities drops a foreign-drug field from a candidate card (Pillar 3, end-to-end provenance)');
  } else {
    fail(`Pillar 3 provenance regression (foreignGone=${foreignGone} ownKept=${ownKept} otherIntact=${otherIntact} flags=${flags.length})`);
  }

  // finalizeReportText wires the guard into the real render path.
  const finalized = finalizeReportText(contaminated, { evidence: null, trials: null });
  if (!/lumateperone/i.test(finalized.split(/(?=CANDIDATE:)/i).find((b) => /Magnesium/i.test(b)) || '')) {
    pass('finalizeReportText applies the anti-contamination provenance guard');
  } else {
    fail('finalizeReportText did not strip cross-candidate contamination');
  }

  // A legitimate self-named interaction note is preserved (no over-stripping).
  const legit = 'CANDIDATE: Magnesium\nPATIENT_SPECIFIC_RISKS: Magnesium may reduce absorption of Lumateperone.\nCANDIDATE: Lumateperone\nCONFIDENCE: 75%';
  const legitOut = assertNoForeignEntities(legit);
  if (/Magnesium may reduce absorption of Lumateperone/i.test(legitOut.text) && legitOut.flags.length === 0) {
    pass('assertNoForeignEntities preserves a legitimate host-named interaction (no over-stripping)');
  } else {
    fail('assertNoForeignEntities over-stripped a legitimate interaction note');
  }
}

// 29. PILLAR 3: provenance tags are stamped at the source and the client mirror
//     is wired into the candidate parser.
{
  if (drugKeyFromName('Lumateperone (Caplyta) — 42 mg') === 'lumateperone') {
    pass('drugKeyFromName isolates the stable drug identity for provenance tagging');
  } else {
    fail(`drugKeyFromName regression (got "${drugKeyFromName('Lumateperone (Caplyta) — 42 mg')}")`);
  }
  if (/dropForeignCandidateFields/.test(indexSrc) &&
      /return dropForeignCandidateFields\(deduped\)/.test(indexSrc)) {
    pass('index.html parseCandidates routes parsed cards through the foreign-field provenance drop (client mirror)');
  } else {
    fail('index.html parseCandidates missing the client-side anti-contamination provenance drop');
  }
}

// 30. SOURCE (AGA defect 1): collectBlock treats a repeated card header
//     ("### 💊 CARD N —", "--- ### CARD 3:", "CARD 2 —") as a HARD boundary so a
//     card's REFERENCES/SOURCES field cannot swallow the next card's header +
//     intro (the "Finasteride sources bled Minoxidil's WHAT IT DOES" bug).
if (/CARD_BOUNDARY_RE\s*=/.test(indexSrc) &&
    /isCardBoundaryLine\(trimmed\)\)\s*break/.test(indexSrc)) {
  pass('collectBlock breaks on repeated "### 💊 CARD N —" boundary (approved-treatment SOURCES-bleed guard, defect 1)');
} else {
  fail('collectBlock missing card-header boundary guard — approved-treatment SOURCES can bleed the next card');
}

// 31. SOURCE (AGA defect 2): parseCombos matches field labels by NORMALIZING the
//     leading token, so it is robust to non-underscored / spaced / bold labels
//     ("EVIDENCE TIER:", "SUPPORTING EVIDENCE:"). Otherwise RATIONALE swallows
//     every later field and the combo renders as one raw ALLCAPS blob.
if (/COMBO_FIELD_BY_NORM/.test(indexSrc) &&
    /comboFieldFromLine/.test(indexSrc) &&
    /EVIDENCETIER:\s*'evidence_tier'/.test(indexSrc)) {
  pass('parseCombos normalizes field labels (underscored OR spaced/bold) — no raw combo blob (defect 2)');
} else {
  fail('parseCombos still requires exact underscored labels — combos can render as a raw blob');
}
if (/COMBO_TRAILING_FIELDS/.test(indexSrc) && /cleaned\.pop\(\)/.test(indexSrc)) {
  pass('parseCombos drops a truncated final combo missing all trailing fields (defect 3)');
} else {
  fail('parseCombos does not drop a truncated final combo — a half-complete combo card can render');
}
if (/<EvidenceStrengthBadge value=\{c\.evidence_tier\}/.test(indexSrc) &&
    /c\.how_to_discuss_with_doctor/.test(indexSrc) &&
    /c\.patient_specific_risks/.test(indexSrc)) {
  pass('ComboCard renders combos as STRUCTURED cards (evidence tier, confidence, risks, how-to-discuss, links) (defect 2)');
} else {
  fail('ComboCard does not render structured combo fields — combination ideas show as a raw blob');
}
if (/return isOpus \? 2600 : 3400/.test(researchSrc)) {
  pass('Repurpose back-half max_tokens raised to 3400 (Sonnet) — combos finish without mid-field truncation (defect 3)');
} else {
  fail('Repurpose back-half max_tokens still too low — final combination can truncate');
}

// 32. BEHAVIORAL (AGA defect 4): a Female Pattern Hair Loss trial is penalized +
//     sex-cautioned for a MALE patient and ranks below a sex-neutral AGA trial,
//     whether the restriction is explicit (eligibility.sex=FEMALE) or only in
//     the title. A mixed "men and women" trial and a same-sex patient are NOT
//     penalized (conservative — opposite-sex restriction only).
{
  const RAW = 80;
  const femaleOnly = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT_OMA102',
    sex: 'FEMALE', briefTitle: 'OMA102 in Female Pattern Hair Loss',
    conditions: ['Female Pattern Hair Loss']
  }, { patientAge: 29, patientSex: 'Male' });
  const neutral = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', acceptingNewPatients: true, nctId: 'NCT_AGA', sex: 'ALL',
    briefTitle: 'Topical agent for Androgenetic Alopecia', conditions: ['Androgenetic Alopecia']
  }, { patientAge: 29, patientSex: 'Male' });
  const titleOnly = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', nctId: 'NCT_RF', sex: 'ALL',
    briefTitle: 'Radiofrequency in Female Pattern Hair Loss', conditions: ['Female Pattern Hair Loss']
  }, { patientAge: 29, patientSex: 'Male' });
  const mixed = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', nctId: 'NCT_MIX', sex: 'ALL',
    briefTitle: 'AGA in men and women', conditions: ['Androgenetic Alopecia']
  }, { patientAge: 29, patientSex: 'Male' });
  const samesex = applyPatientPromiseAdjustment(RAW, {
    status: 'RECRUITING', nctId: 'NCT_OMA102', sex: 'FEMALE',
    briefTitle: 'OMA102 in Female Pattern Hair Loss', conditions: ['Female Pattern Hair Loss']
  }, { patientAge: 29, patientSex: 'Female' });
  const foNorm = normalizePromise(femaleOnly.score);
  const nNorm = normalizePromise(neutral.score);
  const toNorm = normalizePromise(titleOnly.score);
  const cautioned = /sex/i.test(femaleOnly.caution || '');
  if (foNorm < nNorm && toNorm < nNorm && cautioned &&
      !neutral.caution && !mixed.caution && !samesex.caution &&
      normalizePromise(mixed.score) === nNorm && normalizePromise(samesex.score) === nNorm) {
    pass(`Sex-ineligible Female Pattern trial penalized + cautioned for a male patient (${foNorm}/100 < ${nNorm}/100); mixed/same-sex not penalized (defect 4)`);
  } else {
    fail(`Sex-ineligibility regression (femaleOnly=${foNorm} neutral=${nNorm} titleOnly=${toNorm} cautioned=${cautioned} mixedCaution=${!!mixed.caution} samesexCaution=${!!samesex.caution})`);
  }
}
if (/patientSex:\s*patient\?\.gender/.test(researchSrc) && /patientSex = null/.test(readFileSync(new URL('../api/trials.js', import.meta.url), 'utf8'))) {
  pass('research.js plumbs patientSex (gender) into the trials call, mirroring patientAge (defect 4)');
} else {
  fail('patientSex not plumbed from research.js → trials.js the same way patientAge is');
}

// 33. LAYER 1 (leak detector): the shared detectStructuralLeak/auditCardFields
//     flag residual structural tokens (card-boundary headers, underscore-less
//     field labels) inside a parsed field value — the generalization of the
//     Pillar 3 guard that makes a whole class of parse-failure blobs LOUD.
{
  const boundaryLeak = detectStructuralLeak('[PMID 1](u) --- ### 💊 CARD 2 — Minoxidil WHAT IT DOES: a vasodilator');
  const blobLeak = detectStructuralLeak('Pairs two agents. EVIDENCETIER: SMALL_RCT SUPPORTINGEVIDENCE: a trial. HOWTODISCUSSWITHDOCTOR: ask.');
  const cleanProse = detectStructuralLeak('Slows FVC decline by half; photosensitivity and GI upset are common.');
  const acronym = detectStructuralLeak('Monitor FVC: an acronym mention should not flag.');
  if (boundaryLeak.includes('CARD boundary') && boundaryLeak.includes('WHAT IT DOES:') &&
      blobLeak.some((t) => /EVIDENCETIER/.test(t)) && blobLeak.some((t) => /SUPPORTINGEVIDENCE/.test(t)) &&
      !cleanProse.length && !acronym.length) {
    pass('Layer 1: detectStructuralLeak flags card-boundary + underscore-less label leaks; no false positive on prose/acronyms');
  } else {
    fail(`Layer 1: leak detector regression (boundary=${JSON.stringify(boundaryLeak)} blob=${JSON.stringify(blobLeak)} prose=${cleanProse.length} acronym=${acronym.length})`);
  }

  const leakyCard = { treatment: 'Finasteride', references: '[PMID 1](u) ### 💊 CARD 2 — Minoxidil WHAT IT DOES: ...', risks: 'Decreased libido in a small minority.' };
  const cleanCard = { treatment: 'Pirfenidone', references: '[PMID 24836310](u)', risks: 'Nausea and rash; sun protection advised.' };
  const leakyAudit = auditCardFields(leakyCard, ['treatment', 'references', 'risks']);
  const cleanAudit = auditCardFields(cleanCard, ['treatment', 'references', 'risks']);
  if (leakyAudit.length === 1 && leakyAudit[0].field === 'references' && !cleanAudit.length) {
    pass('Layer 1: auditCardFields isolates the leaked field (references) and passes a clean card');
  } else {
    fail(`Layer 1: auditCardFields regression (leaky=${JSON.stringify(leakyAudit)} clean=${cleanAudit.length})`);
  }
}

// 34. LAYER 1 (client wiring): index.html mirrors the leak detector and renders
//     a non-blocking "formatting issue" indicator on the specific card instead
//     of the leaked blob, via auditAndScrubCard + FormatWarning.
if (/const detectStructuralLeak =/.test(indexSrc) &&
    /STRUCTURAL_FIELD_LABELS/.test(indexSrc) &&
    /auditAndScrubCard/.test(indexSrc) &&
    /const FormatWarning =/.test(indexSrc) &&
    /<FormatWarning leaks=\{leaks\}/.test(indexSrc)) {
  pass('Layer 1: index.html mirrors the leak detector and renders FormatWarning on leaked cards (loud, non-blocking)');
} else {
  fail('Layer 1: index.html missing the client leak-detector mirror / FormatWarning wiring');
}

// 35. LAYER 3 (unified eligibility gate): one assessTrialEligibility function
//     returns the applicable per-dimension penalties/flags. One test per
//     dimension — sex opposite-restricted, age out-of-range, pediatric/adult
//     age-band, mixed-sex NOT penalized, sex-neutral NOT penalized.
{
  // (a) sex opposite-restricted
  const sexOpp = assessTrialEligibility(
    { sex: 'FEMALE', briefTitle: 'Female Pattern Hair Loss', conditions: ['Female Pattern Hair Loss'] },
    { patientSex: 'Male', patientAge: 29 }
  );
  // (b) age out-of-range (numeric)
  const ageOut = assessTrialEligibility(
    { minimumAge: '10 Years', maximumAge: '17 Years', stdAges: ['CHILD'] },
    { patientAge: 64, patientSex: 'Male' }
  );
  // (c) adult-only age-band for a pediatric patient (new band sanity)
  const adultOnlyForChild = assessTrialEligibility(
    { stdAges: ['ADULT', 'OLDER_ADULT'] },
    { patientAge: 9, patientSex: 'Female' }
  );
  // (d) mixed-sex ("men and women") NOT penalized
  const mixed = assessTrialEligibility(
    { sex: 'ALL', briefTitle: 'AGA in men and women', conditions: ['Androgenetic Alopecia'] },
    { patientSex: 'Male', patientAge: 29 }
  );
  // (e) sex-neutral + age-eligible NOT penalized
  const neutral = assessTrialEligibility(
    { sex: 'ALL', minimumAge: '18 Years', maximumAge: '85 Years', stdAges: ['ADULT', 'OLDER_ADULT'] },
    { patientSex: 'Male', patientAge: 29 }
  );
  const sexOk = sexOpp.penalty < 0 && sexOpp.flags.some((f) => f.dimension === 'sex');
  const ageOk = ageOut.penalty < 0 && ageOut.flags.some((f) => f.dimension === 'age');
  const bandOk = adultOnlyForChild.penalty < 0 && adultOnlyForChild.flags.some((f) => f.dimension === 'age');
  const mixedOk = mixed.penalty === 0 && !mixed.flags.length;
  const neutralOk = neutral.penalty === 0 && !neutral.flags.length;
  if (sexOk && ageOk && bandOk && mixedOk && neutralOk) {
    pass('Layer 3: assessTrialEligibility gates sex/age/age-band; mixed-sex + sex-neutral pass (one explicit test per dimension)');
  } else {
    fail(`Layer 3: eligibility-gate regression (sex=${sexOk} age=${ageOk} band=${bandOk} mixed=${mixedOk} neutral=${neutralOk})`);
  }

  // The gate is the SINGLE source used by the score adjuster (no scattered checks).
  const trialsSrc = readFileSync(new URL('../api/trials.js', import.meta.url), 'utf8');
  if (/export const assessTrialEligibility/.test(trialsSrc) &&
      /const eligibility = assessTrialEligibility\(study/.test(trialsSrc)) {
    pass('Layer 3: applyPatientPromiseAdjustment delegates to the unified assessTrialEligibility gate');
  } else {
    fail('Layer 3: eligibility checks still scattered — applyPatientPromiseAdjustment does not use assessTrialEligibility');
  }
}

console.log(process.exitCode ? '\n\x1b[31mPlatform regression FAILED\x1b[0m\n' : '\n\x1b[32mPlatform regression passed\x1b[0m\n');
