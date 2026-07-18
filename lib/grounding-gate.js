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

import { canonicalizeCitationUrl, isUnverifiedDocumentUrl } from './citation-gate.js';

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
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    out.add(m[1]);
    out.add(`${m[1]}%`);
  }
  // Keep decimal + unit as one grounding fact. Splitting "12.5 mL/year" into
  // "12" made a different decimal or unit look supported.
  for (const m of str.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|µg|g|kg|mL|ml|L|units?|%)(?:\s*\/\s*(day|week|month|year|yr))?\b/gi)) {
    out.add(`${m[1].replace(/,/g, '')}${m[2].toLowerCase()}${m[3] ? `/${m[3].toLowerCase()}` : ''}`);
  }
  // Standalone multi-digit numbers (strip embedded commas: 1,000 → 1000),
  // retaining the complete decimal.
  for (const m of str.matchAll(/\b(\d[\d,]+(?:\.\d+)?)\b/g)) {
    const n = m[1].replace(/,/g, '');
    if (n.replace(/\D/g, '').length >= 2) out.add(n);
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

// ===========================================================================
// Citation-claim RELEVANCE (semantic grounding of a per-card / per-claim link).
//
// A real, LIVE link is still WRONG when its source does not actually reference
// the drug/mechanism/claim it is attached to — e.g. a generic "Treatment of
// Androgenetic Alopecia" review linked on a Clascoterone card, when the review
// never discusses clascoterone. The link resolves 200, so the URL sanitizers
// (which only check dead/search/non-specific) let it through. This layer asks a
// different question: does the SOURCE TEXT for this URL mention the card's
// subject? If we can positively determine it does NOT, the link is off-topic
// and must be demoted to plain text (or the card dropped). Bias is conservative:
// a URL we cannot resolve to source text returns `null` (unknown) and is KEPT,
// so this never strips a legitimate citation we simply cannot see the text of.
// ===========================================================================

// Every reader-verifiable URL an evidence item can be cited under (its own url
// plus the PubMed/DOI records derived from its identifiers), lowercased and
// trimmed of a trailing slash. Mirrors report-polish preferVerifiableUrl but
// kept local so grounding-gate has no dependency on report-polish.
const itemCitationUrls = (a) => {
  if (!a || typeof a !== 'object') return [];
  const urls = [];
  const push = (u) => {
    const s = canonicalizeCitationUrl(u);
    if (/^https?:\/\//.test(s)) urls.push(s);
  };
  for (const f of ['url', 'link', 'pmcUrl', 'pubmedUrl', 'doiUrl', 'sourceUrl', 'fullTextUrl']) push(a[f]);
  if (a.pmid) {
    const digits = String(a.pmid).replace(/\D/g, '');
    if (digits) push(`https://pubmed.ncbi.nlm.nih.gov/${digits}/`);
  }
  if (a.doi) {
    const doi = String(a.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    if (doi) push(`https://doi.org/${doi}`);
  }
  return urls;
};

const normalizeUrlKey = (u) => canonicalizeCitationUrl(u);

// Build a Map(normalized-URL → source display/summary text) over the evidence
// pack so a citation can be checked against the text of the source it points to.
export const buildEvidenceUrlIndex = (evidence) => {
  const map = new Map();
  if (!evidence) return map;
  const kb = evidence.knowledgeBase || {};
  const lists = [
    evidence.groundedForPrompt, evidence.topRanked, evidence.evidencePack,
    kb.references, evidence.references
  ];
  for (const list of lists) {
    for (const a of Array.isArray(list) ? list : []) {
      const txt = evidenceItemText(a);
      if (!txt) continue;
      for (const u of itemCitationUrls(a)) {
        const key = normalizeUrlKey(u);
        map.set(key, `${map.get(key) || ''} ${txt}`.trim().toLowerCase());
      }
    }
  }
  return map;
};

// Salient subject tokens from a card/claim SUBJECT name (a drug/supplement, or a
// "Drug (Brand)" pair). Alphanumeric tokens of length ≥4, lowercased, minus
// stopwords. Short names (all tokens <4 chars, e.g. "NAC") yield an empty set →
// callers treat relevance as UNKNOWN and keep the link (cannot verify safely).
export const subjectTokens = (name) => {
  const out = new Set();
  for (const m of normalize(name).matchAll(/[a-z][a-z0-9-]{3,}/g)) {
    const w = m[0];
    if (!STOPWORDS.has(w)) out.add(w);
  }
  return out;
};

// Does a source's text mention the subject (any salient subject token appears)?
export const sourceMentionsSubject = (sourceText, name) => {
  const toks = subjectTokens(name);
  if (!toks.size) return null; // subject too short to verify → unknown
  const text = normalize(sourceText);
  if (!text) return null;
  for (const t of toks) {
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)) return true;
  }
  return false;
};

// Taxonomy words that appear in almost every disease paper ("sickle cell
// disease", "Parkinson disease"). Matching ONLY on these would false-accept
// wrong-disease citations when the patient condition is "… Disease".
const CONDITION_TAXONOMY_TOKENS = new Set([
  'disease', 'diseases', 'disorder', 'disorders', 'syndrome', 'syndromes',
  'condition', 'conditions', 'chronic', 'acute', 'primary', 'secondary',
  'type', 'form', 'spectrum', 'complex', 'inherited', 'genetic', 'rare',
  'progressive', 'familial'
]);

// Distinctive condition tokens for citation gating: drop taxonomy fillers so
// "Parkinson Disease" requires "parkinson", not a bare "disease" hit.
export const conditionSubjectTokens = (name) => {
  const all = subjectTokens(name);
  if (!all.size) return all;
  const distinctive = new Set([...all].filter((t) => !CONDITION_TAXONOMY_TOKENS.has(t)));
  return distinctive.size ? distinctive : all;
};

const conditionPhrase = (name) => String(name || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// Does a source mention the patient's condition as an exact canonical phrase?
// An acronym is accepted only as a whole token. Generic shared words such as
// "disease", "fibrosis", or "type" can never establish relevance alone.
export const sourceMentionsCondition = (sourceText, name) => {
  const phrase = conditionPhrase(name);
  const text = conditionPhrase(sourceText);
  if (!phrase || !text) return null;
  if (phrase.length <= 6 && !phrase.includes(' ')) {
    return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  }
  return new RegExp(`\\b${phrase.split(/\s+/).map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('\\s+')}\\b`, 'i').test(text);
};

const lookupUrlIndexText = (url, urlIndex) => {
  if (!url || !urlIndex || !urlIndex.size) return null;
  const key = normalizeUrlKey(url);
  const text = urlIndex.get(key);
  return text == null ? null : text;
};

// Is a citation URL relevant to a card/claim subject?
//   true   → the source text for this URL mentions the subject (keep the link)
//   false  → the source text is known and does NOT mention the subject (drop)
//   null   → cannot verify (URL not in pack, or subject too short) → keep
// Is a citation URL relevant to a card/claim subject?
//   true   → the source text for this URL mentions the subject (keep the link)
//   false  → the source text is known and does NOT mention the subject (drop),
//            OR the URL looks like a paper/document but is not in the pack
//            (fail-closed — prefer plain text over an unverifiable cite)
//   null   → cannot verify (subject too short, or registry/label URL) → keep
export const citationRelevantToSubject = (url, name, urlIndex) => {
  if (!url || !name || !urlIndex || !urlIndex.size) return null;
  const toks = subjectTokens(name);
  if (!toks.size) return null; // subject too short to verify → unknown
  const text = lookupUrlIndexText(url, urlIndex);
  if (text == null) {
    return isUnverifiedDocumentUrl(url) ? false : null;
  }
  return sourceMentionsSubject(text, name);
};

// Same three-valued contract as citationRelevantToSubject, but for the
// patient's CONDITION (disease A must not cite a paper about disease B).
export const citationRelevantToCondition = (url, name, urlIndex) => {
  if (!url || !name || !urlIndex || !urlIndex.size) return null;
  const toks = conditionSubjectTokens(name);
  if (!toks.size) return null;
  const text = lookupUrlIndexText(url, urlIndex);
  if (text == null) {
    return isUnverifiedDocumentUrl(url) ? false : null;
  }
  return sourceMentionsCondition(text, name);
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
