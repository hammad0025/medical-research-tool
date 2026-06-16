// Vercel Serverless Function for the main research pipeline.
//
// Modes supported:
//   - "research"   : full evidence-based analysis of treatments for the condition,
//                    tailored to patient profile, with contraindication check
//   - "repurpose"  : EveryCure-style out-of-the-box drug repurposing analysis
//                    ("professor-to-students" reasoning)
//   - "trials"     : narrative analysis layered on top of live ClinicalTrials.gov
//                    data (the structured pull happens in /api/trials)
//   - "chat"       : free-form follow-up in the same context
//
// Audience toggle: "medical" (clinician language) or "layperson" (10th-grade).
//
// GROUNDING: for "research" and "repurpose" modes, we first call /api/evidence
// to fan out across PubMed + Europe PMC + OpenAlex + Cochrane + openFDA,
// de-duplicate by DOI/PMID, pull OA full text when available, and hand Claude
// a grounded evidence pack. Claude is instructed to cite ONLY from that pack.
// This eliminates the single biggest failure mode of consumer AI medical
// research: hallucinated citations that confidently reference papers the AI
// never actually read.
//
// All modes return Claude's text; the frontend parses structured blocks
// (PROVIDER/TREATMENT/EFFICACY/SAFETY/COST/REFERENCES) into the comparison chart.

import evidenceHandler from '../lib/evidence.js';
import validateHandler from '../lib/validate.js';
import perplexitySearchHandler from '../lib/perplexity-search.js';
import trialsHandler from './trials.js';
import {
  finalizeReportText,
  filterExcludedAgentMentions,
  applyValidationFixes,
  collectAllowedUrls
} from '../lib/report-polish.js';
import { getDossier } from '../lib/disease-dossier.js';
import { loadKb, matchKb } from '../lib/kb.js';
import { ensureDynamicKb } from '../lib/kb-bootstrap.js';
import {
  consumeResearchCredit,
  limits as usageLimits,
  pricing as usagePricing,
  getUsage,
  isUsageLimitBypassed,
  verifyPlanCode,
  activatePlanForIp
} from '../lib/usage-store.js';
import { requireAccess } from '../lib/access-gate.js';
import { asInternalReq } from '../lib/internal-call.js';
import { getInfraStatus } from '../lib/infra-status.js';
import { registryStats as diseaseRegistryStats } from '../lib/disease-registry.js';
import { registryStats as drugRegistryStats, selectRepurposeDrugs, buildRepurposeDrugLibraryBlock } from '../lib/drug-registry.js';
import { buildSupplementDiscoveryBlock } from '../lib/supplement-discovery.js';
import { countCandidateBlocks, isLaneTruncated } from '../lib/repurpose-quality.js';
import { resolveCondition, detectValidationMismatch } from '../lib/condition-resolver.js';
import { listConditionSubtypes } from '../lib/condition-subtypes.js';
import { conditionInferenceConfig } from '../lib/condition-intake-flags.js';
import {
  isResearchPipelineEnabled,
  isSpendEnabled,
  isPaidUserMode,
  isPerplexitySpendEnabled,
  isDynamicKbSpendEnabled,
  spendControlsConfig,
  spendDisabledMessage
} from '../lib/spend-controls.js';
import {
  parsePatientMessage,
  mergePatientFromMessage,
  extractConditionFromMessage
} from '../lib/patient-intake.js';
import {
  buildGatherFingerprintFromPatient,
  gatherFingerprintAccepted,
  poolBoundSynthValid
} from '../lib/gather-fingerprint.js';
import {
  checkProfileCoherence,
  checkDossierProfileCoherence
} from '../lib/profile-coherence.js';

import {
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_DOSSIER_MODEL,
  isModelNotFoundError,
  nextFallbackModel
} from '../lib/anthropic-models.js';

const DEFAULT_MODEL = DEFAULT_RESEARCH_MODEL;

const callAnthropicMessages = async ({ model, maxTokens, system, messages, apiKey }) => {
  let activeModel = model;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: activeModel,
        max_tokens: maxTokens,
        system,
        messages
      })
    });
    if (response.ok) {
      return { ok: true, model: activeModel, data: await response.json() };
    }
    const errorData = await response.json().catch(() => ({}));
    lastError = { response, errorData, model: activeModel };
    const fallback = isModelNotFoundError(response.status, errorData)
      ? nextFallbackModel(activeModel)
      : null;
    if (!fallback) break;
    console.warn(
      `[research] model ${activeModel} unavailable (${errorData?.error?.message || response.status}) — retrying with ${fallback}`
    );
    activeModel = fallback;
  }
  return { ok: false, ...lastError };
};

// Serverless timeout safety: Opus is typically slower token/sec than Sonnet,
// so we cap max_tokens lower by default to reduce timeout risk. You can still
// override directly with ANTHROPIC_MAX_TOKENS if needed.
const resolveMaxTokens = (model, mode, phase, half, isBatch) => {
  const forced = Number(process.env.ANTHROPIC_MAX_TOKENS || 0);
  if (forced > 0) return forced;
  const m = String(model || '').toLowerCase();
  const isOpus = m.includes('opus');
  // On Vercel Pro each function may run up to 300s (see vercel.json), so we
  // can give synthesis room for fuller output than the old 60s Hobby cap
  // allowed. These stay split across two calls for resilience + streaming UX.
  if (phase === 'synthesize' && mode === 'repurpose') {
    if (half === 'back') return isOpus ? 1800 : 2200;
    // BATCHED front: 5 candidates per lane. ~700 tok/candidate in plain-English
    // mode; 2800 was truncating at ~4 and Dorothy saw "only 3 drugs". Lanes
    // run in parallel so wall-clock stays ~90–120s even at ~4200 tok/lane.
    if (isBatch) return isOpus ? 3400 : 4200;
    // Single-shot fallback (API back-compat): one big call for all 15.
    return isOpus ? 5200 : 7000;
  }
  // Research is split front/back; 2400 was hitting stop_reason=max_tokens on
  // every RP/IPF run (sections cut off mid-sentence). Pro allows ~300s/invoke.
  if (phase === 'synthesize' && mode === 'research') {
    if (half === 'back') return isOpus ? 3600 : 5200;
    // Front holds sections 1-3; the last approved-treatment card (e.g. the
    // nintedanib RISKS line) was being cut mid-word at 4800. Give it headroom.
    return isOpus ? 3600 : 5400;
  }
  if (isOpus) return 1400;
  if (m.includes('sonnet')) return 2000;
  return 2200; // haiku / unknown
};

// How much grounded evidence to inject per call. On Pro we can afford a
// richer evidence pack (more papers, longer excerpts) so candidates cite
// real sources, while still splitting the work into two resilient calls.
const groundingPlan = (mode, phase, half) => {
  if (mode === 'repurpose' && phase === 'synthesize') {
    // Combinations call references Part 1 drugs by name, so it needs less
    // raw literature than the candidate-generation call. Leaner prefill =
    // faster time-to-first-token = shorter total runtime.
    if (half === 'back') return { limit: 4, excerpt: 550 };
    return { limit: 8, excerpt: 950 };
  }
  if (mode === 'repurpose') return { limit: 12, excerpt: 2000 };
  return { limit: 6, excerpt: 2000 };
};

// Cross-validation runs automatically on every complete report (Vercel Pro
// allows 300s). Pass validate:false to skip. Partial synth halves / repurpose
// lanes skip — the client stitches the full text and polish-report validates.
const shouldAutoValidate = (mode, phase, half, isRepurposeBatch, body = {}) => {
  if (body.validate === false) return false;
  if (mode === 'chat' || mode === 'polish-report') return false;
  if (phase === 'gather') return false;
  if (phase === 'synthesize' && (half || isRepurposeBatch)) return false;
  return mode === 'research' || mode === 'repurpose' || mode === 'trials';
};

const invokeInProcess = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {}, status(c) { captured.status = c; return this; },
    end() {}, json(o) { captured.body = o; return this; }
  };
  try {
    await handler(asInternalReq({ method: 'POST', body, headers: {}, query: {} }), res);
  } catch (e) {
    captured.status = 500;
    captured.body = { error: e.message };
  }
  return captured.body;
};

const invokeEvidence = (body) => invokeInProcess(evidenceHandler, body);
const invokeValidate = (body) => invokeInProcess(validateHandler, body);
const invokeTrials = (body) => invokeInProcess(trialsHandler, body);
const invokePerplexitySearch = (body) => invokeInProcess(perplexitySearchHandler, body);

// Map a raw article (KB item or Perplexity web hit) into the groundedForPrompt
// shape the synthesis prompt expects.
const toGroundedItem = (a, { isCuratedKB = false, kbCategory = null } = {}) => ({
  id: a.id || a.doi || a.pmid || null,
  title: a.title,
  journal: a.journal || '',
  publisher: a.publisher || '',
  tier: a.tier || a.journalTier || null,
  year: a.year || null,
  sources: a.sources || (a.source ? [a.source] : isCuratedKB ? ['CuratedKB'] : ['PerplexityWeb']),
  isCuratedKB,
  kbCategory,
  isWebSearch: !!a.isWebSearch,
  openAccess: !!a.openAccess,
  accessLevel: a.accessLevel || 'abstract',
  citations: a.citedByCount || a.citations || 0,
  isRCT: !!a.isRCT,
  isMetaAnalysis: !!a.isMetaAnalysis,
  isSystematicReview: !!a.isSystematicReview,
  url: a.url || a.pubmedUrl || a.doiUrl || '',
  text: (a.abstract || a.fullText || a.summary || '').slice(0, 3500)
});

// KB-ONLY EVIDENCE FALLBACK.
// The live evidence fetch (PubMed/EPMC/OpenAlex fan-out) can be slow and is
// wrapped in a 120s deadline that resolves to `null` on timeout OR error. When
// that happened, the synthesis ran with NO grounding at all — which is exactly
// what produced Dorothy's bug report: only ~3 candidates, no source links, and
// metformin mislabeled as "not yet studied" (the excludedAgents guardrail never
// reached the prompt). The curated KB is a LOCAL file that loads in <50ms, so
// there is no excuse to ever run ungrounded when a KB exists for the condition.
// This builds an evidence object from the KB alone, shaped exactly like the
// real evidence.js response (groundedForPrompt + pipelineDrugs + excludedAgents
// + canonicalFacts), so the synthesis prompt, required-mentions, and coverage
// audit all keep working even when every external API is down.
const buildKbFallbackEvidence = async (condition, dossier = null, { kbSlug } = {}) => {
  try {
    if (!condition) return null;
    let kb = null;
    if (kbSlug) {
      const slugHit = await matchKb(kbSlug);
      if (slugHit?.kb) {
        kb = await loadKb(slugHit.kb.condition, {
          fallbackCanonical: dossier?.canonical || condition,
          fallbackSynonyms: dossier?.synonyms || []
        });
      }
    }
    if (!kb?.matched) {
      kb = await loadKb(condition, {
        fallbackCanonical: dossier?.canonical,
        fallbackSynonyms: dossier?.synonyms || []
      });
    }
    if (!kb || !kb.matched) return null;
    const canonical = kb.meta?.canonical || condition;
    const kbGrounded = (kb.items || []).map((it) =>
      toGroundedItem(it, { isCuratedKB: true, kbCategory: it.category || null })
    );

    // Even when PubMed/EPMC time out, Perplexity can still pull recent web
    // hits (new approvals, negative trials). Without this, KB-only fallback
    // was static saved sources only — no freshness layer at all.
    let webGrounded = [];
    if (process.env.PERPLEXITY_API_KEY && isPerplexitySpendEnabled()) {
      const drugNames = (kb.meta?.pipelineDrugs || []).map((d) => d.name).filter(Boolean).slice(0, 3);
      const seeds = (kb.meta?.literatureSearchSeeds || [])
        .map((s) => (typeof s === 'string' ? s : s?.term)).filter(Boolean).slice(0, 2);
      try {
        const webRes = await invokePerplexitySearch({
          condition: canonical,
          drugs: [...drugNames, ...seeds].slice(0, 6)
        });
        webGrounded = (webRes?.articles || []).map((a) =>
          toGroundedItem({ ...a, source: 'PerplexityWeb', isWebSearch: true })
        );
      } catch (e) {
        console.warn('[research] KB fallback Perplexity scout failed:', e?.message || e);
      }
    }

    const grounded = [...kbGrounded, ...webGrounded];
    const webCount = webGrounded.length;
    return {
      totalUnique: grounded.length,
      totalFetched: grounded.length,
      uniqueJournals: new Set(grounded.map((g) => g.journal).filter(Boolean)).size || grounded.length,
      perSourceCounts: { CuratedKB: kbGrounded.length, PerplexityWeb: webCount },
      groundedForPrompt: grounded,
      topRanked: grounded.slice(0, 50),
      pipelineDrugs: kb.meta?.pipelineDrugs || [],
      excludedAgents: kb.meta?.excludedAgents || [],
      canonicalFacts: kb.meta?.canonicalFacts || [],
      fdaLabels: [],
      fdaManufacturers: [],
      promptPackBreakdown: {
        total: grounded.length,
        curatedKB: kbGrounded.length,
        perplexityWeb: webCount,
        live: webCount
      },
      knowledgeBase: {
        matched: true,
        ...kb.meta,
        matchedOn: kb.matchedOn,
        score: kb.score,
        degraded: true,
        perplexityScout: webCount > 0
      }
    };
  } catch (e) {
    console.warn('[research] buildKbFallbackEvidence failed:', e?.message || e);
    return null;
  }
};

// True when an evidence object actually carries grounding the synthesis can
// cite. A null result OR an empty groundedForPrompt both mean "ungrounded".
const evidenceIsUsable = (ev) =>
  !!ev && Array.isArray(ev.groundedForPrompt) && ev.groundedForPrompt.length > 0;

// When there is no curated KB, still ground synthesis from the dossier agent
// (registry or LLM) plus a Perplexity scout. Without this, conditions like
// borderline personality disorder hit gather OK then synth with zero papers —
// the #1 "not in the brain yet" failure mode.
const buildDossierFallbackEvidence = async (condition, dossier = null) => {
  try {
    if (!condition) return null;
    const d = dossier?.canonical ? dossier : await getDossier(condition);
    const canonical = d?.canonical || condition;
    const grounded = [];
    let webCount = 0;

    if (process.env.PERPLEXITY_API_KEY && isPerplexitySpendEnabled()) {
      const seeds = [
        ...(d?.landmarkTrials || []).map((t) => t.acronym || t.name).filter(Boolean),
        ...(d?.synonyms || []).slice(0, 2)
      ];
      try {
        const webRes = await invokePerplexitySearch({
          condition: canonical,
          drugs: seeds.slice(0, 6)
        });
        const webGrounded = (webRes?.articles || []).map((a) =>
          toGroundedItem({ ...a, source: 'PerplexityWeb', isWebSearch: true })
        );
        grounded.push(...webGrounded);
        webCount = webGrounded.length;
      } catch (e) {
        console.warn('[research] dossier fallback Perplexity scout failed:', e?.message || e);
      }
    }

    for (const trial of (d?.landmarkTrials || []).slice(0, 4)) {
      const label = [trial.acronym, trial.name].filter(Boolean).join(' — ') || trial.topic;
      if (!label) continue;
      grounded.push(toGroundedItem({
        title: `${label} (${canonical})`,
        journal: 'Landmark trial / study',
        source: 'DossierIntake',
        summary: trial.topic || `Landmark study context for ${canonical}.`,
        accessLevel: 'dossier'
      }));
    }
    for (const rf of (d?.redFlags || []).slice(0, 3)) {
      grounded.push(toGroundedItem({
        title: `Clinical caution — ${canonical}`,
        journal: 'Dossier intake',
        source: 'DossierIntake',
        summary: rf,
        accessLevel: 'dossier'
      }));
    }
    if (!grounded.length) {
      grounded.push(toGroundedItem({
        title: `${canonical} — disease overview`,
        journal: d?.source === 'disease-registry' ? 'Disease registry' : 'Clinical intake',
        source: 'DossierIntake',
        summary: [
          `Condition: ${canonical}.`,
          d?.subspecialty ? `Specialty: ${d.subspecialty}.` : '',
          (d?.synonyms || []).length ? `Also known as: ${d.synonyms.slice(0, 5).join(', ')}.` : ''
        ].filter(Boolean).join(' '),
        accessLevel: 'dossier'
      }));
    }

    return {
      totalUnique: grounded.length,
      totalFetched: grounded.length,
      uniqueJournals: new Set(grounded.map((g) => g.journal).filter(Boolean)).size || grounded.length,
      perSourceCounts: { DossierIntake: grounded.length - webCount, PerplexityWeb: webCount },
      groundedForPrompt: grounded,
      topRanked: grounded.slice(0, 50),
      pipelineDrugs: [],
      excludedAgents: [],
      canonicalFacts: [],
      fdaLabels: [],
      fdaManufacturers: [],
      promptPackBreakdown: {
        total: grounded.length,
        dossierIntake: grounded.length - webCount,
        perplexityWeb: webCount,
        live: webCount
      },
      knowledgeBase: {
        matched: false,
        canonical,
        source: d?.source || 'dossier-llm',
        degraded: true,
        perplexityScout: webCount > 0,
        note: 'No curated KB yet — grounding from dossier + live web scout'
      }
    };
  } catch (e) {
    console.warn('[research] buildDossierFallbackEvidence failed:', e?.message || e);
    return null;
  }
};

const ensureGroundedEvidence = async (condition, dossier, evidence, hints = {}) => {
  if (evidenceIsUsable(evidence)) return evidence;
  const kbFallback = await buildKbFallbackEvidence(condition, dossier, hints);
  if (evidenceIsUsable(kbFallback)) {
    console.warn(`[research] KB fallback (${kbFallback.groundedForPrompt.length} curated refs)`);
    return kbFallback;
  }
  const dossierFallback = await buildDossierFallbackEvidence(condition, dossier);
  if (evidenceIsUsable(dossierFallback)) {
    console.warn(`[research] dossier fallback (${dossierFallback.groundedForPrompt.length} refs, no static KB)`);
    return dossierFallback;
  }
  return evidence;
};

// Gather returns pools to the browser, which POSTs them back for synthesize.
// Trials + evidence can exceed 1MB and break slow clients; trim to what the
// UI and synth path actually need (matches the final-response shape below).
// Slim pools the client POSTs back for synthesize — keeps request bodies
// under ~500KB so mobile clients and Vercel don't choke.
const trimSynthPools = (pools = {}) => {
  const { dossier, evidence, trials } = pools;
  const slimEvidence = evidence
    ? {
        condition: evidence.condition,
        dossier: evidence.dossier,
        pipelineDrugs: evidence.pipelineDrugs || [],
        excludedAgents: evidence.excludedAgents || [],
        totalUnique: evidence.totalUnique,
        totalFetched: evidence.totalFetched,
        perSourceCounts: evidence.perSourceCounts,
        accessBreakdown: evidence.accessBreakdown,
        promptPackBreakdown: evidence.promptPackBreakdown,
        qualityBreakdown: evidence.qualityBreakdown,
        knowledgeBase: evidence.knowledgeBase,
        fdaLabels: (evidence.fdaLabels || []).slice(0, 4),
        fdaManufacturers: (evidence.fdaManufacturers || []).slice(0, 3),
        groundedForPrompt: (evidence.groundedForPrompt || []).slice(0, 25).map((a) => ({
          ...a,
          text: (a.text || '').slice(0, 1800)
        })),
        topRanked: (evidence.topRanked || []).slice(0, 15).map((a) => ({
          id: a.id,
          title: a.title,
          journal: a.journal,
          year: a.year,
          url: a.url || a.pmcUrl || a.pubmedUrl || a.doiUrl,
          accessLevel: a.accessLevel,
          abstract: (a.abstract || '').slice(0, 800)
        }))
      }
    : null;
  return {
    dossier: dossier
      ? { ...dossier, poolsFingerprint: dossier.poolsFingerprint || null }
      : null,
    evidence: slimEvidence,
    trials: trials
      ? {
          total: trials.total,
          returned: trials.returned,
          breakdown: trials.breakdown,
          subQueries: trials.subQueries,
          query: trials.query,
          studies: (trials.studies || []).slice(0, 20)
        }
      : null
  };
};

const trimGatherPools = ({ dossier, evidence, trials, gatherFingerprint = null }) => ({
  dossier: dossier
    ? { ...dossier, poolsFingerprint: gatherFingerprint || dossier.poolsFingerprint || null }
    : null,
  evidence: evidence
    ? {
        condition: evidence.condition,
        dossier: evidence.dossier,
        pipelineDrugs: evidence.pipelineDrugs || [],
        excludedAgents: evidence.excludedAgents || [],
        repurposeDrugPool: evidence.repurposeDrugPool || [],
        repurposeDrugScreen: evidence.repurposeDrugScreen || null,
        totalUnique: evidence.totalUnique,
        totalFetched: evidence.totalFetched,
        perSourceCounts: evidence.perSourceCounts,
        uniqueJournals: evidence.uniqueJournals,
        corpusFootprint: evidence.corpusFootprint,
        accessBreakdown: evidence.accessBreakdown,
        promptPackBreakdown: evidence.promptPackBreakdown,
        qualityBreakdown: evidence.qualityBreakdown,
        knowledgeBase: evidence.knowledgeBase,
        topRanked: (evidence.topRanked || []).slice(0, 25).map((a) => ({
          ...a,
          fullText: (a.fullText || '').slice(0, 2000),
          abstract: (a.abstract || '').slice(0, 1500)
        })),
        groundedForPrompt: (evidence.groundedForPrompt || []).slice(0, 25).map((a) => ({
          ...a,
          text: (a.text || '').slice(0, 2000)
        })),
        fdaLabels: evidence.fdaLabels,
        fdaManufacturers: evidence.fdaManufacturers
      }
    : null,
  trials: trials
    ? {
        total: trials.total,
        returned: trials.returned,
        breakdown: trials.breakdown,
        subQueries: trials.subQueries,
        query: trials.query,
        studies: (trials.studies || []).slice(0, 25)
      }
    : null
});

const getClientIp = (req) => {
  const xff = String(req.headers?.['x-forwarded-for'] || '').trim();
  if (xff) return xff.split(',')[0].trim();
  return String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
};

const TRANSLATE_MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-3-5-haiku-20241022';
const TRANSLATE_MAX_CHARS = 65000;
const sanitize = (v) => (v == null ? '' : String(v).trim());

// Build a Claude-readable digest of the disease-intake dossier. This is the
// AI's "what do I know about this disease" context — canonical name, synonyms,
// subspecialty, the world-class centers known for this specific disease (not
// just generic famous hospitals), the landmark trial acronyms, the patient
// advocacy orgs. Without this, Claude researches IPF and Retinitis Pigmentosa
// with the same generic vocabulary; with this, it knows to talk about
// Pittsburgh Simmons + UCSF for ILD and Bascom Palmer + Wilmer for RP.
const buildDossierBlock = (dossier) => {
  if (!dossier) return '';
  const safe = (v) => (v == null ? '' : String(v));
  const lines = [];
  lines.push(`DISEASE DOSSIER (realtime intake, generated by ${safe(dossier.generatedBy) || 'AI agent'}, uncertainty ${dossier.uncertainty ?? '?'}):`);
  lines.push(`  Canonical name: ${safe(dossier.canonical)}`);
  if (dossier.subspecialty) lines.push(`  Subspecialty: ${dossier.subspecialty}`);
  if ((dossier.synonyms || []).length) {
    lines.push(`  Known synonyms / aliases: ${dossier.synonyms.join(', ')}`);
  }
  if ((dossier.meshTerms || []).length) {
    lines.push(`  NCBI MeSH terms used for PubMed fan-out: ${dossier.meshTerms.join(', ')}`);
  }
  if (dossier.icd10) lines.push(`  ICD-10: ${dossier.icd10}`);
  if ((dossier.topCenters || []).length) {
    lines.push(`  Top centers specific to this disease (dossier — you MUST surface these in the "Top Centers & Experts" section unless you have grounded evidence to override):`);
    dossier.topCenters.forEach((c) => {
      const loc = [c.city, c.country].filter(Boolean).join(', ');
      lines.push(`    - ${safe(c.name)}${loc ? ` (${loc})` : ''}${c.why ? ` — ${c.why}` : ''}`);
    });
  }
  if ((dossier.keyInvestigators || []).length) {
    lines.push(`  Key investigators (dossier):`);
    dossier.keyInvestigators.forEach((i) => {
      lines.push(`    - ${safe(i.name)}${i.affiliation ? ` (${i.affiliation})` : ''}${i.why ? ` — ${i.why}` : ''}`);
    });
  }
  if ((dossier.patientAdvocacy || []).length) {
    lines.push(`  Patient advocacy / registries (include these in the "Patient Advocacy & Resources" section):`);
    dossier.patientAdvocacy.forEach((a) => {
      lines.push(`    - ${safe(a.name)}${a.url ? ` — ${a.url}` : ''}${a.why ? ` — ${a.why}` : ''}`);
    });
  }
  if ((dossier.landmarkTrials || []).length) {
    lines.push(`  Landmark trials / acronyms:`);
    dossier.landmarkTrials.forEach((t) => {
      lines.push(`    - ${safe(t.acronym)}${t.name ? ` (${t.name})` : ''}${t.topic ? ` — ${t.topic}` : ''}`);
    });
  }
  if ((dossier.commonComorbidities || []).length) {
    lines.push(`  Common comorbidities to screen for: ${dossier.commonComorbidities.join(', ')}`);
  }
  if ((dossier.redFlags || []).length) {
    lines.push(`  Literature safety considerations (cover these in Section 8 "Safety Considerations Reported in Literature"):`);
    dossier.redFlags.forEach((r) => lines.push(`    - ${r}`));
  }
  if (dossier.notes) lines.push(`  Agent notes: ${dossier.notes}`);
  if (dossier.uncertainty != null && dossier.uncertainty >= 0.6) {
    lines.push(`  IMPORTANT: the dossier agent flagged HIGH UNCERTAINTY for this condition. Treat the dossier as a starting hypothesis, not fact. Prefer grounded evidence and explicitly disclose when you are relying on the dossier for a non-grounded claim.`);
  }
  return lines.join('\n') + '\n';
};

// Build a compact Claude-readable digest of the trials fan-out. We give
// Claude a ranked list of the TOP trials by category (recruiting, expanded
// access, OLE) so it can explicitly cover each section without blowing the
// token budget on hundreds of studies. Without this block the user gets a
// research answer that is silently blind to Expanded Access and OLE
// programs — which is exactly what they caught us missing.
const buildTrialsBlock = (trials) => {
  if (!trials) return '';
  const studies = Array.isArray(trials.studies) ? trials.studies : [];
  if (!studies.length) return '';

  const fmt = (s) => {
    const phase = (s.phases || []).join('/') || 'N/A';
    const loc = (s.contacts?.locations || []).slice(0, 2)
      .map((l) => [l.facility, l.city, l.country].filter(Boolean).join(', '))
      .join(' | ') || 'no sites listed';
    const centers = (s.topCenters || []).slice(0, 3).join('; ');
    const designations = [];
    if (s.designations?.fastTrack) designations.push('fast-track');
    if (s.designations?.breakthrough) designations.push('breakthrough');
    if (s.designations?.orphan) designations.push('orphan');
    if (s.designations?.hasExpandedAccess) designations.push('EXPANDED-ACCESS');
    if (s.designations?.hasOpenLabelExtension) designations.push('OPEN-LABEL-EXTENSION');
    if (s.designations?.hasPostTrialAccess) designations.push('post-trial-access');
    if (s.designations?.hasPayToAccess) designations.push('PAY-TO-ACCESS');
    return `  - ${s.nctId} · ${phase} · ${s.status} · ${s.briefTitle || '(untitled)'}
    Sponsor: ${s.sponsor || 'unknown'}${centers ? ` · Top centers: ${centers}` : ''}
    Sites: ${loc}${designations.length ? ` · Flags: ${designations.join(', ')}` : ''}
    Interventions: ${(s.interventions || []).slice(0, 3).map((i) => i.name).join(' | ') || '(none listed)'}
    URL: ${s.url}`;
  };

  // Same budget story as the grounding block: bigger trial lists chew
  // input tokens AND output tokens (Claude tries to discuss each).
  // 6 + 3 + 3 + 3 is enough to surface the most important programs in
  // each pathway while leaving Claude enough output budget to finish
  // sections 5-8.
  const recruiting = studies.filter((s) => s.acceptingNewPatients && !s.isExpandedAccessStudy && !s.designations?.hasOpenLabelExtension).slice(0, 6);
  const ea = studies.filter((s) => s.isExpandedAccessStudy === true).slice(0, 6);
  const ole = studies.filter((s) => s.designations?.hasOpenLabelExtension && !s.isExpandedAccessStudy).slice(0, 3);
  const topCenter = studies.filter((s) => s.hasTopCenter).slice(0, 3);

  const chunks = [];
  chunks.push(`LIVE CLINICAL TRIALS PULL (ClinicalTrials.gov, fanned across condition + synonyms + expanded-access studyType + OLE title search):
Breakdown: ${trials.breakdown ? JSON.stringify(trials.breakdown) : '(unknown)'}
Synonyms used: ${(trials.dossier?.synonyms || []).join(', ') || '(single term)'}
MeSH terms used: ${(trials.dossier?.meshTerms || []).join(', ') || '(none)'}`);

  if (recruiting.length) {
    chunks.push(`\nRECRUITING TRIALS (top ${recruiting.length} by promise score):\n${recruiting.map(fmt).join('\n\n')}`);
  }
  if (ea.length) {
    chunks.push(`\nEXPANDED ACCESS / COMPASSIONATE USE (${ea.length} CT.gov record(s) with studyType=EXPANDED_ACCESS — patients who don't qualify for a trial may still get the drug this way):\n${ea.map(fmt).join('\n\n')}`);
  } else {
    chunks.push(`\nEXPANDED ACCESS / COMPASSIONATE USE: **zero** CT.gov records with studyType=EXPANDED_ACCESS for this search. You MUST write exactly one sentence: "No Expanded Access / compassionate-use programs were found on ClinicalTrials.gov for this condition in this search." Do NOT list investigational drugs, pipeline drugs, or standard-of-care drugs in this section — they are NOT expanded access programs. Do NOT invent sponsor programs or URLs.`);
  }
  if (ole.length) {
    chunks.push(`\nOPEN-LABEL EXTENSION STUDIES (${ole.length} record(s) — for patients already in a prior trial):\n${ole.map(fmt).join('\n\n')}`);
  } else {
    chunks.push(`\nOPEN-LABEL EXTENSION STUDIES: none surfaced. Still mention in the answer that patients currently in Phase 2/3 trials should ask their PI whether an OLE is planned — most multi-year programs have one even before it lists on CT.gov.`);
  }
  if (topCenter.length) {
    chunks.push(`\nTRIALS AT TOP CENTERS (${topCenter.length}):\n${topCenter.map(fmt).join('\n\n')}`);
  }

  return chunks.join('\n') + '\n';
};

// Build a REQUIRED MENTIONS block from the KB's pipelineDrugs + excludedAgents.
// This is the anti-"AI slop" guardrail that prevents Claude from silently
// omitting drugs that matter. The evidence.js response carries these
// straight through from the curated KB; if the KB has no entry for this
// condition (which is fine for rare / uncurated diseases) the block is
// empty and the prompt behaves as before.
//
// We inject this into the system prompt for research + repurpose modes.
// After Claude answers, a coverage audit (scanForMissedPipelineDrugs,
// below) checks that every `name`/alias was actually mentioned and
// re-prompts Claude if any was missed.
const buildRequiredMentionsBlock = (evidence) => {
  const pipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  const excludedAgents = Array.isArray(evidence?.excludedAgents) ? evidence.excludedAgents : [];
  if (!pipelineDrugs.length && !excludedAgents.length) return '';

  // Tight one-liner per drug. We dropped the sponsor + PMID + DOI + whyItMatters
  // prose that was here before — it's already in the evidence pack below,
  // plus the KB-curated grounding block. What matters for the anti-omission
  // guardrail is the NAME, the aliases (so Claude doesn't skip by using a
  // different synonym), and the approval status (so Claude knows which
  // section to file it in). ~70% smaller than the previous block.
  // Cost cut 2026-04-23: saves ~600-900 input tokens per synthesis call.
  const drugLines = pipelineDrugs.map((d) => {
    const aliases = Array.isArray(d.aliases) && d.aliases.length ? ` (${d.aliases.join(' / ')})` : '';
    const status = d.approvalStatus ? ` — ${d.approvalStatus}` : '';
    return `- **${d.name}**${aliases}${status}`;
  }).join('\n');

  const excludedLines = excludedAgents.map((x) => `- **${x.name}** — ${x.reason}`).join('\n');

  return `=== REQUIRED MENTIONS (anti-omission guardrail) ===
Every pipeline drug below MUST appear by name (or listed alias) in your output. Approved agents belong in Section 3 ONLY — never in Pipeline Watch (Section 5). Investigational / not-yet-approved-for-this-condition agents belong in Section 4 or 5; discontinued/failed in Section 8.

PIPELINE DRUGS:
${drugLines || '- (none)'}

EXCLUDED AGENTS (mention ONLY in Section 8 — Safety Considerations — with the reason. NEVER output these as repurposing CANDIDATE blocks or as "drug ideas"):
${excludedLines || '- (none)'}

REPURPOSING RULE: Drugs listed under EXCLUDED AGENTS have already been studied for this condition and failed or harmed — do NOT include them in drug-repurposing output at all.

=== END REQUIRED MENTIONS ===
`;
};

// Investigational-only list for Section 5 Pipeline Watch (back half).
// Approved agents (olanzapine, cariprazine, Lybalvi, ECT, etc.) belong
// in Section 3 — never in "Drugs Still Being Tested".
const buildPipelineWatchBlock = (evidence) => {
  const pipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  const approved = (d) => /^approved/i.test(String(d.approvalStatus || ''));
  const investigational = pipelineDrugs.filter((d) => !approved(d));
  if (!investigational.length) return '';

  const lines = investigational.map((d) => {
    const aliases = Array.isArray(d.aliases) && d.aliases.length ? ` (${d.aliases.join(' / ')})` : '';
    const bits = [d.status, d.mechanism, d.nct ? `NCT ${d.nct}` : null, d.pmid ? `PMID ${d.pmid}` : null]
      .filter(Boolean)
      .join(' · ');
    return `- **${d.name}**${aliases}: ${bits || d.whyItMatters || 'investigational'}`;
  }).join('\n');

  return `=== PIPELINE WATCH — INVESTIGATIONAL ONLY (Section 5 table) ===
Put ONLY these agents in the "Pipeline Watch" table. Every drug already FDA-approved for this condition (including olanzapine, quetiapine, lithium, cariprazine/Vraylar, aripiprazole LAI, Lybalvi, lumateperone/Caplyta, lurasidone, etc.) belongs in Section 3 Approved Treatments — NEVER repeat them here. ECT is an approved procedure → Section 6, not Pipeline Watch.

${lines}

=== END PIPELINE WATCH ===`;
};

const buildCanonicalFactsBlock = (evidence) => {
  const facts = Array.isArray(evidence?.canonicalFacts) ? evidence.canonicalFacts : [];
  if (!facts.length) return '';
  const lines = facts.map((f) => `- ${f.claim || String(f)}`).join('\n');
  return `=== CANONICAL FACTS (curated ground truth — NEVER contradict these) ===
${lines}
=== END CANONICAL FACTS ===`;
};

// Chat must be grounded like research/repurpose — not a generic ChatGPT clone.
const chatGroundingRules = (condition) => `
=== CHAT GROUNDING RULES (violations embarrass clinicians — treat as hard failures) ===

1. **CITE FROM THE EVIDENCE PACK + CANONICAL FACTS + REQUIRED MENTIONS + PRIOR ANALYSES ONLY.**
   Do NOT answer from unconstrained "general medical knowledge" or training-data recall.
   If the pack does not support a claim, say "I don't have a grounded source for that in this session" — do NOT invent.

2. **NEVER call an investigational, failed, offshore, or non-FDA-approved therapy the "gold standard" or "standard of care" for this condition.**
   Gold standard / first-line = ONLY drugs marked **approved** in REQUIRED MENTIONS or explicitly in canonical facts for THIS condition.
   WORKED EXAMPLE — IPF: approved antifibrotics are pirfenidone (Esbriet), nintedanib (Ofev), and nerandomilast (Jascayd, FDA 2025).
   CAR-T, CAR cell therapy, and stem-cell / MSC "regenerative" clinics are **NOT** approved for IPF, are **NOT** gold standard, and early trials showed no proven efficacy.
   If the user asks about them, say they are investigational or warned-against — not standard treatment.

3. **"Why wasn't [drug X] mentioned?"** — follow this protocol exactly:
   (a) Search PRIOR ANALYSES for X by name and aliases.
   (b) Search REQUIRED MENTIONS pipeline drugs for X.
   (c) Search the GROUNDED EVIDENCE PACK for X.
   Then answer honestly:
   - If X is **approved** for this condition but missing from the prior report → "That was an omission in the earlier report. Here is what the literature shows: …" and give a proper summary with links from the pack.
   - If X is **investigational / failed / discontinued** → state status clearly; do NOT upsell it as standard care.
   - If X is **for a different disease** (e.g. CAR-T for lupus or lymphoma, not IPF) → say so plainly: "CAR-T is studied in [other conditions], not as standard IPF treatment."
   - If X is **offshore stem-cell / clinic marketing** → cite safety warnings from the pack; not peer-reviewed standard care.

4. **Do not conflate diseases.** Only discuss therapies approved or in trials **for the patient's condition (${condition})**. A therapy famous in another field is not automatically relevant.

5. Every drug name, trial, and center must link per citation rules when making factual claims.

6. Still ANSWER on the first turn — but answer **from the pack**, not from memory. Short honest "not in our sources for this condition" beats a confident wrong lecture.
`;

// Supplement candidates come from live gather via buildSupplementDiscoveryBlock(evidence).

// Post-synthesis coverage audit. Scans the Claude output text for every
// pipelineDrug name + its aliases. Returns the list of drugs whose name
// was NOT found in the output, so the caller can force a rewrite. Simple
// case-insensitive substring search is enough — we don't care about
// morphology, only whether the drug was mentioned AT ALL.
const scanForMissedPipelineDrugs = (claudeText, pipelineDrugs) => {
  if (!claudeText || !Array.isArray(pipelineDrugs) || !pipelineDrugs.length) return [];
  const lower = claudeText.toLowerCase();
  const missed = [];
  for (const drug of pipelineDrugs) {
    const candidates = [drug.name, ...(Array.isArray(drug.aliases) ? drug.aliases : [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    const found = candidates.some((n) => lower.includes(n));
    if (!found) missed.push(drug);
  }
  return missed;
};

// Remove CANDIDATE blocks and prose lines for KB excluded / already-studied drugs (e.g. metformin in IPF).
// Implemented in lib/report-polish.js — filterExcludedAgentMentions imported above.

// Build a deterministic "Agents Evaluated" transparency block that gets
// appended to every research + repurpose synthesis. This is the methodology-
// visibility requirement: the user can see, explicitly, which agents were
// in the consideration set and whether they made it into the analysis.
// The LLM cannot silently drop a drug — if one is in pipelineDrugs but
// missing from the analysis text, this block will say so.
const buildAgentsEvaluatedBlock = (claudeText, evidence) => {
  const pipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  const excludedAgents = Array.isArray(evidence?.excludedAgents) ? evidence.excludedAgents : [];
  if (!pipelineDrugs.length && !excludedAgents.length) return '';

  const lower = (claudeText || '').toLowerCase();
  const evaluated = pipelineDrugs.map((d) => {
    const candidates = [d.name, ...(Array.isArray(d.aliases) ? d.aliases : [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    const found = candidates.some((n) => lower.includes(n));
    const status = d.approvalStatus || 'investigational';
    return `- **${d.name}** — ${status}${d.status ? ` · ${d.status}` : ''}${found ? ' · ✓ discussed above' : ' · **NOT DISCUSSED** in this analysis'}`;
  }).join('\n');

  const excluded = excludedAgents.map((x) => `- **${x.name}** — ${x.reason}`).join('\n');

  return `\n\n---\n\n## Medicines we checked for this condition\n\nThese are the medicines we made sure to look up for this condition. "Pipeline drugs" are medicines that are either already approved or still being developed and tested — the ones doctors and researchers are watching most closely. If something is marked "NOT DISCUSSED" above, it means the research we found did not support it for this person's situation.\n\n### Pipeline drugs (approved, in late-stage testing, or important to watch)\n${evaluated || '_(none on our watch list for this condition yet)_'}\n\n### Medicines considered and set aside\n${excluded || '_(none)_'}\n`;
};

const buildGroundingBlock = (evidence, opts = {}) => {
  if (!evidence) return '';
  const limit = opts.limit ?? 6;
  const excerpt = opts.excerpt ?? 2000;
  // Repurpose mode needs more papers so each candidate can cite real URLs.
  const items = (evidence.groundedForPrompt || []).slice(0, limit);
  if (!items.length) return '';
  const packed = items.map((it, i) => {
    const tierLabel = it.tier ? ` [TIER ${it.tier}]` : '';
    const oa = it.openAccess ? ' [OPEN ACCESS]' : '';
    // Access level is the single most important disclosure — Claude must
    // never claim details from a paper beyond what is visible in the excerpt.
    const access =
      it.accessLevel === 'full-text' ? ' [FULL-TEXT]'
      : it.accessLevel === 'abstract' ? ' [ABSTRACT-ONLY]'
      : ' [METADATA-ONLY]';
    // Curated KB items are hand-picked landmark references for this disease
    // (guidelines, defining RCTs, FDA labels). Tag them distinctly so Claude
    // knows these are the canonical ground-truth floor.
    const kbTag = it.isCuratedKB
      ? ` [CURATED KB${it.kbCategory ? ` · ${it.kbCategory.toUpperCase()}` : ''}]`
      : '';
    // Live-web freshness items are recent leads, not verified peer review.
    const webTag = it.isWebSearch ? ' [WEB SOURCE — recent, verify before trusting]' : '';
    // Quality signals — render the two most important positive and negative
    // flags inline so Claude weights the source appropriately when citing.
    const qualityTags = [];
    if (it.isMetaAnalysis) qualityTags.push('META-ANALYSIS');
    else if (it.isSystematicReview) qualityTags.push('SYSTEMATIC-REVIEW');
    else if (it.isRCT) qualityTags.push('RCT');
    if (it.isPreprint) qualityTags.push('PREPRINT-NOT-PEER-REVIEWED');
    // (First-author-country integrity flag removed 2026-04 per product
    // decision; we no longer down-weight literature based on author
    // country. Retraction + predatory-publisher flags still apply.)
    const qTag = qualityTags.length ? ` [${qualityTags.join(' · ')}]` : '';
    const src = (it.sources || []).join('+');
    const pubLine = it.publisher ? ` · Publisher: ${it.publisher}` : '';
    const countryLine = it.firstAuthorCountry ? ` · 1st-author country: ${it.firstAuthorCountry}` : '';
    return `[#${i + 1}]${kbTag}${webTag}${tierLabel}${access}${oa}${qTag} ${it.title || '(no title)'}
      Journal: ${it.journal || '?'}${pubLine} · Year: ${it.year || '?'} · Sources: ${src} · Citations: ${it.citations || 0}${countryLine}
      URL: ${it.url || '(no URL)'}
      Content: ${(it.text || '').slice(0, excerpt) || '(no text available — metadata only; you may name this paper but MUST NOT claim anything about its results, methods, or conclusions)'}`;
  }).join('\n\n');

  const fdaBits = [];
  (evidence.fdaLabels || []).forEach((f) => {
    if (!f.label) return;
    fdaBits.push(
      `FDA LABEL · ${f.drug || (f.label.genericName || []).join(', ')}
      Indications: ${(f.label.indications || '').slice(0, 900)}
      Warnings: ${(f.label.warnings || '').slice(0, 900)}
      Contraindications: ${(f.label.contraindications || '').slice(0, 600)}
      Drug interactions: ${(f.label.drugInteractions || '').slice(0, 900)}
      Top FAERS reactions: ${(f.topAdverseEvents || []).map((e) => `${e.reaction} (${e.reports})`).join(', ')}
      Source: ${f.label.url}`
    );
  });
  (evidence.fdaManufacturers || []).forEach((m) => {
    if (!m.enforcementActions?.length) return;
    fdaBits.push(
      `FDA ENFORCEMENT · manufacturer ${m.manufacturer}
      Actions: ${m.enforcementActions.slice(0, 6).map((a) => `${a.recallInitiationDate} Class ${a.classification}: ${a.reason}`).join(' | ')}`
    );
  });

  // Curated knowledge base context block — canonical facts, lifestyle, and
  // red-flag contraindications for this disease, from the hand-curated KB.
  const kb = evidence.knowledgeBase;
  let kbBlock = '';
  if (kb && kb.matched) {
    const facts = (kb.canonicalFacts || []).slice(0, 15);
    const lifestyle = (kb.lifestyleRecommendations || []).slice(0, 10);
    const redFlags = (kb.redFlags || []).slice(0, 10);
    kbBlock = `CURATED KNOWLEDGE BASE — ${kb.condition} (v${kb.version || '?'}, ${kb.itemCount} pinned references)
The evidence items tagged [CURATED KB] below are hand-picked landmark references for this specific disease. They are the canonical ground-truth floor; every query on this condition always sees them. Live-fetched items ([PubMed], [EuropePMC], etc.) supplement them.

CANONICAL FACTS (hand-reviewed, each backed by at least one KB item):
${facts.map((f, i) => `  - ${f.claim}  [refs: ${(f.evidenceRefs || []).join(', ')}]`).join('\n') || '  (none)'}

LIFESTYLE / NON-DRUG GUIDANCE:
${lifestyle.map((l) => `  - ${l.recommendation}`).join('\n') || '  (none)'}

LITERATURE SAFETY CONSIDERATIONS (established concerns from guidelines/trials — report as cited evidence for physician discussion; NEVER as directives like "do not take"):
${redFlags.map((r) => `  - ${r}`).join('\n') || '  (none)'}

Use these canonical facts and safety considerations as your backbone. Live evidence supplements them. If a live item contradicts a canonical fact, say so explicitly and weigh the quality of each.
`;
  }

  // Quality-exclusion summary — tell Claude what we already filtered OUT so
  // it doesn't cite papers we pulled out of the pool and doesn't try to
  // compensate by naming known-retracted titles from general knowledge.
  const qb = evidence.qualityBreakdown;
  let qualityNoteBlock = '';
  if (qb) {
    const bits = [];
    if (qb.retractedExcluded > 0) {
      bits.push(`${qb.retractedExcluded} retracted paper(s) were FOUND in the initial pool and EXCLUDED from this pack. Do not cite these titles from memory: ${qb.retractedTitles.map((r) => `"${(r.title || '').slice(0, 80)}"`).join('; ')}.`);
    }
    if (qb.predatoryExcluded > 0) {
      bits.push(`${qb.predatoryExcluded} paper(s) from publishers with documented integrity concerns were filtered from this prompt pack.`);
    }
    if (qb.preprintsInPool > 0) {
      bits.push(`${qb.preprintsInPool} preprint(s) are still present but tagged — flag them to the user as "preprint, not peer-reviewed".`);
    }
    bits.push(`Items tagged [WEB SOURCE — recent, verify before trusting] came from a live web search (Perplexity) to catch very recent approvals / trials / negative findings. Treat them as RECENCY LEADS: you may surface them so the user knows about new developments, but (a) prefer a peer-reviewed item when one covers the same fact, (b) explicitly say the item is from a live web search and should be confirmed, and (c) never cite a web-source item as the SOLE evidence for a safety-critical claim. Always include the URL.`);
    if (qb.countryConcernInPromptPack > 0) {
      bits.push(`${qb.countryConcernInPromptPack} of the items below have a first author from a jurisdiction with documented systemic research-integrity concerns (CN, RU, IR, PK, IN, VN). They carry a "FIRST-AUTHOR-*-INTEGRITY-CONCERN" tag. You may still cite them, but: (a) prefer equivalent Western-origin evidence when available, (b) when you do cite them, explicitly note the origin in the text of your answer, and (c) never cite them as the SOLE evidence for a safety-critical claim.`);
    }
    if (bits.length) qualityNoteBlock = `SOURCE-QUALITY NOTES FOR THIS PACK:\n${bits.map((b) => `- ${b}`).join('\n')}\n\n`;
  }

  return `GROUNDED EVIDENCE PACK (internal — cite only from this list; NEVER echo this header or the phrase "grounded evidence pack" in your output). If a claim is not supported by one of these items, OMIT the claim or use plain English for the reader (e.g. "Published rates vary by region."). Do NOT write "No grounded evidence in pack".

${kbBlock}

${qualityNoteBlock}CITATION ACCESS RULES (strict — many medical journals are paywalled and we deliberately only pull what is legal to share):
- Each item is tagged [FULL-TEXT], [ABSTRACT-ONLY], or [METADATA-ONLY] to tell you exactly how much of it you have read.
- Items also tagged [CURATED KB] are hand-curated landmark references — prefer them when the topic is directly covered.
- [FULL-TEXT] items: you may cite methods, results, secondary endpoints, subgroups, adverse events, and figures, because you actually have the body text.
- [ABSTRACT-ONLY] items: you may ONLY cite things that literally appear in the Content field (which is the peer-reviewed abstract or, for KB items, editor summary + verbatim passages). You may NOT claim anything about sub-group analyses, exact adverse-event frequencies beyond what the abstract states, study methods beyond what the abstract states, or any detail that requires having read the full paper.
- [METADATA-ONLY] items: you may NAME the paper and reference it as "peer-reviewed source exists (abstract/full text unavailable in this pack)" but you may NOT claim anything about its findings.
- In EVERY citation you write, include the URL and a verbatim quoted passage when available. Do NOT append [FULL-TEXT]/[ABSTRACT-ONLY]/[METADATA-ONLY] tags in patient-facing output — those are internal only.
- When the Content shows an "Editor's summary", treat that as context — do not quote it as if it were from the paper. Quote only "Verbatim passage" blocks verbatim, or abstract text for live items.
- When you quote, copy the text verbatim from the Content field below and include the URL.

SOURCE-QUALITY PRIORITY ORDER (use this when two items conflict):
  1. [CURATED KB] items (hand-curated landmark refs for this disease)
  2. Cochrane Systematic Reviews + [META-ANALYSIS]
  3. [SYSTEMATIC-REVIEW] + [RCT] in A+ / A tier journals
  4. Observational / cohort studies in A+ / A tier journals
  5. [RCT] / [META-ANALYSIS] in B tier journals
  6. Anything else peer-reviewed
  7. [PREPRINT-NOT-PEER-REVIEWED] items (only cite as supplementary, flag explicitly)
  Items carrying FIRST-AUTHOR-*-INTEGRITY-CONCERN drop one tier in this order.

${packed}

${fdaBits.join('\n\n')}`;
};

const buildPatientContext = (p = {}) => {
  const lines = [];
  if (p.condition) lines.push(`PRIMARY CONDITION TO RESEARCH: ${p.condition}${p.stage ? ` (stage: ${p.stage})` : ''}`);
  if (p.age) lines.push(`Age: ${p.age}`);
  if (p.gender) lines.push(`Gender: ${p.gender}`);
  if (p.weight) lines.push(`Weight: ${p.weight}`);
  if (p.smoking) lines.push(`Smoking history: ${p.smoking}`);
  if (p.exercise) lines.push(`Exercise / activity: ${p.exercise}`);
  if (p.diagnoses) lines.push(`ALL current diagnoses (do NOT research these unless relevant for interactions): ${p.diagnoses}`);
  if (p.medications) lines.push(`Current medications (check every recommendation for interaction/contraindication): ${p.medications}`);
  if (p.symptoms) lines.push(`Current symptoms: ${p.symptoms}`);
  if (p.labWork) lines.push(`Lab work / pulmonary function / other studies: ${p.labWork}`);
  if (p.scans) lines.push(`Recent imaging / scans: ${p.scans}`);
  // Genetic variant — critical for gene-therapy eligibility. We label it
  // CONFIRMED GENETIC MUTATION/VARIANT and instruct the model to filter
  // gene-targeted therapies by this variant explicitly. Without this the
  // model has historically suggested e.g. Luxturna (RPE65-only) for an
  // RP patient who actually carries USH2A — wrong eligibility, wasted
  // hope. This block tells the model: if a gene therapy targets a
  // different gene, say so out loud and don't recommend it.
  if (p.geneticVariant) {
    lines.push(`CONFIRMED GENETIC MUTATION / VARIANT (use this to gate gene-therapy and gene-targeted small-molecule recommendations): ${p.geneticVariant}
  → For EVERY gene-targeted therapy you mention, you MUST explicitly check whether the therapy targets the SAME gene as the patient's variant. If yes, call out the eligibility match. If no, write "NOT ELIGIBLE — therapy targets <other gene>, patient carries <patient's gene>." Do not silently recommend gene therapies for the wrong gene.`);
  }
  if (p.caregiverContext) {
    lines.push(`CAREGIVER CONTEXT: ${p.caregiverContext} — tailor answers to the person being cared for, not the person typing.`);
  }
  return lines.length ? lines.join('\n') : 'No patient context provided.';
};

const audienceLine = (audience) =>
  audience === 'medical'
    ? 'AUDIENCE: Medical professional. Use precise clinical terminology, include pharmacology, dosing, and mechanism where relevant.'
    : `AUDIENCE: Non-medical reader at a 7th-grade reading level. This output will be read by patients and caregivers with NO medical training. Imagine the reader finished about 7 years of school. If a 12-year-old could not follow a sentence, rewrite it.

LAYPERSON RULES (mandatory — violations are failures):
- WRITE EVERYTHING AT A 7TH-GRADE READING LEVEL. This applies to ALL output: section headings, table cells, bullets, and every structured card field (WHAT_IT_DOES, WHY_FOR_THIS_CONDITION, MECHANISM_TARGET, RATIONALE, SUMMARY, RISKS, etc.).
- Use short sentences (aim for 15 words or fewer). One idea per sentence. Break long sentences into two.
- Use common, everyday words. Say "how well it works" not "efficacy", "side effect" not "adverse event", "reason not to use it" not "contraindication", "other health condition" not "comorbidity", "how it works in the body" not "mechanism" or "pathway", "what goes wrong in the body" not "pathophysiology", "still being tested" not "investigational", "key study" not "pivotal trial", "slowly adjust the dose" not "titrate", "reduce" not "mitigate", "trusted" or "main" not "canonical", "slows scarring" not "antifibrotic".
- Write like you're explaining to a smart friend who is NOT in medicine. No "graduate seminar" tone.
- Every drug card MUST start with WHAT_IT_DOES in one plain sentence anyone can understand.
- NEVER use a medical or technical term without a short plain-English definition in parentheses the FIRST time it appears, in the same sentence. This covers Latin and clinical jargon (mTOR, autophagy, pericellular, analogs, pathway, inducer, fibrosis cascade, etc.).
  Example: "autophagy (your cells' built-in cleanup system)" NOT bare "autophagy". Example: "antifibrotic (a drug that slows lung scarring)".
- If you cannot define a term simply, drop the term and just describe what it does in plain words.
- MECHANISM_TARGET and REPURPOSE_RATIONALE must use everyday words first; technical terms only in parentheses after the plain explanation.
- No dense paragraph blocks. Prefer short bullets over long paragraphs.
- Headings must be plain too. Do NOT use headings like "potential unexplored drug categories" — say "Drugs not yet studied for this condition" or "Ideas from biology (not yet tested in people)".`;

const laypersonRepurposeExtra = (audience) =>
  audience === 'medical' ? '' : `

REPURPOSE LAYPERSON FORMAT (when AUDIENCE is non-medical — keep every field at a 7th-grade reading level, short sentences, common words, and define any medical term in parentheses the first time):
- WHAT_IT_DOES is REQUIRED for every CANDIDATE — one sentence: what the drug is normally used for + what it does in the body in plain English.
- WHY_FOR_THIS_CONDITION is REQUIRED — one plain sentence: "This might help [condition] because …" using everyday words only.
- MECHANISM_TARGET must be a plain-English phrase (≤12 words), e.g. "Slows lung scarring signals" — NOT "TGF-β signalling" alone.
- REPURPOSE_RATIONALE must be exactly 2 short bullets in plain text (use "•" bullets) — skip the third unless essential.
- REFERENCES is REQUIRED — at least one clickable markdown link [short title](url) per candidate from the evidence pack. No candidate may ship without a link.
- HOW_TO_DISCUSS_WITH_DOCTOR: **one** question the patient can read aloud — not a paragraph.
- SUPPORTING_EVIDENCE: max 2 sentences or one short quote — no literature review.
- Every field ≤25 words unless quoting a source.`;

// Build the per-request dynamic header that is NEVER cached (it's different
// on every call: audience, patient profile, condition-specific context).
// Paired with the mode's *_STATIC scaffolding which IS cached. This is the
// Anthropic prompt-caching split — static scaffold gets `cache_control:
// ephemeral` and is served at 10% of the input-token price on cache hits.
const buildDynamicHeader = (patient, audience, mode) => `${audienceLine(audience)}${mode === 'repurpose' ? laypersonRepurposeExtra(audience) : ''}

PATIENT PROFILE:
${buildPatientContext(patient)}`;

const SHARED_GUARDRAILS = `
CITATION RULES (absolute — the single biggest failure mode of AI in medical research is hallucinated citations):
- CITE ONLY FROM THE GROUNDED EVIDENCE PACK provided below. Do not invent, paraphrase-without-URL, or cite from general knowledge.
- Every factual claim about efficacy, safety, interactions, or outcomes MUST reference at least one evidence-pack item by its number (e.g. "[#3]") and include a verbatim quoted passage from that item's Content AND a clickable markdown link: [short title](url).
- EVERY named entity MUST be a clickable markdown link — no exceptions. This includes treatments, drugs, trials, papers, guidelines, AND non-paper entities: hospitals/centers, clinics, advocacy organizations, patient registries, government bodies (FDA, NIH), and named physicians/experts. The client's hard requirement is "links to everything" — a named entity rendered as plain or bold-only text is a failure.
- LINK SOURCE PRIORITY (use the first that applies, never invent a deep link to fake a citation):
  1. If a URL for the entity exists in the evidence pack or trials pull, use that exact URL.
  2. Trials → [NCT… ](https://clinicaltrials.gov/study/NCT01234567); if no NCT, link a ClinicalTrials.gov search: https://clinicaltrials.gov/search?term=<url-encoded terms>.
  3. Drugs → FDA label on DailyMed search (https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=<drug>) or a PubMed search; guidelines → the issuing society's guideline page if you are certain of it, else a PubMed search (https://pubmed.ncbi.nlm.nih.gov/?term=<url-encoded>).
  4. Centers/clinics/advocacy orgs/registries/experts → the entity's official website ONLY if you are confident of the exact URL; otherwise link a Google search (https://www.google.com/search?q=<url-encoded name>). A search link is always acceptable and is preferred over guessing a specific page.
- NEVER fabricate a specific paper URL, DOI, PMID, or deep link to manufacture a citation. For grounded CLAIMS the link must come from the evidence pack (rule above); the search-URL fallback is ONLY for naming/navigation of non-claim entities.
- Bare URLs are acceptable only if markdown link syntax is impossible; prefer [title](url) always.
- If the evidence pack does not support a claim, OMIT it or use plain English ("Published figures vary — ask your doctor for local rates."). NEVER write "No grounded evidence in pack" or other internal pipeline phrases.
- Prefer A+ and A tier journals (NEJM, Lancet, JAMA, BMJ, Nature Medicine, Cochrane, ERJ, AJRCCM, Thorax, Chest) over B/C.
- Weight evidence on METHODOLOGICAL grounds (RCT > observational > case report; meta-analysis > single study; larger n > smaller n; registered + pre-registered > not). Do NOT down-weight or up-weight by country of origin — a well-conducted RCT from any country is a well-conducted RCT.

ACCESS-LEVEL HONESTY (critical — many high-impact medical journals are paywalled):
- Every evidence item has an internal [ACCESS] tag: [FULL-TEXT], [ABSTRACT-ONLY], or [METADATA-ONLY]. These tags are for YOU only — do NOT print [ABSTRACT-ONLY] etc. in the patient-facing report.
- For abstract-only papers: you may cite what the abstract literally says. You may NOT invent numeric values, methodological details, subgroup outcomes, or adverse-event frequencies that are not in the abstract text.
- For metadata-only papers: you may name the paper but you must NOT claim what it found. Say "a peer-reviewed paper exists but the full study was not available to us."
- If a claim cannot be supported without overreaching past abstract content, state the limitation in plain English: "Based on the study summary; the full methods/results were not accessible."

READER-FACING LANGUAGE (critical — demo / lawyer audience):
- NEVER expose internal terms to the reader: "grounded evidence", "evidence pack", "dossier", "dossier source", "confirmed against grounded evidence", "uncertainty score", or similar.
- Centers, experts, and advocacy orgs should read like a normal medical report — no mention of where the list came from internally.
- NEVER write "Note on patient profile", "the dossier flags X but the profile says Y", or reconcile sex/condition mismatches in the report. The pipeline guarantees profile and dossier align — treat PRIMARY CONDITION and dossier canonical as authoritative; do not invent mismatch disclaimers.

LANGUAGE TONE (critical — legal/educational framing):
- This tool is educational decision-support, NOT medical advice or a prescription service.
- NEVER give personal opinion: ban "I think", "I believe", "in my opinion", "I recommend", "you should", "best choice for you".
- NEVER use imperative directives to patients: "do not take", "avoid", "stop", "DO NOT DO THIS", "you must not".
- Instead use literature-framed language: "Research suggests…", "Studies report…", "Literature reports…", "Physicians often caution against…", "Evidence suggests caution regarding…", "Discuss with your physician before considering…", "Guidelines generally do not recommend…".
- Safety information must be preserved and cited — reframe it, do not delete it.

PATIENT-SPECIFIC SAFETY (critical):
- When discussing any drug, check the patient's current medication list for interactions and contraindications. Name the specific interaction and severity.
- Consider age, comorbidities, labs/PFTs, and scans when assessing suitability.
- Note treatments that literature or guidelines flag as concerning for this specific patient profile, even if effective in the general population — frame as "worth discussing with your physician."

GEOGRAPHIC / SOURCING RULES:
- For stem cell therapies, clinics in China, Vietnam, Mexico, or India must be excluded unless explicitly requested. Prefer US/Western Europe clinics whose source lab has no active FDA warning letter.
- For each stem cell treatment, state: cell type (e.g. cord blood MSCs, exosomes from MSCs, autologous adipose), source lab, delivery route (IV, nebulized/inhaled, intratracheal, intrathecal, local), dose, and whether any peer-reviewed data supports the specific product.
- Do not rely on a clinic's own advertising or press releases.

DISCLAIMERS:
- This is educational decision-support research, not medical advice. Final choices require a licensed physician.
`;

// Formatting rules that apply to EVERY section. Pulled out so the user's
// explicit complaint ("all the unecessary **** ****, make it bold or
// underlines things or bullet them") has a single, enforced source of truth.
const FORMATTING_RULES = `
OUTPUT FORMATTING RULES (enforce strictly — the user has explicitly complained about wall-of-text):
- Use MARKDOWN with headings (##, ###), bullets, and **bold** for key terms.
- **Bold every** drug name, trial acronym, NCT ID, percentage, dose, phone number, physician name, and center name.
- NO paragraphs longer than 3 lines. Break them into bullets.
- When comparing ≥3 items, USE A MARKDOWN TABLE, not prose.
- No filler words ("Furthermore", "Additionally", "It is worth noting that", "In conclusion"). Every sentence either gives a fact, a number, a name, or an action the patient can take.
- STRATEGIC BREVITY (critical): Lead with the decision-relevant fact. One sentence beats three. Cut repetition across sections — if a drug appears in Section 3, do not re-explain it in Section 5. Prefer tables and bullets over prose. When in doubt, shorter.
- Every URL MUST be a real clickable markdown link: [PANTHER-IPF trial (NEJM 2012)](https://pubmed.ncbi.nlm.nih.gov/...) or [NCT01234567](https://clinicaltrials.gov/study/NCT01234567).
- LINKS TO EVERYTHING (client's hard requirement): every named entity in prose, bullets, AND tables must carry an inline clickable link — drugs, trials, papers, guidelines, AND centers/hospitals, clinics, advocacy orgs, registries, FDA/NIH, and named experts. Follow the LINK SOURCE PRIORITY in the citation rules (pack URL first; ClinicalTrials.gov / DailyMed / PubMed canonical or search URLs; official site or a Google search for centers/orgs/experts). A search link is acceptable; dead text is not.
- In markdown tables, the entity cell must contain the link itself, e.g. | [Pirfenidone](url) | … |.
- For every card (treatment / trial / candidate), use the exact fixed-field structure. Do not add prose between fields.
`;

// Front-half sections (1-3): condition snapshot, centers & experts,
// approved treatments (UI-parsed cards). These are the "here is your
// disease and what's available for it today" sections.
// (Section 4 — clinical trials & access programs — was moved to the
// BACK half because bundling trial sub-tables with 5 treatment cards
// kept blowing through max_tokens; BACK had 1000 tokens of headroom
// to absorb it.)
//
// Split into STATIC (cacheable) and a dynamic header built per-request
// so we can attach `cache_control: { type: 'ephemeral' }` to the big
// static block. Cost cut 2026-04-23: Anthropic prompt caching serves
// cached input tokens at 10% of the normal rate, so repeat runs on
// the same mode/half cost ~$0.006 instead of ~$0.06 for the static
// part. Break-even is 1 cache hit within 5 minutes.
const RESEARCH_PROMPT_FRONT_STATIC = `You are a comprehensive medical research assistant. Produce SECTIONS 1-3 of a structured analysis for the patient's primary condition. Sections 4-8 will be produced by a separate call — do NOT write them now.

LENGTH BUDGET (HARD RULE — this call has ~2,400 output tokens across 3 sections):
- Target ~800 output tokens (~600 words) per section on average.
- Dense bullets / tables. No paragraphs longer than 2 lines. No filler.
- YOU MUST FINISH ALL 3 SECTIONS. If running long, shorten sections 1–2 — NEVER drop an FDA-approved drug from Section 3 to save space.

Your output MUST include the following 3 sections IN THIS ORDER, and nothing else. Do NOT add sections 4-8 — a separate call handles those.

## 1. Condition Snapshot
- One-sentence definition.
- Prevalence / incidence if you have a cited source with a number; otherwise one plain sentence ("Affects roughly X people" or "Relatively rare — exact rates vary by region") — never write "no grounded prevalence".
- Typical trajectory if untreated.
- Primary medical specialty + one or two named top experts (with links). These are the report's headline experts — do NOT repeat the same people in Section 2's named-experts list; Section 2 should name DIFFERENT experts.
- **If patient geneticVariant / gene is provided:** name the gene, inheritance pattern if known, and whether approved gene therapies (e.g. Luxturna for RPE65, CRISPR trials) apply ONLY to that mutation — never imply one drug covers all genetic forms of the disease.
- **Lifestyle & environment (from dossier lifestyleCategories + KB lifestyleRecommendations):** 3-6 bullets framed as "Research suggests…" / "Studies report…" (e.g. IPF → GERD management, feather pillows/bird exposure, pulm rehab; RP → UV protection). Every bullet needs a clickable link from the evidence pack when possible.
- **Key safety flags (top 3 redFlags from dossier/KB):** literature-framed cautions with links — NOT patient directives.

## 2. Top Centers & Experts Worldwide
Use the intake context and evidence below as your starting list; add or correct from peer-reviewed sources. Present as a markdown table (no internal labels like "dossier" or "confirmed against grounded evidence"):

| Center | City | URL / Phone | Why it leads |
|---|---|---|---|

CENTER-LINK RULE (this table only): link each center to its OFFICIAL institutional website (e.g. [MHH Hannover](https://www.mhh.de)) ONLY when you are confident of the exact domain. If you are NOT confident of the real institutional URL, leave the center name as PLAIN TEXT — do NOT insert a "https://www.google.com/search?q=…" placeholder link in this table. A real link or none; never a search-engine placeholder for a named center here.

Then list 3–5 individual **named experts** with affiliations. Peer-recognised only — no clinic self-advertising. DE-DUPLICATE ACROSS SECTIONS: any expert you already named in Section 1 must NOT be repeated in this list — each named expert appears exactly once in the whole report. Pick different experts here, or note "(see Section 1)" rather than re-listing the same person.

## 3. Approved Treatments (Backed by Research)
Include **every** drug the KB / REQUIRED MENTIONS marks as **approved** for this condition (e.g. IPF: nerandomilast/Jascayd, pirfenidone/Esbriet, AND nintedanib/Ofev — all three cards, not just the newest). One card per approved drug. Quality over quantity for off-label extras — see FDA-STATUS HONESTY RULE; do NOT pad with supplements.

DRUG-APPROVAL RECENCY RULE (critical — your training data may be out of date):
- The curated knowledge base and evidence pack below are kept CURRENT and may be NEWER than your training cutoff. If a drug is marked "approved" in the REQUIRED MENTIONS list or the grounded evidence/FDA-label items, treat it as APPROVED and put it in this section — even if your own training data says it is investigational, "in trials", or "not yet approved". Never override the KB's approval status with older internal knowledge.
- ORDER: list the MOST RECENTLY APPROVED / newest-mechanism drug FIRST when the evidence shows it is approved and effective, then the older approved drugs. Do not bury a newer approved drug beneath older ones.
- Every drug the KB marks "approved" for this condition MUST appear here as its own card.
- When you include an OLDER drug, be honest about why a newer option may be preferred (e.g. more side effects, older mechanism) in its RISKS/EFFICACY lines — do not present an older drug as the single best choice if a newer approved drug exists.

FDA-STATUS HONESTY RULE (critical — NEVER imply a drug is approved when it is not):
- This section is titled "Approved Treatments." A treatment counts as APPROVED only if it is FDA-approved FOR THIS CONDITION (or the KB marks it approved for this condition). Approved drugs MUST be listed FIRST.
- Supplements, vitamins, and off-label or investigational drugs (e.g. N-acetylcysteine / NAC, vitamin A, metformin) are NOT approved treatments. Do NOT present them as approved. If one is genuinely important enough to include, you MUST (a) place it AFTER every approved drug, and (b) start its TREATMENT line with a plain flag a 7th grader understands, e.g. "NOT FDA-approved for this condition — sold as a supplement" or "NOT FDA-approved for this condition — used off-label" or "Still in trials — not approved yet". Never use wording that suggests approval.
- Set FDA_STATUS accurately on EVERY card. Whenever FDA_STATUS is anything other than "approved", the card's own text must read as clearly NOT-approved.
- If this condition has only one or two genuinely approved drugs, that is the honest answer — list just those. It is FINE for this section to be short. Do NOT inflate it with supplements or off-label drugs dressed up as approved options.

Ranked as above. For EACH output this EXACT card structure (the UI parses these fields):

PROVIDER: <doctor / clinic / manufacturer with phone or URL>
TREATMENT: <drug / biologic / device / surgery; include dose, strength, route>
FDA_STATUS: <approved | off-label | investigational | expanded access | compassionate use | not FDA regulated>
LENGTH_FREQUENCY: <duration + frequency>
EFFICACY: <1-100>% — <one-line justification with grounded citation>  (the number MUST be the very first characters of this line, plain digits + "%", NEVER bolded e.g. "**70**%"; the headline percent comes first, then the dash and justification)
SAFETY: <1-100>% — <higher = safer, one-line justification>  (same rule: plain "NN%" at the start, never bold, never a different incidental percent first)
RISKS: <serious AEs + THIS patient's risk given meds/comorbidities>
INTERACTIONS: <named interactions vs this patient's meds, or "None identified">
COST: <USD range, US insurance coverage note>
REFERENCES: <2-3 clickable markdown links from the evidence pack, e.g. [NEJM 2014 — pirfenidone](https://...) [ABSTRACT-ONLY]; never plain text URLs without link syntax>

${FORMATTING_RULES}

${SHARED_GUARDRAILS}`;

// Back-half sections (4-8): clinical trials & access programs, drug
// repurposing + pipeline, cell/gene, THIS patient's interaction &
// access plan, red flags. These are the "here's how to get into a
// trial, what to try, and what to avoid" sections — safety-critical
// and personalised.
const RESEARCH_PROMPT_BACK_STATIC = `You are a comprehensive medical research assistant. Produce SECTIONS 4-8 of a structured analysis for the patient's primary condition. Sections 1-3 were produced by a previous call — do NOT repeat them. Start straight at section 4.

LENGTH BUDGET (HARD RULE — this call has ~2,500 output tokens across 5 sections):
- Target ~500 output tokens (~375 words) per section on average. Section 4 (trials) may be larger; compensate by keeping 5-8 tighter.
- Dense bullets / tables. No paragraphs longer than 2 lines. No filler.
- YOU MUST FINISH ALL 5 SECTIONS. Sections 7-8 are safety-critical — do NOT starve them.
- Begin your output with the "## 4." heading. Do NOT write any preamble.

Your output MUST include the following 5 sections IN THIS ORDER, and nothing else.

## 4. Clinical Trials & Access Programs

**What these terms mean (one line each — 7th-grade plain English):** Recruiting = the study is signing people up now · **Open-Label Extension (OLE)** = if you finish the main trial, you can often keep taking the real study drug afterward (everyone gets the drug, not a placebo) · Expanded Access = a way to get a not-yet-approved drug outside a normal trial when you are very sick · Pay-to-Access = you pay to keep the drug before FDA approval.

**This single section MUST cover ALL FOUR access pathways.** Pull directly from the LIVE CLINICAL TRIALS PULL block below. Do NOT list FDA-approved standard-of-care drugs here — Section 3 owns those.

**A. Recruiting trials (top 3 only):** Markdown table —
| NCT ID | Phase | Title | Top Center? | Accepting? | URL |
|---|---|---|---|---|---|

**B. Open-Label Extension (OLE):** Up to 3 lines — NCT, sponsor, status. Plain English first: "After the main trial ends, participants may keep the study drug." If none: one sentence + suggest asking trial PI about OLE. DO NOT repeat an NCT here that you already listed in the Recruiting trials table above — each trial appears in ONE pathway only. If a recruiting study is itself an OLE, keep it in the recruiting table and note "(open-label extension)" there instead of re-listing it here.

**C. Expanded Access:** One bullet per EA record, or ONE sentence if zero.

**D. Pay-to-Access:** One sentence if known; otherwise "None identified in this pull."

## 5. Pipeline Watch (Investigational Programs Only)
**Do NOT write drug-repurposing candidates or COMBO blocks here** — detailed drug cards appear below this report.

Table only — **max 5 rows**, best match to this patient:
| Drug / Program | Phase / Status | Plain-English Summary | Link |

Rules:
- **Investigational only** — phase 2/3 programs, pre-approval biologics, agents NOT FDA-approved for this condition (e.g. azetukalner, ketamine/psilocybin where bipolar trials exclude patients).
- **NEVER list already-approved standard-of-care** (olanzapine, quetiapine, lithium, cariprazine/Vraylar, aripiprazole LAI, Lybalvi, lurasidone, lumateperone, etc.) — Section 3 owns those.
- **NEVER list ECT here** — Section 6 owns neuromodulation (ECT, TMS).
- Pediatric-only trials on an adult patient: note age exclusion in the Summary column.
- Every Link cell MUST be a clickable markdown link [NCT01234567](https://clinicaltrials.gov/study/NCT01234567) — never bare "NCT…" text or label-only "DailyMed".
- Use the PIPELINE WATCH block below when present.


## 6. Cell, Gene & Advanced Therapies
*If not applicable: one line "**N/A** — no active cell/gene therapy program for this condition."* Max 3 bullets total (stem cell caution, gene therapy status, ECT/TMS pointer if relevant).

## 7. This Patient's Interaction & Access Plan
Tailored to **this specific patient profile** — strategic, not exhaustive:
- **Drug-drug interactions:** table or bullets — only **clinically meaningful** interactions for this patient's current meds. Skip theoretical/low-risk pairs.
- **Non-drug / lifestyle:** **max 4 bullets** — highest-impact only (sleep, activity, substance use, monitoring). Frame as "Research suggests…" — not directives.
- **Patient advocacy:** 2-4 orgs / registries / foundations from the dossier's patientAdvocacy list, with homepage URLs.
- **Insurance & cost:** what US commercial / Medicare typically covers. Rough out-of-pocket. Red-flag overseas clinics with undisclosed pricing.

## 8. Safety Considerations Reported in Literature
From the dossier's redFlags + your grounded-evidence knowledge. Frame each item as cited literature for physician discussion — NEVER as patient directives:
- e.g. IPF: *"Literature reports increased mortality with prednisone+azathioprine+NAC triple therapy ([PANTHER-IPF, NEJM 2012](url)) — physicians generally avoid this combination; discuss with your doctor before considering it."*
- e.g. LADA: *"Evidence suggests sulfonylureas may accelerate beta-cell failure in LADA when misclassified as type 2 diabetes ([citation](url)) — worth verifying diagnosis and treatment approach with an endocrinologist."*
- e.g. RP: *"High-dose vitamin A palmitate carries teratogenic risk reported in literature ([citation](url)) — pregnancy planning should be discussed with a physician before use."*

Also cover: overseas clinic concerns (with source URLs where available), unproven 'cures' contradicted by peer-reviewed sources, and excluded agents from the REQUIRED MENTIONS list — each with a clickable link.

${FORMATTING_RULES}

${SHARED_GUARDRAILS}`;

const REPURPOSE_CANDIDATE_FORMAT = `Produce ranked CANDIDATE blocks using this exact format (the UI parses it):

CANDIDATE: <name — plain English the patient would say, e.g. "Goji berries" or "TUDCA"; Latin/scientific name only in parentheses if needed>
CLASS: <drug class or supplement category — for layperson: use plain category, e.g. "immune-suppressing pill" not "mTOR inhibitor class">
APPROVED_FOR: <current FDA-approved or common use — plain English for layperson>
WHAT_IT_DOES: <REQUIRED — one sentence a non-doctor understands: what this drug/supplement is normally for and what it does in the body. No unexplained jargon.>
WHY_FOR_THIS_CONDITION: <REQUIRED — one plain sentence. For a drug with positive or untested rationale: "This might help [condition] because …". For a drug whose human evidence is NEGATIVE / no-benefit / possible-harm (see STUDIED-AGENT RULE), DO NOT write "this might help" — state the honest finding instead, e.g. "This has been tried for [condition], but the research so far shows no clear benefit and possible harm — it is listed here so you and your doctor know it was already studied." Everyday words, no jargon without a parenthetical definition.>
MECHANISM_TARGET: <for medical audience: molecular target/pathway. For layperson: ≤12-word plain phrase, e.g. "Helps cells clean up damaged parts" — define any technical term in parentheses>
REPURPOSE_RATIONALE: <why it might help THIS condition — at the specified audience level. Layperson: 3 bullet lines per LAYPERSON RULES above. Medical: step-by-step biology.>
EVIDENCE_STRENGTH: <one of: MECHANISTIC_ONLY | PRECLINICAL | CASE_REPORT | OBSERVATIONAL | SMALL_RCT | LARGE_RCT>
SUPPORTING_EVIDENCE: <peer-reviewed support with clickable markdown links [title](url) from the evidence pack plus verbatim quoted passages. If no human data exists, say "Mechanistic hypothesis only — no human data yet".>
REFERENCES: <REQUIRED — 1-3 clickable markdown links [short title](url) from the evidence pack or trials pull. Every candidate MUST have at least one link here even if SUPPORTING_EVIDENCE repeats them.>
EFFICACY_HYPOTHESIS: <1-100>% — <one-line plain-English justification>
SAFETY: <1-100>% — <higher = safer; reference FDA label / FAERS reactions if available>
CONFIDENCE: <1-100>% — <overall confidence that this is worth physician discussion>
PATIENT_SPECIFIC_RISKS: <interactions with THIS patient's meds, age, comorbidities>
HOW_TO_DISCUSS_WITH_DOCTOR: <practical script / questions the patient should ask a physician>`;

const REPURPOSE_PROMPT_INTRO = `You are a medical research professor leading a graduate seminar. Your students are looking at an existing drug library and asking, for a specific patient condition, "Which already-approved medications or widely-available supplements might logically help this condition — even though no formal guideline endorses them yet?"

This is the EveryCure / drug-repurposing methodology. Think outside the box. Reason from first principles about:
- the pathophysiology of the primary condition
- known mechanisms of action of existing drugs
- shared molecular pathways with other conditions where a drug is already effective
- supportive (not definitive) peer-reviewed evidence

STUDIED-AGENT RULE (critical — read before assigning evidence strength):
Before you label any candidate MECHANISTIC_ONLY or PRECLINICAL, search the GROUNDED EVIDENCE PACK and LIVE TRIALS for human studies of that agent + THIS condition.

FAILED-TRIAL DISQUALIFIER (GENERAL RULE — applies to EVERY condition and EVERY agent, prescription drug OR over-the-counter supplement; reason it out, do not rely on a hardcoded list):
- Do NOT propose any drug or supplement that has already been tested in a COMPLETED clinical trial for THIS exact condition and FAILED — meaning it missed its primary endpoint, showed no benefit versus placebo, was negative/null, or was terminated/halted for futility or harm. Such an agent has already been TRIED for this disease; it is NOT a "repurposing opportunity" or a "new idea to discuss," and it must NEVER appear as a fresh CANDIDATE block or in a combination.
- Disqualifying evidence = a published failed/negative Phase 2 or Phase 3 (or equivalent RCT) for THIS indication that is present in the gathered evidence pool. Typical signal: a randomized trial reporting "no significant benefit" / "did not meet the primary endpoint," or a trial stopped early for harm.
- SELF-CHECK every candidate before you emit it: "Has this exact agent been studied in a completed trial for THIS condition and failed (or shown no benefit / been stopped for harm)?" If YES → EXCLUDE it from candidates and combos. Do not rationalize it back in as "worth another look."
- Base this on the GATHERED EVIDENCE (LIVE TRIALS + grounded papers), NOT on memory. If the pool contains the failed trial for that agent, that trial is your proof — and if you mention the agent at all, cite that failed trial as the reason it is not a candidate.
- SUBGROUP / BIOMARKER EXCEPTION (context only — never a fresh card): If an agent failed in the broad population but has an ACTIVE biomarker- or genotype-defined subgroup trial ongoing (e.g. a specific gene-type cohort), you may mention it ONLY in a "previously studied / context" framing that plainly says it already failed overall — NEVER as a new candidate card and NEVER with "this might help."

SUPPLEMENT / OTC HANDLING:
- If human pilot/RCT data is POSITIVE, mixed, or genuinely untested for a **supplement/OTC** + this condition (e.g. a small positive pilot), output exactly ONE candidate with honest EVIDENCE_STRENGTH (SMALL_RCT, OBSERVATIONAL, etc.) — NEVER also list it as "not yet studied" or MECHANISTIC_ONLY.
- BUT a supplement that FAILED a completed trial for this condition is disqualified by the FAILED-TRIAL DISQUALIFIER above, exactly like any prescription drug — "it's just a supplement" is NOT a loophole.

BACKSTOP (not your primary safeguard): Some conditions also ship a curated EXCLUDED AGENTS list — skip anything on it entirely. But that list is a belt-and-suspenders backstop; the FAILED-TRIAL DISQUALIFIER above is the PRIMARY safeguard, and you must catch failed/negative agents yourself from the evidence even when they are not on any list.

NO DUPLICATE CANDIDATE NAMES across batches (an agent must appear once, not twice under different spellings).

CARD INTEGRITY (every CANDIDATE block):
- REFERENCES must cite papers about THAT drug only — never paste an unrelated NCT or guideline link.
- CONFIDENCE / PATIENT_SPECIFIC_RISKS / HOW_TO_DISCUSS must describe THIS candidate — never copy text from a different drug or combo.
- WORKED EXAMPLE (the general principle, not a special case): if the evidence pool shows an agent was studied in a completed trial for this condition and showed no benefit — whether it is a prescription drug (e.g. metformin in IPF) or a supplement (e.g. an antioxidant that failed its primary endpoint) — it must NOT appear as a repurposing candidate; at most it belongs in a "previously studied" context with the failed trial cited.

OTC / SUPPLEMENT CARVE-OUT (Lane C and combination blocks):
Over-the-counter supplements are DIFFERENT from prescription repurposing. Lane C MUST read the "OTC / SUPPLEMENT LITERATURE IN THIS PACK" block (if present) and output one CANDIDATE per supplement that has peer-reviewed support in the pack AND has not failed a completed trial for this condition (see FAILED-TRIAL DISQUALIFIER). Use plain-English names patients recognize (e.g. "Goji berries", "TUDCA", "Taurine", "Alpha-lipoic acid") — never Latin binomial alone as the CANDIDATE name. Label EVIDENCE_STRENGTH honestly from what the papers show. Do NOT invent supplements that are not in the evidence pack.

## Mechanistic Hypotheses (genuinely no human data for this condition)
Produce 5-8 candidates where EVIDENCE_STRENGTH is MECHANISTIC_ONLY or PRECLINICAL ONLY when the evidence pack truly contains no human studies for that drug + this condition.
These MUST be drugs/supplements with plausible pathway logic for THIS condition. Examples of the thinking we want:
- Anti-inflammatory already used in Condition B → shared pathway with patient's condition
- Metabolic drug → overlaps with disease pathophysiology
- Supplement targeting oxidative stress when disease involves ROS

For EACH mechanistic candidate, SUPPORTING_EVIDENCE must say explicitly:
"Mechanistic hypothesis only — no human data for [condition] yet" when true.
Still cite adjacent-condition papers or pathway reviews from the evidence pack when available — with clickable links.

Output these mechanistic/preclinical candidates FIRST, each using the CANDIDATE block format below.
Then continue with additional candidates that may have observational or trial data.

QUOTA (mandatory): At least 30% of your candidates MUST have EVIDENCE_STRENGTH of MECHANISTIC_ONLY or PRECLINICAL — but ONLY when the evidence pack lacks human data for that drug + condition.`;

const REPURPOSE_COMBO_AND_SUMMARY = `## Combination Candidates
Produce **3-4** combination candidates (quality over quantity). Prefer novel biology pairings where **each drug alone may not help much** but together might — NOT guideline first-line pairs from Section 3.

Include at least:
- **One 3-drug combo** (Agent A + Agent B + Agent C) when three weak-alone agents have complementary pathways.
- **One OTC/supplement + prescription combo** (e.g. antioxidant supplement + antifibrotic) when the evidence pack supports both — label INTERACTION_RISK honestly.

For EACH combo output this exact block:

COMBO: <Agent A + Agent B [+ Agent C]>
RATIONALE: <one or two sentences on why the mechanisms are complementary or synergistic for THIS condition — pathway diagram in words. Say plainly if each part alone failed or is weak alone.>
EVIDENCE_TIER: <one of: MECHANISTIC_ONLY | PRECLINICAL | CASE_REPORT | OBSERVATIONAL | SMALL_RCT | LARGE_RCT>
SUPPORTING_EVIDENCE: <verbatim quotes + clickable markdown links [title](url) from the evidence pack, or "Mechanistic hypothesis only — no human combo data yet" if there is no supporting literature.>
INTERACTION_RISK: <severity LOW | MODERATE | HIGH plus the specific pharmacokinetic / pharmacodynamic interaction; reference FDA label drug-interaction text when available>
PATIENT_SPECIFIC_RISKS: <interactions with THIS patient's current medications + comorbidities; if none, write "None identified">
CONFIDENCE: <1-100>% — <overall confidence that this combo is worth physician discussion>
HOW_TO_DISCUSS_WITH_DOCTOR: <practical script — "I read about combining X and Y for [condition] because [pathway]; can we discuss whether monitoring [labs/AEs] would let us trial it?">
REFERENCES: <REQUIRED — 1-2 clickable markdown links [short title](url) from the evidence pack>

Combinations are HYPOTHESIS-GENERATION ONLY. When interaction risk may dominate benefit, report honestly — confidence < 25% and INTERACTION_RISK: HIGH. Skip combos built on EXCLUDED AGENTS or on any agent that already failed a completed trial for THIS condition (see FAILED-TRIAL DISQUALIFIER) — a single completed failure does not become a "new idea" by being paired with something else, unless the combo rationale explicitly and credibly addresses why the combination changes the biology.

## Reasoning Summary
Two sentences: (1) best single-agent idea and why; (2) best combo idea and why. No recap of the full list.

## What This Is NOT
One sentence: hypothesis-generation only — discuss with a physician before any change.`;

const REPURPOSE_PROMPT_FRONT_STATIC = `${REPURPOSE_PROMPT_INTRO}

THIS IS PART 1 OF 2. Output ONLY individual CANDIDATE blocks — no combination section, no reasoning summary.
Produce 12 candidates (mechanistic/preclinical FIRST, at least 4, then published-support). 12 is the target; returning fewer than 10 is a FAILURE.
Keep EVERY field to ONE concise sentence (≤25 words). Every candidate MUST include WHY_FOR_THIS_CONDITION and at least one link in REFERENCES.

${REPURPOSE_CANDIDATE_FORMAT}

${SHARED_GUARDRAILS}`;

// Distinct "lanes" of drug types. Each batched front call covers ONE lane so
// the concurrent batches don't produce the same drugs. Lane D is the one that
// forces honest handling of drugs already studied in this condition (e.g.
// metformin in IPF) so a studied-but-negative drug can never be mislabeled as
// "never researched".
const REPURPOSE_LANES = [
  'LANE A — anti-inflammatory & immune-modulating drugs already approved for OTHER inflammatory or autoimmune conditions that could plausibly slow this condition. These must be MECHANISTIC_ONLY or PRECLINICAL for THIS condition — zero human trials for this disease. Skip any drug in EXCLUDED AGENTS and any agent that already failed a completed trial for THIS condition (FAILED-TRIAL DISQUALIFIER).',
  'LANE B — metabolic, antifibrotic, hormonal, and cardiovascular drugs approved for other diseases that could be repurposed via pathway overlap. MECHANISTIC_ONLY or PRECLINICAL for THIS condition only. Skip EXCLUDED AGENTS and any agent that already failed a completed trial for THIS condition (FAILED-TRIAL DISQUALIFIER).',
  'LANE C — over-the-counter supplements, vitamins, and antioxidants. Read the OTC / SUPPLEMENT LITERATURE block in the evidence pack and output candidates FROM those live-retrieved papers. Plain-English CANDIDATE names only (e.g. "Goji berries", not "Lycium barbarum"). Skip EXCLUDED AGENTS and any supplement that already failed a completed trial for THIS condition (FAILED-TRIAL DISQUALIFIER).'
];

// Batched front prompt: one lane, a handful of candidates, finishes fast.
// Does NOT hardcode "15" (that quota belongs to the single-shot prompt); the
// per-batch count comes from the user message. Keeps the STUDIED-AGENT rule
// and the candidate format so quality + the metformin guardrail are intact.
const REPURPOSE_PROMPT_FRONT_BATCH_STATIC = `${REPURPOSE_PROMPT_INTRO}

THIS IS ONE BATCH of a larger candidate list. Other batches (running at the same time) cover the other drug lanes, so produce ONLY candidates that fit the LANE named in the user message — do not stray into other lanes, or you will duplicate another batch.
Output ONLY individual CANDIDATE blocks — no combination section, no reasoning summary, no preamble.
Produce the EXACT number of candidates requested in the user message. Quality over padding, but do not stop short of the requested count.
Keep EVERY field to ONE concise sentence (≤25 words). Every candidate MUST include WHY_FOR_THIS_CONDITION and at least one link in REFERENCES. FINISH the last candidate fully.

${REPURPOSE_CANDIDATE_FORMAT}

${SHARED_GUARDRAILS}`;

const REPURPOSE_PROMPT_BACK_STATIC = `${REPURPOSE_PROMPT_INTRO}

THIS IS PART 2 OF 2 (combinations + summary). It runs in parallel with the
candidate list, so you will NOT see a Part 1 list — derive promising
combinations yourself from the disease biology, the grounded evidence pack,
and standard-of-care for this condition. Output ONLY the sections below — do
NOT output individual CANDIDATE blocks.

${REPURPOSE_COMBO_AND_SUMMARY}

${SHARED_GUARDRAILS}`;

// Single-shot fallback (API backward compat). UI uses gather → synth front → synth back.
const REPURPOSE_PROMPT_STATIC = `${REPURPOSE_PROMPT_INTRO}

Produce a ranked list of 12 candidate repurposed drugs or supplements total (10 minimum).

${REPURPOSE_CANDIDATE_FORMAT}

${REPURPOSE_COMBO_AND_SUMMARY}

${SHARED_GUARDRAILS}`;

const TRIALS_PROMPT = (patient, audience, trialsPayload) => {
  const studies = Array.isArray(trialsPayload?.studies) ? trialsPayload.studies : [];
  const eaCount = studies.filter((s) => s.isExpandedAccessStudy === true).length;
  const trialsBlock = buildTrialsBlock(trialsPayload);
  const allowedNcts = studies.map((s) => s.nctId).filter(Boolean);

  return `You are a clinical trials analyst. You have a live ClinicalTrials.gov pull for this patient's condition. Produce a patient-friendly analysis.

${audienceLine(audience)}

PATIENT PROFILE:
${buildPatientContext(patient)}

${trialsBlock || 'LIVE CLINICAL TRIALS PULL: (empty — say no trials were returned and stop.)'}

ABSOLUTE RULES (violations are failures):
- CITE ONLY trials/NCTs/URLs that appear in the LIVE CLINICAL TRIALS PULL above. Never invent NCT IDs, sponsor URLs, or program names.
- Expanded Access / compassionate use = ONLY records with studyType EXPANDED_ACCESS in the pull (${eaCount} found). If ${eaCount} === 0, write ONE sentence stating none were found — do NOT list other drugs (pipeline, investigational, or approved) as if they were expanded access.
- Investigational or pipeline drugs belong in a separate "Drugs in development" note ONLY if they appear as recruiting interventional trials in the pull — never confuse them with expanded access.
- Every URL must be https://clinicaltrials.gov/study/NCT######## from this pull: ${allowedNcts.slice(0, 20).join(', ') || '(none)'}.
- Do NOT use strikethrough, ~~text~~, or "NOT approved" flags on drug names.

STRUCTURE (use these exact headings):
## Recruiting trials for you
Rank the most promising 5-8 interventional trials. For each, use the TRIAL block format below.

## Expanded Access / Compassionate Use
${eaCount > 0
    ? `List ONLY the ${eaCount} Expanded Access record(s) from the pull — one bullet each with NCT + link.`
    : 'Write exactly: "No Expanded Access / compassionate-use programs were found on ClinicalTrials.gov for this condition in this search." Nothing else in this section.'}

## Open-label extensions & keeping the drug after a trial
Only trials flagged OPEN-LABEL-EXTENSION in the pull. If none, say so in one sentence.

## What this means for you
2-4 plain-language sentences. No medical advice.

TRIAL block format (UI parses this — one block per trial):
TRIAL: <brief title>
NCT: <NCT ID from pull only>
URL: <https://clinicaltrials.gov/study/NCT######## from pull only>
PHASE: <phase(s)>
STATUS: <recruiting status>
ACCEPTING: <yes / no>
PLACEBO: <yes / no / partial>
TREATMENT_ONLY: <yes / no>
COUNTRY: <country list>
OVERSIGHT: <IRB yes/no, DSMB yes/no, FDA-regulated yes/no>
DESIGNATIONS: <fast-track / breakthrough / orphan / expanded-access / PTA / OLE flags — only if in pull>
FIT_FOR_PATIENT: <1-100>% — <why in plain English>
HARM_RISK: <1-100>% — <higher = safer; plain English>
INTERACTIONS: <named interactions with this patient's meds, or "None identified">
LOCATION_CONTACT: <closest site + contact from pull data>
SUMMARY: <2-3 sentence plain-language summary>

${SHARED_GUARDRAILS}`;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-access-passcode'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Site-wide access gate. When MRT_ACCESS_PASSCODE is set, the caller
  // must present a matching x-access-passcode header. Fail-open when
  // the env var is unset so local dev + tests keep working.
  if (!requireAccess(req, res)) return;

  try {
    const {
      mode = 'research',
      patient = {},
      audience = 'layperson',
      userQuery = '',
      chatHistory = [],
      trialsData = null,
      // Two-phase pipeline to stay under Vercel's 60s serverless cap.
      //   phase='gather'     — fan out to dossier+evidence+trials, return
      //                         those pools to the client, DON'T call Claude.
      //   phase='synthesize' — skip fan-out, use dossier+evidence+trials
      //                         provided by the client, run Claude only.
      //   phase='all' (default for backward compat & chat/trials/repurpose modes):
      //                         do everything in one request. Research mode
      //                         from the UI now uses gather→synthesize; the
      //                         single-shot path is still there for the API.
      phase = 'all',
      // When phase='synthesize' for the research mode, the client runs
      // TWO successive synth calls — each gets its own 60s Vercel slot
      // so Claude always finishes its half without hitting max_tokens
      // truncation.
      //   half='front' → sections 1-4 (snapshot, centers, treatments,
      //                  trials & access programs)
      //   half='back'  → sections 5-8 (repurposing+pipeline, cell/gene,
      //                  patient plan, red flags)
      // The frontend stitches the two responses together.
      half = 'front',
      providedDossier = null,
      providedEvidence = null,
      providedTrials = null,
      // For split synthesis on the BACK half: the client sends the
      // FRONT half's output text here so the server-side "Agents
      // evaluated" transparency block can correctly mark approved
      // drugs (which appear in the front half's section 3) as
      // discussed.
      priorText = '',
      // Repurpose candidate generation is split into several SMALL batches
      // that run concurrently on the client, instead of one slow ~200s call
      // that risks hitting the function time limit and returning a truncated
      // 3-candidate, no-links result. Each batch covers a distinct "lane" of
      // drug types so the batches don't duplicate each other.
      //   batchLane  → 0-based index into REPURPOSE_LANES (front half only)
      //   batchSize  → how many candidates this batch should produce
      batchLane = null,
      batchSize = null,
      gatherFingerprint: clientGatherFingerprint = null
    } = req.body || {};
    const model = String(req.body?.model || DEFAULT_MODEL);
    const isRepurposeBatch =
      mode === 'repurpose' && phase === 'synthesize' && half === 'front' &&
      batchLane !== null && batchLane !== undefined;
    const maxTokens = resolveMaxTokens(model, mode, phase, half, isRepurposeBatch);

    // ============================================================
    // Utility modes consolidated into /api/research so we stay
    // within Vercel Hobby's 12-function cap.
    // ============================================================
    if (mode === 'runtime-config') {
      const adsEnabled = String(process.env.MRT_ADS_ENABLED || '').trim() === '1';
      const adsenseClient = String(process.env.MRT_ADSENSE_CLIENT || '').trim();
      const prices = usagePricing();
      const lim = usageLimits();
      const devUnlimited = isUsageLimitBypassed(getClientIp(req));
      const hasPerplexity = !!process.env.PERPLEXITY_API_KEY;
      const hasOpenAI = !!process.env.OPENAI_API_KEY;
      const hasXai = !!process.env.XAI_API_KEY;
      return res.status(200).json({
        branding: { productName: 'researchingmycondition.com' },
        build: {
          sha: String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim().slice(0, 7) || null,
          at: process.env.VERCEL_GIT_COMMIT_SHA ? undefined : null
        },
        ai: {
          researchModel: String(process.env.ANTHROPIC_RESEARCH_MODEL || DEFAULT_MODEL),
          modelFallback: true
        },
        validation: {
          available: hasPerplexity || hasOpenAI || hasXai,
          primaryProvider: hasPerplexity ? 'Perplexity' : hasOpenAI ? 'OpenAI' : hasXai ? 'xAI' : null
        },
        dynamicKb: {
          enabled: String(process.env.MRT_DYNAMIC_KB || '1').trim() !== '0',
          store: String(process.env.UPSTASH_REDIS_REST_URL || '').trim() ? 'upstash-redis' : 'in-memory',
          refreshHours: Number(process.env.MRT_BRAIN_REFRESH_HOURS || 24),
          dailyCron: String(process.env.MRT_BRAIN_CRON || '1').trim() !== '0'
        },
        monetization: {
          devUnlimited,
          freeRunsPerMonth: devUnlimited ? 999999 : lim.free,
          proRunsPerMonth: devUnlimited ? 999999 : lim.pro,
          maxRunsPerMonth: devUnlimited ? 999999 : lim.max,
          proPriceUsd: prices.proPriceUsd,
          maxPriceUsd: prices.maxPriceUsd,
          // Backward compat for older clients
          paidRunsPerMonth: devUnlimited ? 999999 : lim.pro,
          paidPriceUsd: prices.proPriceUsd,
          upgradeUrl: String(process.env.MRT_UPGRADE_URL || '').trim(),
          tiers: devUnlimited
            ? [{ id: 'dev', label: 'Development', runsPerMonth: 999999, priceUsd: 0 }]
            : [
                { id: 'free', label: 'Free', runsPerMonth: lim.free, priceUsd: 0 },
                { id: 'pro', label: 'Pro', runsPerMonth: lim.pro, priceUsd: prices.proPriceUsd },
                { id: 'max', label: 'Max', runsPerMonth: lim.max, priceUsd: prices.maxPriceUsd }
              ]
        },
        ads: {
          enabled: adsEnabled,
          provider: adsEnabled ? 'google-adsense' : 'none',
          adsenseClient,
          slots: {
            researchTop: String(process.env.MRT_AD_SLOT_RESEARCH_TOP || '').trim(),
            repurposeTop: String(process.env.MRT_AD_SLOT_REPURPOSE_TOP || '').trim(),
            trialsTop: String(process.env.MRT_AD_SLOT_TRIALS_TOP || '').trim(),
            footer: String(process.env.MRT_AD_SLOT_FOOTER || '').trim()
          }
        },
        infra: getInfraStatus(),
        diseaseRegistry: await diseaseRegistryStats(),
        drugRegistry: await drugRegistryStats(),
        conditionInference: conditionInferenceConfig(),
        spendControls: spendControlsConfig()
      });
    }

    if (mode === 'resolve-condition') {
      const condition = String(req.body?.condition || req.query?.condition || '').trim();
      if (!condition) return res.status(400).json({ error: 'condition is required' });
      const resolution = await resolveCondition(condition);
      return res.status(200).json(resolution);
    }

    if (mode === 'condition-subtypes') {
      const query = String(req.body?.query || req.body?.condition || req.query?.query || '').trim();
      if (!query) return res.status(400).json({ error: 'query is required' });
      const listing = await listConditionSubtypes(query);
      return res.status(200).json(listing);
    }

    // Spend kill — blocks paid API before any Anthropic/Perplexity calls.
    const pipelineMode = mode === 'research' || mode === 'repurpose' || mode === 'trials';
    if (pipelineMode && !isResearchPipelineEnabled()) {
      return res.status(503).json({
        error: spendDisabledMessage(),
        code: 'RESEARCH_SPEND_DISABLED',
        spendControls: spendControlsConfig()
      });
    }
    if (isPaidUserMode(mode) && !pipelineMode && !isSpendEnabled()) {
      return res.status(503).json({
        error: spendDisabledMessage(),
        code: 'SPEND_DISABLED',
        spendControls: spendControlsConfig()
      });
    }

    if (mode === 'parse-patient-message') {
      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ error: 'message is required' });
      const parsed = parsePatientMessage(message);
      const { patient: mergedPatient, merged, fieldsUpdated } = mergePatientFromMessage(
        req.body?.patient || {},
        parsed
      );
      let conditionResolution = null;
      const cond = parsed.conditionRaw || mergedPatient.condition;
      if (cond) {
        conditionResolution = await resolveCondition(cond);
        if (conditionResolution?.resolved && conditionResolution.matchScore >= 55) {
          mergedPatient.condition = conditionResolution.resolved;
        }
      }
      return res.status(200).json({
        ok: true,
        parsed,
        merged,
        fieldsUpdated,
        patient: mergedPatient,
        conditionResolution
      });
    }

    if (mode === 'usage') {
      try {
        const ip = getClientIp(req);
        const usage = await getUsage(ip);
        const lim = usageLimits();
        const prices = usagePricing();
        const devUnlimited = isUsageLimitBypassed(ip);
        return res.status(200).json({
          ok: true,
          usage,
          devUnlimited,
          limits: lim,
          pricing: devUnlimited
            ? {
                freeTier: 'Development — unlimited runs',
                proTier: 'Development — unlimited runs',
                maxTier: 'Development — unlimited runs',
                paidTier: 'Development — unlimited runs',
                tiers: [{ id: 'dev', runsPerMonth: 999999, priceUsd: 0 }]
              }
            : {
                freeTier: `${lim.free} runs / month`,
                proTier: `$${prices.proPriceUsd}/month for up to ${lim.pro} runs`,
                maxTier: `$${prices.maxPriceUsd}/month for up to ${lim.max} runs`,
                paidTier: `$${prices.proPriceUsd}/month for up to ${lim.pro} runs`,
                tiers: [
                  { id: 'free', runsPerMonth: lim.free, priceUsd: 0 },
                  { id: 'pro', runsPerMonth: lim.pro, priceUsd: prices.proPriceUsd },
                  { id: 'max', runsPerMonth: lim.max, priceUsd: prices.maxPriceUsd }
                ]
              }
        });
      } catch (err) {
        return res.status(500).json({ error: err?.message || 'Failed to fetch usage' });
      }
    }

    if (mode === 'activate-plan') {
      const code = String(req.body?.code || '').trim();
      if (!code) return res.status(400).json({ error: 'code is required' });
      const tier = verifyPlanCode(code);
      if (!tier) return res.status(403).json({ error: 'Invalid upgrade code' });
      try {
        const ip = getClientIp(req);
        await activatePlanForIp(ip, tier);
        const usage = await getUsage(ip);
        return res.status(200).json({
          ok: true,
          message: `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan activated for this IP.`,
          plan: tier,
          usage
        });
      } catch (err) {
        return res.status(500).json({ error: err?.message || 'Plan activation failed' });
      }
    }

    if (mode === 'translate') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
      const rawText = sanitize(req.body?.text);
      const targetLanguage = sanitize(req.body?.targetLanguage);
      const sourceLanguage = sanitize(req.body?.sourceLanguage) || 'English';
      if (!rawText) return res.status(400).json({ error: 'text is required' });
      if (!targetLanguage) return res.status(400).json({ error: 'targetLanguage is required' });
      if (rawText.length > TRANSLATE_MAX_CHARS) {
        return res.status(400).json({ error: `text too long (${rawText.length} chars). Max ${TRANSLATE_MAX_CHARS}.` });
      }
      const translatePrompt = [
        `Translate the following medical-analysis markdown from ${sourceLanguage} to ${targetLanguage}.`,
        'STRICT RULES:',
        '- Preserve ALL markdown structure (headers, bullets, numbering, links).',
        '- Do NOT omit or add clinical claims.',
        '- Keep drug names, trial IDs (NCT numbers), gene names, acronyms, and dosages unchanged.',
        '- Keep URLs unchanged.',
        '- Translate explanatory prose naturally for native readers.',
        '- Return ONLY the translated markdown text (no preface, no code fences).',
        '',
        rawText
      ].join('\n');
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: TRANSLATE_MODEL,
            max_tokens: 2800,
            temperature: 0,
            messages: [{ role: 'user', content: translatePrompt }]
          })
        });
        const raw = await r.text();
        let j;
        try { j = JSON.parse(raw); }
        catch {
          return res.status(502).json({ error: `Anthropic returned non-JSON (HTTP ${r.status})`, raw: raw.slice(0, 200) });
        }
        if (!r.ok) return res.status(502).json({ error: j?.error?.message || `Anthropic error (HTTP ${r.status})` });
        const translatedText = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!translatedText) return res.status(502).json({ error: 'Translation returned empty output' });
        return res.status(200).json({ translatedText, model: TRANSLATE_MODEL, sourceLanguage, targetLanguage });
      } catch (err) {
        return res.status(500).json({ error: err?.message || 'Translation failed' });
      }
    }

    if (mode === 'benchmark-models') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
      const SONNET_MODEL = process.env.ANTHROPIC_BENCHMARK_SONNET_MODEL || DEFAULT_RESEARCH_MODEL;
      const OPUS_MODEL = process.env.ANTHROPIC_BENCHMARK_OPUS_MODEL || process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-opus-4-20250514';
      const MAX_BENCH_TOKENS = Number(process.env.ANTHROPIC_BENCHMARK_MAX_TOKENS || 700);
      const BENCH_PROMPT = 'Write 6 concise bullets on idiopathic pulmonary fibrosis: standard of care, one pipeline agent, one safety monitoring point, one trial-access note. Under 350 words.';
      const runOne = async (m) => {
        const started = Date.now();
        const rr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: m,
            max_tokens: MAX_BENCH_TOKENS,
            temperature: 0.1,
            messages: [{ role: 'user', content: BENCH_PROMPT }]
          })
        });
        const elapsedMs = Date.now() - started;
        const raw = await rr.text();
        let j;
        try { j = JSON.parse(raw); } catch { return { ok: false, model: m, elapsedMs, error: `Non-JSON HTTP ${rr.status}` }; }
        if (!rr.ok) return { ok: false, model: m, elapsedMs, error: j?.error?.message || `HTTP ${rr.status}` };
        const out = Number(j?.usage?.output_tokens || 0);
        return { ok: true, model: m, elapsedMs, outputTokens: out, tokensPerSec: elapsedMs > 0 ? Number((out / (elapsedMs / 1000)).toFixed(2)) : null };
      };
      const sonnet = await runOne(SONNET_MODEL);
      const opus = await runOne(OPUS_MODEL);
      const ratio = sonnet.ok && opus.ok && sonnet.elapsedMs > 0 ? Number((opus.elapsedMs / sonnet.elapsedMs).toFixed(2)) : null;
      return res.status(200).json({
        ok: true,
        sonnet,
        opus,
        comparison: {
          opusVsSonnetLatencyRatio: ratio,
          note: ratio ? `Opus latency is ${ratio}x Sonnet in deployment.` : 'Could not compute latency ratio.'
        }
      });
    }

    if (mode === 'validate') {
      return validateHandler(req, res);
    }

    if (mode === 'polish-report') {
      const analysisText = String(req.body?.analysisText || '');
      const evidence = {
        excludedAgents: req.body?.excludedAgents || [],
        groundedForPrompt: req.body?.evidencePack || [],
        topRanked: req.body?.evidencePack || [],
        pipelineDrugs: req.body?.pipelineDrugs || []
      };
      const trials = req.body?.trials || null;
      let polished = finalizeReportText(analysisText, { evidence, trials });
      let validation = req.body?.validation || null;
      const hasAnyValidatorKey =
        !!process.env.PERPLEXITY_API_KEY ||
        !!process.env.OPENAI_API_KEY ||
        !!process.env.XAI_API_KEY;
      const wantValidation = req.body?.validate !== false && !validation;
      const wantSilentFix = req.body?.silentFix !== false;
      const validateTimeoutMs = Number(process.env.MRT_VALIDATE_TIMEOUT_MS || 90_000);
      if (wantValidation && analysisText && hasAnyValidatorKey && isSpendEnabled()) {
        try {
          const vResult = await Promise.race([
            invokeValidate({
              analysisText: polished,
              evidencePack: (req.body.evidencePack || []).slice(0, 18),
              patient: req.body.patient || {},
              condition: req.body.condition || req.body.patient?.condition || '',
              audience: req.body.audience || 'layperson'
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('validate timeout')), validateTimeoutMs)
            )
          ]);
          if (vResult?.primary) {
            validation = vResult;
            if (wantSilentFix) {
              polished = applyValidationFixes(
                polished,
                vResult,
                evidence,
                collectAllowedUrls(evidence, trials)
              );
            }
          }
        } catch (err) {
          console.warn('[research] polish-report validate skipped:', err.message);
        }
      } else if (validation && wantSilentFix) {
        polished = applyValidationFixes(
          polished,
          validation,
          evidence,
          collectAllowedUrls(evidence, trials)
        );
      }
      return res.status(200).json({
        content: [{ type: 'text', text: polished }],
        validation,
        validationMismatch: validation
          ? detectValidationMismatch(
              validation,
              req.body?.condition || req.body?.patient?.condition || ''
            )
          : null
      });
    }

    // Monthly per-IP gate:
    // - free: first 4 runs/month
    // - paid: up to 15 runs/month
    //
    // IMPORTANT: research mode calls this endpoint multiple times per
    // user action (gather + synth + back half). We meter ONLY entry
    // requests (phase=all or phase=gather) so one "Run Full Research"
    // counts once, not 2-3x.
    const isBillableMode = mode === 'research' || mode === 'repurpose' || mode === 'trials';
    const ip = getClientIp(req);
    const shouldMeter = isBillableMode && (phase === 'all' || phase === 'gather') && !isUsageLimitBypassed(ip);
    if (shouldMeter) {
      const quota = await consumeResearchCredit(ip);
      if (!quota.allowed) {
        const lim = usageLimits();
        const prices = usagePricing();
        const planLabel = quota.plan === 'max' ? 'Max' : quota.plan === 'pro' ? 'Pro' : 'Free';
        return res.status(402).json({
          error: `Monthly limit reached for this IP (${quota.used}/${quota.limit} on ${planLabel} plan). Free: ${lim.free}/mo · Pro: $${prices.proPriceUsd} → ${lim.pro}/mo · Max: $${prices.maxPriceUsd} → ${lim.max}/mo.`,
          code: 'USAGE_LIMIT_REACHED',
          upgradeRequired: true,
          usage: quota,
          pricing: {
            freeRunsPerMonth: lim.free,
            proRunsPerMonth: lim.pro,
            maxRunsPerMonth: lim.max,
            proPriceUsd: prices.proPriceUsd,
            maxPriceUsd: prices.maxPriceUsd,
            paidRunsPerMonth: lim.pro,
            paidPriceUsd: prices.proPriceUsd,
            upgradeUrl: String(process.env.MRT_UPGRADE_URL || '').trim()
          }
        });
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Server configuration error: ANTHROPIC_API_KEY not set.'
      });
    }

    // Effective condition — prefer patient.condition, but fall back to the
    // user's latest message (chat input) if the profile field is empty. This
    // is the fix for the "I type RP in the chat, AI refuses because no
    // condition set" UX bug. The dossier agent itself vets whatever we
    // pass; a junk string returns a high-uncertainty fallback.
    const latestUserMsg = (() => {
      if (userQuery && String(userQuery).trim()) return String(userQuery).trim();
      const lastUser = [...(chatHistory || [])].reverse().find((m) => m?.role === 'user');
      return lastUser?.content ? String(lastUser.content).trim() : '';
    })();
    // Heuristic: trim long conversational messages down to the medical noun
    // phrase. "My mom has LADA and takes insulin…" → "LADA".
    const effectiveCondition =
      (patient.condition || '').trim() ||
      extractConditionFromMessage(latestUserMsg);

    let gatherCondition = effectiveCondition;
    let conditionResolutionHint = null;
    if (effectiveCondition) {
      conditionResolutionHint = await resolveCondition(effectiveCondition);
      if (phase !== 'synthesize' && conditionResolutionHint?.ok && conditionResolutionHint.resolved) {
        gatherCondition = conditionResolutionHint.resolved;
      }
    }
    const groundingHints = {
      kbSlug: conditionResolutionHint?.kbSlug || conditionResolutionHint?.kbMatch?.slug || null
    };

    const serverGatherFingerprint = buildGatherFingerprintFromPatient(patient, conditionResolutionHint);

    if ((mode === 'research' || mode === 'repurpose') && (phase === 'gather' || phase === 'synthesize')) {
      const profileCheck = checkProfileCoherence(patient);
      if (!profileCheck.ok) {
        return res.status(400).json({
          error: profileCheck.message,
          code: profileCheck.code
        });
      }
    }

    // Research pipeline — three phases:
    //   (1) Disease-intake agent (Haiku, 24h cache) — builds structured
    //       dossier for ANY condition, including aliases like "RP" or
    //       "LADA". Runs for ALL modes now, even chat, so the agent has
    //       disease context from the very first turn.
    //   (2) Evidence + Trials in parallel, sharing the one dossier call.
    //   (3) Claude Sonnet synthesis with the dossier injected as context.
    let evidence = null;
    let trials = null;
    let dossier = null;

    // Phase: 'synthesize' trusts client-provided pools, skips fan-out.
    // Everything else (gather / all) does the live pulls.
    if (phase === 'synthesize') {
      const slim = trimSynthPools({
        dossier: providedDossier,
        evidence: providedEvidence,
        trials: providedTrials
      });
      dossier = slim.dossier || null;
      evidence = slim.evidence || null;
      trials = slim.trials || null;

      if (mode === 'research' || mode === 'repurpose') {
        const hasProvidedPools = !!(providedDossier || providedEvidence || providedTrials);
        const poolFingerprint = dossier?.poolsFingerprint || null;
        if (!clientGatherFingerprint) {
          return res.status(409).json({
            error: 'Profile changed — re-gathering.',
            code: 'GATHER_STALE'
          });
        }
        // Pool-bound same-session synth: trust only the gather stamp on the
        // dossier — do NOT re-compare live profile re-resolve (canonicalize
        // drift, inference on/off, slug vs display name all caused false 409s).
        if (hasProvidedPools && poolFingerprint) {
          if (!poolBoundSynthValid(clientGatherFingerprint, poolFingerprint)) {
            return res.status(409).json({
              error: 'Profile changed — re-gathering.',
              code: 'GATHER_STALE'
            });
          }
        } else if (!gatherFingerprintAccepted(
          clientGatherFingerprint, serverGatherFingerprint, poolFingerprint
        )) {
          return res.status(409).json({
            error: 'Profile changed — re-gathering.',
            code: 'GATHER_STALE'
          });
        } else {
          const poolCheck = checkDossierProfileCoherence(patient, dossier, evidence);
          if (!poolCheck.ok) {
            return res.status(409).json({
              error: poolCheck.message || 'Profile changed — re-gathering.',
              code: poolCheck.code || 'GATHER_STALE'
            });
          }
        }
      }

      // Same safety net on the synth side:
      // evidence (slow PubMed, old client payload), rebuild grounding from the
      // curated KB so the candidate lanes still get the excludedAgents guardrail,
      // pipeline drugs, and real citable papers. Prevents the "3 candidates / no
      // links / metformin mislabeled" failure even when gather degraded.
      if ((mode === 'research' || mode === 'repurpose') && !evidenceIsUsable(evidence)) {
        evidence = await ensureGroundedEvidence(effectiveCondition, dossier, evidence, groundingHints);
      }
    } else {
      // Hard deadline for the entire gather phase. On Vercel Pro functions
      // may run up to 300s (see vercel.json maxDuration); 120s gives the
      // PubMed/EPMC/OpenAlex/trials fan-out room to complete fully instead
      // of returning partial pools, while still bounding worst-case latency.
      // Override with MRT_GATHER_DEADLINE_MS if needed.
      const GATHER_DEADLINE_MS = Number(process.env.MRT_GATHER_DEADLINE_MS || 120_000);
      const withDeadline = (p, label) => Promise.race([
        p.catch((e) => {
          console.warn(`[research.gather] ${label} threw:`, e?.message || e);
          return null;
        }),
        new Promise((resolve) => setTimeout(() => {
          console.warn(`[research.gather] ${label} exceeded ${GATHER_DEADLINE_MS}ms — returning partial`);
          resolve(null);
        }, GATHER_DEADLINE_MS))
      ]);

      // Kick off dossier + evidence + trials ALL IN PARALLEL. Evidence
      // and trials each call getDossier() internally and, thanks to
      // the in-flight promise dedup in disease-dossier.js, they share
      // the same pending Claude call as the one research.js started.
      // Net effect: one ~8-10s Claude dossier call runs concurrently
      // with the PubMed/EPMC/OpenAlex fan-out and the ClinicalTrials
      // API pull, instead of serially before them.
      const drugs = (patient.medications || '')
        .split(/[,;\n]/).map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 6);
      const needsEvidence = (mode === 'research' || mode === 'repurpose');
      const dossierP = gatherCondition
        ? withDeadline(getDossier(gatherCondition), 'dossier')
        : Promise.resolve(null);
      const evidenceP = needsEvidence
        ? withDeadline(invokeEvidence({
            condition: gatherCondition,
            mode,
            // Trimmed fan-out: 2 treatment cross-products instead of 4.
            // The dossier's synonyms + KB cover the specificity loss.
            treatments: ['treatment', 'systematic review'],
            drugs,
            manufacturers: [],
            limitPerSource: mode === 'repurpose' ? 6 : 3,
            includeFullText: true
            // NB: dossier intentionally NOT passed — evidence.js will
            // fetch it via getDossier() and hit the in-flight cache so
            // we still only make one Claude call total.
          }), 'evidence')
        : Promise.resolve(null);
      const trialsP = needsEvidence
        ? withDeadline(invokeTrials({
            condition: gatherCondition,
            recruitingOnly: false,
            treatmentOnly: true,
            pageSize: 30
          }), 'trials')
        : Promise.resolve(null);

      const [dossierResult, evidenceResult, trialsResult] = await Promise.all([
        dossierP, evidenceP, trialsP
      ]);
      dossier = dossierResult;
      evidence = evidenceResult;
      trials = trialsResult;

      // Only start building a saved reference library for conditions we do
      // NOT already have a hand-curated KB for (e.g. IPF is static — no build).
      if (needsEvidence && dossier?.canonical && isDynamicKbSpendEnabled()) {
        loadKb(gatherCondition, {
          fallbackCanonical: dossier.canonical,
          fallbackSynonyms: dossier.synonyms || [],
          ensureBuild: false,
          dossier
        }).then((kbHit) => {
          if (!kbHit.matched || kbHit.meta?.source === 'dynamic-brain') {
            ensureDynamicKb(dossier.canonical, dossier).catch(() => {});
          }
        }).catch(() => {});
      }

      // SAFETY NET: if the live evidence fetch timed out or errored (withDeadline
      // → null) OR came back with zero grounded papers, fall back to curated KB
      // or dossier+Perplexity so synthesis never runs fully ungrounded.
      if (needsEvidence && !evidenceIsUsable(evidence)) {
        evidence = await ensureGroundedEvidence(gatherCondition, dossier, evidence, groundingHints);
      }
    }

    // Chat ALWAYS loads curated KB + merges client evidence pack. The old
    // prompt literally said "use your own medical knowledge" when the pack
    // was empty — that caused CAR cell / stem-cell to be called "gold
    // standard" for IPF on a live Dorothy call.
    if (mode === 'chat' && effectiveCondition) {
      const clientPack = Array.isArray(req.body?.evidencePack) ? req.body.evidencePack : [];
      const clientGrounded = clientPack.map((a) =>
        toGroundedItem({ ...a, text: a.text || a.abstract || a.summary || '' })
      );
      const clientEv = clientGrounded.length ? { groundedForPrompt: clientGrounded } : null;
      const kbMerged = await ensureGroundedEvidence(effectiveCondition, dossier, clientEv, groundingHints);
      if (kbMerged) {
        const seen = new Set();
        const merged = [];
        for (const item of [...clientGrounded, ...(kbMerged.groundedForPrompt || [])]) {
          const key = String(item.pmid || item.doi || item.title || '').toLowerCase();
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          merged.push(item);
        }
        evidence = {
          ...kbMerged,
          groundedForPrompt: merged.slice(0, 28),
          topRanked: merged.slice(0, 28)
        };
      }
    }

    // Phase='gather' short-circuits here. We hand the raw pools back to the
    // client, which will then call us again with phase='synthesize' and the
    // pools attached. This splits the >60s single-shot pipeline into two
    // sub-60s serverless invocations.
    if (phase === 'gather') {
      const trimmed = trimGatherPools({
        dossier, evidence, trials, gatherFingerprint: serverGatherFingerprint
      });
      const conditionResolution = conditionResolutionHint;
      return res.status(200).json({
        phase: 'gather',
        model,
        maxTokens,
        gatherFingerprint: serverGatherFingerprint,
        conditionResolution,
        ...trimmed
      });
    }
    const gPlan = groundingPlan(mode, phase, half);
    const groundingBlock = evidence ? buildGroundingBlock(evidence, gPlan) : '';
    const trialsBlock = trials ? buildTrialsBlock(trials) : '';
    const dossierBlock = dossier ? buildDossierBlock(dossier) : '';
    // Anti-omission guardrail: inject the KB's pipelineDrugs +
    // excludedAgents as REQUIRED MENTIONS. See buildRequiredMentionsBlock.
    const requiredMentionsBlock = evidence ? buildRequiredMentionsBlock(evidence) : '';
    const pipelineWatchBlock =
      mode === 'research' && half === 'back' && evidence
        ? buildPipelineWatchBlock(evidence)
        : '';
    const supplementDiscoveryBlock = (mode === 'repurpose' && evidence)
      ? buildSupplementDiscoveryBlock(evidence)
      : '';

    let repurposeLibraryBlock = '';
    if (mode === 'repurpose' && dossier) {
      const lane = isRepurposeBatch ? Number(batchLane) : null;
      const pool = (lane != null && !Number.isNaN(lane))
        ? await selectRepurposeDrugs(dossier, { lane, limit: 14 })
        : (evidence?.repurposeDrugPool?.length
          ? evidence.repurposeDrugPool
          : await selectRepurposeDrugs(dossier, { limit: 20 }));
      repurposeLibraryBlock = buildRepurposeDrugLibraryBlock(pool, {
        lane: lane != null && !Number.isNaN(lane) ? lane : null,
        condition: dossier.canonical || effectiveCondition
      });
    }

    // Extra context layers stitched onto the base mode prompt. Order matters:
    // dossier first (the AI's starting hypothesis about the disease), then
    // grounded evidence pack (what the literature actually says), then the
    // live trials pull (what's currently enrolling / offering expanded
    // access), then repurpose drug library (open curated drug list),
    // then the REQUIRED MENTIONS list last so Claude sees the
    // anti-omission constraint immediately before starting to write.
    const extraContext = [dossierBlock, groundingBlock, trialsBlock, repurposeLibraryBlock, requiredMentionsBlock, pipelineWatchBlock, supplementDiscoveryBlock]
      .filter(Boolean)
      .join('\n\n');

    // `systemBlocks` is an array of content blocks sent to Anthropic.
    // The first block (when present) is the STATIC mode scaffolding with
    // `cache_control: { type: 'ephemeral' }` so it is served at 10% of
    // normal input-token rate on repeat requests within the 5-minute
    // cache window. The second block is the dynamic per-request header
    // (audience, patient profile, grounded evidence, trials data) which
    // is always fresh. Chat/trials modes bypass the cache split — chat
    // is too dynamic and trials embeds a big JSON blob inline.
    let systemBlocks = null;
    let systemPrompt = null;

    switch (mode) {
      case 'repurpose': {
        const repStatic = (phase === 'synthesize' && half === 'back')
          ? REPURPOSE_PROMPT_BACK_STATIC
          : isRepurposeBatch
            ? REPURPOSE_PROMPT_FRONT_BATCH_STATIC
            : (phase === 'synthesize' ? REPURPOSE_PROMPT_FRONT_STATIC : REPURPOSE_PROMPT_STATIC);
        systemBlocks = [
          { type: 'text', text: repStatic, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildDynamicHeader(patient, audience, 'repurpose') + (extraContext ? `\n\n${extraContext}` : '') }
        ];
        break;
      }
      case 'trials':
        systemPrompt = TRIALS_PROMPT(patient, audience, trialsData || {});
        break;
      case 'chat': {
        const priorPieces = [];
        const prior = req.body?.priorAnalyses || {};
        if (prior.research)  priorPieces.push(`=== PRIOR "RESEARCH" ANALYSIS (produced earlier in this session) ===\n${String(prior.research).slice(0, 25000)}`);
        if (prior.repurpose) priorPieces.push(`=== PRIOR "REPURPOSE" ANALYSIS ===\n${String(prior.repurpose).slice(0, 20000)}`);
        if (prior.trials)    priorPieces.push(`=== PRIOR "TRIALS" ANALYSIS ===\n${String(prior.trials).slice(0, 20000)}`);
        const hasPriors = priorPieces.length > 0;

        const chatGrounding = evidence
          ? buildGroundingBlock(evidence, { limit: 14, excerpt: 900 })
          : '';
        const chatRequired = evidence ? buildRequiredMentionsBlock(evidence) : '';
        const chatCanonical = evidence ? buildCanonicalFactsBlock(evidence) : '';
        const dossierInChat = dossier && dossier.canonical ? buildDossierBlock(dossier) : '';
        const detectedCondition = effectiveCondition || '(none detected yet)';

        systemPrompt = `You are a grounded medical research assistant for decision support — NOT a generic chatbot. Every factual claim must trace to the GROUNDED EVIDENCE PACK, CANONICAL FACTS, REQUIRED MENTIONS, or PRIOR ANALYSES below.

${audienceLine(audience)}

=== DETECTED CONDITION ===
The user appears to be asking about: **${detectedCondition}**

PATIENT PROFILE:
${buildPatientContext(patient)}

${dossierInChat ? dossierInChat + '\n\n' : ''}${chatCanonical ? chatCanonical + '\n\n' : ''}${chatRequired ? chatRequired + '\n\n' : ''}${hasPriors ? priorPieces.join('\n\n') + '\n\n' : ''}${chatGrounding || '=== GROUNDED EVIDENCE PACK ===\n(No literature loaded — say you need the user to run Full Research first, or answer only from REQUIRED MENTIONS / CANONICAL FACTS above if present. Do NOT invent treatments.)\n=== END ===\n\n'}${chatGroundingRules(detectedCondition)}

${SHARED_GUARDRAILS}

=== RESPONSE SHAPE ===
- Answer the user's question directly in the first sentence.
- Use markdown bullets. Bold drug and trial names.
- For "why wasn't X mentioned" follow rule 3 in CHAT GROUNDING RULES.
- End with one line: "Run Full Research on the Profile tab for a complete personalized report with live PubMed pull."
- Keep disclaimers to one short line at the end.`;
        break;
      }
      case 'research':
      default: {
        // Research mode is split across two Claude calls (half='front'
        // + half='back') so each fits under Vercel's 60s cap and
        // neither hits stop_reason=max_tokens mid-answer.
        const baseStatic = half === 'back'
          ? RESEARCH_PROMPT_BACK_STATIC
          : RESEARCH_PROMPT_FRONT_STATIC;
        systemBlocks = [
          { type: 'text', text: baseStatic, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildDynamicHeader(patient, audience, 'research') + (extraContext ? `\n\n${extraContext}` : '') }
        ];
        break;
      }
    }

    const synthUserQuery = (() => {
      if (userQuery) return userQuery;
      if (mode === 'repurpose' && phase === 'synthesize' && half === 'back') {
        // Runs in parallel with the candidate list — derive combinations from
        // the evidence pack + standard-of-care, not from a Part 1 list.
        return 'Produce Part 2 only: combination candidates + reasoning summary + "What This Is NOT" disclaimer. Derive combinations from supplements and drugs that appear in the grounded evidence pack (especially the OTC / SUPPLEMENT LITERATURE block) plus standard-of-care. Do NOT output individual CANDIDATE blocks.';
      }
      if (isRepurposeBatch) {
        const laneIdx = Math.max(0, Math.min(REPURPOSE_LANES.length - 1, Number(batchLane) || 0));
        const count = Math.max(1, Math.min(8, Number(batchSize) || 4));
        return `Produce EXACTLY ${count} CANDIDATE blocks, and ONLY for this lane:\n${REPURPOSE_LANES[laneIdx]}\n\nDo not output any candidate that belongs to a different lane. No combinations, no summary, no preamble — just the ${count} CANDIDATE blocks.`;
      }
      if (mode === 'repurpose' && phase === 'synthesize' && half === 'front') {
        return 'Produce Part 1 only: ranked CANDIDATE blocks (mechanistic/preclinical first, then published-support). No combinations or summary.';
      }
      return `Please perform the ${mode} analysis now for the patient profile above.`;
    })();
    const messages = [
      ...chatHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: synthUserQuery }
    ];

    const anthropic = await callAnthropicMessages({
      model,
      maxTokens,
      system: systemBlocks || systemPrompt,
      messages,
      apiKey
    });

    if (!anthropic.ok) {
      const { response, errorData } = anthropic;
      console.error('Anthropic API error:', errorData);
      const msg =
        errorData?.error?.message ||
        errorData?.error?.type ||
        (typeof errorData?.error === 'string' ? errorData.error : null) ||
        `Claude API failed (HTTP ${response?.status})`;
      const hint = isModelNotFoundError(response?.status, errorData)
        ? ` Set ANTHROPIC_RESEARCH_MODEL in Vercel to a model your key supports (e.g. claude-sonnet-4-6).`
        : '';
      return res.status(response?.status >= 500 ? 502 : (response?.status || 502)).json({
        error: `${msg}${hint}`,
        details: errorData,
        modelAttempted: anthropic.model
      });
    }

    if (anthropic.model !== model) {
      console.warn(`[research] synthesis used fallback model ${anthropic.model} (requested ${model})`);
    }
    const data = anthropic.data;

    // Extract Claude's text so we can feed it to the cross-validator.
    let claudeText = (data.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join('\n\n');

    if (isRepurposeBatch && isLaneTruncated(data, claudeText)) {
      console.warn(
        `[research] repurpose lane ${batchLane} truncated: stop=${data.stop_reason || '?'} candidates=${countCandidateBlocks(claudeText)}`
      );
    }

    if ((mode === 'research' || mode === 'repurpose') && evidence) {
      const filtered = filterExcludedAgentMentions(claudeText, evidence);
      if (filtered !== claudeText) {
        console.warn('[research] stripped excluded-agent content from output');
        claudeText = filtered;
        if (data.content?.length) {
          data.content = data.content.map((c, i) =>
            i === 0 && c?.type === 'text' ? { ...c, text: filtered } : c
          );
        }
      }
      claudeText = finalizeReportText(claudeText, { evidence, trials });
      if (data.content?.length) {
        const lastText = data.content.findIndex((c) => c?.type === 'text');
        if (lastText >= 0) data.content[lastText] = { ...data.content[lastText], text: claudeText };
      }
    }

    // === Post-synthesis coverage audit ===
    // Scan the output for every pipelineDrug in the evidence pack's
    // KB-derived list. If any is missing, force Claude to rewrite with
    // the missing drugs inserted. This is the failsafe below the REQUIRED
    // MENTIONS prompt directive — if the model ignored the directive we
    // still catch it.
    //
    // Limit: one re-prompt attempt. Two reasons:
    //   (a) Vercel Hobby has a hard 60s per-invocation cap; a second
    //       Claude call already pushes the budget.
    //   (b) If two attempts both miss the drug, that's a signal the drug
    //       is genuinely borderline for this patient — log it and move on.
    //
    // Only runs for research + repurpose modes where the pipelineDrugs
    // list is meaningful. Skipped for pure chat and for the trials mode
    // (which is a separate analysis shape).
    const isSynthesisMode = (mode === 'research' || mode === 'repurpose');
    const allPipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];

    // Segment by which synthesis half is responsible for each agent.
    //   RESEARCH mode, split synthesis:
    //     - FRONT half (sections 1-3): FDA-approved standard-of-care agents.
    //     - BACK half  (sections 4-8): investigational, pipeline, discontinued,
    //                                  pivotal-negative agents.
    //   REPURPOSE mode: the analysis is candidate-oriented, not section-oriented.
    //     We audit only investigational/pipeline agents — approved drugs are
    //     what the patient is already on and aren't "repurposing candidates".
    //   If `half` is undefined (single-shot research mode), audit everything.
    const pipelineDrugs = (() => {
      if (mode === 'repurpose') {
        // Batched front calls each produce only ~4 candidates for one lane,
        // so a per-batch coverage audit would flag almost every pipeline drug
        // as "missed" and trigger a needless forced full rewrite on each
        // batch — defeating the whole point of batching. Skip it; coverage is
        // spread across the lanes (lane D explicitly forces studied/excluded
        // agents) and the single-shot fallback still audits.
        if (isRepurposeBatch) return [];
        // Repurpose synthesis is split into a candidate list (front) and a
        // combinations section (back) that run in PARALLEL. Pipeline-drug
        // coverage belongs to the candidate list; the combinations section
        // is not expected to name every investigational agent, so auditing
        // it would trigger a needless forced rewrite. Audit front only.
        if (half === 'back') return [];
        return allPipelineDrugs.filter((d) => d.approvalStatus !== 'approved');
      }
      if (mode !== 'research' || !half) return allPipelineDrugs;
      if (half === 'front') {
        return allPipelineDrugs.filter((d) => d.approvalStatus === 'approved');
      }
      return allPipelineDrugs.filter((d) => d.approvalStatus !== 'approved');
    })();

    let coverageAudit = null;
    if (isSynthesisMode && pipelineDrugs.length && claudeText) {
      const initialMissed = scanForMissedPipelineDrugs(claudeText, pipelineDrugs);
      coverageAudit = {
        half: half || 'single-shot',
        pipelineDrugsAudited: pipelineDrugs.length,
        pipelineDrugsTotal: allPipelineDrugs.length,
        initialMissed: initialMissed.map((d) => d.name),
        reprompted: false,
        finalMissed: initialMissed.map((d) => d.name)
      };
      if (initialMissed.length > 0) {
        // Research split synthesis: skip forced rewrite on BOTH halves. A second
        // Claude call was pushing back-half runs past ~180s and surfacing as
        // FUNCTION_INVOCATION_FAILED / gateway errors on live demos. REQUIRED
        // MENTIONS + the pipeline list in the evidence pack still guide coverage.
        const skipReprompt = mode === 'research';
        if (!skipReprompt) {
        // Construct a targeted re-prompt. We don't send the whole system
        // prompt again — we send the previous draft plus a directive that
        // calls out the missed drugs by name.
        const missedSummary = initialMissed.map((d) => {
          const aliases = d.aliases?.length ? ` (aka ${d.aliases.join(', ')})` : '';
          const bits = [d.mechanism, d.sponsor, d.status, d.nct ? `NCT ${d.nct}` : null, d.pmid ? `PMID ${d.pmid}` : null]
            .filter(Boolean).join(' · ');
          return `- **${d.name}**${aliases}: ${bits}. ${d.whyItMatters || ''}`;
        }).join('\n');

        const repromptDirective = `=== COVERAGE AUDIT FAILURE — FORCED REWRITE ===
Your previous draft FAILED the mandatory pipeline-drug coverage audit. The following agents were in the REQUIRED MENTIONS list but were NOT mentioned in your output. You MUST rewrite and return the complete analysis with each of these agents inserted in the appropriate section. Do not produce a partial response.

MISSED AGENTS:
${missedSummary}

Where they must go:
- FDA-approved agents → Section 3 (Approved Treatments)
- Phase 3 / phase 2b investigational agents → Section 4 (Clinical Trials & Access Programs) or Section 5 (Pipeline Watch)
- Discontinued or pivotal-negative agents → Section 8 (Safety Considerations Reported in Literature)

Return the full corrected analysis now, beginning again at "## 1." (front half) or "## 4." (back half) depending on which half you are generating.`;

        // Build the reprompt system in the same shape as the original — if
        // the original used cached blocks, keep them cached on the reprompt
        // (same 5-minute cache key) so we only pay for the appended
        // directive as fresh input tokens.
        const repromptSystem = systemBlocks
          ? [
              ...systemBlocks,
              { type: 'text', text: repromptDirective }
            ]
          : `${systemPrompt}\n\n${repromptDirective}`;

        try {
          const reprompt = await callAnthropicMessages({
            model,
            maxTokens,
            system: repromptSystem,
            messages,
            apiKey
          });
          if (reprompt.ok) {
            const repromptData = reprompt.data;
            const rewritten = (repromptData.content || [])
              .filter((c) => c?.type === 'text')
              .map((c) => c.text)
              .join('\n\n');
            if (rewritten) {
              claudeText = rewritten;
              coverageAudit.reprompted = true;
              coverageAudit.finalMissed = scanForMissedPipelineDrugs(rewritten, pipelineDrugs).map((d) => d.name);
              // Replace the content in the response so the UI renders the
              // corrected analysis, not the first draft.
              data.content = repromptData.content;
            }
          }
        } catch (err) {
          console.error('[research] coverage-audit reprompt failed:', err.message);
        }
        }
      }
    }

    // Append the deterministic "Agents evaluated" transparency block so
    // the user can always see which agents were in the consideration set
    // and whether they made it into the analysis. This is programmatic —
    // not generated by Claude — so it can't be hallucinated.
    //
    // Append once per run, on the half that actually contains the audited
    // agents so the "discussed?" flags are accurate:
    //   - research: BACK half (appended last by the client) or single-shot.
    //   - repurpose: FRONT half (the candidate list); front + back run in
    //     parallel, so the back combinations text can't see the candidates.
    // Transparency block ("NOT DISCUSSED" appendix) disabled — reads like the
    // search failed on patient reports. Coverage audit still runs server-side.
    const shouldAppendTransparency = false;
    if (shouldAppendTransparency) {
      const textForScan = priorText ? `${priorText}\n\n${claudeText}` : claudeText;
      const transparencyBlock = buildAgentsEvaluatedBlock(textForScan, evidence);
      if (transparencyBlock) {
        claudeText = claudeText + transparencyBlock;
        if (data.content && data.content.length) {
          const last = data.content[data.content.length - 1];
          if (last && last.type === 'text') {
            last.text = (last.text || '') + transparencyBlock;
          } else {
            data.content.push({ type: 'text', text: transparencyBlock });
          }
        }
      }
    }

    // Cross-validation: independent second AI (Perplexity / OpenAI / xAI)
    // audits Claude's output against the same evidence pack. ON by default on
    // Vercel Pro (300s cap). Two-phase research/repurpose validates via
    // polish-report after the client stitches halves. Pass validate:false to skip.
    let validation = null;
    const wantValidation = shouldAutoValidate(mode, phase, half, isRepurposeBatch, req.body);
    const hasAnyValidatorKey =
      !!process.env.PERPLEXITY_API_KEY ||
      !!process.env.OPENAI_API_KEY ||
      !!process.env.XAI_API_KEY;
    if (wantValidation && claudeText && hasAnyValidatorKey && isSpendEnabled()) {
      try {
        validation = await invokeValidate({
          analysisText: claudeText,
          evidencePack: (evidence?.groundedForPrompt || []).slice(0, 18),
          patient,
          condition: patient.condition || '',
          audience
        });
      } catch (err) {
        console.error('[research] inline validation failed (non-fatal):', err.message);
        validation = null;
      }
    }

    return res.status(200).json({
      ...data,
      model: anthropic.model,
      modelRequested: model !== anthropic.model ? model : undefined,
      maxTokens,
      dossier: dossier
        ? {
            canonical: dossier.canonical,
            synonyms: dossier.synonyms,
            meshTerms: dossier.meshTerms,
            icd10: dossier.icd10,
            subspecialty: dossier.subspecialty,
            topCenters: dossier.topCenters || [],
            keyInvestigators: dossier.keyInvestigators || [],
            patientAdvocacy: dossier.patientAdvocacy || [],
            landmarkTrials: dossier.landmarkTrials || [],
            commonComorbidities: dossier.commonComorbidities || [],
            redFlags: dossier.redFlags || [],
            lifestyleCategories: dossier.lifestyleCategories || [],
            uncertainty: dossier.uncertainty,
            notes: dossier.notes,
            cacheHit: dossier.cacheHit,
            cacheDisabled: dossier.cacheDisabled || false,
            generatedBy: dossier.generatedBy
          }
        : null,
      evidence: evidence
        ? {
            totalUnique: evidence.totalUnique,
            accessBreakdown: evidence.accessBreakdown,
            promptPackBreakdown: evidence.promptPackBreakdown,
            qualityBreakdown: evidence.qualityBreakdown,
            knowledgeBase: evidence.knowledgeBase,
            topRanked: (evidence.topRanked || []).slice(0, 50),
            groundedForPrompt: evidence.groundedForPrompt,
            fdaLabels: evidence.fdaLabels,
            fdaManufacturers: evidence.fdaManufacturers,
            pipelineDrugs: evidence.pipelineDrugs || [],
            excludedAgents: evidence.excludedAgents || []
          }
        : null,
      trials: trials
        ? {
            total: trials.total,
            breakdown: trials.breakdown,
            subQueries: trials.subQueries,
            studies: (trials.studies || []).slice(0, 25)
          }
        : null,
      coverageAudit,
      repurposeDrugScreen:
        mode === 'repurpose' && evidence?.repurposeDrugScreen
          ? evidence.repurposeDrugScreen
          : undefined,
      validationMismatch: detectValidationMismatch(
        validation,
        patient?.condition || effectiveCondition
      ),
      validation
    });
  } catch (error) {
    console.error('research.js error:', error);
    return res.status(500).json({
      error: error?.message || 'Internal server error',
      message: error?.message || 'Internal server error'
    });
  }
}
