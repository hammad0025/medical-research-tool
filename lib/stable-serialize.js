// Canonical, order-stable JSON serialization shared by the seal/report modules.
//
// Recursively sorts plain-object keys so a value serializes (and therefore
// hashes) identically regardless of key insertion order. Arrays keep their
// order; non-plain values (class instances, Date, Map, …) pass through
// untouched rather than being flattened into {} by Object.keys.
//
// These helpers were previously copied byte-for-byte into gather-seal.js,
// report-completion.js, and report-artifact.js. Consolidated here so the seal
// and report fingerprints can never silently drift apart.

export const isPlainObject = (value) =>
  value !== null && typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
};

export const stableJson = (value) => JSON.stringify(stableValue(value));
