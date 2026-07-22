// Single source of truth for "is B a more-specific variant of general term A?"
//
// Used two ways:
//   - condition-resolver: reject a general query binding to a narrower child
//     (so "diabetes" never resolves to "type 1 diabetes" / "prediabetes").
//   - condition-umbrella: find the children of a general term (so we KNOW
//     "diabetes" is an umbrella over its subtypes and can research it as one).
//
// Both inputs must already be normalized (lib/normalize.js). The relation is
// asymmetric: isNarrowerVariant(general, candidate) is true only when candidate
// is narrower than general, never the reverse.

// Words that only formalize a name without adding specificity. "crohn" ->
// "crohn disease" is the SAME disease, not a narrower one.
const FORMAL = new Set([
  'disease', 'diseases', 'syndrome', 'syndromes',
  'disorder', 'disorders', 'condition', 'conditions'
]);

const coreTokens = (s) => s.split(/\s+/).filter((t) => t && !FORMAL.has(t));

/**
 * True when `candidate` denotes a strictly more-specific variant of the general
 * term `general` — a subtype ("type 1 diabetes"), a site/qualifier variant
 * ("oral tuberculosis"), or a prefix-glued sibling ("prediabetes",
 * "silicotuberculosis"). Both args must be normalized.
 *
 * endsWith (not includes) for the morphological case is deliberate: a query
 * that is a PREFIX/abbreviation of the candidate ("schizo" -> "schizophrenia",
 * "hypo" -> "hypothyroidism") is the SAME disease and must NOT count.
 */
export const isNarrowerVariant = (general, candidate) => {
  if (!general || !candidate || general === candidate) return false;
  const g = coreTokens(general);
  const c = coreTokens(candidate);
  if (!g.length || !c.length) return false;

  const cSet = new Set(c);
  const everyGeneralTokenInCandidate = g.every((t) => cSet.has(t));
  // Candidate keeps all of the general term's words and adds specificity words.
  if (everyGeneralTokenInCandidate && c.length > g.length) return true;
  // A general word survives only as the SUFFIX of a longer candidate word.
  if (!everyGeneralTokenInCandidate) {
    for (const t of g) {
      if (t.length >= 5 && c.some((ct) => ct !== t && ct.endsWith(t))) return true;
    }
  }
  return false;
};
