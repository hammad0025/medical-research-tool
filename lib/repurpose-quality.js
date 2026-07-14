// Shared repurpose quality targets — used by client orchestration, server logs, and regression.

import { buildEvidenceUrlIndex, citationRelevantToSubject } from './grounding-gate.js';

export const REPURPOSE_LANE_COUNT = 3;
// Per-lane ASK. The lanes run in parallel and each proposes up to this many
// candidates; the model is told to prefer fewer well-grounded candidates over
// padding (see api/research.js). 3 lanes × 9 = 27 raw, trimmed to the soft cap
// of 25 so the final list can actually reach the Hard-25 linked floor.
export const REPURPOSE_PER_LANE = 9;
// Hard floor on the FINAL curated list: every displayed card must carry a REAL
// citation link (pack / CT.gov NCT / DailyMed). Quantity is still gated by
// quality — registry fill is MECHANISTIC_ONLY + DailyMed only, never fake papers.
export const REPURPOSE_TARGET_TOTAL = 25;
export const REPURPOSE_SOFT_CAP = 25;
/** @deprecated Prefer REPURPOSE_TARGET_TOTAL; kept for callers that still say "min". */
export const REPURPOSE_MIN_TOTAL = 25;
/**
 * Retry a lane when it returns fewer than this many CANDIDATE blocks.
 * Raised from 3 → 7 (Fix 2): with 3 lanes each asked for up to 9, a lane that
 * returns only 4-6 used to be accepted, leaving the merged list stuck near ~20.
 * A mid-sized lane now gets a second attempt so the final list can reach the
 * Hard-25 linked floor. This is a FLOOR for retry, not a quota.
 */
export const REPURPOSE_MIN_PER_LANE = 7;
/**
 * Backfill/top-up threshold (Hard 25): after cross-lane dedup + excluded-agent
 * filtering, if the REAL-linked distinct count is below this, keep topping up
 * (multi-pass, then registry fill). Equals the Hard-25 floor.
 */
export const REPURPOSE_BACKFILL_THRESHOLD = 25;
/** Cap on extra AI backfill calls after the initial lane fan-out (not counting registry fill).
 *  Keep this low: registry fill with real DailyMed setid labels finishes Hard-25
 *  without stacking multi-minute Claude calls that leave the UI stuck on
 *  "Looking for more drug ideas…" with zero cards shown. */
export const REPURPOSE_BACKFILL_MAX_PASSES = 1;

export const countCandidateBlocks = (text) =>
  (String(text || '').match(/^CANDIDATE:/gm) || []).length;

// Extract the leading drug/supplement name from every CANDIDATE block so a
// backfill pass can pass the already-used names to the model (avoid repeats)
// and so callers can measure the DISTINCT grounded candidate count. Mirrors the
// client de-dup key: drop parentheticals, cut at the first dash/colon/digit.
export const candidateNamesFromText = (text) => {
  const names = [];
  for (const m of String(text || '').matchAll(/^CANDIDATE:\s*(.+)$/gim)) {
    const raw = String(m[1] || '').replace(/\*/g, '').trim();
    if (raw) names.push(raw);
  }
  return names;
};

export const candidateDedupKey = (name) =>
  String(name || '')
    .replace(/\*/g, '')
    .replace(/\(.*?\)/g, ' ')
    .split(/[—–\-:|/]|\d/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();

export const distinctCandidateCount = (text) => {
  const keys = new Set();
  for (const n of candidateNamesFromText(text)) {
    const k = candidateDedupKey(n);
    if (k) keys.add(k);
  }
  return keys.size;
};

/**
 * Should we run a backfill top-up pass? True when the distinct REAL-linked
 * candidate count is short of the Hard-25 floor AND something was produced
 * (empty is a hard failure elsewhere). Defaults to REPURPOSE_BACKFILL_THRESHOLD.
 */
export const needsBackfill = (distinctCount, threshold = REPURPOSE_BACKFILL_THRESHOLD) =>
  distinctCount > 0 && distinctCount < threshold;

// ---------------------------------------------------------------------------
// REAL citation links (Hard 25 gate)
//
// A URL counts toward the Hard-25 floor only if it is:
//   1. ClinicalTrials.gov /study/NCT######## (or pack URL that looks like one),
//   2. A SPECIFIC DailyMed label monograph (drugInfo.cfm?setid=…) for a drug,
//   3. Otherwise any http(s) URL that is NOT a Google search or DailyMed search.
// Google-search-only and DailyMed SEARCH pages MUST NEVER count as a citation
// for Hard 25 (a search results page is not a source). Dead/invented deep links
// are stripped earlier by sanitize + removeDeadLinks; what remains here after
// sanitization is treated as real enough for the count.
// ---------------------------------------------------------------------------

export const isGoogleSearchUrl = (url) =>
  /^https?:\/\/(www\.)?google\.[a-z.]+\/search\b/i.test(String(url || ''));

// A DailyMed SEARCH results page — never an authoritative label, never a
// citation (client mandate; query=minoxidil returns 1,576 mostly third-party
// packager entries). Only a specific label monograph (drugInfo.cfm?setid=…)
// counts as a real DailyMed citation.
export const isDailyMedSearchUrl = (url) =>
  /^https?:\/\/(www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm/i.test(String(url || ''));

export const isDailyMedLabelUrl = (url) =>
  /^https?:\/\/(www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=[^&\s)]+/i.test(String(url || ''));

export const isClinicalTrialsStudyUrl = (url) =>
  /^https?:\/\/(www\.)?clinicaltrials\.gov\/study\/NCT\d{8}\b/i.test(String(url || ''));

/**
 * @deprecated DailyMed SEARCH pages are no longer acceptable citations. Kept
 * only so legacy callers do not throw; the result will NOT count toward Hard 25
 * (isRealCitationUrl rejects it). Resolve a specific setid label URL instead.
 */
export const dailyMedSearchUrl = (drugName) => {
  const q = encodeURIComponent(String(drugName || '').trim());
  return `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${q}`;
};

/** Specific DailyMed label monograph URL from an SPL setid (the ONLY OK form). */
export const dailyMedLabelUrl = (setid) => {
  const id = String(setid || '').trim();
  return id ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(id)}` : '';
};

/**
 * True when `url` is acceptable as a REAL source citation for Hard 25.
 * Google search never qualifies. A DailyMed SEARCH page never qualifies (only
 * a specific drugInfo.cfm?setid= label does). Empty/non-http never qualifies.
 */
export const isRealCitationUrl = (url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (isGoogleSearchUrl(u)) return false;
  if (isDailyMedSearchUrl(u)) return false;
  return true;
};

/** Pull http(s) URLs from a REFERENCES / SUPPORTING_EVIDENCE blob. */
export const extractCitationUrls = (blob) => {
  const urls = [];
  const s = String(blob || '');
  const mdRe = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = mdRe.exec(s)) !== null) urls.push(m[1].trim().replace(/[.,;)]+$/, ''));
  const bareRe = /(?<![(\[])(https?:\/\/[^\s)\]"'<>]+)/g;
  while ((m = bareRe.exec(s)) !== null) urls.push(m[1].trim().replace(/[.,;)]+$/, ''));
  return urls;
};

// Subject (drug/supplement name) a candidate block/object is about — used to
// check that a citation URL is RELEVANT (its source mentions the drug), not
// merely real. Strips markdown emphasis and any trailing dash/colon qualifier.
const candidateSubject = (nameOrBlock) => {
  const s = String(nameOrBlock || '');
  const m = s.match(/^CANDIDATE:\s*(.+)$/im);
  const raw = m ? m[1] : s;
  return String(raw).replace(/\*/g, '').split(/[—–\-:|\n]/)[0].trim();
};

// Does at least one REAL citation URL survive relevance to `subject`? When a
// `urlIndex` (from buildEvidenceUrlIndex) is supplied, a real URL whose source
// text is KNOWN and does NOT mention the subject (citationRelevantToSubject ===
// false) does NOT count — an off-topic live link is not a valid citation. URLs
// we cannot resolve to source text (null) still count, so the Hard-25 floor is
// never lowered by links we simply cannot verify. Condition-agnostic.
const someRealAndRelevant = (urls, subject, urlIndex) =>
  urls.some((u) => {
    if (!isRealCitationUrl(u)) return false;
    if (!urlIndex || !urlIndex.size) return true;
    return citationRelevantToSubject(u, subject, urlIndex) !== false;
  });

/**
 * A candidate/card counts toward Hard 25 when it carries ≥1 REAL citation URL
 * in references or supporting_evidence (Google alone does not count). When
 * `urlIndex` is supplied, the citation must ALSO be relevant to the candidate's
 * drug (an off-topic-but-live source does not count).
 */
export const candidateHasRealCitation = (candidate = {}, urlIndex = null) => {
  const blob = `${candidate.references || ''} ${candidate.supporting_evidence || ''}`;
  const subject = candidateSubject(candidate.name || candidate.drug || '');
  return someRealAndRelevant(extractCitationUrls(blob), subject, urlIndex);
};

export const textHasRealCitation = (blockText, urlIndex = null) =>
  someRealAndRelevant(extractCitationUrls(blockText), candidateSubject(blockText), urlIndex);

/**
 * Split merged CANDIDATE markdown into per-candidate blocks (raw text chunks).
 */
export const splitCandidateBlocks = (text) => {
  const s = String(text || '');
  const parts = s.split(/(?=^CANDIDATE:\s)/gim).filter((p) => /^CANDIDATE:/im.test(p));
  return parts.map((p) => p.trim()).filter(Boolean);
};

/**
 * Count DISTINCT candidates that each carry at least one REAL citation link.
 */
export const distinctLinkedCandidateCount = (text, evidence = null) => {
  const urlIndex = evidence ? buildEvidenceUrlIndex(evidence) : null;
  const keys = new Set();
  for (const block of splitCandidateBlocks(text)) {
    if (!textHasRealCitation(block, urlIndex)) continue;
    const nameMatch = block.match(/^CANDIDATE:\s*(.+)$/im);
    const k = candidateDedupKey(nameMatch?.[1] || '');
    if (k) keys.add(k);
  }
  return keys.size;
};

/**
 * Build a MECHANISTIC_ONLY registry-fill CANDIDATE block with DailyMed only.
 * Never invents a paper/DOI/PMID URL.
 */
export const buildRegistryFillCandidate = (drug, { condition = '', labelUrl = '' } = {}) => {
  const name = String(drug?.name || drug || '').trim();
  if (!name) return '';
  const mechanism = String(drug?.mechanism || drug?.drugClass || '').trim();
  const cond = String(condition || 'this condition').trim() || 'this condition';
  // Client mandate: NEVER attach a DailyMed SEARCH link as a citation. Only a
  // resolved specific label monograph (drugInfo.cfm?setid=…) may be linked; if
  // none is available, the reference is PLAIN TEXT (no fabricated link).
  const specificLabel = isDailyMedLabelUrl(labelUrl) ? String(labelUrl).trim() : '';
  const referencesLine = specificLabel
    ? `REFERENCES: [FDA label for ${name} (DailyMed)](${specificLabel})`
    : `REFERENCES: FDA DailyMed label for ${name} — look it up by name on DailyMed. No specific study for ${cond} was available in this run, so no citation link is attached (a search page is not a source).`;
  const why = mechanism
    ? `• FDA-tracked medication from the open drug library (${mechanism}).\n• No published trial for ${cond} in this run's evidence pack — labeled MECHANISTIC_ONLY on purpose.\n• Discuss with a physician; this is an educational hypothesis, not a recommendation.`
    : `• FDA-tracked medication from the open drug library, included to reach a full list of ideas when literature for ${cond} is thin.\n• No published trial for ${cond} in this run's evidence pack — labeled MECHANISTIC_ONLY on purpose.\n• Discuss with a physician; this is an educational hypothesis, not a recommendation.`;
  return `CANDIDATE: ${name}
CLASS: FDA-tracked medication (library fill)
APPROVED_FOR: Other FDA-listed uses (see DailyMed) — not established for ${cond}
WHAT_IT_DOES: An already-marketed medicine from the curated drug library; see DailyMed for its labeled uses.
WHY_FOR_THIS_CONDITION: Library fill for a thin evidence pack — pathway overlap is a hypothesis only.
MECHANISM_TARGET: ${mechanism || 'See DailyMed label for named targets'}
REPURPOSE_RATIONALE:
${why}
EVIDENCE_STRENGTH: MECHANISTIC_ONLY
SUPPORTING_EVIDENCE: No human study for ${cond} was available in the grounded pack for this run — and a DailyMed search page is not a source, so no citation link is fabricated.
${referencesLine}
EFFICACY_HYPOTHESIS: No human efficacy results yet for this condition — the reason to list it is library/pathway overlap, not a measured benefit.
SAFETY: 50% — labeled safety is on DailyMed; condition-specific safety is unknown without studies
CONFIDENCE: 25% — mechanistic library fill only; not backed by a trial for this condition
PATIENT_SPECIFIC_RISKS: Confirm identity, dose, and interactions with the prescribing physician before considering any change.
HOW_TO_DISCUSS_WITH_DOCTOR: Ask whether any mechanism for ${cond} makes this drug worth watching in the literature — do not start it based on this list alone.`;
};

/**
 * Append registry-fill candidates until linked distinct count reaches `target`.
 * `pool` is an array of { name, mechanism? } or bare name strings; skips names
 * already present (by dedup key) and excluded keys.
 */
export const appendRegistryFill = (
  text,
  pool = [],
  { condition = '', target = REPURPOSE_TARGET_TOTAL, excludedKeys = [] } = {}
) => {
  const excluded = new Set(
    (excludedKeys || []).map(candidateDedupKey).filter(Boolean)
  );
  let out = String(text || '');
  const used = new Set();
  for (const n of candidateNamesFromText(out)) {
    const k = candidateDedupKey(n);
    if (k) used.add(k);
  }
  let linked = distinctLinkedCandidateCount(out);
  if (linked >= target) return { text: out, filled: 0, linked };

  let filled = 0;
  for (const drug of pool) {
    if (linked >= target) break;
    const name = typeof drug === 'string' ? drug : drug?.name;
    const k = candidateDedupKey(name);
    if (!k || used.has(k) || excluded.has(k)) continue;
    const shape = typeof drug === 'string' ? { name } : drug;
    const labelUrl =
      shape?.dailyMedUrl || shape?.labelUrl || shape?.dailyMedLabelUrl || '';
    const block = buildRegistryFillCandidate(shape, { condition, labelUrl });
    if (!block || !textHasRealCitation(block)) continue;
    out = out ? `${out.trim()}\n\n${block}` : block;
    used.add(k);
    filled += 1;
    linked += 1;
  }
  return { text: out, filled, linked };
};

export const textFromAnthropicResponse = (response) =>
  (response?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');

export const isLaneTruncated = (response, text = null) => {
  const body = text ?? textFromAnthropicResponse(response);
  const stop = response?.stop_reason || response?.stopReason || '';
  if (stop === 'max_tokens') return true;
  return countCandidateBlocks(body) < REPURPOSE_MIN_PER_LANE;
};

/**
 * Assess merged lane quality. Hard 25: `ok` requires ≥25 distinct candidates
 * that each carry a REAL citation (not Google-only). Pass plain lane texts;
 * when `linkedCount` is provided (client after parse), it overrides the text scan.
 */
export const assessRepurposeQuality = (laneTexts = [], opts = {}) => {
  const perLane = laneTexts.map((t) => countCandidateBlocks(t));
  const total = perLane.reduce((n, c) => n + c, 0);
  const merged = laneTexts.join('\n\n');
  const linked =
    opts.linkedCount != null
      ? Number(opts.linkedCount)
      : distinctLinkedCandidateCount(merged);
  const floor = opts.floor != null ? Number(opts.floor) : REPURPOSE_TARGET_TOTAL;
  return {
    perLane,
    total,
    linked,
    target: REPURPOSE_TARGET_TOTAL,
    minAcceptable: floor,
    ok: linked >= floor,
    shortfall: Math.max(0, floor - linked)
  };
};
