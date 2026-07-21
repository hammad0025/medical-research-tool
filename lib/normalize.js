/** Condition/disease text: Unicode-fold, lowercase, strip punctuation. */
export const normalize = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // Preserve decimal subtype notation such as "type 1.5".
    .replace(/(\d)\.(?=\d)/g, '$1__decimal__')
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .replace(/__decimal__/g, '.')
    .replace(/\s+/g, ' ')
    .trim();

/** Passcode/access gate: trim + lowercase only (preserves inner punctuation). */
export const normalizePasscode = (s) => String(s || '').trim().toLowerCase();

/** Escape a string for safe literal use inside a RegExp. */
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse only explicit boolean representations; never use JS truthiness on query strings. */
export const parseExplicitBoolean = (value, fallback = false) => {
  if (value === true || value === false) return value;
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

/** Parse a positive integer and clamp it to an endpoint-safe range. */
export const parsePageSize = (value, { fallback = 10, min = 1, max = 100 } = {}) => {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};
