/** Condition/disease text: lowercase, strip punctuation, collapse whitespace. */
export const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Passcode/access gate: trim + lowercase only (preserves inner punctuation). */
export const normalizePasscode = (s) => String(s || '').trim().toLowerCase();
