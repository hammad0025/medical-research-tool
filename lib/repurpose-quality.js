// Shared repurpose quality targets — used by client orchestration, server logs, and regression.

import { buildEvidenceUrlIndex, citationRelevantToSubject } from './grounding-gate.js';
import {
  isGoogleSearchUrl,
  isDailyMedSearchUrl,
  isDailyMedLabelUrl
} from './citation-gate.js';

export { isGoogleSearchUrl, isDailyMedSearchUrl, isDailyMedLabelUrl };

// Four lanes: three by drug category, plus a dedicated lane for agents already
// studied for the condition. See REPURPOSE_LANES in api/research.js.
export const REPURPOSE_LANE_COUNT = 4;
/** Lane index whose entire output is researched-not-approved. */
export const REPURPOSE_RESEARCHED_LANE = 3;
// Diversity fan-out, not a quota: each lane may return up to 7 supported
// candidates split across the two patient-facing sections (~10+10 total).
// Sized against the lane token budget in api/research.js (~350 tokens per
// candidate against a 9000-token Opus cap). Asking for more makes lanes hit
// stop_reason=max_tokens, which marks the lane truncated and re-runs the
// WHOLE lane — multiplying the wall clock without returning more ideas.
export const REPURPOSE_PER_LANE = 7;
/** Hard display cap per patient-facing section. 10 researched + 10 not. */
export const REPURPOSE_SECTION_DISPLAY_CAP = 10;
/** No minimum target per section. */
export const REPURPOSE_SECTION_TARGET = 0;
// No medically unsupported candidate quota. A label for another indication is
// not condition-specific evidence and must not be used to fill an arbitrary count.
export const REPURPOSE_TARGET_TOTAL = 0;
export const REPURPOSE_SOFT_CAP = REPURPOSE_LANE_COUNT * REPURPOSE_PER_LANE;
/** @deprecated Prefer REPURPOSE_TARGET_TOTAL; kept for callers that still say "min". */
export const REPURPOSE_MIN_TOTAL = 1;
/** Candidate count never triggers a retry. */
export const REPURPOSE_MIN_PER_LANE = 0;
/**
 * Backfill/top-up threshold: after cross-lane dedup + excluded-agent
 * filtering, if the REAL-linked distinct count is below this, keep topping up
 * (multi-pass, then registry fill). Equals the Hard-50 floor.
 */
export const REPURPOSE_BACKFILL_THRESHOLD = 0;
/** Quota-driven AI and registry backfill is disabled. */
export const REPURPOSE_BACKFILL_MAX_PASSES = 0;

/**
 * Explicit parser/UI section tags emitted on every CANDIDATE block.
 * Values match the client's category labels exactly (src/app.jsx is the
 * proven, live reference for this classification) so this module is a
 * drop-in for every consumer without changing any downstream comparison.
 */
export const REPURPOSE_SECTION_NEVER = 'no-condition-study-identified';
export const REPURPOSE_SECTION_RESEARCHED = 'researched-not-approved';
/** Untagged/unrecognized candidate — NOT the same as never-researched. This
 * bucket still requires a real citation before it may render or export;
 * only REPURPOSE_SECTION_NEVER is exempt from that requirement. */
export const REPURPOSE_SECTION_UNCLEAR = 'study-status-unclear';

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

// A candidate block reaches this function either as raw synthesis text or as
// text that polishReportForDisplay has already relabelled for the reader, so
// both spellings must resolve. Matching only the raw key made every polished
// candidate fall through to "unclear".
// True when the candidate's REFERENCES / SUPPORTING_EVIDENCE actually name the
// condition. Requires a real link on the line so a passing mention in prose
// cannot promote a candidate into the researched section.
const sourcesNameCondition = (blob, condition) => {
  const name = String(condition || '').trim().toLowerCase();
  if (!name || name.length < 4) return false;
  for (const line of String(blob || '').split('\n')) {
    const text = line.toLowerCase();
    if (!text.includes(name)) continue;
    if (/https?:\/\//.test(text)) return true;
  }
  return false;
};

const SECTION_TAG_RE = /^(?:REPURPOSE_SECTION|Research category):\s*(\S+)/im;
const STRENGTH_TAG_RE = /^(?:EVIDENCE_STRENGTH|Strength of research):\s*(.+)$/im;

/**
 * Resolve Dorothy section for a candidate block/object.
 * Prefer explicit REPURPOSE_SECTION; otherwise infer from EVIDENCE_STRENGTH:
 * MECHANISTIC_ONLY → never-researched; any condition-linked tier → researched.
 */
export const resolveRepurposeSection = (blockOrFields = {}, opts = {}) => {
  const blob = typeof blockOrFields === 'string'
    ? blockOrFields
    : [
        blockOrFields.repurpose_section,
        blockOrFields.REPURPOSE_SECTION,
        blockOrFields.evidence_strength,
        blockOrFields.EVIDENCE_STRENGTH,
        blockOrFields.references,
        blockOrFields.REFERENCES,
        blockOrFields.supporting_evidence,
        blockOrFields.SUPPORTING_EVIDENCE,
        ''
      ].join('\n');
  const tagged = String(
    (typeof blockOrFields === 'object' && (blockOrFields.repurpose_section || blockOrFields.REPURPOSE_SECTION)) ||
    (String(blob).match(SECTION_TAG_RE) || [])[1] ||
    ''
  ).toLowerCase().trim();
  // Extract EVIDENCE_STRENGTH early — MECHANISTIC_ONLY always means no
  // condition-specific study exists, regardless of what REPURPOSE_SECTION says.
  // This handles the case where Claude tags a candidate as "researched-not-approved"
  // but also marks EVIDENCE_STRENGTH: MECHANISTIC_ONLY (contradictory — trust the
  // evidence strength since it directly reflects the gathered sources).
  const strength = String(
    (typeof blockOrFields === 'object' && (blockOrFields.evidence_strength || blockOrFields.EVIDENCE_STRENGTH)) ||
    (String(blob).match(STRENGTH_TAG_RE) || [])[1] ||
    ''
  ).toUpperCase();
  // The no-condition-study section makes a factual claim to the reader: that
  // no study of this agent for this condition was found, and that the links
  // shown are NOT studies of it. When the candidate's own sources name the
  // condition, that claim is false — goji berries was filed there while
  // linking a 12-month study in patients with this very condition. Resolve
  // the contradiction from the sources rather than from the tag, so a
  // candidate whose sources are about other conditions still stays put.
  if (tagged.includes('never') || tagged.includes('no-condition')) {
    // Only promote when the candidate can actually stand in the researched
    // section. That section requires a surviving citation; the no-study
    // section does not. Promoting a candidate whose link is later stripped
    // deletes it from the report entirely — which is how goji berries went
    // from mislabelled to missing.
    const promotable = opts.hasCitation !== false && sourcesNameCondition(blob, opts.condition);
    return promotable ? REPURPOSE_SECTION_RESEARCHED : REPURPOSE_SECTION_NEVER;
  }
  // MECHANISTIC_ONLY means no condition-specific human data exists — classify as
  // never-researched even if REPURPOSE_SECTION says otherwise. This prevents the
  // completion gate from failing when all candidates have stripped citations
  // because Claude cited papers not in the evidence pack for drugs that actually
  // have only mechanistic rationale.
  if (strength.includes('MECHANISTIC_ONLY')) return REPURPOSE_SECTION_NEVER;
  if (tagged.includes('researched')) return REPURPOSE_SECTION_RESEARCHED;
  if (/PRECLINICAL|CASE_REPORT|OBSERVATIONAL|SMALL_RCT|LARGE_RCT/.test(strength)) {
    return REPURPOSE_SECTION_RESEARCHED;
  }
  // Untagged/unrecognized — do NOT default to the link-exempt bucket. An
  // earlier version of this function defaulted here to REPURPOSE_SECTION_NEVER,
  // which meant a candidate the model forgot to tag would be silently treated
  // as "no citation needed" instead of the conservative "needs a citation
  // like any claim we can't otherwise classify."
  return REPURPOSE_SECTION_UNCLEAR;
};

/** SUPPORTIVE_CARE | SUPPLEMENT | MEDICATION — prefer ITEM_KIND; else infer from CLASS + CANDIDATE text. */
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
  if (tagged.includes('SUPPORTIVE')) return 'SUPPORTIVE_CARE';
  if (tagged.includes('SUPPLEMENT')) return 'SUPPLEMENT';
  if (tagged.includes('MEDICATION') || tagged.includes('DRUG')) return 'MEDICATION';
  const classLine = String(
    (typeof blockOrFields === 'object' && (blockOrFields.class || blockOrFields.CLASS)) ||
    (String(blob).match(/^CLASS:\s*(.+)$/im) || [])[1] ||
    ''
  );
  const candidateName = String(
    (typeof blockOrFields === 'object' && blockOrFields.candidate) ||
    (String(blob).match(/^CANDIDATE:\s*(.+)$/im) || [])[1] ||
    ''
  );
  const cls = `${candidateName} ${classLine}`.toLowerCase();
  if (/\b(rehabilitation|rehab|physical therapy|exercise program|counseling|nutrition service|supportive care)\b/.test(cls)) {
    return 'SUPPORTIVE_CARE';
  }
  if (/\b(supplement|vitamin|mineral|antioxidant|nutraceutical|herbal|otc|over[- ]the[- ]counter)\b/.test(cls)) {
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
//
// isGoogleSearchUrl / isDailyMedSearchUrl / isDailyMedLabelUrl are imported
// from report-polish.js (and re-exported above) rather than redefined here —
// this file used to carry byte-identical copies that could silently drift
// from report-polish.js's versions.
// ---------------------------------------------------------------------------

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
const splitCandidateBlocks = (text) => {
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
const distinctLinkedCountBySection = (text, evidence = null) => {
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

const textFromAnthropicResponse = (response) =>
  (response?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');

export const isLaneTruncated = (response, text = null) => {
  const body = text ?? textFromAnthropicResponse(response);
  const stop = response?.stop_reason || response?.stopReason || '';
  if (stop === 'max_tokens') return true;
  return !String(body || '').trim();
};

/**
 * Assess merged lane quality. `ok` requires at least one supported candidate;
 * candidate count never causes filler generation. Pass plain lane texts;
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
