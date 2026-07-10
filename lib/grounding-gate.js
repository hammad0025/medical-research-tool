// ===========================================================================
// Validator grounding gate (medical-safety guard).
//
// WHY THIS EXISTS — the GERD/antacid regression:
//   The second-AI validator (lib/validate.js) can be WRONG. It once claimed the
//   2022 ATS/ERS/JRS/ALAT IPF guideline recommends AGAINST antacid therapy and
//   flagged our "~87% of IPF patients have acid reflux (GERD)" statistic as
//   unsupported. Both are actually backed by OUR OWN curated ground truth:
//     - canonical fact  "~87% of IPF patients have abnormal acid GERD…"
//     - lifestyle rec    "Treat acid reflux aggressively … ~87% of IPF patients…"
//     - KB reference     "Antacid therapy for idiopathic pulmonary fibrosis"
//   Before this gate, applyValidationFixes DESTRUCTIVELY deleted / rewrote those
//   lines the moment the validator disagreed, and error-store.js persisted them
//   as permanent "do-not-repeat" memory. So a single wrong validator run could
//   silently strip accurate, KB-grounded medical facts from every future report.
//
// Dorothy's rule: "only remove things the AI disagrees with IF it's not
// accurate." This module lets the pipeline cross-check a disputed/unsupported
// claim against our grounding (the condition's canonical facts + the exact
// evidence pack the first AI was given). If the claim IS grounded, the validator
// is likely wrong: we KEEP the claim and do NOT persist it to the error store.
// If the claim is NOT grounded, the existing behaviour stands (remove + learn).
//
// The matching is deliberately CONSERVATIVE and biased toward KEEPING: a false
// deletion of accurate medical information is the worst possible outcome, so
// when a claim's salient entities/numbers appear in our grounding we treat it as
// grounded even if the phrasing differs.
// ===========================================================================

// Common words that carry no discriminating signal — excluded so overlap is
// measured on meaningful medical/entity tokens, not filler like "with"/"have".
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this',
  'that', 'have', 'has', 'had', 'from', 'they', 'them', 'their', 'been', 'were',
  'was', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'into',
  'more', 'most', 'some', 'such', 'than', 'then', 'when', 'what', 'which',
  'who', 'whom', 'about', 'also', 'because', 'while', 'these', 'those', 'over',
  'under', 'between', 'each', 'other', 'often', 'people', 'patient', 'patients',
  'study', 'studies', 'research', 'suggests', 'reports', 'shows', 'many', 'much',
  'very', 'like', 'used', 'using', 'use', 'per', 'via', 'onto', 'upon', 'both',
  'after', 'before', 'during', 'within', 'across', 'among', 'being', 'does',
  'doing', 'done', 'here', 'there', 'where', 'their', 'yours', 'ours'
]);

const normalize = (s) => String(s == null ? '' : s).toLowerCase();

// Statistic-like numbers only: a percentage (87%, ~87 %, 12.5%) or any run of
// 2+ digits (dose, prevalence, count, year). Single digits are ignored — they
// appear everywhere and would produce spurious matches. Tokens are the bare
// digit run ("87", "2000", "110") so membership tests are whole-token, never a
// substring hit ("87" must not match "870").
const statNumbers = (s) => {
  const out = new Set();
  const str = String(s == null ? '' : s);
  // Percentages first (any number of digits, incl. single, when tied to %).
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.add(m[1]);
  // Standalone multi-digit numbers (strip embedded commas: 1,000 → 1000).
  for (const m of str.matchAll(/\b(\d[\d,]{1,})(?:\.\d+)?\b/g)) {
    const n = m[1].replace(/,/g, '');
    if (n.length >= 2) out.add(n);
  }
  return out;
};

// Meaningful words: alphanumeric tokens of length ≥4 (keeps "GERD", "reflux",
// "antacid", drug names; drops "PPI"/"H2"), lowercased, minus stopwords.
const salientWords = (s) => {
  const out = new Set();
  for (const m of normalize(s).matchAll(/[a-z][a-z0-9-]{3,}/g)) {
    const w = m[0];
    if (!STOPWORDS.has(w)) out.add(w);
  }
  return out;
};

// Pull display/summary text out of one evidence-pack item, whatever shape it
// arrived in (KB item, live web hit, or the trimmed client mirror).
const evidenceItemText = (a) => {
  if (!a) return '';
  if (typeof a === 'string') return a;
  const parts = [
    a.title, a.journal, a.summary, a.content, a.text, a.abstract,
    a.snippet, a.claim, a.quote
  ];
  if (Array.isArray(a.keyPassages)) parts.push(a.keyPassages.join(' '));
  return parts.filter(Boolean).join(' ');
};

const factText = (f) => (typeof f === 'string' ? f : (f?.claim || ''));
const recText = (r) => (typeof r === 'string' ? r : (r?.recommendation || r?.claim || ''));

// Build a searchable index over our grounding. `grounding` may carry any of:
//   canonicalFacts  — [{ claim }] or [string]  (curated ground truth)
//   evidencePack    — [evidence item]          (the pack the first AI cited from)
//   lifestyle       — [{ recommendation }]     (KB lifestyle guidance)
//   redFlags        — [string]                 (KB safety considerations)
// All are flattened into a word set + a statistic-number set for O(1) lookup.
export const buildGroundingIndex = (grounding = {}) => {
  const chunks = [];
  for (const f of grounding.canonicalFacts || []) chunks.push(factText(f));
  for (const a of grounding.evidencePack || []) chunks.push(evidenceItemText(a));
  for (const l of grounding.lifestyle || []) chunks.push(recText(l));
  for (const r of grounding.redFlags || []) chunks.push(String(r || ''));
  const blob = chunks.join('\n');
  const words = new Set();
  for (const w of salientWords(blob)) words.add(w);
  const numbers = statNumbers(blob);
  return { words, numbers, size: chunks.filter(Boolean).length };
};

// Convenience: assemble a grounding index straight from an `evidence` object
// (server internal shape OR the client-returned projection). Falls back through
// the several places canonical facts / the pack can live.
export const groundingIndexFromEvidence = (evidence) => {
  if (!evidence) return buildGroundingIndex({});
  const kb = evidence.knowledgeBase || {};
  return buildGroundingIndex({
    canonicalFacts: evidence.canonicalFacts || kb.canonicalFacts || [],
    evidencePack:
      evidence.groundedForPrompt || evidence.evidencePack || evidence.topRanked || [],
    lifestyle: kb.lifestyleRecommendations || evidence.lifestyleRecommendations || [],
    redFlags: kb.redFlags || evidence.redFlags || []
  });
};

// Per-ITEM grounding texts (lowercased) assembled from an `evidence` object —
// the SAME sources buildGroundingIndex flattens, but returned as an array of
// individual source strings (one per canonical fact / evidence-pack item /
// lifestyle rec / red flag) instead of one flattened blob. Callers that must
// verify a gene + eligibility statement co-occur WITHIN A SINGLE SOURCE (not
// merely somewhere across the whole pack) use this. The eligibility-qualifier
// sanitizer in report-polish.js relies on per-item adjacency: a disease-
// mechanism paper that merely NAMES the patient's gene must NOT be able to
// "ground" an eligibility claim just because some OTHER pack item happens to
// contain the word "eligible".
export const groundingItemsFromEvidence = (evidence) => {
  if (!evidence) return [];
  const kb = evidence.knowledgeBase || {};
  const items = [];
  for (const f of evidence.canonicalFacts || kb.canonicalFacts || []) items.push(factText(f));
  for (const a of evidence.groundedForPrompt || evidence.evidencePack || evidence.topRanked || [])
    items.push(evidenceItemText(a));
  for (const l of kb.lifestyleRecommendations || evidence.lifestyleRecommendations || [])
    items.push(recText(l));
  for (const r of kb.redFlags || evidence.redFlags || []) items.push(String(r || ''));
  return items.filter(Boolean).map((s) => String(s).toLowerCase());
};

// Is a single claim string supported by our grounding? Conservative and biased
// toward KEEPING grounded content (a false "grounded" is far less harmful here
// than a false deletion of an accurate medical fact):
//   - A claim that carries statistic-like numbers is grounded only when EVERY
//     such number appears in the grounding AND at least one salient word also
//     overlaps. This catches the GERD/87% case (87 + reflux/antacid all present)
//     while still removing a made-up "95%" whose number is absent.
//   - A number-free claim needs solid word overlap (≥60%, ≥2 hits, or a full
//     match for very short claims) so a single incidental common word can't
//     "ground" an otherwise unsupported sentence.
//   - An empty grounding index (nothing to check against) can never ground a
//     claim → current remove-and-learn behaviour is preserved.
export const isClaimGrounded = (claimText, index) => {
  if (!index || !index.size) return false;
  const text = String(claimText == null ? '' : claimText);
  if (text.trim().length < 6) return false;
  const nums = statNumbers(text);
  const words = [...salientWords(text)];
  if (!nums.size && !words.length) return false;
  const wordHits = words.filter((w) => index.words.has(w));
  if (nums.size) {
    const allNumsGrounded = [...nums].every((n) => index.numbers.has(n));
    return allNumsGrounded && wordHits.length >= 1;
  }
  if (words.length <= 2) return wordHits.length === words.length;
  return wordHits.length / words.length >= 0.6 && wordHits.length >= 2;
};

// A validator finding is grounded if EITHER the verbatim quote it copied out of
// the report OR its own paraphrased claim is grounded. Checking both favours
// keeping: the quote holds the real report wording/number, the claim sometimes
// names the entity more explicitly.
export const isFindingGrounded = (finding, index) => {
  if (!finding) return false;
  return (
    isClaimGrounded(finding.quote, index) ||
    isClaimGrounded(finding.claim, index)
  );
};

// Split a validator verdict's disputed + unsupported findings into the ones we
// should ACT ON (ungrounded → remove/rewrite + persist) versus the ones the gate
// OVERRULES (grounded → keep + do not persist). Hallucinated citations are left
// untouched here — a dead/nonexistent URL is objectively checkable and handled
// separately (the link is stripped, but the grounded claim it sat on is kept).
export const partitionValidatorFindings = (primary, index) => {
  const disputed = [];
  const unsupported = [];
  const overruled = [];
  for (const d of Array.isArray(primary?.disputed) ? primary.disputed : []) {
    if (isFindingGrounded(d, index)) overruled.push({ ...d, _kind: 'disputed' });
    else disputed.push(d);
  }
  for (const u of Array.isArray(primary?.unsupported) ? primary.unsupported : []) {
    if (isFindingGrounded(u, index)) overruled.push({ ...u, _kind: 'unsupported' });
    else unsupported.push(u);
  }
  return { disputed, unsupported, overruled };
};
