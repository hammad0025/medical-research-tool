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
  /\b(?:no\b[^\n;,.]{0,60}\bpathogenic\s+(?:variants?|mutations?)|no\s+known\s+(?:pathogenic\s+)?(?:variants?|mutations?|genes?)|no\s+(?:pathogenic|disease[- ]causing)\s+(?:variants?|mutations?)|no\s+(?:genetic|known)\s+(?:variants?|mutations?|component|cause)|none\s+(?:found|detected|identified)|not\s+detected|no\s+mutations?\s+(?:found|detected|identified)|wild[- ]?type|tested\s+negative|negative(?:\s+result)?)\b/i;

const POSITIVE_RE =
  /\b(?:pathogenic|likely pathogenic|positive|detected|identified|found|carrier|heterozygous|homozygous)\b/i;

const classifyClause = (clause) => {
  if (NOT_TESTED_RE.test(clause)) return 'nottested';
  if (NEGATIVE_RE.test(clause)) return 'negative';
  if (POSITIVE_RE.test(clause) || /\b[A-Z][A-Z0-9-]{1,11}\b/.test(clause)) return 'positive';
  return null;
};

/**
 * Classify a raw geneticVariant string.
 * @returns {'none'|'positive'|'negative'|'nottested'|'mixed'}
 */
export const classifyGeneticResult = (raw) => {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return 'none';
  if (/\bnegative\b[^\n;,.]{0,50}\band\b[^\n;,.]{0,50}\bpositive\b/i.test(text)) return 'mixed';
  const clauseKinds = text
    .split(/\s*(?:;|\n|\bbut\b|\bwhile\b|\bhowever\b)\s*/i)
    .map(classifyClause)
    .filter(Boolean);
  const substantive = new Set(clauseKinds.filter((kind) => kind === 'positive' || kind === 'negative'));
  if (substantive.size > 1) return 'mixed';
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
  → For EVERY gene-targeted therapy you mention, you MUST explicitly check whether the therapy targets the SAME gene as the patient's variant. If yes, call out the eligibility match ONLY when an evidence-pack item explicitly establishes that gene indication. If no, write "NOT ELIGIBLE — therapy targets <other gene>, patient carries <patient's gene>." Do not silently recommend gene therapies for the wrong gene.
  → Do NOT tag a therapy that is NOT gene-targeted (e.g. a general antioxidant, an anti-inflammatory, a supplement) as "gene-agnostic", "${text.split(/\s|,|\(/)[0]}-eligible", or otherwise "eligible" for the patient's gene. A non-gene-specific mechanism does not make the patient's specific gene "eligible" for that drug — omit any eligibility/gene-coverage claim unless the evidence pack explicitly supports it for that gene.`;
  }
  if (kind === 'mixed') {
    return `GENETIC TESTING RESULT — MIXED FINDINGS (preserve each positive and negative finding separately): ${text}
  → Do not summarize this as globally "positive" or "negative." Match any gene-targeted therapy only to the specifically positive gene/variant, and do not treat a negative finding for another gene as excluding it.`;
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
  if (kind === 'mixed') return ['Genetic testing result (mixed positive and negative findings)', text];
  if (kind === 'negative') return ['Genetic testing result (provided — no known pathogenic variant)', text];
  return ['Genetic testing status (not reported as done)', text];
};
