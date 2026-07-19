#!/usr/bin/env node
// Platform robustness regression — offline, no Anthropic spend.
// Run: node scripts/regression-platform.mjs

import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { loadKb, listKbs } from '../lib/kb.js';
import { buildSupplementDiscoveryBlock, isSupplementEvidenceItem } from '../lib/supplement-discovery.js';
import {
  REPURPOSE_MIN_TOTAL,
  REPURPOSE_TARGET_TOTAL,
  REPURPOSE_SECTION_TARGET,
  REPURPOSE_LANE_COUNT,
  REPURPOSE_PER_LANE,
  countCandidateBlocks,
  assessRepurposeQuality,
  isRealCitationUrl,
  candidateHasRealCitation,
  distinctLinkedCandidateCount,
  appendRegistryFill,
  dailyMedSearchUrl,
  buildRegistryFillCandidate,
  textHasRealCitation,
  isDailyMedSearchUrl,
  isDailyMedLabelUrl,
  resolveRepurposeSection,
  resolveItemKind,
  REPURPOSE_SECTION_NEVER,
  REPURPOSE_SECTION_RESEARCHED,
  REPURPOSE_BACKFILL_MAX_PASSES
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
  recordConditionErrors,
  getConditionErrors,
  _resetErrorStoreForTests
} from '../lib/error-store.js';
import { verdictToErrorRecords, buildPatientSnapshot } from '../lib/validate.js';
import {
  buildLearnedErrorsBlock,
  MAX_LEARNED_ERRORS,
  DEFAULT_GEN_TEMPERATURE,
  buildPatientContext
} from '../api/research.js';
import {
  applyValidationFixes,
  injectApprovedTreatmentStubs,
  allApprovedDrugsRendered,
  stripApprovedTreatmentsSection,
  drugBaseKey,
  parseHeadlinePercent,
  clampToCompleteSentence,
  finalizeReportText,
  stripUnsupportedEligibilityClaims,
  assertNoForeignEntities,
  detectStructuralLeak,
  auditCardFields,
  reattachEntityLinks,
  sanitizeFabricatedEfficacyScores,
  demoteGoogleAsPaperCitations,
  stripGoogleSearchMarkdownLinks,
  isFabricatedEfficacyScore,
  sanitizeMarkdownLinks,
  collectAllowedUrls,
  preferVerifiableUrl,
  resolveInlineReferenceMarkers,
  buildReferenceUrlMap,
  stripDailyMedSearchLinks,
  isNamedEntityBold,
  enforceCandidateCitationRelevance,
  enforceConditionCitationRelevance,
  attachMissingClaimCitations,
  linkBareNctIds,
  filterApprovedSocFromRepurpose,
  approvedSocNames,
  isKnownDeadUrl,
  stripInvalidMarkdownAnchors,
  stripNegativeFindingCitations,
  isNegativeOrEmptyFinding,
  isMarkdownTableRow,
  polishReportForDisplay
} from '../lib/report-polish.js';
import {
  buildGroundingIndex,
  isClaimGrounded,
  partitionValidatorFindings,
  buildEvidenceUrlIndex,
  citationRelevantToSubject,
  sourceMentionsSubject,
  sourceMentionsCondition,
  subjectTokens,
  conditionSubjectTokens
} from '../lib/grounding-gate.js';
import { stripDemographicMismatchLines } from '../lib/demographic-gate.js';
import { stripForeignDiseaseContamination, filterEvidencePackByCondition } from '../lib/disease-contamination.js';
import {
  REPURPOSE_MIN_PER_LANE,
  REPURPOSE_BACKFILL_THRESHOLD,
  distinctCandidateCount,
  candidateNamesFromText,
  needsBackfill
} from '../lib/repurpose-quality.js';
import { selectRepurposeDrugs } from '../lib/drug-registry.js';
import {
  classifyGeneticResult,
  geneticContextLine,
  geneticSnapshotRow
} from '../lib/genetics.js';
import { drugKeyFromName } from '../lib/kb-builder.js';
import {
  scoreSafety,
  injectSafetyBands,
  normalizePatientMeds,
  FAERS_SERIOUS_MIN_REPORTS
} from '../lib/safety-score.js';
import {
  normalizePromise,
  applyPatientPromiseAdjustment,
  assessTrialEligibility,
  patientSexIneligible,
  patientAgeIneligible,
  NON_ENROLLING_PENALTY,
  accessDesignationBonus,
  programIsAvailable
} from '../api/trials.js';
import {
  classifyProbeStatus,
  isTrustedLiveHost,
  buildFallbackSearchUrl,
  stripDeadLinksFromText,
  extractReportUrls,
  findDeadLinks
} from '../lib/link-check.js';
import {
  isBannedClaimCitation,
  demoteBannedClaimCitations,
  buildDeadLinkReplacement,
  isUnverifiedDocumentUrl
} from '../lib/citation-gate.js';
import { extractKbCitationUrls } from './audit-kb-links.mjs';

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

// Access gate: ON whenever MRT_ACCESS_PASSCODE is set — never requires a
// separate FORCE flag (that left production world-readable while the
// passcode env was present).
{
  const gateSrc = readFileSync(new URL('../lib/access-gate.js', import.meta.url), 'utf8');
  if (
    /validPasscodes\.size\s*>\s*0/.test(gateSrc) &&
    !/MRT_ACCESS_GATE_FORCE/.test(gateSrc)
  ) {
    pass('Access gate: enabled whenever MRT_ACCESS_PASSCODE is set (no FORCE opt-in)');
  } else {
    fail('Access gate still depends on MRT_ACCESS_GATE_FORCE or is not passcode-driven');
  }
}

// 1. Repurpose quality constants wired
if (REPURPOSE_LANE_COUNT * REPURPOSE_PER_LANE >= REPURPOSE_TARGET_TOTAL) {
  pass(`Repurpose target: ${REPURPOSE_LANE_COUNT}×${REPURPOSE_PER_LANE} = ${REPURPOSE_LANE_COUNT * REPURPOSE_PER_LANE} (floor ${REPURPOSE_MIN_TOTAL})`);
} else {
  fail('Lane count × per-lane does not reach target total');
}

// 2. Batch token budget — must be high enough for up to ~18 candidates/lane
const researchSrc = readFileSync(new URL('../api/research.js', import.meta.url), 'utf8');
if (/isBatch\)\s*return\s+isOpus\s*\?\s*9000\s*:\s*12000/.test(researchSrc)) {
  pass('Repurpose lane max_tokens = 12000 (Sonnet) — fits up to ~18 candidates/lane');
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

// 8. Client lane retry (compiled from src/app.jsx)
const html = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
if (/Retrying.*incomplete drug batch/i.test(html) || /MIN_PER_LANE|laneNeedsRetry|truncated/i.test(html)) {
  pass('Frontend retries incomplete repurpose lanes');
} else {
  warn('Frontend lane retry not detected — add orchestration in index.html');
}

// 8b. Only cited, server-sealed candidates render; no count-based padding/cap.
const citedOnly = /\.filter\(hasCitation\)/.test(html);
const noQuotaCap = !/SOFT_CAP\s*=\s*50|SECTION_CAP\s*=\s*25|combined\.slice\(0, SOFT_CAP\)/.test(html);
const twoSections = /neverResearched/.test(html) && /researchedNotApproved/.test(html) && /resolveRepurposeSection/.test(html);
const itemKindUi = /ItemKindBadge/.test(html) && /ITEM_KIND:/.test(html);
// Dorothy: Research tab PRIMARY view must render both section headers itself —
// never a single flat "Drug & supplement ideas (N)" pile that punts to the
// Drug Repurposing tab.
const researchTabTwoSection =
  /Drug &amp; Supplement Repurposing Ideas/.test(html) &&
  /Researched, Not Yet FDA-Approved for \{cond\}/.test(html) &&
  !/Open the Drug Repurposing tab for the full two-section list/.test(html) &&
  /rd-nr-/.test(html) &&
  /rd-rna-/.test(html);
if (citedOnly && noQuotaCap && twoSections && itemKindUi && researchTabTwoSection) {
  pass('Repurpose candidates: two patient-facing sections render cited server output without quota padding');
} else {
  fail(`Citation/section wiring missing in index.html (citedOnly=${citedOnly} noQuotaCap=${noQuotaCap} twoSections=${twoSections} itemKind=${itemKindUi} researchTab=${researchTabTwoSection})`);
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

// 11. Quality assessor sanity — evidence quality is mandatory, but no medical
// candidate quota may force unsupported filler.
{
  // REAL citations only (client mandate): a DailyMed SEARCH page no longer
  // counts — use specific setid label monographs (drugInfo.cfm?setid=…) which do.
  const short = assessRepurposeQuality([
    'CANDIDATE: a\nREFERENCES: [x](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=aa-1)\n',
    'CANDIDATE: b\nREFERENCES: [x](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=bb-2)\n'
  ]);
  if (short.ok && short.linked === 2 && short.shortfall === 0) {
    pass(`Quality assessor accepts ${short.linked} supported candidates without forcing filler`);
  } else {
    fail(`Quality assessor broken (ok=${short.ok} linked=${short.linked} shortfall=${short.shortfall})`);
  }
  const blocks = Array.from({ length: 50 }, (_, i) => {
    const name = `Candidate${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}${i}`;
    return `CANDIDATE: ${name}\nREFERENCES: [DailyMed label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${name.toLowerCase()}-x)`;
  }).join('\n\n');
  const full = assessRepurposeQuality([blocks]);
  if (full.ok && full.linked >= 50) pass(`Quality assessor OK at ${full.linked} REAL-linked candidates`);
  else fail(`Quality assessor should pass Hard 50 (ok=${full.ok} linked=${full.linked})`);
  if (REPURPOSE_SECTION_TARGET === 0 && REPURPOSE_TARGET_TOTAL === 0) {
    pass('Two-section output has no unsupported minimum quota');
  } else {
    fail(`Two-section targets wrong (section=${REPURPOSE_SECTION_TARGET} total=${REPURPOSE_TARGET_TOTAL})`);
  }
}

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

const indexSrc = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
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

// 15. BEHAVIORAL: a disputed claim WITH a correction is rewritten in place
//     (kept, corrected); a disputed claim with NO correction is removed
//     entirely (Dorothy: "remove things the AI disagrees with if it's not
//     accurate"). Now safe because the validator receives the full patient
//     snapshot, so disputes reflect real errors, not missing context.
{
  const badClaim = 'This patient tested negative for known IPF-related gene variants.';
  const keep = 'Pirfenidone is an oral antifibrotic approved for IPF.';
  const report = ['## 2. Background', keep, badClaim, 'It can cause photosensitivity and GI upset.'].join('\n');
  const validation = { primary: { disputed: [{ claim: badClaim, quote: badClaim, reason: 'hallucinated clinical finding' }] } };
  const fixed = applyValidationFixes(report, validation, null, null);
  if (!fixed.includes(badClaim) && fixed.includes(keep)) {
    pass('Second AI check removes a no-correction disputed claim while keeping unrelated lines');
  } else {
    fail(`Second AI check disputed-removal broken (removedBad=${!fixed.includes(badClaim)} keptOther=${fixed.includes(keep)})`);
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

// 22. BEHAVIORAL: internal compatibility normalization remains bounded while
//     the patient UI does not expose a pseudo-clinical numeric score.
{
  const hi = normalizePromise(250);
  const lo = normalizePromise(-300);
  const mid = normalizePromise(35);
  const hidden = !/Ranking \/100/.test(indexSrc) &&
    !/\{trial\.promiseScore\}\/100|promiseScore\}<span[^>]*>\/100/.test(indexSrc);
  if (hi === 100 && lo === 0 && mid > 0 && mid < 100 && hidden) {
    pass('Internal compatibility score stays bounded and is hidden from patient UI');
  } else {
    fail(`Internal ordering compatibility regression (hi=${hi} lo=${lo} mid=${mid} hidden=${hidden})`);
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
  const pedCaution = /age|enrol/i.test(pediatric.eligibilityCaution || '');
  if (pedNorm < adultNorm && pedCaution && !adult.eligibilityCaution) {
    pass(`Age-ineligible pediatric trial penalized + cautioned and ranks below adult-eligible (${pedNorm}/100 < ${adultNorm}/100) (defect 4b)`);
  } else {
    fail(`Age-ineligibility regression (ped=${pedNorm} adult=${adultNorm} pedCaution=${pedCaution} adultCaution=${!!adult.eligibilityCaution})`);
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
  const finalizedMag = finalized.split(/(?=CANDIDATE:)/i)
    .find((b) => /^CANDIDATE:\s*Magnesium/i.test(b.trim())) || '';
  if (!/lumateperone|QT interval/i.test(finalizedMag)) {
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
  const cautioned = /sex/i.test(femaleOnly.eligibilityCaution || '');
  if (foNorm < nNorm && toNorm < nNorm && cautioned &&
      !neutral.eligibilityCaution && !mixed.eligibilityCaution && !samesex.eligibilityCaution &&
      normalizePromise(mixed.score) === nNorm && normalizePromise(samesex.score) === nNorm) {
    pass(`Sex-ineligible Female Pattern trial penalized + cautioned for a male patient (${foNorm}/100 < ${nNorm}/100); mixed/same-sex not penalized (defect 4)`);
  } else {
    fail(`Sex-ineligibility regression (femaleOnly=${foNorm} neutral=${nNorm} titleOnly=${toNorm} cautioned=${cautioned} mixedCaution=${!!mixed.eligibilityCaution} samesexCaution=${!!samesex.eligibilityCaution})`);
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

// 36. ERROR MEMORY (Dorothy: "remember the errors it catches and not repeat
//     them"). Three checks: (a) error-store insert/dedupe/cap/round-trip on the
//     in-memory fallback, (b) the prompt-block builder renders stored errors +
//     the do-not-repeat instruction and stays capped, (c) validate.js turns a
//     verdict's disputed/unsupported/hallucinated findings into store records.
{
  // (a) insert / dedupe / cap / round-trip
  _resetErrorStoreForTests();
  const cond = 'Test Memory Condition';
  await recordConditionErrors(cond, [
    { type: 'disputed', quote: 'Drug X cures this', reason: 'not supported', correction: 'Drug X may help some patients', source: 'validator' },
    { type: 'unsupported', claim: 'Supplement Y reverses fibrosis', reason: 'no evidence', source: 'validator' }
  ]);
  // Re-insert the SAME disputed quote (different case/whitespace) → must dedupe.
  await recordConditionErrors(cond, [
    { type: 'disputed', quote: '  drug x CURES this  ', reason: 'still not supported', source: 'validator' }
  ]);
  const stored = await getConditionErrors(cond);
  const dedupeOk = stored.length === 2;
  const roundTripOk = stored.some((e) => /Supplement Y reverses fibrosis/.test(e.claim || '')) &&
                      stored.some((e) => /cures this/i.test(e.quote || ''));

  // Cap: push well past MAX (50) and confirm the newest are kept.
  _resetErrorStoreForTests();
  const many = [];
  const recentBaseTs = Date.now() - 60_000;
  for (let i = 0; i < 60; i++) {
    many.push({
      type: 'unsupported',
      claim: `bogus claim number ${i}`,
      ts: recentBaseTs + i,
      source: 'validator'
    });
  }
  await recordConditionErrors(cond, many);
  const capped = await getConditionErrors(cond);
  const capOk = capped.length === 50 &&
                capped.some((e) => /number 59/.test(e.claim)) &&
                !capped.some((e) => /number 0\b/.test(e.claim));

  // Empty / textless records are dropped, and an empty condition is a no-op.
  const noText = await recordConditionErrors(cond, [{ type: 'disputed', reason: 'no claim or quote' }]);
  const emptyCond = await recordConditionErrors('', [{ type: 'disputed', quote: 'x' }]);
  const guardOk = noText === 50 && emptyCond === 0;

  if (dedupeOk && roundTripOk && capOk && guardOk) {
    pass('Error memory (a): insert/dedupe/cap(50, newest)/round-trip on in-memory fallback');
  } else {
    fail(`Error memory (a): store regression (dedupe=${dedupeOk} roundTrip=${roundTripOk} cap=${capOk} guard=${guardOk})`);
  }

  // (b) prompt-block builder
  const emptyBlock = buildLearnedErrorsBlock([]);
  const block = buildLearnedErrorsBlock([
    { type: 'disputed', quote: 'Drug X cures this condition', reason: 'contradicted by pack', correction: 'Drug X modestly slows progression' },
    { type: 'hallucinated_citation', url: 'https://example.com/fake', reason: 'URL 404s' }
  ]);
  const blockOk =
    emptyBlock === '' &&
    /PREVIOUSLY CAUGHT ERRORS FOR THIS CONDITION/.test(block) &&
    /do NOT repeat/i.test(block) &&
    /Drug X cures this condition/.test(block) &&
    /CORRECTION: Drug X modestly slows progression/.test(block) &&
    /None of the wrong claims above may appear/.test(block) &&
    /NEVER echo this header/.test(block);
  // Cap: builder must never emit more than MAX_LEARNED_ERRORS numbered items.
  const big = [];
  for (let i = 0; i < 40; i++) big.push({ type: 'unsupported', claim: `wrong thing ${i}` });
  const bigBlock = buildLearnedErrorsBlock(big);
  const numbered = (bigBlock.match(/^\d+\. WRONG:/gm) || []).length;
  const blockCapOk = numbered === MAX_LEARNED_ERRORS;
  if (blockOk && blockCapOk) {
    pass(`Error memory (b): buildLearnedErrorsBlock renders errors + do-not-repeat instruction, internal-only, capped at ${MAX_LEARNED_ERRORS}`);
  } else {
    fail(`Error memory (b): prompt-block regression (block=${blockOk} cap=${blockCapOk} numbered=${numbered})`);
  }

  // (c) validate.js maps a verdict's findings into store records
  const records = verdictToErrorRecords({
    disputed: [{ claim: 'c1', quote: 'q1', reason: 'r1', correction: 'fix1' }],
    unsupported: [{ claim: 'c2', reason: 'r2' }],
    hallucinatedCitations: [{ url: 'https://x/y', issue: '404' }]
  });
  const mapOk =
    records.length === 3 &&
    records.some((r) => r.type === 'disputed' && r.quote === 'q1' && r.correction === 'fix1' && r.source === 'validator') &&
    records.some((r) => r.type === 'unsupported' && r.claim === 'c2') &&
    records.some((r) => r.type === 'hallucinated_citation' && r.url === 'https://x/y' && r.reason === '404');
  // End-to-end: those records persist and come back for the condition.
  _resetErrorStoreForTests();
  await recordConditionErrors('IPF', records);
  const back = await getConditionErrors('IPF');
  const persistOk = back.length === 3 && back.some((r) => r.quote === 'q1');
  if (mapOk && persistOk) {
    pass('Error memory (c): validate.js verdictToErrorRecords → store persists disputed/unsupported/hallucinated findings');
  } else {
    fail(`Error memory (c): validate persistence regression (map=${mapOk} persist=${persistOk})`);
  }
  _resetErrorStoreForTests();
}

// ===========================================================================
// FIX 1 — validator grounding gate (medical safety). A validator-disputed claim
// that OUR grounding (canonical facts / evidence pack) supports must be KEPT and
// NOT persisted; an ungrounded one is still removed. GERD/87% IPF is the case.
// ===========================================================================
{
  const canonicalFacts = [
    { claim: '~87% of IPF patients have abnormal acid gastroesophageal reflux on pH probe studies.' }
  ];
  const evidencePack = [
    { title: 'Antacid therapy for idiopathic pulmonary fibrosis',
      summary: 'Treat GERD when symptomatic; GERD treatment should not be withheld in IPF.' }
  ];
  const index = buildGroundingIndex({ canonicalFacts, evidencePack });
  const groundedClaim = 'About 87% of people with IPF have acid reflux (GERD), and antacid medicines may help.';
  const ungroundedClaim = 'Vitamin C at 5000 mg daily reverses lung scarring in 95% of IPF patients.';
  const gOk = isClaimGrounded(groundedClaim, index) === true;
  const uOk = isClaimGrounded(ungroundedClaim, index) === false;
  if (gOk && uOk) pass('Fix 1: grounding index accepts the KB-backed 87% GERD/antacid claim, rejects an ungrounded 95% claim');
  else fail(`Fix 1: grounding recognition broken (grounded=${gOk} ungrounded=${uOk})`);

  const report = ['## 1. Snapshot', groundedClaim, ungroundedClaim].join('\n');
  const validation = { primary: { disputed: [
    { claim: 'GERD prevalence overstated', quote: groundedClaim, reason: 'validator thinks guideline recommends against antacids' },
    { claim: 'vitamin C efficacy', quote: ungroundedClaim, reason: 'no evidence in pack' }
  ] } };
  const evidence = { canonicalFacts, groundedForPrompt: evidencePack };
  const fixed = applyValidationFixes(report, validation, evidence, null);
  const keptGrounded = fixed.includes('87%') && /antacid/i.test(fixed);
  const removedUngrounded = !fixed.includes('reverses lung scarring');
  if (keptGrounded && removedUngrounded) pass('Fix 1: applyValidationFixes KEEPS the grounded disputed claim and REMOVES the ungrounded one');
  else fail(`Fix 1: gate end-to-end broken (kept=${keptGrounded} removed=${removedUngrounded})`);

  const { disputed, overruled } = partitionValidatorFindings(validation.primary, index);
  const overruledGrounded = overruled.some((o) => o.quote === groundedClaim)
    && !disputed.some((d) => d.quote === groundedClaim);
  const persistUngrounded = disputed.some((d) => d.quote === ungroundedClaim);
  if (overruledGrounded && persistUngrounded) pass('Fix 1: grounded finding is overruled (not persisted); ungrounded finding still persists to error store');
  else fail(`Fix 1: partition broken (overruleGrounded=${overruledGrounded} persistUngrounded=${persistUngrounded})`);

  // Empty grounding (thin dynamic KB) must fall back to current remove behaviour.
  const emptyIdx = buildGroundingIndex({});
  if (isClaimGrounded(groundedClaim, emptyIdx) === false) pass('Fix 1: an empty grounding index never grounds a claim (thin-KB fallback preserves remove-and-learn)');
  else fail('Fix 1: empty grounding wrongly grounded a claim');
}

// ===========================================================================
// FIX — unsupported gene-eligibility / "gene-agnostic — <GENE>-eligible"
// qualifier stripping (NAC / CERKL leak). The cited source supports the
// finding, NOT the appended patient-specific eligibility claim. Strip the
// qualifier surgically, keep the cited finding + [#N] reference. A genuinely
// evidence-supported gene-eligibility claim is preserved. The validator prompt
// treats a live-cited-but-unsupported eligibility qualifier as flaggable.
// ===========================================================================
{
  // (a) UNSUPPORTED: NAC antioxidant pack never names CERKL → strip qualifier,
  //     keep the genuinely-cited phase-1 finding and its [#6] reference + link.
  const nacEvidence = {
    groundedForPrompt: [{
      title: 'N-acetylcysteine Phase 1 in Retinitis Pigmentosa (FIGHT-RP1)',
      journal: 'American Journal of Ophthalmology',
      year: 2019,
      url: 'https://www.sciencedirect.com/science/article/abs/pii/S0002939419305732',
      summary: 'Oral N-acetylcysteine was safe over 24 weeks and associated with improved visual acuity and retinal sensitivity in retinitis pigmentosa. Phase 1, open-label.'
    }]
  };
  const nacCard = [
    'CANDIDATE: N-acetylcysteine (NAC)',
    'CLASS: Cheap oral antioxidant pill',
    'EFFICACY_HYPOTHESIS: Phase 1 showed improved vision sharpness and retinal sensitivity over 24 weeks [#6]. Gene-agnostic — CERKL-eligible.',
    'REFERENCES: [FIGHT-RP1 Phase 1, Am J Ophthalmol 2019](https://www.sciencedirect.com/science/article/abs/pii/S0002939419305732)'
  ].join('\n');
  const nacRes = stripUnsupportedEligibilityClaims(nacCard, nacEvidence);
  const qualifierGone = !/gene-agnostic/i.test(nacRes.text) && !/CERKL-eligible/i.test(nacRes.text);
  const findingKept = /Phase 1 showed improved vision sharpness and retinal sensitivity over 24 weeks \[#6\]/.test(nacRes.text);
  const refKept = /S0002939419305732/.test(nacRes.text);
  if (qualifierGone && findingKept && refKept && nacRes.stripped.length >= 1) {
    pass('Eligibility: strips "gene-agnostic — CERKL-eligible" while KEEPING the cited phase-1 finding + [#6] reference');
  } else {
    fail(`Eligibility strip regression (qualifierGone=${qualifierGone} findingKept=${findingKept} refKept=${refKept} stripped=${nacRes.stripped.length})`);
  }

  // finalizeReportText wires the stripper into the real render path.
  const finalized = finalizeReportText(nacCard, { evidence: nacEvidence, trials: null });
  if (!/CERKL-eligible/i.test(finalized) && /retinal sensitivity/i.test(finalized)) {
    pass('Eligibility: finalizeReportText applies the qualifier stripper end-to-end (qualifier gone, finding kept)');
  } else {
    fail('Eligibility: finalizeReportText did not strip the unsupported qualifier');
  }

  // (b) SUPPORTED: pack explicitly names the gene in an eligibility context →
  //     the gene-eligibility claim is PRESERVED (no over-stripping).
  const rpe65Evidence = {
    groundedForPrompt: [{
      title: 'Voretigene neparvovec (Luxturna)',
      summary: 'Gene therapy indicated for patients with confirmed biallelic RPE65 mutation-associated inherited retinal dystrophy.',
      url: 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=voretigene'
    }]
  };
  const rpe65Card = 'WHY_FOR_THIS_CONDITION: Approved gene therapy — RPE65-eligible for patients with biallelic RPE65 variants [#2].';
  const rpe65Res = stripUnsupportedEligibilityClaims(rpe65Card, rpe65Evidence);
  if (/RPE65-eligible/i.test(rpe65Res.text) && rpe65Res.stripped.length === 0) {
    pass('Eligibility: a pack-supported gene-eligibility claim (RPE65 named + eligibility context) is PRESERVED');
  } else {
    fail(`Eligibility: over-stripped a supported gene-eligibility claim (stripped=${rpe65Res.stripped.length})`);
  }

  // (b2) SUPPORTED gene-agnostic: the source itself asserts genotype-independent
  //      benefit → the "gene-agnostic" claim is PRESERVED.
  const agnosticEvidence = {
    groundedForPrompt: [{
      title: 'Optogenetic therapy',
      summary: 'Restores light sensitivity independent of genotype and is therefore gene-agnostic across all genotypes.',
      url: 'https://clinicaltrials.gov/study/NCT03326336'
    }]
  };
  const agnosticCard = 'WHAT_IT_DOES: Restores light response — gene-agnostic across RP subtypes [#3].';
  const agnosticRes = stripUnsupportedEligibilityClaims(agnosticCard, agnosticEvidence);
  if (/gene-agnostic/i.test(agnosticRes.text) && agnosticRes.stripped.length === 0) {
    pass('Eligibility: a pack-supported gene-agnostic claim (source asserts genotype-independent) is PRESERVED');
  } else {
    fail(`Eligibility: over-stripped a supported gene-agnostic claim (stripped=${agnosticRes.stripped.length})`);
  }

  // (c) The IPF ~87% GERD canonical fact carries no eligibility marker and must
  //     be left completely untouched (do not weaken the grounding gate's fact
  //     protection or nuke unrelated lines).
  const gerdCard = 'About 87% of people with IPF have acid reflux (GERD), and antacid medicines may help [#1].';
  const gerdRes = stripUnsupportedEligibilityClaims(gerdCard, { canonicalFacts: [{ claim: '~87% of IPF patients have abnormal acid GERD.' }] });
  if (gerdRes.text === gerdCard && gerdRes.stripped.length === 0) {
    pass('Eligibility: the IPF ~87% GERD fact (no eligibility qualifier) is untouched');
  } else {
    fail('Eligibility: stripper wrongly altered the IPF GERD fact');
  }

  // (d) A benign "-eligible" that is NOT a gene symbol (lowercase) is untouched.
  const benign = 'HOW_TO_DISCUSS_WITH_DOCTOR: Ask whether you are trial-eligible for local studies.';
  const benignRes = stripUnsupportedEligibilityClaims(benign, nacEvidence);
  if (benignRes.text === benign && benignRes.stripped.length === 0) {
    pass('Eligibility: a benign non-gene "trial-eligible" phrase is not stripped');
  } else {
    fail('Eligibility: stripper over-matched a benign "-eligible" phrase');
  }

  // (e) Validator prompt treats a live-cited-but-unsupported eligibility
  //     qualifier as a flaggable finding (defense-in-depth beside the
  //     deterministic stripper).
  const validateSrc = readFileSync(new URL('../lib/validate.js', import.meta.url), 'utf8');
  if (/CITED-BUT-UNSUPPORTED ELIGIBILITY/.test(validateSrc) && /gene-agnostic/i.test(validateSrc) && /even when the cited URL is REAL/i.test(validateSrc)) {
    pass('Eligibility: validator prompt flags a live-cited-but-unsupported gene-eligibility qualifier');
  } else {
    fail('Eligibility: validator prompt missing the cited-but-unsupported eligibility check');
  }

  // (f) Prompt hardening: the generator guardrails forbid asserting therapy
  //     gene-eligibility unless the evidence pack explicitly supports it.
  if (/THERAPY GENE-ELIGIBILITY/.test(researchSrc) && /gene-agnostic/i.test(researchSrc)) {
    pass('Eligibility: SHARED_GUARDRAILS forbid unsupported therapy gene-eligibility claims');
  } else {
    fail('Eligibility: SHARED_GUARDRAILS missing the therapy gene-eligibility rule');
  }

  // (g) Fix-7b — Section-4 trial-annotation line: an appended
  //     "· Gene-agnostic — relevant to CERKL patients" is stripped while the
  //     NCT id, sponsor, and status survive (these lines flow through
  //     finalizeReportText along with the rest of the report text).
  const trialLine = 'NCT03999021 — FIGHT-RP 1 Extension Study (oral NAC effervescent tablets) · Sponsor: Johns Hopkins · Status: Active, not recruiting · Gene-agnostic — relevant to CERKL patients';
  const trialRes = stripUnsupportedEligibilityClaims(trialLine, nacEvidence);
  const trialOk = /NCT03999021/.test(trialRes.text) && /Active, not recruiting/.test(trialRes.text)
    && /Johns Hopkins/.test(trialRes.text)
    && !/gene-agnostic/i.test(trialRes.text) && !/CERKL/i.test(trialRes.text);
  if (trialOk && trialRes.stripped.length >= 1) {
    pass('Eligibility: a Section-4 trial-annotation "Gene-agnostic — relevant to CERKL patients" is stripped; NCT id + sponsor + status kept');
  } else {
    fail(`Eligibility: trial-annotation strip regression (ok=${trialOk} stripped=${trialRes.stripped.length}) → "${trialRes.text}"`);
  }

  // (h) "Priority picks" line: gene-agnostic labels woven into a parenthetical
  //     list are removed IN PLACE while BOTH NCT ids (siblings) survive.
  const picks = 'Priority picks for this CERKL patient: NCT06789445 (OpCT-001, gene-agnostic cell therapy at Bascom Palmer) and NCT06319872 (disulfiram, gene-agnostic). Also see the NAC Attack phase 3 (NCT05537220)';
  const picksRes = stripUnsupportedEligibilityClaims(picks, nacEvidence);
  const picksOk = /NCT06789445/.test(picksRes.text) && /NCT06319872/.test(picksRes.text)
    && /NCT05537220/.test(picksRes.text) && !/gene-agnostic/i.test(picksRes.text);
  if (picksOk) {
    pass('Eligibility: "priority picks" gene-agnostic labels removed in place; both NCT siblings preserved');
  } else {
    fail(`Eligibility: priority-picks regression → "${picksRes.text}"`);
  }

  // (i) A mechanistic "— making NAC a potentially gene-agnostic approach" clause
  //     is dropped, keeping the disease-mechanism statement before the dash.
  const mech = 'REPURPOSE_RATIONALE: oxidative stress drives cone cell death in RP regardless of which gene is faulty — making NAC a potentially gene-agnostic approach.';
  const mechRes = stripUnsupportedEligibilityClaims(mech, nacEvidence);
  if (!/gene-agnostic/i.test(mechRes.text) && /oxidative stress drives cone cell death/.test(mechRes.text)) {
    pass('Eligibility: a trailing "making … gene-agnostic approach" clause is dropped, cited mechanism kept');
  } else {
    fail(`Eligibility: mechanism-clause regression → "${mechRes.text}"`);
  }

  // (j) A CERKL-naming disease-mechanism paper in the pack must NOT ground an
  //     eligibility claim (per-item check): the gene + eligibility language must
  //     co-occur in ONE source, not merely across the pack.
  const packWithCerkl = { groundedForPrompt: [
    { title: 'NAC Phase 1 in RP', summary: 'Oral N-acetylcysteine improved retinal sensitivity over 24 weeks.' },
    { title: 'CERKL mutations in RP', summary: 'Biallelic CERKL mutations cause autosomal recessive retinitis pigmentosa; patients qualify for registry enrollment.' }
  ] };
  const stillStrip = stripUnsupportedEligibilityClaims('EFFICACY_HYPOTHESIS: Phase 1 improved retinal sensitivity [#6]. Gene-agnostic — CERKL-eligible.', packWithCerkl);
  if (!/CERKL-eligible/i.test(stillStrip.text) && /retinal sensitivity \[#6\]/.test(stillStrip.text)) {
    pass('Eligibility: a CERKL disease-mechanism paper in the pack does NOT ground a CERKL-eligibility claim (per-item adjacency)');
  } else {
    fail(`Eligibility: per-item grounding regression → "${stillStrip.text}"`);
  }

  // (k) Condition abbreviation is not mistaken for a gene: "relevant to RP
  //     patients" (RP = the condition) is left completely untouched.
  const condFrame = 'These trials are relevant to RP patients broadly.';
  const condRes = stripUnsupportedEligibilityClaims(condFrame, nacEvidence);
  if (condRes.text === condFrame && condRes.stripped.length === 0) {
    pass('Eligibility: a condition abbreviation ("relevant to RP patients") is not treated as a gene');
  } else {
    fail(`Eligibility: condition-abbrev false positive → "${condRes.text}"`);
  }

  // (l) Validator prompt flags a citation whose stated year/journal disagrees
  //     with the linked source (the "Campochiaro AJO 2020" → 2019 PII mismatch).
  if (/CITATION METADATA-MISMATCH/.test(validateSrc) && /S00029394193|encodes the year/i.test(validateSrc)) {
    pass('Eligibility: validator prompt flags a citation year/journal metadata mismatch vs. the linked source');
  } else {
    fail('Eligibility: validator prompt missing the citation metadata-mismatch check');
  }
}

// ===========================================================================
// FIX 2 — Evidence quality without quota-driven generation or registry filler.
// ===========================================================================
{
  const floorOk = REPURPOSE_MIN_PER_LANE === 0 && REPURPOSE_BACKFILL_THRESHOLD === 0;
  const lane11 = Array.from({ length: 11 }, (_, i) => `CANDIDATE: Drug${String.fromCharCode(97 + (i % 26))}${i}`).join('\n');
  const lane13 = Array.from({ length: 13 }, (_, i) => `CANDIDATE: Drug${String.fromCharCode(97 + (i % 26))}${i}`).join('\n');
  const retry11 = countCandidateBlocks(lane11) < REPURPOSE_MIN_PER_LANE;
  const retry13 = countCandidateBlocks(lane13) < REPURPOSE_MIN_PER_LANE;
  if (floorOk && !retry11 && !retry13) pass('Fix 2: candidate count never triggers quota-driven lane retries');
  else fail(`Fix 2: retry-floor regression (floor=${floorOk} retry11=${retry11} retry13=${retry13})`);

  // Names must stay letter-based: candidateDedupKey cuts at the first digit.
  const mk = (n) => Array.from({ length: n }, (_, i) => {
    const a = String.fromCharCode(97 + (i % 26));
    const b = String.fromCharCode(97 + Math.floor(i / 26));
    return `CANDIDATE: Drug${a}${b} (Brand) — dose note`;
  }).join('\n');
  const dupSome = mk(20) + '\nCANDIDATE: Drugaa (dup entry)';
  const distinct = distinctCandidateCount(dupSome);
  const namesOk = candidateNamesFromText(dupSome).length === 21;
  const backfillNeeded = needsBackfill(distinct);
  if (distinct === 20 && namesOk && !backfillNeeded) pass('Fix 2: distinctCandidateCount ignores a duplicate and quota backfill stays disabled');
  else fail(`Fix 2: distinct/backfill regression (distinct=${distinct} names=${namesOk} needBackfill=${backfillNeeded})`);

  const fullList = mk(50);
  if (!needsBackfill(distinctCandidateCount(fullList))) pass('Fix 2: a genuinely full list (50 distinct) does NOT trigger backfill');
  else fail('Fix 2: full list wrongly triggered backfill');

  if (REPURPOSE_BACKFILL_MAX_PASSES === 0) {
    pass('Fix 2: quota-driven AI and registry backfill is disabled');
  } else fail(`Fix 2: BACKFILL_MAX_PASSES should be 0 (got ${REPURPOSE_BACKFILL_MAX_PASSES})`);

  // Google alone never counts toward Hard 50
  const googleOnly = `CANDIDATE: MagicalPill
REFERENCES: [the paper](https://www.google.com/search?q=MagicalPill+IPF+trial)`;
  if (distinctLinkedCandidateCount(googleOnly) === 0 && !isRealCitationUrl('https://www.google.com/search?q=x')) {
    pass('Hard 50: Google-search-only does NOT count as a REAL citation');
  } else {
    fail('Hard 50: Google-search incorrectly counted as real citation');
  }

  // DailyMed SEARCH pages are NO LONGER real citations (client mandate:
  // query=minoxidil → 1,576 mostly third-party results, not a label). Only a
  // specific label monograph (drugInfo.cfm?setid=…) counts.
  const dailySearchNotReal = !isRealCitationUrl(dailyMedSearchUrl('pirfenidone'));
  const dailyLabelReal = isRealCitationUrl('https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc-123');
  const nctOk = isRealCitationUrl('https://clinicaltrials.gov/study/NCT05321069');
  if (dailySearchNotReal && dailyLabelReal && nctOk) {
    pass('Hard 50: DailyMed SEARCH is NOT a real citation; specific setid label + CT.gov study ARE');
  } else {
    fail(`Hard 50: DailyMed citation rule regression (searchNotReal=${dailySearchNotReal} labelReal=${dailyLabelReal})`);
  }

  // Registry fill must NOT fabricate a DailyMed search citation. With no real
  // link available, a registry-fill candidate carries NO citation link and does
  // NOT count toward Hard 50 (honest "real specific URL or none").
  const fillBlock = buildRegistryFillCandidate({ name: 'Metformin', mechanism: 'AMPK' }, { condition: 'IPF' });
  const fillNoSearchLink = !/dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm/i.test(fillBlock);
  const fillNoInventedPaper = !/pubmed\.ncbi|doi\.org\/10\./i.test(fillBlock);
  const fillNotCounted = !textHasRealCitation(fillBlock);
  const fillTaggedNever = resolveRepurposeSection(fillBlock) === REPURPOSE_SECTION_NEVER;
  const fillMedication = resolveItemKind(fillBlock) === 'MEDICATION';
  // A registry-fill candidate WITH a resolved specific setid label DOES count.
  const fillWithLabel = buildRegistryFillCandidate(
    { name: 'Metformin' },
    { condition: 'IPF', labelUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=xyz-1' }
  );
  const fillLabelCounted = textHasRealCitation(fillWithLabel);
  if (fillNoSearchLink && fillNoInventedPaper && fillNotCounted && !fillLabelCounted && fillTaggedNever && fillMedication) {
    pass('Registry filler never turns an unrelated product label into condition evidence');
  } else {
    fail(`Hard 50: registry fill regression (noSearch=${fillNoSearchLink} notCounted=${fillNotCounted} labelCounted=${fillLabelCounted} section=${fillTaggedNever} kind=${fillMedication})`);
  }

  const clientHasNoQuotaFill =
    !/BACKFILL_MAX_PASSES|registryFilled|Still short of 50 linked ideas|pathway overlap/.test(html) &&
    /const PER_LANE = 8/.test(html) &&
    /\.filter\(hasCitation\)/.test(html);
  const clientHasRealGate = /isGoogleSearchCitation|isGoogleUrl/.test(html) && /!isGoogle/.test(html);
  if (clientHasNoQuotaFill && clientHasRealGate) pass('Repurpose UI renders only cited server output and has no quota filler');
  else fail(`Repurpose client policy regression (noQuotaFill=${clientHasNoQuotaFill} gate=${clientHasRealGate})`);

  // Dorothy two-section tags + UI wiring
  const neverBlock = `CANDIDATE: IdeaDrug
ITEM_KIND: MEDICATION
REPURPOSE_SECTION: never-researched
EVIDENCE_STRENGTH: MECHANISTIC_ONLY
REFERENCES: [other](https://pubmed.ncbi.nlm.nih.gov/11111111/)`;
  const researchedBlock = `CANDIDATE: StudiedDrug
ITEM_KIND: SUPPLEMENT
REPURPOSE_SECTION: researched-not-approved
EVIDENCE_STRENGTH: PRECLINICAL
REFERENCES: [ipf](https://pubmed.ncbi.nlm.nih.gov/22222222/)`;
  const sectionOk =
    resolveRepurposeSection(neverBlock) === REPURPOSE_SECTION_NEVER &&
    resolveRepurposeSection(researchedBlock) === REPURPOSE_SECTION_RESEARCHED &&
    resolveItemKind(researchedBlock) === 'SUPPLEMENT' &&
    resolveRepurposeSection({ evidence_strength: 'MECHANISTIC_ONLY' }) === REPURPOSE_SECTION_NEVER &&
    resolveRepurposeSection({ evidence_strength: 'SMALL_RCT' }) === REPURPOSE_SECTION_RESEARCHED;
  const uiTwoSection =
    /Drug &amp; Supplement Repurposing Ideas|Drug & Supplement Repurposing Ideas/.test(html) &&
    /Researched, Not Yet FDA-Approved/.test(html) &&
    /resolveRepurposeSection/.test(html) &&
    /ItemKindBadge/.test(html) &&
    /REPURPOSE_SECTION:/.test(researchSrc) &&
    /rd-nr-/.test(html) &&
    /rd-rna-/.test(html) &&
    !/Open the Drug Repurposing tab for the full two-section list/.test(html);
  if (sectionOk && uiTwoSection) pass('Dorothy two-section: REPURPOSE_SECTION + ITEM_KIND resolve; Research tab renders both section headers');
  else fail(`Dorothy two-section regression (sectionOk=${sectionOk} ui=${uiTwoSection})`);
}

// ===========================================================================
// FIX 3 — run-to-run determinism. Default synthesis temperature is 0 and the
// drug tie-breaker is a stable hash (no Math.random), so identical inputs give
// identical drug ordering across two calls.
// ===========================================================================
{
  const tempOk = DEFAULT_GEN_TEMPERATURE === 0;
  const a = await selectRepurposeDrugs({ subspecialty: 'respiratory' }, { limit: 15 });
  const b = await selectRepurposeDrugs({ subspecialty: 'respiratory' }, { limit: 15 });
  const nA = a.map((d) => d.name);
  const nB = b.map((d) => d.name);
  const sameOrder = nA.length > 0 && nA.length === nB.length && nA.every((n, i) => n === nB[i]);
  if (tempOk && sameOrder) pass('Fix 3: default synthesis temperature is 0 and the deterministic drug tie-breaker yields identical ordering across runs');
  else fail(`Fix 3: determinism regression (temp0=${tempOk} sameOrder=${sameOrder} n=${nA.length})`);
}

// ===========================================================================
// FIX 4 — post-finalize link audit re-attaches a fallback link to a named
// entity whose line lost every link. Prefers DailyMed for drug-like names
// (never Google-as-paper for Hard 25); ignores percentages/doses; preserves
// center-table rows per the CENTER-LINK RULE.
// ===========================================================================
{
  const text = [
    '## 5. Pipeline',
    '- **BI 1015550** is an oral PDE4B inhibitor in phase 3.',
    '- See [the trial](https://clinicaltrials.gov/study/NCT05321069) for details.'
  ].join('\n');
  const { text: relinked, reattached } = reattachEntityLinks(text);
  // Client mandate "real specific URL or none": a bolded drug with no
  // resolvable SPECIFIC record must NOT get a fabricated DailyMed/Google search
  // link — it stays plain bold text. Only NCT ids get a synthesized CT.gov link.
  const noFabricatedLink = !/\[\*\*BI 1015550\*\*\]\(/.test(relinked) && /\*\*BI 1015550\*\*/.test(relinked);
  const noDailyMedSearch = !/dailymed\.nlm\.nih\.gov\/dailymed\/search/.test(relinked);
  const keptLinkedLine = relinked.includes('[the trial](https://clinicaltrials.gov/study/NCT05321069)');
  if (noFabricatedLink && noDailyMedSearch && !reattached.includes('BI 1015550') && keptLinkedLine) {
    pass('Fix 4: link audit leaves a bolded drug as plain text (no fabricated DailyMed/Google search link)');
  } else {
    fail(`Fix 4: link audit regression (noFabricated=${noFabricatedLink} noSearch=${noDailyMedSearch} kept=${keptLinkedLine})`);
  }
  // An NCT id still gets a synthesized specific CT.gov study link.
  const nctText = '- **NCT05888922** is enrolling now.';
  const { text: nctRelinked, reattached: nctReattached } = reattachEntityLinks(nctText);
  if (/\[\*\*NCT05888922\*\*\]\(https:\/\/clinicaltrials\.gov\/study\/NCT05888922\)/.test(nctRelinked) && nctReattached.includes('NCT05888922')) {
    pass('Fix 4: link audit re-attaches a SPECIFIC CT.gov study link to a bare NCT id');
  } else {
    fail('Fix 4: NCT re-attach regression');
  }

  const noise = '- How well it works was **70%**, at a **150 mg** dose.';
  const noiseOut = reattachEntityLinks(noise).text;
  const noiseUntouched = noiseOut === noise;
  const tableRow = '| **Mayo Clinic** | Rochester | (507) 284-2511 | leads in IPF |';
  const { text: tableOut, skipped } = reattachEntityLinks(tableRow);
  const tableUntouched = tableOut === tableRow && skipped.includes('Mayo Clinic');
  if (noiseUntouched && tableUntouched) pass('Fix 4: link audit ignores percentages/doses and does NOT auto-link center-table rows (CENTER-LINK RULE) but logs them');
  else fail(`Fix 4: link-audit conservatism regression (noise=${noiseUntouched} table=${tableUntouched})`);
}

// ===========================================================================
// INLINE CITATIONS (client's #1 requirement) — in-text reference markers must
// become inline clickable links at the claim, resolved against the evidence
// pack; unresolvable markers drop to plain text (no dangling marker, no fake).
// ===========================================================================
{
  const evidence = {
    groundedForPrompt: [
      { title: 'Finasteride Clinical Study', pmid: '11111111', url: 'https://pubmed.ncbi.nlm.nih.gov/11111111/' }, // #1
      { title: 'Dermatology Review', doi: '10.1000/abc', url: 'https://doi.org/10.1000/abc' }, // #2
      { title: 'Minoxidil Trial NCT05321069', url: 'https://clinicaltrials.gov/study/NCT05321069' } // #3
    ]
  };
  const map = buildReferenceUrlMap(evidence);
  const mapOk = map.get(1) === 'https://pubmed.ncbi.nlm.nih.gov/11111111' &&
                map.get(2) === 'https://doi.org/10.1000/abc' &&
                map.get(3) === 'https://clinicaltrials.gov/study/NCT05321069';
  if (mapOk) pass('Inline citations: reference-URL map mirrors the [#N] evidence-pack numbering');
  else fail('Inline citations: reference-URL map regression');

  const body = 'Minoxidil is effective and safe for male AGA before starting. [#3]';
  const resolved = resolveInlineReferenceMarkers(body, evidence);
  if (
    /\[Minoxidil Trial NCT05321069 ↗\]\(https:\/\/clinicaltrials\.gov\/study\/NCT05321069\)/.test(resolved) &&
    !/\[#3\]/.test(resolved)
  ) {
    pass('Inline citations: a resolvable [#3] becomes an inline clickable link at the claim (not a bare marker)');
  } else {
    fail(`Inline citations: [#3] not inlined → ${JSON.stringify(resolved)}`);
  }

  const multi = 'Two sources agree. [#1, #2]';
  const resolvedMulti = resolveInlineReferenceMarkers(multi, evidence);
  if (
    /pubmed\.ncbi\.nlm\.nih\.gov\/11111111/.test(resolvedMulti) &&
    /doi\.org\/10\.1000\/abc/.test(resolvedMulti) &&
    !/\[#1/.test(resolvedMulti)
  ) {
    pass('Inline citations: a combined [#1, #2] marker resolves BOTH to inline links');
  } else {
    fail(`Inline citations: combined marker regression → ${JSON.stringify(resolvedMulti)}`);
  }

  const unresolvable = 'Hair regrows within months. [#9]';
  const droppedMarker = resolveInlineReferenceMarkers(unresolvable, evidence);
  if (!/\[#9\]/.test(droppedMarker) && !/dailymed|google\.com\/search/i.test(droppedMarker) && /Hair regrows within months\./.test(droppedMarker)) {
    pass('Inline citations: an unresolvable [#9] is removed to plain text (no dangling marker, no fabricated link)');
  } else {
    fail(`Inline citations: unresolvable marker not dropped → ${JSON.stringify(droppedMarker)}`);
  }

  const textMarker = 'Topical works well. [JAMA Dermatology / Clinical Review]';
  const droppedText = resolveInlineReferenceMarkers(textMarker, evidence);
  if (!/\[JAMA/.test(droppedText) && /Topical works well\./.test(droppedText)) {
    pass('Inline citations: an unresolvable free-text marker is removed to plain text');
  } else {
    fail(`Inline citations: text marker not dropped → ${JSON.stringify(droppedText)}`);
  }

  // finalizeReportText wires the resolver into the real render path.
  const finalized = finalizeReportText('Finasteride slows loss. [#1]', { evidence, trials: null });
  if (/\[Finasteride Clinical Study ↗\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/11111111\/?\)/.test(finalized) && !/\[#1\]/.test(finalized)) {
    pass('Inline citations: finalizeReportText inlines [#N] markers end-to-end');
  } else {
    fail(`Inline citations: finalize end-to-end regression → ${JSON.stringify(finalized)}`);
  }

  // Bare NCT → ClinicalTrials.gov study link (specific record).
  const nctLinked = linkBareNctIds('See **NCT05537220** for enrollment.');
  if (/\[NCT05537220\]\(https:\/\/clinicaltrials\.gov\/study\/NCT05537220\)/.test(nctLinked)) {
    pass('Inline citations: bare NCT IDs become ClinicalTrials.gov study links');
  } else {
    fail(`Inline citations: bare NCT not linked → ${JSON.stringify(nctLinked)}`);
  }
  const nctAlready = linkBareNctIds('See [NCT05537220](https://clinicaltrials.gov/study/NCT05537220).');
  if ((nctAlready.match(/clinicaltrials\.gov\/study\/NCT05537220/g) || []).length === 1) {
    pass('Inline citations: already-linked NCT is not double-wrapped');
  } else {
    fail(`Inline citations: NCT double-wrap regression → ${JSON.stringify(nctAlready)}`);
  }

  // Significant / hard claim sentences without links get a pack citation;
  // unsourced hard claims are stripped (fundamental: link after every claim).
  const claimPack = {
    groundedForPrompt: [{
      title: 'N-acetylcysteine improves retinal sensitivity in retinitis pigmentosa',
      text: 'Oral NAC improved visual acuity and retinal sensitivity over 24 weeks in RP patients. Night blindness progresses as rod cells die.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/22222222/',
      isCuratedKB: true,
      category: 'clinical-guideline'
    }, {
      title: 'Effect of High-Intensity Treadmill Exercise (SPARX) in Parkinson Disease',
      text: 'Research suggests structured aerobic exercise as studied in the SPARX protocol may slow motor decline in Parkinson disease.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/29228079/',
      isCuratedKB: true
    }],
    pipelineDrugs: [
      { name: 'OCU400', nct: 'NCT06388200', summary: 'gene therapy phase 3 for retinitis pigmentosa' }
    ]
  };
  const claimTrials = {
    studies: [{ nctId: 'NCT05537220', title: 'NAC Attack', url: 'https://clinicaltrials.gov/study/NCT05537220' }]
  };
  const claimIn = [
    'Research suggests oral NAC improved retinal sensitivity over 24 weeks in RP.',
    'Night blindness usually comes first as rod cells die.',
    'Research suggests weather varies by season and has nothing to do with eyes.',
    'OCU400 is in phase 3 enrolling patients now.',
    'Parkinson Disease (PD) is a brain disorder where nerve cells that make dopamine slowly die off, causing tremors and stiffness.',
    '- Exercise: Research suggests structured aerobic exercise as studied in the SPARX protocol may slow motor decline.'
  ].join('\n');
  const claimOut = attachMissingClaimCitations(claimIn, claimPack, claimTrials);
  if (
    claimOut.attached >= 2 &&
    /pubmed\.ncbi\.nlm\.nih\.gov\/22222222/.test(claimOut.text) &&
    /29228079/.test(claimOut.text) &&
    !/OCU400 is in phase 3 enrolling patients now/.test(claimOut.text) &&
    !/weather varies/.test(claimOut.text)
  ) {
    pass('Inline citations FUNDAMENTAL: every matching claim sentence gets a pack link; unsourced hard claims are stripped');
  } else {
    fail(`Inline citations fundamental regression (attached=${claimOut.attached} stripped=${claimOut.stripped}) → ${JSON.stringify(claimOut.text)}`);
  }
  const weakClaim = attachMissingClaimCitations(
    'Please discuss options with your physician before changing anything.',
    claimPack
  );
  if (weakClaim.attached === 0 && /discuss options/.test(weakClaim.text)) {
    pass('Inline citations FUNDAMENTAL: soft non-claim guidance lines are left alone');
  } else {
    fail(`Inline citations soft-line regression → ${JSON.stringify(weakClaim.text)}`);
  }

  // Wrong-disease attach: a Condition Snapshot claim about disease A must NEVER
  // receive a pack item about disease B (RP night-blindness ≠ sickle cell
  // review), even when token-overlap / overview ranking prefers the wrong paper.
  const sickleItem = {
    title: 'Sickle Cell Disease and Retinal Complications: a clinical review',
    text: 'Sickle cell disease causes progressive peripheral vision loss and retinal ischemia. Night blindness is uncommon. Genetic disorder of red blood cells.',
    summary: 'Sickle cell disease ocular manifestations include peripheral vision loss.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/99990001/',
    isCuratedKB: true,
    category: 'clinical-guideline'
  };
  const rpOverview = {
    title: 'Retinitis Pigmentosa: overview and epidemiology',
    text: 'Retinitis pigmentosa is an inherited retinal disease causing night blindness and progressive peripheral vision loss as rod cells die.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/88880001/',
    isCuratedKB: true,
    category: 'clinical-guideline'
  };
  const wrongDiseasePack = { groundedForPrompt: [sickleItem, rpOverview] };
  const snapshotIn = [
    '## 1. Condition Snapshot',
    '### What Is Retinitis Pigmentosa?',
    'Retinitis pigmentosa is a genetic disorder where photoreceptor cells slowly die, typically causing night blindness first and progressive peripheral vision loss.',
    'Without treatment, many patients progress over decades toward severe vision impairment.'
  ].join('\n');
  const snapped = attachMissingClaimCitations(snapshotIn, wrongDiseasePack, null, {
    patient: { condition: 'Retinitis Pigmentosa' }
  });
  if (
    !/99990001/.test(snapped.text) &&
    /88880001/.test(snapped.text) &&
    snapped.attached >= 1
  ) {
    pass('Inline citations: Condition Snapshot refuses wrong-disease pack attaches (RP claim ≠ sickle cell source)');
  } else {
    fail(`Wrong-disease condition attach regression → ${JSON.stringify(snapped.text)}`);
  }

  // Model-authored / [#N]-resolved wrong-disease link is demoted end-to-end.
  const authoredWrong = [
    'Night blindness usually comes first as rod cells die ([source ↗](https://pubmed.ncbi.nlm.nih.gov/99990001/)).',
    'Retinitis pigmentosa overview ([source ↗](https://pubmed.ncbi.nlm.nih.gov/88880001/)).'
  ].join('\n');
  const demotedWrong = enforceConditionCitationRelevance(
    authoredWrong,
    wrongDiseasePack,
    { condition: 'Retinitis Pigmentosa' }
  );
  const finalizedWrong = finalizeReportText(
    'Without treatment, vision loss progresses over decades.',
    { evidence: wrongDiseasePack, trials: null, patient: { condition: 'Retinitis Pigmentosa' } }
  );
  if (
    demotedWrong.demoted.length === 1 &&
    !/99990001/.test(demotedWrong.text) &&
    /88880001/.test(demotedWrong.text) &&
    !/99990001/.test(finalizedWrong)
  ) {
    pass('Inline citations: enforceConditionCitationRelevance + finalize demote wrong-disease links in research prose');
  } else {
    fail(`Wrong-disease demote regression (demoted=${demotedWrong.demoted.length}) → ${JSON.stringify({ demoted: demotedWrong.text, finalized: finalizedWrong })}`);
  }

  const sickleMentionsRp = sourceMentionsCondition(
    `${sickleItem.title} ${sickleItem.text}`,
    'Retinitis Pigmentosa'
  );
  const taxonomyOnly = conditionSubjectTokens("Parkinson's Disease").has('disease') === false
    && conditionSubjectTokens("Parkinson's Disease").has('parkinson');
  if (sickleMentionsRp === false && taxonomyOnly) {
    pass('Inline citations: sourceMentionsCondition / conditionSubjectTokens ignore taxonomy fillers (disease) and reject cross-disease sources');
  } else {
    fail(`Condition mention primitives regression (sickleMentionsRp=${sickleMentionsRp} taxonomyOnly=${taxonomyOnly})`);
  }

  // Prose contamination: sickle-cell sentences must not survive finalize on an
  // IPF/RP report even when no citation URL is attached.
  const contaminatedProse = [
    'Idiopathic pulmonary fibrosis causes progressive scarring of the lungs.',
    'Sickle cell disease can also cause retinal ischemia and vaso-occlusive crisis.',
    'Nintedanib and pirfenidone are FDA-approved antifibrotics for IPF.'
  ].join(' ');
  const scrubbed = stripForeignDiseaseContamination(
    contaminatedProse,
    'Idiopathic Pulmonary Fibrosis'
  );
  const finalizedContam = finalizeReportText(contaminatedProse, {
    evidence: { groundedForPrompt: [{
      title: 'IPF overview',
      text: 'Idiopathic pulmonary fibrosis causes progressive scarring of the lungs. Nintedanib and pirfenidone are approved.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/77770001/',
      isCuratedKB: true
    }] },
    patient: { condition: 'Idiopathic Pulmonary Fibrosis' }
  });
  if (
    scrubbed.stripped.length >= 1 &&
    !/sickle\s*cell/i.test(scrubbed.text) &&
    /nintedanib/i.test(scrubbed.text) &&
    !/sickle\s*cell/i.test(finalizedContam)
  ) {
    pass('Wrong-disease prose: sickle cell sentences stripped from IPF finalize (no sickle cell, no bs)');
  } else {
    fail(`Sickle prose contamination regression → scrubbed=${JSON.stringify(scrubbed)} finalized=${JSON.stringify(finalizedContam)}`);
  }

  // Patient WITH sickle cell keeps their own disease prose.
  const keepOwn = stripForeignDiseaseContamination(
    'Sickle cell disease causes vaso-occlusive crisis. Hydroxyurea reduces crises.',
    'Sickle Cell Disease'
  );
  if (keepOwn.stripped.length === 0 && /sickle\s*cell/i.test(keepOwn.text)) {
    pass('Wrong-disease prose: sickle cell patients keep sickle cell sentences');
  } else {
    fail(`Own-disease keep regression → ${JSON.stringify(keepOwn)}`);
  }

  // Pack gather gate: SCD live hit must not enter an IPF prompt pack.
  const mixedPack = [
    {
      title: 'IPF antifibrotic therapy review',
      text: 'Idiopathic pulmonary fibrosis treated with nintedanib.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/11110001/',
      isCuratedKB: true,
      kbCondition: 'Idiopathic Pulmonary Fibrosis'
    },
    {
      title: 'Voxelotor in sickle cell disease',
      text: 'Sickle cell disease vaso-occlusive crisis reduced with voxelotor (Oxbryta).',
      url: 'https://pubmed.ncbi.nlm.nih.gov/11110002/',
      isCuratedKB: false
    },
    {
      title: 'Hydroxyurea meta-analysis',
      abstract: 'Hydroxyurea for sickle cell disease reduces crises.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/11110003/',
      isCuratedKB: false
    }
  ];
  const filteredPack = filterEvidencePackByCondition(mixedPack, 'Idiopathic Pulmonary Fibrosis');
  if (
    filteredPack.length === 1 &&
    /IPF antifibrotic/i.test(filteredPack[0].title) &&
    !filteredPack.some((it) => /sickle|voxelotor|Oxbryta/i.test(`${it.title} ${it.text || ''} ${it.abstract || ''}`))
  ) {
    pass('Wrong-disease pack: filterEvidencePackByCondition drops SCD live hits from IPF pack');
  } else {
    fail(`Pack filter regression → ${JSON.stringify(filteredPack)}`);
  }

  // Fail-closed: unknown document URL must not stay as a condition cite.
  const unknownDoc = enforceConditionCitationRelevance(
    'Night blindness comes first ([source ↗](https://pubmed.ncbi.nlm.nih.gov/55550001/)).',
    { groundedForPrompt: [rpOverview] }, // 55550001 not in pack → document fail-closed
    { condition: 'Retinitis Pigmentosa' }
  );
  if (!/55550001/.test(unknownDoc.text) && unknownDoc.demoted.length >= 1) {
    pass('Wrong-disease cites: unknown PubMed document demoted fail-closed for condition gate');
  } else {
    fail(`Fail-closed condition cite regression → ${JSON.stringify(unknownDoc)}`);
  }

  // Chat/trials path wiring: research.js must finalize those modes too.
  const researchSrc = readFileSync(new URL('../api/research.js', import.meta.url), 'utf8');
  const evidenceSrcWrong = readFileSync(new URL('../lib/evidence.js', import.meta.url), 'utf8');
  if (
    /mode === 'research' \|\| mode === 'repurpose' \|\| mode === 'chat' \|\| mode === 'trials'/.test(researchSrc) &&
    /coverage rewrite bypasses the earlier finalize/i.test(researchSrc) &&
    /filterEvidencePackByCondition/.test(evidenceSrcWrong)
  ) {
    pass('Wrong-disease seal: chat+trials finalize, coverage re-finalize, and pack gather filter are wired');
  } else {
    fail('api/research.js or lib/evidence.js missing wrong-disease seal wiring');
  }
}

// ===========================================================================
// RP/CERKL live-report citation defects (blank tabs, negative findings,
// Pipeline Watch smash, dead RetNet, evidence-pack jargon).
// ===========================================================================
{
  // Empty / bare-hash / whitespace source anchors must never stay clickable.
  const emptyIn = [
    'Claim A ([source ↗]()).',
    'Claim B ([source ↗](#)).',
    'Claim C ([source ↗]( )).',
    'Keep ([source ↗](https://pubmed.ncbi.nlm.nih.gov/12345678/)).'
  ].join('\n');
  const emptyOut = stripInvalidMarkdownAnchors(emptyIn);
  const emptyFinal = finalizeReportText(emptyIn, {
    evidence: { groundedForPrompt: [{ title: 't', text: 'x', url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/' }] },
    trials: null
  });
  if (
    !/\[source ↗\]\(\s*\)/.test(emptyOut) &&
    !/\[source ↗\]\(#\)/.test(emptyOut) &&
    !/\[source ↗\]\(\s*\)/.test(emptyFinal) &&
    !/\[source ↗\]\(#\)/.test(emptyFinal) &&
    /pubmed\.ncbi\.nlm\.nih\.gov\/12345678/.test(emptyOut)
  ) {
    pass('Empty/hash source anchors: stripInvalidMarkdownAnchors + finalize never leave blank-tab hrefs');
  } else {
    fail(`Empty source anchor regression → ${JSON.stringify({ emptyOut, emptyFinal })}`);
  }

  // Negative / empty findings must never get (or keep) a source cite — even with
  // a full RP pack that includes an ABCA4 paper the token overlap would prefer.
  const rpPack = {
    condition: 'Retinitis Pigmentosa',
    groundedForPrompt: [
      {
        title: 'Autosomal Recessive Retinitis Pigmentosa Due To ABCA4 Mutations',
        text: 'ABCA4 mutations cause autosomal recessive retinitis pigmentosa.',
        url: 'https://iovs.arvojournals.org/article.aspx?articleid=abca4',
        isCuratedKB: true,
        category: 'review'
      },
      {
        title: 'GeneReviews Retinitis Pigmentosa Overview',
        text: 'Retinitis pigmentosa genetics. CERKL is among genes associated with RP.',
        url: 'https://www.ncbi.nlm.nih.gov/books/NBK1417/'
      }
    ]
  };
  const noneIn = 'None identified in this pull.';
  const noneAttached = attachMissingClaimCitations(noneIn, rpPack, null, {
    patient: { condition: 'Retinitis Pigmentosa' }
  });
  const noneWithCite = 'None identified in this pull ([source ↗](https://iovs.arvojournals.org/article.aspx?articleid=abca4)).';
  const noneFinal = finalizeReportText(noneWithCite, {
    evidence: rpPack, trials: null, patient: { condition: 'Retinitis Pigmentosa' }
  });
  if (
    isNegativeOrEmptyFinding(noneIn) &&
    noneAttached.attached === 0 &&
    /None identified in this pull\.?\s*$/m.test(noneFinal) &&
    !/None identified[^\n]*\[source/.test(noneFinal) &&
    !/abca4/.test(noneFinal)
  ) {
    pass('Negative findings: "None identified in this pull" stays unlinked after attach + finalize (no ABCA4 cite)');
  } else {
    fail(`Negative finding cite regression → ${JSON.stringify({ noneAttached, noneFinal })}`);
  }

  // Pipeline Watch GFM tables must survive finalize intact (no source in header,
  // no Drug) (alias)) corruption).
  const pipeTable = [
    '## 5. Pipeline Watch',
    '| Drug / therapy | Phase | NCT | Notes |',
    '|---|---|---|---|',
    '| OCU400 (AAV5-NR2E3) | Phase 3 | NCT06388200 | Gene therapy |',
    '| MCO-010 (sonpiretigene isteparvovec) | Phase 2 | NCT04945772 | Optogenetic |',
    '| jCell | Phase 2 | NCT04604899 | Stem cells |',
    '| NACA (NPI-001) | Phase 2 | NCT04305158 | Antioxidant |'
  ].join('\n');
  const pipeFinal = finalizeReportText(pipeTable, {
    evidence: {
      ...rpPack,
      pipelineDrugs: [{ name: 'OCU400', nct: 'NCT06388200', summary: 'gene therapy retinitis pigmentosa' }]
    },
    trials: {
      query: { condition: 'Retinitis Pigmentosa' },
      studies: [
        {
          nctId: 'NCT06388200',
          briefTitle: 'OCU400',
          status: 'ACTIVE_NOT_RECRUITING',
          phases: ['PHASE3'],
          conditions: ['Retinitis Pigmentosa']
        },
        {
          nctId: 'NCT04945772',
          briefTitle: 'MCO-010',
          status: 'COMPLETED',
          phases: ['PHASE2'],
          conditions: ['Retinitis Pigmentosa']
        },
        {
          nctId: 'NCT04604899',
          briefTitle: 'jCell',
          status: 'COMPLETED',
          phases: ['PHASE2'],
          conditions: ['Retinitis Pigmentosa']
        },
        {
          nctId: 'NCT04305158',
          briefTitle: 'NACA',
          status: 'COMPLETED',
          phases: ['PHASE2'],
          conditions: ['Retinitis Pigmentosa']
        }
      ]
    },
    patient: { condition: 'Retinitis Pigmentosa' }
  });
  const pipeRows = pipeFinal.split('\n').filter((l) => isMarkdownTableRow(l));
  if (
    /\| Drug \/ therapy \| Phase \| NCT \| Notes \|\s*$/m.test(pipeFinal) &&
    /\|---\|---\|---\|---\|/.test(pipeFinal) &&
    /\| OCU400 \(AAV5-NR2E3\) \|/.test(pipeFinal) &&
    /\| MCO-010 \(sonpiretigene isteparvovec\) \|/.test(pipeFinal) &&
    /\| NACA \(NPI-001\) \|/.test(pipeFinal) &&
    !/OCU400\)/.test(pipeFinal) &&
    !/Notes \| \(/.test(pipeFinal) &&
    !/\| \(\[source/.test(pipeFinal) &&
    pipeRows.length >= 6
  ) {
    pass('Pipeline Watch table: finalize preserves GFM rows; no header source / orphan paren corruption');
  } else {
    fail(`Pipeline Watch table regression → ${JSON.stringify(pipeFinal)}`);
  }

  // Dead RetNet host is known-dead: strip, never leave as clickable cite.
  if (
    isKnownDeadUrl('https://web.sph.uth.edu/RetNet/') &&
    isKnownDeadUrl('https://sph.uth.edu/RetNet/sum-dis.htm')
  ) {
    pass('RetNet ban: web.sph.uth.edu/RetNet is known-dead');
  } else {
    fail('RetNet ban: isKnownDeadUrl missed SPH RetNet host');
  }
  const retnetIn = 'CERKL is one of the genes listed in the RetNet database ([source ↗](https://web.sph.uth.edu/RetNet/)).';
  const retnetFinal = finalizeReportText(retnetIn, {
    evidence: rpPack, trials: null, patient: { condition: 'Retinitis Pigmentosa', gene: 'CERKL' }
  });
  if (
    !/web\.sph\.uth\.edu\/RetNet/i.test(retnetFinal) &&
    /CERKL is one of the genes listed in the RetNet database/.test(retnetFinal)
  ) {
    pass('RetNet ban: finalize strips dead RetNet URL (claim may stay plain or use live pack URL)');
  } else {
    fail(`RetNet strip regression → ${JSON.stringify(retnetFinal)}`);
  }

  // evidence-pack jargon must not reach the reader.
  const jargon = polishReportForDisplay(
    'No evidence-pack item establishes any approved gene therapy for CERKL. SAFETY: Moderate — the evidence pack does not provide FAERS post-market death report counts.'
  );
  const jargonFinal = finalizeReportText(
    'No completed positive RCT exists in this evidence pack. [FDA label](https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&applno=&drugname=Nintedanib)',
    { evidence: { groundedForPrompt: [] }, trials: null }
  );
  if (
    !/evidence[- ]pack/i.test(jargon) &&
    !/\bFAERS\b/.test(jargon) &&
    /No published source found here establishes/.test(jargon) &&
    /FDA post-market report/.test(jargon) &&
    !/evidence[- ]pack/i.test(jargonFinal) &&
    !/applno=&/i.test(jargonFinal)
  ) {
    pass('Patient jargon: evidence-pack/FAERS rewritten; empty-applno FDA links demoted');
  } else {
    fail(`Patient jargon regression → ${JSON.stringify({ jargon, jargonFinal })}`);
  }
}

// ===========================================================================
// DailyMed SEARCH ban (client mandate) — a search.cfm?query=… page is NEVER a
// citation regardless of how clean the query is; only a specific label
// monograph (drugInfo.cfm?setid=…) may remain.
// ===========================================================================
{
  const cases = [
    ['finasteride 1mg', 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=finasteride+1mg'],
    ['Initial shedding', 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=Initial%20shedding'],
    ['effective and safe for male AGA', 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=effective%20and%20safe%20for%20male%20AGA'],
    ['minoxidil', 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=minoxidil'],
    ['finasteride', 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=finasteride']
  ];
  let allStripped = true;
  for (const [label, url] of cases) {
    const md = `See the label ([${label}](${url})) for details.`;
    const out = stripDailyMedSearchLinks(md);
    if (new RegExp('\\]\\(https?://[^)]*dailymed[^)]*search\\.cfm').test(out) || /search\.cfm/.test(out)) allStripped = false;
    if (!out.includes(label)) allStripped = false;  // anchor text kept
  }
  if (allStripped) pass('DailyMed ban: every search.cfm?query=… link (incl. clean "minoxidil"/"finasteride") is stripped to plain text, anchor text kept');
  else fail('DailyMed ban: a search.cfm link survived stripping');

  const labelUrl = 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abcd-1234';
  const labelMd = `See the [FDA label](${labelUrl}).`;
  const labelOut = stripDailyMedSearchLinks(labelMd);
  if (labelOut.includes(labelUrl) && isDailyMedLabelUrl(labelUrl) && isDailyMedSearchUrl(cases[0][1])) {
    pass('DailyMed ban: a specific drugInfo.cfm?setid=… label link is PRESERVED');
  } else {
    fail('DailyMed ban: specific setid label link was wrongly stripped');
  }

  // Belt-and-suspenders: finalizeReportText strips an authored DailyMed search
  // even when the pack allows nothing.
  const finalizedSearch = finalizeReportText(
    'Finasteride is first-line ([finasteride 1mg](https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=finasteride+1mg)).',
    { evidence: null, trials: null }
  );
  if (!/search\.cfm/.test(finalizedSearch) && (!finalizedSearch || /finasteride 1mg/.test(finalizedSearch))) {
    pass('DailyMed ban: finalizeReportText strips an authored search link and any now-unsupported hard claim');
  } else {
    fail(`DailyMed ban: finalize did not strip search link → ${JSON.stringify(finalizedSearch)}`);
  }
}

// ===========================================================================
// isNamedEntityBold — rejects prose phrases, accepts real named entities.
// ===========================================================================
{
  const prose = ['Initial shedding', 'Start treatment early', 'Sudden or patchy hair loss', 'Finasteride sexual side effects'];
  const entities = ['Pulmonary Fibrosis Foundation', 'Esbriet', 'NCT05888922', 'BI 1015550', 'American Academy of Dermatology'];
  const proseRejected = prose.every((p) => !isNamedEntityBold(p));
  const entitiesAccepted = entities.every((e) => isNamedEntityBold(e));
  if (proseRejected && entitiesAccepted) {
    pass('isNamedEntityBold: rejects prose phrases; accepts drugs / orgs / NCT ids / drug codes');
  } else {
    fail(`isNamedEntityBold regression (proseRejected=${proseRejected} entitiesAccepted=${entitiesAccepted})`);
  }
}

// ===========================================================================
// Hard 25 extras — fabricated efficacy strip; Google-as-paper demote;
// invented deep links stripped by sanitize; Pipeline Watch up to 25.
// ===========================================================================
{
  if (isFabricatedEfficacyScore('48%') && isFabricatedEfficacyScore('45% — slows decline')) {
    pass('Efficacy sanitize: lone NN% / short-fluff scores are detected as fabricated');
  } else {
    fail('Efficacy sanitize: fabricated score detection failed');
  }
  if (!isFabricatedEfficacyScore('Slowed FVC decline by about 110 mL/year versus placebo [ASCEND](https://pubmed.ncbi.nlm.nih.gov/24836310/)')) {
    pass('Efficacy sanitize: real endpoint + source link is kept');
  } else {
    fail('Efficacy sanitize: wrongly flagged a real outcome');
  }
  const dirty = [
    'EFFICACY: 48%',
    'EFFICACY: **50**% — works well',
    'EFFICACY: Slowed FVC decline by about 110 mL/year versus placebo'
  ].join('\n');
  const cleaned = sanitizeFabricatedEfficacyScores(dirty);
  if (
    /source-supported measured outcome was not available/i.test(cleaned) &&
    /110 mL\/year/.test(cleaned) &&
    !/^EFFICACY:\s*48%/m.test(cleaned)
  ) {
    pass('Efficacy sanitize: fabricated scores rewritten; real endpoints preserved');
  } else {
    fail('Efficacy sanitize: rewrite regression');
  }

  const googlePaper = 'REFERENCES: [the paper](https://www.google.com/search?q=fake+doi)\nSUPPORTING_EVIDENCE: only [g](https://www.google.com/search?q=x)';
  const demoted = demoteGoogleAsPaperCitations(googlePaper);
  if (!/\]\(https:\/\/www\.google\.com\/search/.test(demoted)) {
    pass('Google-as-paper: REFERENCES-only Google links demoted to plain text');
  } else {
    fail('Google-as-paper demote failed');
  }
  const expertGoogle =
    '- **[Dr. Ganesh Raghu](https://www.google.com/search?q=Ganesh+Raghu+IPF)** — University of Washington ([source ↗](https://pubmed.ncbi.nlm.nih.gov/35486072/)).\n' +
    'COST: contact assistance ([Jascayd support](https://www.google.com/search?q=Jascayd+patient+assistance))';
  const strippedExperts = stripGoogleSearchMarkdownLinks(expertGoogle);
  const finalizeExperts = finalizeReportText(expertGoogle, { evidence: { groundedForPrompt: [] }, trials: null });
  if (
    !/google\.com\/search/i.test(strippedExperts) &&
    /Dr\. Ganesh Raghu/.test(strippedExperts) &&
    /pubmed\.ncbi\.nlm\.nih\.gov\/35486072/.test(strippedExperts) &&
    !/google\.com\/search/i.test(finalizeExperts)
  ) {
    pass('Google placeholders: expert/assistance search links stripped to plain names; real PubMed kept');
  } else {
    fail('Google placeholder strip failed for expert/assistance links');
  }

  const invented = 'See [Hallucinated paper](https://pubmed.ncbi.nlm.nih.gov/99999999/) and [fake doi](https://doi.org/10.1234/fake.doi) for proof.';
  const allowed = collectAllowedUrls({ groundedForPrompt: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/24836310/' }] }, null);
  const sanitized = sanitizeMarkdownLinks(invented, allowed);
  const keptReal = sanitizeMarkdownLinks(
    'See [ASCEND](https://pubmed.ncbi.nlm.nih.gov/24836310/) kept.',
    allowed
  );
  if (
    !/\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/99999999/.test(sanitized) &&
    !/\]\(https:\/\/doi\.org\/10\.1234\/fake\.doi/.test(sanitized) &&
    /\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/24836310/.test(keptReal)
  ) {
    pass('Invented PubMed/DOI deep links stripped when not in evidence pack; pack PMID kept');
  } else {
    fail('Invented URL sanitize failed');
  }

  if (/up to \*\*25\*\* rows|max 25|up to \$\{investigational\.length\}/.test(researchSrc) ||
      /up to \*\*25\*\* rows from the PIPELINE WATCH/.test(researchSrc)) {
    pass('Pipeline Watch prompt raised toward 25 real linked rows');
  } else {
    fail('Pipeline Watch still capped at max 5');
  }
  if (/List (?:up to \*\*25\*\*|only interventional records[\s\S]{0,160}up to \*\*25\*\*)/.test(researchSrc)) {
    pass('Trials prompt asks for up to 25 real NCT-linked trials');
  } else {
    fail('Trials prompt still limited to 5-8');
  }
  if (/NEVER invent a paper URL|NEVER invent a DOI|Google search URL must NEVER/.test(researchSrc)) {
    pass('Prompts ban invented paper URLs / Google-as-paper citations');
  } else {
    fail('Prompt invent-URL ban missing');
  }
  if (/honeycombing|identity unclear|NAD/.test(researchSrc)) {
    pass('NAD / imaging NO-INVENTED-PATIENT-FACTS guardrails present');
  } else {
    fail('NAD/imaging guardrails missing');
  }
  if (/DEMO_TALKING_POINTS|talking points/i.test(readFileSync(new URL('../docs/DEMO_TALKING_POINTS.md', import.meta.url), 'utf8'))) {
    pass('docs/DEMO_TALKING_POINTS.md present for operator demo notes');
  } else {
    fail('DEMO_TALKING_POINTS.md missing');
  }
  // Client mandate: the second-AI score panel is NOT shown to readers.
  // Validation may still run server-side; the UI must not surface scores.
  if (/do NOT surface the second-AI score panel/.test(html) && /const ValidatorPanel = \(\) =>/.test(html)) {
    pass('Validator panel hidden from readers (no second-AI score / Backed up UI)');
  } else {
    fail('Validator panel should return null and not surface second-AI scores');
  }
  // Client mandate: no "AIs disagreed" / mismatch dispute banner for readers.
  if (/do NOT surface second-AI vs first-AI disagreement/.test(html) && /const ValidationMismatchBanner = \(\) =>/.test(html)) {
    pass('Validation mismatch banner hidden from readers (no second-AI fight UI)');
  } else {
    fail('ValidationMismatchBanner should return null and not surface AI disagreement');
  }
  // Complete-report exports are format-parity paths and stay disabled while a
  // report is running or either sealed half is missing.
  const fullFormats =
    /Full Report Word/.test(html) &&
    /Full Report PDF/.test(html) &&
    /Full Report Text/.test(html);
  const completeGate =
    /const contract = await props\.getCompletionContract\(\)/.test(html) &&
    /getCompletionContract=\{props\.getCompletionContract\}/.test(html) &&
    /reportContractHtml\(contract\)/.test(html);
  const exactClientAllowlist =
    /return !!allowedReportUrl\(href, allowedUrls\)/.test(html) &&
    /filterAllowedReportLinks/.test(html);
  const safeExportAttributes =
    /replace\(\/"\/g, '&quot;'\).*replace\(\/'\/g, '&#39;'\)/s.test(html) &&
    /<title>\$\{escapeHtmlForExport\(title\)\}/.test(html);
  if (fullFormats && completeGate && exactClientAllowlist && safeExportAttributes && /No Condition-Specific Study Identified/.test(html)) {
    pass('Full report Word/PDF/Text exports require complete sealed output and exact safe links');
  } else {
    fail(`Full export contract regression (formats=${fullFormats} complete=${completeGate} exactLinks=${exactClientAllowlist} escaped=${safeExportAttributes})`);
  }
}

// Dorothy: newest approved treatments must be pinned with REAL efficacy numbers;
 // already-approved SOC must never reappear as "drug ideas".
{
  const ipf = JSON.parse(readFileSync(new URL('../data/kb/ipf.json', import.meta.url), 'utf8'));
  const fib = (ipf.items || []).find((e) => e.id === 'ipf-fibroneer-ipf-2025');
  const claim = (ipf.canonicalFacts || []).some((c) => /68\.8/.test(c.claim || ''));
  if (fib && /68\.8/.test(fib.summary || '') && claim) {
    pass('IPF KB pins FIBRONEER-IPF 68.8 mL week-52 efficacy (no invented 80 mL/year)');
  } else {
    fail('IPF KB missing FIBRONEER-IPF 68.8 mL pin');
  }

  const evidence = {
    pipelineDrugs: (ipf.pipelineDrugs || []).filter((d) => d.approvalStatus === 'approved')
  };
  const soc = approvedSocNames(evidence);
  const dirty = [
    'CANDIDATE: Nerandomilast (Jascayd)',
    'REFERENCES: [x](https://example.com/a)',
    '',
    'CANDIDATE: Losartan (ARB)',
    'REFERENCES: [y](https://example.com/b)',
    '',
    'CANDIDATE: Pirfenidone (Esbriet)',
    'REFERENCES: [z](https://example.com/c)',
    '',
    'CANDIDATE: Nintedanib (Ofev)',
    'REFERENCES: [w](https://example.com/d)'
  ].join('\n');
  const cleaned = filterApprovedSocFromRepurpose(dirty, evidence);
  const kept = (cleaned.match(/^CANDIDATE:/gm) || []).length;
  const droppedSoc = !/nerandomilast|pirfenidone|nintedanib|jascayd|esbriet|ofev/i.test(cleaned)
    && /Losartan/i.test(cleaned);
  if (soc.length >= 3 && kept === 1 && droppedSoc) {
    pass('Approved IPF SOC stripped from repurpose CANDIDATE list (keep novel ideas only)');
  } else {
    fail(`SOC strip regression (soc=${soc.length} kept=${kept} cleaned=${cleaned.slice(0, 200)})`);
  }

  const researchSrc = readFileSync(new URL('../api/research.js', import.meta.url), 'utf8');
  if (/ALREADY-APPROVED-FOR-THIS-CONDITION BAN/.test(researchSrc) && /68\.8 mL/.test(researchSrc)) {
    pass('Repurpose + Section 3 prompts ban SOC-as-candidate and require pack-exact efficacy numbers');
  } else {
    fail('Missing SOC-ban / pack-exact efficacy prompt rules');
  }
}

// ===========================================================================
// FIX 5 — genetics negative-result handling. A provided negative reaches BOTH
// the generator and validator snapshots as a first-class, legitimate fact (not
// a "confirmed mutation," not invented); positive variants still gate therapy.
// ===========================================================================
{
  const negatives = ['Genetic testing done — no known pathogenic variant found', 'no genetic component', 'tested negative'];
  const negClassOk = negatives.every((t) => classifyGeneticResult(t) === 'negative');
  const posOk = classifyGeneticResult('TERT pathogenic variant') === 'positive';
  const ntOk = classifyGeneticResult('Not tested') === 'nottested';
  if (negClassOk && posOk && ntOk) pass('Fix 5: classifyGeneticResult separates provided-negative, positive variant, and not-tested');
  else fail(`Fix 5: classify regression (neg=${negClassOk} pos=${posOk} nt=${ntOk})`);

  const neg = 'Genetic testing done — no known pathogenic variant found';
  const genLine = buildPatientContext({ condition: 'IPF', geneticVariant: neg });
  const genOk = genLine.includes(neg) && /legitimate|provided negative/i.test(genLine)
    && !/CONFIRMED GENETIC MUTATION/.test(genLine);
  const snap = buildPatientSnapshot({ geneticVariant: neg });
  const snapOk = snap.includes(neg) && /no known pathogenic variant/i.test(snap)
    && !/Confirmed genetic mutation/.test(snap);
  const row = geneticSnapshotRow(neg);
  const rowOk = !!row && /provided/i.test(row[0]);
  if (genOk && snapOk && rowOk) pass('Fix 5: a provided negative genetic result reaches the generator + validator snapshots as a legitimate fact (not invented, not a confirmed mutation)');
  else fail(`Fix 5: negative-genetics plumbing regression (gen=${genOk} snap=${snapOk} row=${rowOk})`);

  const posLine = buildPatientContext({ condition: 'RP', geneticVariant: 'USH2A compound heterozygous' });
  if (/CONFIRMED GENETIC MUTATION/.test(posLine) && /USH2A/.test(posLine)) pass('Fix 5: a positive variant still gates gene-targeted therapy (CONFIRMED GENETIC MUTATION block preserved)');
  else fail('Fix 5: positive-variant gene-gating regression');
}

// ===========================================================================
// FIX 6 — evidence-derived, deterministic SAFETY band (replaces the fabricated
// "SAFETY: NN%" the model used to eyeball). Every band is traceable: it is
// computed from REAL FDA facts + this patient's meds, and each contributing
// fact carries a clickable FDA source link. Confidence becomes a band too and
// is DROPPED when it has no citable evidence.
// ===========================================================================
{
  const url = 'https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&drugname=Test';
  const completeContext = {
    allergies: 'No known drug allergies',
    pregnancyStatus: 'not pregnant',
    renalFunction: 'normal',
    hepaticFunction: 'normal',
    medicationHistory: 'No prior treatment',
    labWork: 'Relevant labs reviewed'
  };

  // (a) Boxed warning → High safety concern.
  const boxed = scoreSafety({
    drugName: 'DrugA', patientMeds: '', patientContext: completeContext,
    fdaLabel: { url, genericName: ['DrugA'], boxedWarning: 'WARNING: serious liver injury' }, faers: []
  });
  const boxedOk = boxed.band === 'High' &&
    boxed.factors.some((f) => /boxed/i.test(f.text) && f.url === url);
  if (boxedOk) pass('Fix 6(a): boxed warning maps to High safety concern with a cited FDA factor');
  else fail(`Fix 6(a): boxed-warning concern regression (band=${boxed.band} factors=${JSON.stringify(boxed.factors)})`);

  // (b) A patient-med interaction/contraindication → High concern.
  const clean = scoreSafety({ drugName: 'DrugB', patientMeds: 'Metformin', patientContext: completeContext, fdaLabel: { url, genericName: ['DrugB'], warnings: 'mild nausea' }, faers: [] });
  const interact = scoreSafety({
    drugName: 'DrugB', patientMeds: 'Warfarin 5 mg', patientContext: completeContext,
    fdaLabel: { url, genericName: ['DrugB'], drugInteractions: 'Concomitant warfarin increases bleeding risk.' }, faers: []
  });
  const dropsOk = clean.band === 'Unknown' && interact.band === 'High' &&
    interact.factors.some((f) => /warfarin/i.test(f.text) && f.url === url);
  if (dropsOk) pass('Fix 6(b): a patient-med interaction maps to High concern with a cited factor');
  else fail(`Fix 6(b): interaction-concern regression (clean=${clean.band} interact=${interact.band})`);

  // (c) Spontaneous report counts never determine the concern band.
  const completeLabel = {
    url, genericName: ['DrugC'], warnings: 'No warnings identified.',
    contraindications: 'None known.', drugInteractions: 'No known interactions.'
  };
  const oneSerious = scoreSafety({ drugName: 'DrugC', patientContext: completeContext, fdaLabel: completeLabel, faers: [
    { reaction: 'Hepatic failure', reports: FAERS_SERIOUS_MIN_REPORTS + 10 }, { reaction: 'Nausea', reports: 99999 }
  ] });
  const threeSerious = scoreSafety({ drugName: 'DrugC', patientContext: completeContext, fdaLabel: completeLabel, faers: [
    { reaction: 'Hepatic failure', reports: 5000 }, { reaction: 'Sepsis', reports: 2000 }, { reaction: 'Cardiac arrest', reports: 1500 }
  ] });
  const belowThreshold = scoreSafety({ drugName: 'DrugC', patientContext: completeContext, fdaLabel: completeLabel, faers: [
    { reaction: 'Hepatic failure', reports: FAERS_SERIOUS_MIN_REPORTS - 1 }
  ] });
  const deathIgnored = scoreSafety({ drugName: 'DrugC', patientContext: completeContext, fdaLabel: completeLabel, faers: [
    { reaction: 'Death', reports: 99999 }
  ] });
  const faersOk = [oneSerious, threeSerious, belowThreshold, deathIgnored].every((result) =>
    result.band === 'Low' && result.factors.some((f) => /not incidence rates.*do not prove causation/i.test(f.text))
  );
  if (faersOk) pass('Fix 6(c): spontaneous report counts do not change the safety-concern band and carry a limitation');
  else fail(`Fix 6(c): spontaneous-report limitation regression (one=${oneSerious.band} three=${threeSerious.band} below=${belowThreshold.band} death=${deathIgnored.band})`);

  // (d) Incomplete captured label sections cannot establish High safety.
  const high = scoreSafety({ drugName: 'DrugD', patientMeds: 'Metformin', fdaLabel: { url, warnings: 'headache' }, faers: [{ reaction: 'Headache', reports: 40 }] });
  if (high.band === 'Unknown' && high.factors.length === 1 && high.factors[0].url === url) {
    pass('Fix 6(d): incomplete FDA sections remain Unknown with a clickable FDA source');
  } else {
    fail(`Fix 6(d): no-signal High regression (band=${high.band} factors=${JSON.stringify(high.factors)})`);
  }

  // (e) No FDA label → explicit Unknown (caller does not invent a rating).
  const nolabel = scoreSafety({ drugName: 'DrugE', patientMeds: '', fdaLabel: null, faers: [] });
  if (nolabel.band === 'Unknown' && !nolabel.factors.length) {
    pass('Fix 6(e): a drug with no FDA label yields an explicit Unknown state');
  } else {
    fail(`Fix 6(e): no-label degrade regression (band=${nolabel.band})`);
  }

  // (f) Determinism — identical inputs → identical band + factors every run.
  const args = { drugName: 'DrugF', patientMeds: 'Warfarin', fdaLabel: { url, boxedWarning: 'x', contraindications: 'warfarin' }, faers: [] };
  if (JSON.stringify(scoreSafety(args)) === JSON.stringify(scoreSafety(args))) {
    pass('Fix 6(f): scoreSafety is deterministic (same inputs → same band + factors)');
  } else {
    fail('Fix 6(f): scoreSafety is non-deterministic');
  }

  // (g) injectSafetyBands rewrites a card's SAFETY line with the computed band
  //     + FDA links, and DROPS the SAFETY line for a card with no FDA label.
  const report = [
    'CANDIDATE: Nintedanib (Ofev) — 150 mg',
    'SAFETY: High — model eyeballed 90%',
    'CONFIDENCE: Moderate — some evidence [PMID 1](https://pubmed.ncbi.nlm.nih.gov/1/)',
    '',
    'CANDIDATE: UnmatchedDrugXYZ',
    'SAFETY: 80% — model eyeballed'
  ].join('\n');
  const fdaLabels = [{ drug: 'Nintedanib', label: { url, genericName: ['nintedanib'], activeIngredient: ['nintedanib 150 mg'], drugInteractions: 'aspirin' }, topAdverseEvents: [] }];
  const injected = injectSafetyBands(report, {
    fdaLabels,
    patientMeds: 'Aspirin 81 mg',
    patientContext: completeContext
  });
  const nintBand = /SAFETY: Safety concern: High — FDA label lists a drug interaction with your Aspirin \[FDA label\]\(https:\/\/www\.accessdata\.fda\.gov/i.test(injected);
  const droppedUnmatched = !/UnmatchedDrugXYZ[\s\S]*SAFETY:/i.test(injected);
  const confUntouched = /CONFIDENCE: Moderate — some evidence/.test(injected);
  if (nintBand && droppedUnmatched && confUntouched) {
    pass('Fix 6(g): injectSafetyBands writes the computed band + FDA links, drops safety for an unmatched drug, leaves confidence alone');
  } else {
    fail(`Fix 6(g): injection regression (nintBand=${nintBand} dropped=${droppedUnmatched} confUntouched=${confUntouched})`);
  }

  // (h) No FDA labels at all → every SAFETY line dropped (no eyeballed % ships).
  const stripped = injectSafetyBands('CANDIDATE: X\nSAFETY: 70% — guess\nRISKS: none', { fdaLabels: [], patientMeds: '' });
  if (!/SAFETY:/.test(stripped) && /RISKS: none/.test(stripped)) {
    pass('Fix 6(h): with no FDA labels, all SAFETY lines are dropped (no fabricated % survives)');
  } else {
    fail(`Fix 6(h): no-label strip regression (out=${JSON.stringify(stripped)})`);
  }

  // (i) The FDA drug-lookup link is navigational and survives link sanitization.
  const safetyLine = injected.split('\n').find((l) => /^SAFETY:/.test(l));
  const keptFdaLink = sanitizeMarkdownLinks(safetyLine, collectAllowedUrls({}, null));
  if (/\[FDA label\]\(https:\/\/www\.accessdata\.fda\.gov/i.test(keptFdaLink)) {
    pass('Fix 6(i): the FDA drug-lookup source link survives sanitizeMarkdownLinks (navigational exemption)');
  } else {
    fail(`Fix 6(i): FDA source link stripped by sanitizer (out=${JSON.stringify(keptFdaLink)})`);
  }

  // (j) Health endpoint advertises the evidence-derived safety config.
  const healthSrc = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  if (/ratings:/.test(healthSrc) && /evidence-derived/.test(healthSrc) && /faersSeriousMinReports/.test(healthSrc)) {
    pass('Fix 6(j): /api/health advertises evidence-derived, deterministic safety scoring config');
  } else {
    fail('Fix 6(j): /api/health missing safety-scoring config flags');
  }

  // (k) The synthesis prompt no longer asks the model for a "SAFETY: NN%".
  if (!/SAFETY: <1-100>%/.test(researchSrc) &&
      /SAFETY: Safety concern: <Low \| Moderate \| High>/.test(researchSrc) &&
      /OMIT this entire CONFIDENCE line/.test(researchSrc)) {
    pass('Fix 6(k): prompt emits SAFETY/CONFIDENCE bands (no fabricated percent) and drops unsourced confidence');
  } else {
    fail('Fix 6(k): prompt still asks for a safety/confidence percent, or missing confidence-drop instruction');
  }

  // (l) normalizePatientMeds strips doses and de-dupes.
  const meds = normalizePatientMeds('Aspirin 81 mg, Warfarin 5mg; aspirin');
  if (meds.length === 2 && meds[0] === 'Aspirin' && meds[1] === 'Warfarin') {
    pass('Fix 6(l): normalizePatientMeds strips doses + de-dupes patient medications');
  } else {
    fail(`Fix 6(l): normalizePatientMeds regression (${JSON.stringify(meds)})`);
  }

  // (m) Client mandate: Safety/Confidence meters are NOT shown on cards —
  // there was no reliable backing link for the band. MeterBar may still exist
  // as dead code; cards must not render it.
  if (!/<MeterBar[\s>]/.test(indexSrc) && !/label="Safety"/.test(indexSrc) && !/label="Confidence"/.test(indexSrc)) {
    pass('Fix 6(m): index.html does not render Safety/Confidence meters on cards (no unsourced band UI)');
  } else {
    fail('Fix 6(m): Safety/Confidence MeterBar still rendered on cards');
  }
}

// ===========================================================================
// FIX 7 — Option B: prefer a reader-verifiable link. When an evidence-pack item
// carries both a paywalled publisher URL and an open-access alternative for the
// SAME source, the cited `url` becomes the reader-accessible one (PMC > PubMed >
// DOI > ClinicalTrials.gov > publisher). We ONLY reorder URLs that already exist
// on the item — never fabricate one — and a publisher-only item is untouched.
// ===========================================================================
{
  // (a) Publisher URL alongside a PMC full-text link → cite PMC.
  const withPmc = preferVerifiableUrl({
    url: 'https://www.nature.com/articles/s41586-020-1234-5',
    pmcUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/',
    pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/32000001/',
    doiUrl: 'https://doi.org/10.1038/s41586-020-1234-5'
  });
  if (withPmc === 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321') {
    pass('Fix 7(a): a paywalled publisher URL with a PMC alternative cites the PMC full-text link');
  } else {
    fail(`Fix 7(a): PMC promotion regression (got ${withPmc})`);
  }

  // (b) Publisher + PubMed + DOI (no PMC) → cite PubMed over DOI over publisher.
  const withPubmed = preferVerifiableUrl({
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000',
    pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/32000002/',
    doiUrl: 'https://doi.org/10.1016/j.example.2021.01.001'
  });
  if (withPubmed === 'https://pubmed.ncbi.nlm.nih.gov/32000002') {
    pass('Fix 7(b): with no PMC copy, the PubMed record is preferred over DOI and the publisher URL');
  } else {
    fail(`Fix 7(b): PubMed promotion regression (got ${withPubmed})`);
  }

  // (c) Publisher + DOI only → cite the DOI (doi.org) over the publisher page.
  const withDoi = preferVerifiableUrl({
    url: 'https://link.springer.com/article/10.1007/s00000-000-0000-0',
    doiUrl: 'https://doi.org/10.1007/s00000-000-0000-0'
  });
  if (withDoi === 'https://doi.org/10.1007/s00000-000-0000-0') {
    pass('Fix 7(c): with only a DOI alternative, doi.org is preferred over the publisher URL');
  } else {
    fail(`Fix 7(c): DOI promotion regression (got ${withDoi})`);
  }

  // (d) Only a publisher URL exists → keep it unchanged (never dropped/fabricated).
  const only = 'https://www.wiley.com/en-us/some-article';
  const publisherOnly = preferVerifiableUrl({ url: only });
  if (publisherOnly === only) {
    pass('Fix 7(d): a publisher-only item keeps its URL unchanged (no fabrication, no drop)');
  } else {
    fail(`Fix 7(d): publisher-only regression (got ${publisherOnly})`);
  }

  // (e) No URL at all → empty string (nothing invented), honors the fallback arg.
  const none = preferVerifiableUrl({ title: 'no links here' });
  const fb = preferVerifiableUrl({ title: 'x' }, 'https://doi.org/10.1/fallback');
  if (none === '' && fb === 'https://doi.org/10.1/fallback') {
    pass('Fix 7(e): an item with no URLs yields empty (never fabricates); a caller fallback is honored');
  } else {
    fail(`Fix 7(e): empty-item regression (none=${JSON.stringify(none)} fb=${fb})`);
  }

  // (f) An open-access (Unpaywall) copy is preferred over the publisher page even
  //     when both resolve to the "other-host" tier (oaUrl beats url on a tie).
  const withOa = preferVerifiableUrl({
    url: 'https://www.tandfonline.com/doi/full/10.1080/x',
    oaUrl: 'https://repository.university.edu/bitstream/handle/paper.pdf'
  });
  if (withOa === 'https://repository.university.edu/bitstream/handle/paper.pdf') {
    pass('Fix 7(f): an open-access copy is cited over the publisher page on a same-tier tie');
  } else {
    fail(`Fix 7(f): OA-over-publisher tie regression (got ${withOa})`);
  }

  // (g) Determinism — identical input → identical chosen URL every run.
  const item = {
    url: 'https://www.nature.com/articles/x',
    pmcUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
    pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/1/',
    doiUrl: 'https://doi.org/10.1/x'
  };
  if (preferVerifiableUrl(item) === preferVerifiableUrl(item)) {
    pass('Fix 7(g): preferVerifiableUrl is deterministic (same item → same chosen URL)');
  } else {
    fail('Fix 7(g): preferVerifiableUrl is non-deterministic');
  }

  // (h) The promoted URL survives the report-polish allowlist / link sanitizer.
  const allow = collectAllowedUrls({ groundedForPrompt: [item] }, null);
  const line = `See the trial [source](${preferVerifiableUrl(item)}).`;
  if (/\[source\]\(https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC1\/?\)/.test(sanitizeMarkdownLinks(line, allow))) {
    pass('Fix 7(h): the promoted reader-verifiable URL is on the allowlist and survives sanitizeMarkdownLinks');
  } else {
    fail('Fix 7(h): promoted URL stripped by the link sanitizer');
  }

  // (i) A curated-KB item carries a paywalled publisher `url` plus BARE
  //     `pmid` / `doi` identifiers (not pre-built *Url fields). The derived
  //     PubMed record must win over the ScienceDirect 403 — this is the exact
  //     NAC / retinitis-pigmentosa dud Dorothy clicked.
  const kbNac = {
    url: 'https://www.sciencedirect.com/science/article/pii/S0002939419305732',
    pmid: '31734129',
    doi: '10.1016/j.ajo.2019.11.008'
  };
  const kbDoiOnly = { url: 'https://www.nature.com/articles/x', doi: '10.1038/x' };
  if (
    preferVerifiableUrl(kbNac) === 'https://pubmed.ncbi.nlm.nih.gov/31734129/' &&
    preferVerifiableUrl(kbDoiOnly) === 'https://doi.org/10.1038/x' &&
    preferVerifiableUrl({ url: 'https://www.wiley.com/x' }) === 'https://www.wiley.com/x'
  ) {
    pass('Fix 7(i): a KB item with bare pmid/doi cites the derived PubMed/DOI over the paywalled publisher URL');
  } else {
    fail(`Fix 7(i): bare pmid/doi derivation regression (nac=${preferVerifiableUrl(kbNac)})`);
  }
}

// ===========================================================================
// Fix 8: hard dead-link gate — a "dud" (paywalled / bot-blocked 401/403/451)
// on an untrusted host is treated as dead, trusted reader-accessible hosts
// fail open, and a stripped citation is replaced with a scoped search link
// instead of leaving a bare claim (Dorothy's dead-link complaint).
// ===========================================================================
{
  // (a) 404/410 are always dead, on any host.
  if (
    classifyProbeStatus('https://www.sciencedirect.com/x', 404) === 'dead' &&
    classifyProbeStatus('https://pubmed.ncbi.nlm.nih.gov/1/', 410) === 'dead'
  ) {
    pass('Fix 8(a): 404/410 classify as dead on any host');
  } else {
    fail('Fix 8(a): 404/410 no longer classify as dead');
  }

  // (b) A 403 on an untrusted publisher (paywall/bot-block) is a dud → dead.
  if (
    classifyProbeStatus('https://www.sciencedirect.com/science/article/abs/pii/S0002939419305732', 403) === 'dead' &&
    classifyProbeStatus('https://www.nature.com/articles/x', 401) === 'dead' &&
    classifyProbeStatus('https://link.springer.com/x', 451) === 'dead'
  ) {
    pass('Fix 8(b): 401/403/451 on an untrusted publisher classify as a dead dud');
  } else {
    fail('Fix 8(b): paywalled 403 dud no longer treated as dead');
  }

  // (c) The same blocked status on a trusted reader-accessible host fails OPEN
  //     (bot-block, not a wall for humans) so real citations are never stripped.
  const trustedBlocked = [
    'https://pubmed.ncbi.nlm.nih.gov/32000001/',
    'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
    'https://doi.org/10.1/x',
    'https://clinicaltrials.gov/study/NCT01234567',
    'https://accessdata.fda.gov/scripts/cder/daf/',
    'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=x',
    'https://europepmc.org/article/MED/1'
  ];
  if (trustedBlocked.every((u) => classifyProbeStatus(u, 403) === 'alive' && isTrustedLiveHost(u))) {
    pass('Fix 8(c): a 403 from a trusted host (PubMed/PMC/DOI/CT.gov/FDA/DailyMed/EuropePMC) fails open');
  } else {
    fail('Fix 8(c): a trusted host 403 was wrongly treated as dead');
  }

  // (d) Transient statuses (429/5xx) and 2xx/3xx always stay alive.
  if (
    classifyProbeStatus('https://www.sciencedirect.com/x', 429) === 'alive' &&
    classifyProbeStatus('https://www.sciencedirect.com/x', 503) === 'alive' &&
    classifyProbeStatus('https://www.sciencedirect.com/x', 200) === 'alive'
  ) {
    pass('Fix 8(d): transient 429/5xx and healthy 2xx stay alive (fail-open on flaky network)');
  } else {
    fail('Fix 8(d): a transient/healthy status was wrongly treated as dead');
  }

  // (e) A dead markdown citation without an NCT is demoted to PLAIN TEXT —
  //     never replaced with a PubMed search placeholder (citation integrity).
  const dud = 'https://www.sciencedirect.com/science/article/abs/pii/S0002939419305732';
  const body = `NAC in RP — Johns Hopkins phase 1, AJO 2020 [source](${dud}) improved vision.`;
  const fixed = stripDeadLinksFromText(body, new Set([dud]), { condition: 'retinitis pigmentosa' });
  if (
    !fixed.includes(dud) &&
    /source/.test(fixed) &&
    !/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=/i.test(fixed) &&
    !/google\.com\/search/i.test(fixed)
  ) {
    pass('Fix 8(e): a stripped dud citation becomes plain text (no search-placeholder replacement)');
  } else {
    fail(`Fix 8(e): dud citation handling regression (got: ${fixed})`);
  }

  // (f) An NCT-labelled dead link is repointed at the exact ClinicalTrials.gov
  //     study, and a bare dead URL is removed entirely.
  const nctUrl = buildFallbackSearchUrl('Phase 3 trial NCT04148833 of drug X', 'IPF');
  const bareBody = `See ${dud} for details.`;
  const bareFixed = stripDeadLinksFromText(bareBody, new Set([dud]), {});
  if (nctUrl === 'https://clinicaltrials.gov/study/NCT04148833' && !bareFixed.includes(dud)) {
    pass('Fix 8(f): an NCT label repoints to the exact CT.gov study; a bare dead URL is removed');
  } else {
    fail(`Fix 8(f): NCT/bare-URL handling regression (nct=${nctUrl}, bare="${bareFixed}")`);
  }

  // (g) Non-NCT dead links get NO search fallback (empty string) — integrity over density.
  const replUrl = buildFallbackSearchUrl('some paper title', 'IPF');
  if (replUrl === '' && buildFallbackSearchUrl('some paper title', 'IPF') === '') {
    pass('Fix 8(g): non-NCT dead-link fallback is empty (plain text, not a search URL)');
  } else {
    fail(`Fix 8(g): expected empty fallback, got ${replUrl}`);
  }

  // Citation authority: banned claim cites + fail-closed unverified documents.
  {
    const bannedOk =
      isBannedClaimCitation('https://www.google.com/search?q=x') &&
      isBannedClaimCitation('https://pubmed.ncbi.nlm.nih.gov/?term=ipf') &&
      isBannedClaimCitation('https://clinicaltrials.gov/search?term=ipf') &&
      isBannedClaimCitation('https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=x') &&
      !isBannedClaimCitation('https://pubmed.ncbi.nlm.nih.gov/35486072/');
    const demoted = demoteBannedClaimCitations(
      'See [Dr X](https://www.google.com/search?q=x) and [paper](https://pubmed.ncbi.nlm.nih.gov/35486072/).'
    );
    const demoteOk = !/google\.com\/search/i.test(demoted) && /pubmed\.ncbi\.nlm\.nih\.gov\/35486072/.test(demoted);
    const unverifiedOk =
      isUnverifiedDocumentUrl('https://pubmed.ncbi.nlm.nih.gov/99999999/') &&
      !isUnverifiedDocumentUrl('https://clinicaltrials.gov/study/NCT04148833');
    const nctOnly = buildDeadLinkReplacement('see NCT04148833') === 'https://clinicaltrials.gov/study/NCT04148833'
      && buildDeadLinkReplacement('random paper') === '';
    if (bannedOk && demoteOk && unverifiedOk && nctOnly) {
      pass('Citation authority: banned search cites demoted; NCT-only dead fallback; unverified docs flagged');
    } else {
      fail(`Citation authority regression (banned=${bannedOk} demote=${demoteOk} unverified=${unverifiedOk} nct=${nctOnly})`);
    }
  }

  // ALL CONDITIONS: every curated KB must pin ≥1 citeable URL and ZERO banned
  // claim citations (Google / DailyMed search / PubMed search / CT search).
  // This is the explicit per-condition gate Dorothy required — runs offline.
  {
    const kbDir = join(repoRoot, 'data', 'kb');
    const files = readdirSync(kbDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    let empty = 0;
    let bannedConds = 0;
    let bannedUrls = 0;
    for (const f of files) {
      const slug = f.replace(/\.json$/, '');
      const kb = JSON.parse(readFileSync(join(kbDir, f), 'utf8'));
      const cites = extractKbCitationUrls(kb, slug);
      if (!cites.length) empty++;
      const bad = cites.filter((c) => isBannedClaimCitation(c.url));
      if (bad.length) {
        bannedConds++;
        bannedUrls += bad.length;
        fail(`[${slug}] pins ${bad.length} banned citation URL(s) — e.g. ${bad[0].url}`);
      }
    }
    if (!empty && !bannedConds) {
      pass(`All ${files.length} condition KBs: ≥1 citeable URL each, 0 banned search/dud cites`);
    } else if (empty) {
      fail(`${empty}/${files.length} condition KB(s) have zero citeable URLs`);
    }
  }

  // (h) Budget guard: findDeadLinks skips always-live hosts (PubMed/PMC/DOI/
  //     CT.gov/EuropePMC) WITHOUT a network probe, so a link-heavy report spends
  //     its time budget on risky publisher links. An all-always-live input
  //     resolves instantly to an empty dead set (no fetch). fda.gov is
  //     deliberately NOT skipped here — its deep label PDFs rotate and 404.
  const t0 = Date.now();
  const deadFast = await findDeadLinks([
    'https://pubmed.ncbi.nlm.nih.gov/1/',
    'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
    'https://doi.org/10.1/x',
    'https://clinicaltrials.gov/study/NCT01234567',
    'https://europepmc.org/article/MED/1'
  ]);
  if (deadFast.size === 0 && Date.now() - t0 < 500) {
    pass('Fix 8(h): always-live hosts are skipped without a network probe (time budget preserved)');
  } else {
    fail(`Fix 8(h): always-live hosts were probed (size=${deadFast.size}, ms=${Date.now() - t0})`);
  }
}

// ===========================================================================
// TASK A — validator ENFORCEMENT (catch-all): the second AI must FLAG and the
// pipeline (applyValidationFixes) must REMOVE/repair, driven by patient profile.
//   1. bad link (dead / search-page / non-specific) → link stripped
//   2. citation-claim MISMATCH (real URL, wrong source) → link stripped
//   3. demographic / eligibility MISMATCH study → line removed
// Fail-safe: deterministic gates hold even when the validator returns nothing.
// ===========================================================================
{
  // (1)+(2) BAD LINK / MISMATCH: validator flags the URL under
  // hallucinatedCitations → applyValidationFixes strips the link to plain text
  // (claim survives). Covers a dead link, a DailyMed search page, AND a live
  // but off-topic (mismatched) source URL.
  const report = [
    'Finasteride slows hair loss ([review](https://pubmed.ncbi.nlm.nih.gov/dead123/)).',
    'Clascoterone is topical ([AGA review](https://pubmed.ncbi.nlm.nih.gov/99999999/)).'
  ].join('\n');
  const validation = {
    primary: {
      hallucinatedCitations: [
        { url: 'https://pubmed.ncbi.nlm.nih.gov/dead123/', issue: 'URL 404s / does not resolve' },
        { url: 'https://pubmed.ncbi.nlm.nih.gov/99999999/', issue: 'URL resolves but source does not mention clascoterone' }
      ]
    }
  };
  const fixed = applyValidationFixes(report, validation, null, null);
  const bothStripped =
    !/\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/dead123\//.test(fixed) &&
    !/\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/99999999\//.test(fixed) &&
    /Finasteride slows hair loss/.test(fixed) &&
    /Clascoterone is topical/.test(fixed);
  if (bothStripped) {
    pass('Task A(1/2): applyValidationFixes REMOVES a validator-flagged dead link AND a citation-claim-mismatch link (claims survive as plain text)');
  } else {
    fail(`Task A(1/2): flagged bad/mismatched links not stripped → ${JSON.stringify(fixed)}`);
  }

  // (3) DEMOGRAPHIC MISMATCH: a female-only study surfaced for a MALE patient is
  // REMOVED (not labeled), driven by the patient profile — not a hardcoded
  // condition. A grounded, on-topic line for the same patient is KEPT.
  const male = { gender: 'Male', age: 45 };
  const demoReport = [
    'A female-only study of topical estrogen in women with hair loss showed benefit (NCT01234567).',
    'Finasteride is a standard oral option studied in men and women (NCT07654321).'
  ].join('\n');
  const demoValidation = {
    primary: {
      demographicMismatches: [
        { quote: 'A female-only study of topical estrogen in women with hair loss showed benefit (NCT01234567).', reason: 'female-only study, patient is male' }
      ]
    }
  };
  const demoFixed = applyValidationFixes(demoReport, demoValidation, null, null, false, { patient: male });
  if (!/female-only study/.test(demoFixed) && /Finasteride is a standard oral option/.test(demoFixed)) {
    pass('Task A(3): applyValidationFixes REMOVES a validator-flagged female-only study for a male patient; keeps the inclusive study');
  } else {
    fail(`Task A(3): demographic-mismatch line not removed / inclusive line lost → ${JSON.stringify(demoFixed)}`);
  }

  // Fail-safe: deterministic demographic gate removes an opposite-sex-only study
  // line even with NO validator verdict at all (validator errored / returned
  // nothing). Driven by patient sex; condition-agnostic.
  const failsafe = stripDemographicMismatchLines(demoReport, male);
  if (!/female-only study/.test(failsafe.text) && /Finasteride is a standard oral option/.test(failsafe.text) && failsafe.removed.length === 1) {
    pass('Task A fail-safe: deterministic gate removes the female-only study for a male patient with no validator verdict');
  } else {
    fail(`Task A fail-safe: deterministic demographic strip regression → ${JSON.stringify(failsafe)}`);
  }

  // A female patient is NOT gated on the same female-only line (patient-driven).
  const femaleKept = stripDemographicMismatchLines(demoReport, { gender: 'Female', age: 45 });
  if (/female-only study/.test(femaleKept.text) && femaleKept.removed.length === 0) {
    pass('Task A fail-safe: a female patient KEEPS the female-only study (gate is patient-profile driven, not hardcoded)');
  } else {
    fail(`Task A fail-safe: female patient wrongly gated → ${JSON.stringify(femaleKept)}`);
  }

  // Age band: a pediatric-only trial line is removed for an adult; kept for a child.
  const pedLine = 'A pediatric trial enrolled children only with early disease (NCT02020202).';
  const adultStrip = stripDemographicMismatchLines(pedLine, { age: 64 });
  const childStrip = stripDemographicMismatchLines(pedLine, { age: 8 });
  if (adultStrip.removed.length === 1 && childStrip.removed.length === 0) {
    pass('Task A fail-safe: a pediatric-only trial is removed for a 64-year-old and kept for an 8-year-old');
  } else {
    fail(`Task A fail-safe: age-band gate regression (adult=${adultStrip.removed.length} child=${childStrip.removed.length})`);
  }

  // A non-study prose line that merely mentions a sex is NOT removed (only real
  // study/trial mentions are gated — no false deletion of epidemiology prose).
  const proseKept = stripDemographicMismatchLines('This condition is more common in women.', male);
  if (proseKept.removed.length === 0) {
    pass('Task A fail-safe: epidemiology prose ("more common in women") is NOT mistaken for a mismatched study');
  } else {
    fail(`Task A fail-safe: prose wrongly removed → ${JSON.stringify(proseKept)}`);
  }

  // finalizeReportText wires the deterministic demographic gate into the real
  // render path (patient threaded through). Exact trial records are supplied
  // because finalized quantitative/NCT claims now fail closed without their
  // own supporting source.
  const finalizedDemo = finalizeReportText(demoReport, {
    evidence: null,
    trials: {
      studies: [
        {
          nctId: 'NCT01234567',
          title: 'A female-only study of topical estrogen in women with hair loss showed benefit'
        },
        {
          nctId: 'NCT07654321',
          title: 'Finasteride is a standard oral option studied in men and women'
        }
      ]
    },
    patient: male
  });
  if (!/female-only study/.test(finalizedDemo) && /Finasteride is a standard oral option/.test(finalizedDemo)) {
    pass('Task A: finalizeReportText applies the demographic gate end-to-end (male patient)');
  } else {
    fail(`Task A: finalize demographic gate regression → ${JSON.stringify(finalizedDemo)}`);
  }
}

// ===========================================================================
// TASK A — trials hard-gate: a study the patient is hard-INELIGIBLE for by sex
// or age is REMOVED from the surfaced list (patient-driven, condition-agnostic),
// not merely penalized. Uses the CT.gov eligibility fields directly.
// ===========================================================================
{
  const femaleOnly = { nctId: 'NCT00000001', sex: 'FEMALE', briefTitle: 'X in women', conditions: [] };
  const pediatric = { nctId: 'NCT00000002', sex: 'ALL', minimumAge: '2 Years', maximumAge: '17 Years', stdAges: ['CHILD'] };
  const inclusive = { nctId: 'NCT00000003', sex: 'ALL', minimumAge: '18 Years', maximumAge: '80 Years', stdAges: ['ADULT', 'OLDER_ADULT'] };
  const maleAdult = { patientSex: 'Male', patientAge: 45 };
  if (
    patientSexIneligible(femaleOnly, maleAdult.patientSex) &&
    patientAgeIneligible(pediatric, maleAdult.patientAge) &&
    !patientSexIneligible(inclusive, maleAdult.patientSex) &&
    !patientAgeIneligible(inclusive, maleAdult.patientAge)
  ) {
    pass('Task A trials: sex/age hard-ineligibility is detected for a male adult (female-only + pediatric) and NOT for an inclusive adult study');
  } else {
    fail('Task A trials: eligibility detection regression');
  }
  // Unknown patient sex/age never gates (bias toward keeping).
  if (!patientSexIneligible(femaleOnly, null) && !patientAgeIneligible(pediatric, null)) {
    pass('Task A trials: a patient with no sex/age provided is never demographically gated');
  } else {
    fail('Task A trials: null patient profile wrongly gated a study');
  }
}

// ===========================================================================
// TASK B — citation-claim RELEVANCE (semantic grounding). A live, non-search,
// specific link is still stripped when its SOURCE does not mention the card's
// drug. A source that DOES mention the drug is kept. Unknown sources are kept.
// ===========================================================================
{
  const evidence = {
    groundedForPrompt: [
      {
        title: 'Treatment of Androgenetic Alopecia: a clinical review',
        summary: 'A broad review of androgenetic alopecia covering only minoxidil and finasteride, with no mention of newer topical antiandrogens.',
        url: 'https://pubmed.ncbi.nlm.nih.gov/11110000/'
      },
      {
        title: 'Clascoterone cream 1% for androgenetic alopecia: phase 2 trial',
        summary: 'A randomized phase 2 trial of clascoterone topical solution in androgenetic alopecia.',
        url: 'https://pubmed.ncbi.nlm.nih.gov/22220000/'
      }
    ]
  };
  const urlIndex = buildEvidenceUrlIndex(evidence);

  // sourceMentionsSubject / subjectTokens primitives.
  const okTokens = subjectTokens('Clascoterone (Winlevi)').has('clascoterone');
  const shortTokens = subjectTokens('NAC').size === 0; // too short to verify
  if (okTokens && shortTokens) {
    pass('Task B: subjectTokens extracts salient drug tokens; a too-short name (NAC) yields no tokens (unknown)');
  } else {
    fail(`Task B: subjectTokens regression (ok=${okTokens} short=${shortTokens})`);
  }

  const offTopic = citationRelevantToSubject('https://pubmed.ncbi.nlm.nih.gov/11110000/', 'Clascoterone', urlIndex);
  const onTopic = citationRelevantToSubject('https://pubmed.ncbi.nlm.nih.gov/22220000/', 'Clascoterone', urlIndex);
  const unknown = citationRelevantToSubject('https://pubmed.ncbi.nlm.nih.gov/33330000/', 'Clascoterone', urlIndex);
  // Fail-closed: a PubMed document URL not in the pack is demoted (false), not kept (null).
  if (offTopic === false && onTopic === true && unknown === false) {
    pass('Task B: citationRelevantToSubject rejects off-topic + pack-unknown PubMed docs; accepts on-topic trial');
  } else {
    fail(`Task B: relevance regression (offTopic=${offTopic} onTopic=${onTopic} unknown=${unknown})`);
  }

  // enforceCandidateCitationRelevance demotes the off-topic link on the card,
  // keeps the on-topic one.
  const cards = [
    'CANDIDATE: Clascoterone',
    'REFERENCES: [AGA review](https://pubmed.ncbi.nlm.nih.gov/11110000/) [Clascoterone trial](https://pubmed.ncbi.nlm.nih.gov/22220000/)',
    '',
    'CANDIDATE: Minoxidil',
    'REFERENCES: [AGA review](https://pubmed.ncbi.nlm.nih.gov/11110000/)'
  ].join('\n');
  const enforced = enforceCandidateCitationRelevance(cards, evidence);
  const clascoteroneOk =
    !/\[AGA review\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/11110000\/\)[^\n]*Clascoterone trial/.test(enforced.text) &&
    /\[Clascoterone trial\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/22220000\/\)/.test(enforced.text);
  // The AGA review DOES mention minoxidil, so it stays on the Minoxidil card.
  const minoxidilKept = /CANDIDATE: Minoxidil[\s\S]*\[AGA review\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/11110000\/\)/.test(enforced.text);
  if (clascoteroneOk && minoxidilKept && enforced.demoted.length === 1) {
    pass('Task B: enforceCandidateCitationRelevance demotes the off-topic review on the Clascoterone card, keeps it on the Minoxidil card (source mentions minoxidil)');
  } else {
    fail(`Task B: card relevance enforcement regression (demoted=${enforced.demoted.length}) → ${JSON.stringify(enforced.text)}`);
  }

  // distinctLinkedCandidateCount(text, evidence): the off-topic-only Clascoterone
  // card would NOT count toward Hard-25 if its ONLY link were the AGA review.
  const offOnly = [
    'CANDIDATE: Clascoterone',
    'REFERENCES: [AGA review](https://pubmed.ncbi.nlm.nih.gov/11110000/)'
  ].join('\n');
  const withoutIndex = distinctLinkedCandidateCount(offOnly);
  const withIndex = distinctLinkedCandidateCount(offOnly, evidence);
  if (withoutIndex === 1 && withIndex === 0) {
    pass('Task B: distinctLinkedCandidateCount drops a card whose ONLY citation is off-topic once relevance (evidence) is supplied');
  } else {
    fail(`Task B: Hard-25 relevance counting regression (withoutIndex=${withoutIndex} withIndex=${withIndex})`);
  }
}

// ===========================================================================
// TASK C — IPF KB hygiene: no DailyMed search.cfm URLs remain, and the
// pirfenidone/nintedanib entries carry a specific resolving label monograph.
// ===========================================================================
{
  const ipf = JSON.parse(readFileSync(new URL('../data/kb/ipf.json', import.meta.url), 'utf8'));
  const raw = JSON.stringify(ipf);
  const noSearch = !/dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm/i.test(raw);
  const refs = ipf.items || ipf.references || ipf.evidence || [];
  const findRef = (id) => (refs.find((r) => r.id === id) || {});
  const pirf = findRef('ipf-fda-label-pirfenidone');
  const nint = findRef('ipf-fda-label-nintedanib');
  const isSpecific = (u) =>
    /dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=[0-9a-f-]{8,}/i.test(String(u || '')) ||
    /^https?:\/\//i.test(String(u || '')) && /pubmed|doi|accessdata\.fda\.gov\/drugsatfda/i.test(String(u || ''));
  if (noSearch && isSpecific(pirf.url) && isSpecific(nint.url)) {
    pass('Task C: ipf.json has no search.cfm URLs; pirfenidone + nintedanib carry a specific resolving label / primary source');
  } else {
    fail(`Task C: ipf.json hygiene regression (noSearch=${noSearch} pirf=${pirf.url} nint=${nint.url})`);
  }
}

console.log(process.exitCode ? '\n\x1b[31mPlatform regression FAILED\x1b[0m\n' : '\n\x1b[32mPlatform regression passed\x1b[0m\n');
