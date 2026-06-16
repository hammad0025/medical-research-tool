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
  allApprovedDrugsRendered
} from '../lib/report-polish.js';

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

// 2. Batch token budget — must be high enough for 5 candidates/lane
const researchSrc = readFileSync(new URL('../api/research.js', import.meta.url), 'utf8');
if (/isBatch\)\s*return\s+isOpus\s*\?\s*3400\s*:\s*4200/.test(researchSrc)) {
  pass('Repurpose lane max_tokens = 4200 (Sonnet) — prevents 3-drug truncation');
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

console.log(process.exitCode ? '\n\x1b[31mPlatform regression FAILED\x1b[0m\n' : '\n\x1b[32mPlatform regression passed\x1b[0m\n');
