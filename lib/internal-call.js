// Marks requests made by our own in-process handler fan-out (research.js →
// evidence.js → pubmed.js, etc.). HTTP callers cannot set this — it is a
// Symbol property, not a header or JSON field — so the access gate can
// safely allow internal orchestration while still blocking strangers.
export const INTERNAL_CALL = Symbol.for('mrt.internalCall');

export const asInternalReq = (req = {}) => ({
  ...req,
  headers: {
    'content-type': 'application/json',
    ...(req.headers || {})
  },
  [INTERNAL_CALL]: true
});
