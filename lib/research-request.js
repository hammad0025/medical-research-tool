const normalizePart = (value) =>
  String(value == null ? '' : value).normalize('NFKC').trim().toLowerCase();

const stableHash = (value) => {
  let hash = 0xcbf29ce484222325n;
  for (const char of String(value || '')) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

const synthesisSegment = (payload = {}) => {
  const half = normalizePart(payload.half || 'full');
  const lane = Number.isInteger(payload.batchLane) && payload.batchLane >= 0
    ? `-lane-${payload.batchLane}`
    : '';
  return `${half}${lane}`;
};

export const splitSynthesisIdempotencyKey = (payload = {}, { profileKey = '' } = {}) => {
  const mode = normalizePart(payload.mode);
  if (
    payload.phase !== 'synthesize' ||
    !['research', 'repurpose'].includes(mode)
  ) return '';
  const profileIdentity = profileKey || payload.gatherFingerprint || payload.patient?.condition;
  // The fingerprint is stable for the same profile, while each fresh gather
  // receives a new seal. Include both so a transport retry reuses its key but
  // a later full run cannot collide with an earlier completed synthesis.
  const gatherIdentity = `${payload.gatherFingerprint || ''}|${payload.gatherSeal || ''}`;
  return [
    'mrt-synthesis-v1',
    mode,
    synthesisSegment(payload),
    stableHash(profileIdentity),
    stableHash(gatherIdentity)
  ].join(':');
};

export const resolvePaidRequestIdempotencyKey = ({
  suppliedKey,
  requestFingerprint,
  authenticatedPreview = false
} = {}) => {
  const supplied = String(suppliedKey || '').trim();
  if (supplied) return supplied;
  const fingerprint = String(requestFingerprint || '').trim();
  if (!authenticatedPreview || !fingerprint) return '';
  return `mrt-private-preview-v1:${fingerprint}`;
};

export const buildBrowserResearchRequest = (payload = {}, options = {}) => {
  const idempotencyKey = splitSynthesisIdempotencyKey(payload, options);
  const body = idempotencyKey && !payload.idempotencyKey
    ? { ...payload, idempotencyKey }
    : payload;
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
};
