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
/** Retry a lane when it returns fewer than this many CANDIDATE blocks. */
export const REPURPOSE_MIN_PER_LANE = 3;

export const countCandidateBlocks = (text) =>
  (String(text || '').match(/^CANDIDATE:/gm) || []).length;

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
