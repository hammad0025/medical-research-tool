// Shared repurpose quality targets — used by client orchestration, server logs, and regression.

import { buildEvidenceUrlIndex, citationRelevantToSubject } from './grounding-gate.js';

export const REPURPOSE_LANE_COUNT = 3;
// Per-lane ASK. Each lane proposes up to this many candidates split across the
// two Dorothy sections (~half never-researched, ~half researched-not-approved).
// 3 lanes × 18 = 54 raw, trimmed to the soft cap of 50 (~25 per section).
export const REPURPOSE_PER_LANE = 18;
/** Soft target per Dorothy section (never-researched / researched-not-approved). */
export const REPURPOSE_SECTION_TARGET = 0;
// No medically unsupported candidate quota. A label for another indication is
// not condition-specific evidence and must not be used to fill an arbitrary count.
export const REPURPOSE_TARGET_TOTAL = 0;
export const REPURPOSE_SOFT_CAP = 50;
/** @deprecated Prefer REPURPOSE_TARGET_TOTAL; kept for callers that still say "min". */
export const REPURPOSE_MIN_TOTAL = 1;
/**
 * Retry a lane when it returns fewer than this many CANDIDATE blocks.
 * With 3 lanes each asked for up to 18, accept mid-sized lanes with a second
 * attempt so the merged list can reach the Hard-50 linked floor.
 */
export const REPURPOSE_MIN_PER_LANE = 12;
/**
 * Backfill/top-up threshold: after cross-lane dedup + excluded-agent
 * filtering, if the REAL-linked distinct count is below this, keep topping up
 * (multi-pass, then registry fill). Equals the Hard-50 floor.
 */
export const REPURPOSE_BACKFILL_THRESHOLD = 0;
/** Cap on extra AI backfill calls after the initial lane fan-out (not counting registry fill).
 *  Keep this low: registry fill with real DailyMed setid labels finishes Hard-50
 *  without stacking multi-minute Claude calls that leave the UI stuck on
 *  "Looking for more drug ideas…" with zero cards shown. */
export const REPURPOSE_BACKFILL_MAX_PASSES = 1;

/** Explicit parser/UI section tags emitted on every CANDIDATE block. */
export const REPURPOSE_SECTION_NEVER = 'never-researched';
export const REPURPOSE_SECTION_RESEARCHED = 'researched-not-approved';

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
 * Resolve Dorothy section for a candidate block/object.
 * Prefer explicit REPURPOSE_SECTION; otherwise infer from EVIDENCE_STRENGTH:
 * MECHANISTIC_ONLY → never-researched; any condition-linked tier → researched.
 */
export const resolveRepurposeSection = (blockOrFields = {}) => {
  const blob = typeof blockOrFields === 'string'
    ? blockOrFields
    : [
        blockOrFields.repurpose_section,
        blockOrFields.REPURPOSE_SECTION,
        blockOrFields.evidence_strength,
        blockOrFields.EVIDENCE_STRENGTH,
        ''
      ].join('\n');
  const tagged = String(
    (typeof blockOrFields === 'object' && (blockOrFields.repurpose_section || blockOrFields.REPURPOSE_SECTION)) ||
    (String(blob).match(/^REPURPOSE_SECTION:\s*(\S+)/im) || [])[1] ||
    ''
  ).toLowerCase().trim();
  if (tagged.includes('never')) return REPURPOSE_SECTION_NEVER;
  if (tagged.includes('researched')) return REPURPOSE_SECTION_RESEARCHED;
  const strength = String(
    (typeof blockOrFields === 'object' && (blockOrFields.evidence_strength || blockOrFields.EVIDENCE_STRENGTH)) ||
    (String(blob).match(/^EVIDENCE_STRENGTH:\s*(.+)$/im) || [])[1] ||
    ''
  ).toUpperCase();
  if (strength.includes('MECHANISTIC_ONLY')) return REPURPOSE_SECTION_NEVER;
  if (/PRECLINICAL|CASE_REPORT|OBSERVATIONAL|SMALL_RCT|LARGE_RCT/.test(strength)) {
    return REPURPOSE_SECTION_RESEARCHED;
  }
  return REPURPOSE_SECTION_NEVER;
};

/** SUPPLEMENT | MEDICATION — prefer ITEM_KIND; else infer from CLASS text. */
export const resolveItemKind = (blockOrFields = {}) => {
  const blob = typeof blockOrFields === 'string'
    ? blockOrFields
    : [
        blockOrFields.item_kind,
        blockOrFields.ITEM_KIND,
        blockOrFields.class,
        blockOrFields.CLASS,
        blockOrFields.candidate,
        ''
      ].join('\n');
  const tagged = String(
    (typeof blockOrFields === 'object' && (blockOrFields.item_kind || blockOrFields.ITEM_KIND)) ||
    (String(blob).match(/^ITEM_KIND:\s*(\S+)/im) || [])[1] ||
    ''
  ).toUpperCase().trim();
  if (tagged.includes('SUPPLEMENT')) return 'SUPPLEMENT';
  if (tagged.includes('MEDICATION') || tagged.includes('DRUG')) return 'MEDICATION';
  const classLine = String(
    (typeof blockOrFields === 'object' && (blockOrFields.class || blockOrFields.CLASS)) ||
    (String(blob).match(/^CLASS:\s*(.+)$/im) || [])[1] ||
    ''
  ).toLowerCase();
  if (/\b(supplement|vitamin|mineral|antioxidant|nutraceutical|herbal|otc|over[- ]the[- ]counter)\b/.test(classLine)) {
    return 'SUPPLEMENT';
  }
  return 'MEDICATION';
};

/**
 * Should we run a backfill top-up pass? True when the distinct REAL-linked
 * candidate count is short of the Hard-50 floor AND something was produced
 * (empty is a hard failure elsewhere). Defaults to REPURPOSE_BACKFILL_THRESHOLD.
 */
export const needsBackfill = (distinctCount, threshold = REPURPOSE_BACKFILL_THRESHOLD) =>
  threshold > 0 && distinctCount > 0 && distinctCount < threshold;

// ---------------------------------------------------------------------------
// REAL citation links (Hard 50 gate)
//
// A URL counts toward the Hard-50 floor only if it is:
//   1. ClinicalTrials.gov /study/NCT######## (or pack URL that looks like one),
//   2. A SPECIFIC DailyMed label monograph (drugInfo.cfm?setid=…) for a drug,
//   3. Otherwise any http(s) URL that is NOT a Google search or DailyMed search.
// Google-search-only and DailyMed SEARCH pages MUST NEVER count as a citation
// for Hard 50 (a search results page is not a source). Dead/invented deep links
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
 * only so legacy callers do not throw; the result will NOT count toward Hard 50
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
 * True when `url` is acceptable as a REAL source citation for Hard 50.
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
// we cannot resolve to source text (null) still count, so the Hard-50 floor is
// never lowered by links we simply cannot verify. Condition-agnostic.
const someRealAndRelevant = (urls, subject, urlIndex) =>
  urls.some((u) => {
    if (!isRealCitationUrl(u)) return false;
    if (!urlIndex || !urlIndex.size) return true;
    return citationRelevantToSubject(u, subject, urlIndex) !== false;
  });

/**
 * A candidate/card counts toward Hard 50 when it carries ≥1 REAL citation URL
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

/** Distinct linked counts split by Dorothy section. */
export const distinctLinkedCountBySection = (text, evidence = null) => {
  const urlIndex = evidence ? buildEvidenceUrlIndex(evidence) : null;
  const never = new Set();
  const researched = new Set();
  for (const block of splitCandidateBlocks(text)) {
    if (!textHasRealCitation(block, urlIndex)) continue;
    const nameMatch = block.match(/^CANDIDATE:\s*(.+)$/im);
    const k = candidateDedupKey(nameMatch?.[1] || '');
    if (!k) continue;
    if (resolveRepurposeSection(block) === REPURPOSE_SECTION_RESEARCHED) researched.add(k);
    else never.add(k);
  }
  return {
    neverResearched: never.size,
    researchedNotApproved: researched.size,
    total: never.size + researched.size
  };
};

/**
 * Build a MECHANISTIC_ONLY registry-fill CANDIDATE block with DailyMed only.
 * Never invents a paper/DOI/PMID URL. Tagged as Section 1 (never-researched).
 */
export const buildRegistryFillCandidate = (drug, { condition = '', labelUrl = '' } = {}) => {
  // A drug-registry entry and label establish identity and labeled use only.
  // They do not establish a pathway match or efficacy hypothesis for `condition`.
  // Returning no card prevents quota-driven, unsupported medical suggestions.
  void drug;
  void condition;
  void labelUrl;
  return '';
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
 * Assess merged lane quality. Hard 50: `ok` requires ≥50 distinct candidates
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
  const floor = opts.floor != null ? Number(opts.floor) : REPURPOSE_MIN_TOTAL;
  const bySection = distinctLinkedCountBySection(merged);
  return {
    perLane,
    total,
    linked,
    bySection,
    target: REPURPOSE_TARGET_TOTAL,
    sectionTarget: REPURPOSE_SECTION_TARGET,
    minAcceptable: floor,
    ok: linked >= floor,
    shortfall: Math.max(0, floor - linked)
  };
};
