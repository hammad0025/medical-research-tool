// Shared repurpose quality targets — used by client orchestration, server logs, and regression.

export const REPURPOSE_LANE_COUNT = 3;
// Per-lane ASK. The lanes run in parallel and each proposes up to this many
// candidates; the model is told to prefer fewer well-grounded candidates over
// padding (see api/research.js). 3 lanes × 9 = 27 raw, trimmed to the soft cap
// of 25 so the final list can actually reach the 25 target Dorothy asked for
// (previously 3 × 7 = 21 raw capped at 20, which is why searches maxed at 20).
export const REPURPOSE_PER_LANE = 9;
// Soft cap on the FINAL curated list after grounding gate + ranking + dedup.
// "Up to 25 grounded candidates" — quantity is an output of the quality gate,
// not a hard quota.
export const REPURPOSE_TARGET_TOTAL = 25;
export const REPURPOSE_SOFT_CAP = 25;
export const REPURPOSE_MIN_TOTAL = 12;
/**
 * Retry a lane when it returns fewer than this many CANDIDATE blocks.
 * Raised from 3 → 7 (Fix 2): with 3 lanes each asked for up to 9, a lane that
 * returns only 4-6 used to be accepted, leaving the merged list stuck near ~20.
 * A mid-sized lane now gets a second attempt so the final list can reach the
 * 25 target. This is a FLOOR for retry, not a quota — genuine grounded output
 * below it just triggers one more try, never padding.
 */
export const REPURPOSE_MIN_PER_LANE = 7;
/**
 * Backfill/top-up threshold (Fix 2): after cross-lane dedup + excluded-agent
 * filtering, if the grounded candidate count is below this, make ONE more
 * attempt for NON-DUPLICATE grounded candidates. Below the soft cap of 25 so a
 * short list gets topped up, but we never pad past what is genuinely grounded.
 */
export const REPURPOSE_BACKFILL_THRESHOLD = 22;

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

const candidateDedupKey = (name) =>
  String(name || '')
    .replace(/\*/g, '')
    .replace(/\(.*?\)/g, ' ')
    .split(/[—–\-:|/]|\d/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();

// Count DISTINCT candidates in the merged lane text (post-dedup). Used to decide
// whether a backfill top-up is warranted.
export const distinctCandidateCount = (text) => {
  const keys = new Set();
  for (const n of candidateNamesFromText(text)) {
    const k = candidateDedupKey(n);
    if (k) keys.add(k);
  }
  return keys.size;
};

/**
 * Should we run a backfill top-up pass? True when the distinct grounded
 * candidate count is short of the target AND the lanes actually produced
 * something (a totally empty result is a hard failure handled elsewhere, not a
 * backfill case). `threshold` defaults to REPURPOSE_BACKFILL_THRESHOLD.
 */
export const needsBackfill = (distinctCount, threshold = REPURPOSE_BACKFILL_THRESHOLD) =>
  distinctCount > 0 && distinctCount < threshold;

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

export const assessRepurposeQuality = (laneTexts = []) => {
  const perLane = laneTexts.map((t) => countCandidateBlocks(t));
  const total = perLane.reduce((n, c) => n + c, 0);
  return {
    perLane,
    total,
    target: REPURPOSE_TARGET_TOTAL,
    minAcceptable: REPURPOSE_MIN_TOTAL,
    ok: total >= REPURPOSE_MIN_TOTAL,
    shortfall: Math.max(0, REPURPOSE_MIN_TOTAL - total)
  };
};
