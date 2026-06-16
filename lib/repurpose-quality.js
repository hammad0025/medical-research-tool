// Shared repurpose quality targets — used by client orchestration, server logs, and regression.

export const REPURPOSE_LANE_COUNT = 3;
export const REPURPOSE_PER_LANE = 4;
export const REPURPOSE_TARGET_TOTAL = 12;
export const REPURPOSE_MIN_TOTAL = 10;
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
