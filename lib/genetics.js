// Genetic-result classification (Fix 5 — negative genetic results are a
// first-class fact, not a hallucination).
//
// The problem: the geneticVariant field can carry three very different things,
// and they must NOT be treated the same:
//   1. positive  — a named variant ("TERT pathogenic variant", "USH2A")
//   2. negative  — testing WAS done and found nothing ("tested, no known
//                  pathogenic variant", "no genetic component") ← Dorothy's case
//   3. nottested — testing was not done / unknown ("Not tested")
//
// Before this, ANY value was labelled "CONFIRMED GENETIC MUTATION / VARIANT",
// so a provided NEGATIVE result read as if the patient carried a mutation, and
// the no-invented-facts guardrail's "do NOT convert 'not tested' into 'tested
// negative'" risked the validator flagging a legitimately-provided negative as
// a hallucination — or the report deleting it. Dorothy: "it did provide results
// which was that there was no genetic component." A provided negative is a real
// finding and must survive to both the generator and the validator.

// Testing explicitly NOT done / unknown. Checked FIRST so "Not tested" never
// gets misread as a negative RESULT.
const NOT_TESTED_RE =
  /\b(?:not\s+(?:yet\s+)?(?:tested|done|performed|checked)|no\s+(?:genetic\s+)?testing(?:\s+done)?|never\s+tested|untested|unknown|have\s+not\s+been\s+tested|haven'?t\s+been\s+tested|don'?t\s+know|not\s+sure)\b/i;

// Testing WAS done and found no disease-causing variant (a provided NEGATIVE).
const NEGATIVE_RE =
  /\b(?:no\s+known\s+(?:pathogenic\s+)?(?:variant|mutation|gene)|no\s+(?:pathogenic|disease[- ]causing)\s+(?:variant|mutation)|no\s+(?:genetic|known)\s+(?:variant|mutation|component|cause)|none\s+(?:found|detected|identified)|not\s+detected|no\s+mutations?\s+(?:found|detected|identified)|wild[- ]?type|tested\s+negative|negative(?:\s+result)?)\b/i;

/**
 * Classify a raw geneticVariant string.
 * @returns {'none'|'positive'|'negative'|'nottested'}
 */
export const classifyGeneticResult = (raw) => {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return 'none';
  if (NOT_TESTED_RE.test(text)) return 'nottested';
  if (NEGATIVE_RE.test(text)) return 'negative';
  return 'positive';
};

/**
 * Generator (buildPatientContext) prompt line for the patient's genetic status,
 * with the RIGHT framing for each class so the model neither invents a variant
 * nor asserts an unreported negative — but DOES state a genuinely provided one.
 * @returns {string|null}
 */
export const geneticContextLine = (raw) => {
  const text = String(raw == null ? '' : raw).trim();
  const kind = classifyGeneticResult(text);
  if (kind === 'none') return null;
  if (kind === 'positive') {
    return `CONFIRMED GENETIC MUTATION / VARIANT (use this to gate gene-therapy and gene-targeted small-molecule recommendations): ${text}
  → For EVERY gene-targeted therapy you mention, you MUST explicitly check whether the therapy targets the SAME gene as the patient's variant. If yes, call out the eligibility match. If no, write "NOT ELIGIBLE — therapy targets <other gene>, patient carries <patient's gene>." Do not silently recommend gene therapies for the wrong gene.`;
  }
  if (kind === 'negative') {
    return `GENETIC TESTING RESULT — PROVIDED NEGATIVE (this is a legitimate, patient-reported fact, NOT an invented one — state it, do not delete it): ${text}
  → Genetic testing was reported as done and found NO known pathogenic variant. You MAY state this provided negative result plainly (e.g. "Genetic testing did not find a known disease-causing variant"). Do NOT invent a specific gene or variant. Gene-targeted therapies that require a specific mutation are unlikely to apply — say so plainly rather than recommending them.`;
  }
  // nottested
  return `GENETIC TESTING STATUS — NOT REPORTED AS DONE: ${text}
  → Genetic testing status is not established. Do NOT assert a negative result ("tested negative") when none was reported; if relevant, note only that genetic testing was not reported. Do not invent a variant.`;
};

/**
 * Validator snapshot row ([label, value]) for buildPatientSnapshot, so the
 * second AI sees a provided negative labelled as a RESULT (not a "confirmed
 * mutation") and therefore does not flag it as a hallucination.
 * @returns {[string, string]|null}
 */
export const geneticSnapshotRow = (raw) => {
  const text = String(raw == null ? '' : raw).trim();
  const kind = classifyGeneticResult(text);
  if (kind === 'none') return null;
  if (kind === 'positive') return ['Confirmed genetic mutation / variant', text];
  if (kind === 'negative') return ['Genetic testing result (provided — no known pathogenic variant)', text];
  return ['Genetic testing status (not reported as done)', text];
};
