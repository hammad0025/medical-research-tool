// Patient-facing report cleanup — strip internal pipeline jargon, bad links,
// and validator-flagged content before display or export.

// Honest "thin evidence" hedges. Normally these read as internal jargon and are
// stripped, but when a report is graded thin/dossier-only (Pillar 1) we KEEP
// them so the user is told the evidence base was limited rather than shown a
// confident-looking report built on dossier-derived rows.
const HEDGE_PHRASE_PATTERNS = [
  /^[^\n]*\bNo grounded evidence[^\n]*$/gim,
  /^[^\n]*\bno grounded prevalence[^\n]*$/gim,
  /^[^\n]*\bno grounded prevalence number in pack[^\n]*$/gim,
  /\bNo grounded evidence in pack\b/gi,
  /\bno grounded prevalence number in pack\b/gi,
  /\bdossier[- ]sourced\b/gi,
  /\bdossier source\b/gi,
  /\s*\(dossier-sourced[^)]*\)/gi
];

// Always-internal plumbing jargon — stripped regardless of evidence grade.
const INTERNAL_PHRASE_PATTERNS = [
  /\bconfirmed against grounded evidence\b/gi,
  /\bGROUNDED EVIDENCE PACK\b/gi,
  /\bgrounded evidence pack\b/gi,
  /\bDisease-dossier uncertainty[^.\n]*/gi,
  /\buncertainty score[^.\n]*/gi,
  /\s*\(confirmed against grounded evidence[^)]*\)/gi,
  /\s*\[(FULL-TEXT|ABSTRACT-ONLY|METADATA-ONLY|CURATED KB|PREPRINT[^\]]*)\]\s*/gi
];

export const polishReportForDisplay = (text, { keepHedges = false } = {}) => {
  if (!text) return text;
  let s = String(text);
  // Models sometimes wrap NOT-approved flags in ~~strikethrough~~ — show plain text.
  s = s.replace(/~~([^~]+)~~/g, '$1');
  const patterns = keepHedges
    ? INTERNAL_PHRASE_PATTERNS
    : [...HEDGE_PHRASE_PATTERNS, ...INTERNAL_PHRASE_PATTERNS];
  for (const pat of patterns) {
    s = s.replace(pat, pat.global && pat.source.startsWith('^') ? '' : ' ');
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * Hide Section 3 prose when the UI renders parsed treatment cards separately,
 * but KEEP a short "## 3. Approved Treatments" placeholder so the report
 * numbering stays continuous (1, 2, 3, 4…) instead of jumping 1, 2, 4.
 */
export const SECTION_3_PLACEHOLDER =
  '## 3. Approved Treatments\n\nSee the treatment cards above for every approved option, with dosing, evidence, and patient-specific interactions.';

export const stripApprovedTreatmentsSection = (text) => {
  if (!text) return text;
  const s = String(text);
  const start = s.search(/^##\s*3\.\s*Approved Treatments/im);
  if (start < 0) return s;
  const rest = s.slice(start);
  const end = rest.search(/^##\s*4\./im);
  const placeholder = `${SECTION_3_PLACEHOLDER}\n\n`;
  if (end < 0) return (s.slice(0, start) + placeholder).replace(/\n{3,}/g, '\n\n').trim();
  return (s.slice(0, start) + placeholder + s.slice(start + end)).replace(/\n{3,}/g, '\n\n').trim();
};

// Derive a dedup key from ONLY the leading drug name. The parsed card name
// carries dose/brand text ("Pirfenidone (Esbriet) — 2,403 mg/day") that would
// otherwise normalize to "pirfenidone2403mgday" and never match the stub
// "pirfenidone". Strip markdown asterisks, drop parentheticals, then cut at the
// first dash/colon/digit so only the bare drug name survives before normalizing.
export const drugBaseKey = (name) => {
  let s = String(name || '').replace(/\*/g, '');   // strip markdown bold/italic
  s = s.replace(/\(.*?\)/g, ' ');                  // drop parenthetical brand/generic
  s = s.split(/[—–\-:|/]|\d/)[0];                  // text before first dash/colon/digit
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
};

// Match a drug key against a card key by exact match OR startsWith containment
// (so "pirfenidone" matches a card keyed "pirfenidonesomething"), with a length
// guard so short fragments cannot cross-match unrelated drugs.
export const drugKeysMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
};

const normalizeDrugKey = drugBaseKey;

const approvedPipelineDrugs = (pipelineDrugs) =>
  (Array.isArray(pipelineDrugs) ? pipelineDrugs : [])
    .filter((d) => /^approved/i.test(String(d?.approvalStatus || '')));

const drugNameVariants = (d) =>
  [d?.name, ...(Array.isArray(d?.aliases) ? d.aliases : [])];

/**
 * Inject KB-approved drugs (approvalStatus === "approved") as treatment-card
 * stubs so the approved-treatment list is DATA-DRIVEN rather than dependent on
 * the model emitting a structured TREATMENT block for every drug. Without this,
 * a prose-only approved drug (e.g. nintedanib, pirfenidone) silently vanishes
 * once Section 3 prose is stripped — the exact "only nerandomilast" regression.
 * De-duplicates against already-parsed cards by drug name and known aliases.
 */
export const injectApprovedTreatmentStubs = (parsed, pipelineDrugs) => {
  const list = Array.isArray(parsed) ? parsed : [];
  const approved = approvedPipelineDrugs(pipelineDrugs);
  if (!approved.length) return list;
  const cardKeys = [];
  for (const t of list) {
    const k = normalizeDrugKey(t?.treatment);
    if (k) cardKeys.push(k);
  }
  const stubs = [];
  const added = new Set();
  for (const d of approved) {
    const key = normalizeDrugKey(d?.name);
    if (!key || added.has(key)) continue;
    const already = drugNameVariants(d).some((nm) => {
      const k = normalizeDrugKey(nm);
      return k && cardKeys.some((ck) => drugKeysMatch(k, ck));
    });
    if (already) continue;
    added.add(key);
    stubs.push({
      _type: 'treatment',
      _approvedStub: true,
      treatment: d.name,
      fda_status: 'FDA-approved',
      provider: d.mechanism ? `Mechanism: ${d.mechanism}` : '',
      efficacy_pct: null,
      safety_pct: null
    });
  }
  return [...list, ...stubs];
};

/**
 * Section 3 prose may only be hidden when EVERY KB-approved drug for the
 * condition is represented by a rendered treatment card. Otherwise a prose-only
 * approved drug would disappear from the report entirely once the section is
 * stripped. With injectApprovedTreatmentStubs this is normally guaranteed; this
 * guard is the belt-and-suspenders that keeps the prose if injection is absent.
 */
export const allApprovedDrugsRendered = (pipelineDrugs, treatments) => {
  const approved = approvedPipelineDrugs(pipelineDrugs);
  if (!approved.length) return true;
  const cardKeys = [];
  for (const t of Array.isArray(treatments) ? treatments : []) {
    const k = normalizeDrugKey(t?.treatment);
    if (k) cardKeys.push(k);
  }
  return approved.every((d) =>
    drugNameVariants(d).some((nm) => {
      const k = normalizeDrugKey(nm);
      return k && cardKeys.some((ck) => drugKeysMatch(k, ck));
    })
  );
};

// Headline-percent extraction for treatment/candidate meters. The synth emits
// "EFFICACY: **70**% — slows decline"; the bold asterisks break a naive
// /(\d{1,3})\s*%/ match (it skips "70**%" and grabs a later incidental "10%").
// Strip markdown first, then prefer a percentage at the START of the field
// (the headline number) before falling back to the first percent anywhere.
export const parseHeadlinePercent = (text) => {
  if (text == null) return null;
  const cleaned = String(text).replace(/\*/g, '');
  let m = cleaned.match(/^\s*(\d{1,3})\s*%/);
  if (!m) m = cleaned.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 100 ? n : null;
};

// Guard against a card field that was cut mid-word by a token-budget truncation
// (e.g. "…risk of bleeding is increased — nint"). If a complete sentence exists
// before the dangling fragment, drop only the fragment; never empty the field.
export const clampToCompleteSentence = (text) => {
  const s = String(text == null ? '' : text).trim();
  if (!s) return s;
  if (/[.!?)\]%"]$/.test(s)) return s;                 // already ends cleanly
  // Split into the head (through the last sentence-ender) + trailing fragment.
  const m = s.match(/^([\s\S]*[.!?])(?=\s)([\s\S]*)$/);
  if (!m) return s;                                    // no prior complete sentence — keep as-is
  const head = m[1].trim();
  const tail = m[2].trim();
  if (!tail || head.length < 20) return s;
  // Only drop the tail when it clearly looks truncated (a dangling dash + short
  // token like "— nint", or a very short leftover fragment right after a
  // period). A normal trailing clause that just lacks a period is preserved.
  const danglingDash = /[—–-]\s*\S{0,5}$/.test(tail);
  const shortFragment = tail.length <= 15;
  return (danglingDash || shortFragment) ? head : s;
};

const normalizeWhitespace = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Apply a validator correction by matching the VERBATIM offending quote the
// second AI copied out of the report and swapping in the FULL corrected
// sentence. We never truncate the correction and never delete lines: if we
// cannot find a reliable match for the quote, the text is left untouched.
const replaceClaimWithCorrection = (text, quote, correction) => {
  const q = String(quote || '').trim();
  const fix = String(correction || '').trim();
  if (!q || !fix || q.length < 10) return text;
  // 1. Exact verbatim match — the common case when the validator copies the
  //    offending sentence character-for-character.
  if (text.includes(q)) return text.replace(q, fix);
  // 2. Whitespace-tolerant match (the model may have re-wrapped the sentence
  //    across lines or collapsed runs of spaces).
  const target = normalizeWhitespace(q);
  if (target.length >= 10) {
    const esc = target
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const re = new RegExp(esc, 'i');
    if (re.test(text)) return text.replace(re, fix);
  }
  // No reliable match — do not guess, truncate, or delete. Leave unchanged.
  return text;
};

const normalizeUrl = (u) => String(u || '').trim().replace(/[.,;)]+$/, '');

const addArticleUrls = (urls, a) => {
  if (!a) return;
  const add = (u) => {
    const n = normalizeUrl(u);
    if (n && /^https?:\/\//i.test(n)) urls.add(n);
  };
  add(a.url);
  add(a.pmcUrl);
  add(a.pubmedUrl);
  add(a.doiUrl);
  add(a.oaUrl);
  add(a.landingUrl);
  add(a.europePmcUrl);
  if (a.pmid) add(`https://pubmed.ncbi.nlm.nih.gov/${String(a.pmid).replace(/\D/g, '')}/`);
  if (a.doi) add(`https://doi.org/${String(a.doi).replace(/^https?:\/\/doi\.org\//i, '')}`);
};

export const collectAllowedUrls = (evidence, trials) => {
  const urls = new Set();
  const seen = new Set();
  const articles = [];
  for (const list of [
    evidence?.groundedForPrompt,
    evidence?.topRanked,
    evidence?.evidencePack
  ]) {
    for (const a of list || []) {
      const key = String(a.pmid || a.doi || a.id || a.title || '').toLowerCase();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      articles.push(a);
    }
  }
  for (const a of articles) addArticleUrls(urls, a);
  for (const d of evidence?.pipelineDrugs || []) {
    if (d.pmid) addArticleUrls(urls, { pmid: d.pmid });
    if (d.nct) addArticleUrls(urls, { url: `https://clinicaltrials.gov/study/${String(d.nct).toUpperCase()}` });
    addArticleUrls(urls, { url: d.url });
  }
  for (const s of trials?.studies || []) {
    if (s.nctId) addArticleUrls(urls, { url: `https://clinicaltrials.gov/study/${String(s.nctId).toUpperCase()}` });
    addArticleUrls(urls, { url: s.url });
  }
  return urls;
};

const urlIsAllowed = (href, allowedUrls) => {
  if (!allowedUrls?.size || !href) return true;
  const h = normalizeUrl(href);
  if (allowedUrls.has(h)) return true;
  try {
    const u = new URL(h);
    const ct = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    if (allowedUrls.has(ct)) return true;
  } catch (_) {}
  for (const a of allowedUrls) {
    if (h.startsWith(a) || a.startsWith(h)) return true;
  }
  return false;
};

export const sanitizeMarkdownLinks = (text, allowedUrls) => {
  if (!text || !allowedUrls?.size) return text;
  let s = String(text);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) =>
    urlIsAllowed(url, allowedUrls) ? m : label);
  s = s.replace(/(?<![(\[])(https?:\/\/[^\s)\]"']+)/g, (url) => {
    const clean = normalizeUrl(url);
    return urlIsAllowed(clean, allowedUrls)
      ? `[${clean.replace(/^https?:\/\//, '').slice(0, 50)}](${clean})`
      : clean.replace(/^https?:\/\//, '');
  });
  return s;
};

// True for a Google-search fallback URL (the model emits these for centers/orgs
// that have no canonical page — api/research.js link-priority rules).
export const isGoogleSearchUrl = (url) =>
  /^https?:\/\/(www\.)?google\.[a-z.]+\/search\b/i.test(String(url || ''));

// Display label for an anchor: strip markdown emphasis markers and, for a bare
// "Google search" anchor, relabel to a clean "Search ↗" so the literal words
// "Google search" never render as a user-facing link label.
export const cleanAnchorLabel = (label, url) => {
  const stripped = String(label == null ? '' : label).replace(/\*\*|__|\*|_/g, '').trim();
  if (isGoogleSearchUrl(url) && (!stripped || /^google\s*search$/i.test(stripped))) {
    return 'Search ↗';
  }
  return stripped;
};

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Inline-safe markdown for SHORT card fields (meter notes, the risks line,
// rationale, "what it does", patient-specific risks, etc.). Converts
//   **bold** / __bold__   → <strong>…</strong>
//   [label](url)          → <a target="_blank" rel="noopener noreferrer">…</a>
// and HTML-escapes everything else. Injects NO block wrappers (<p>/<div>), so it
// is safe inside tiny one-line rows. This is the source-of-truth port of the
// index.html <InlineMD> component (the static page cannot import modules); the
// regression suite asserts both stay in lockstep so literal `**bold**` / raw
// `[label](url)` can never silently leak into a rendered card body again.
export const renderInlineMarkdownHtml = (text) => {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const renderBold = (s) => {
    let out = '';
    const boldRe = /\*\*([^*]+)\*\*|__([^_]+)__/g;
    let last = 0, m;
    while ((m = boldRe.exec(s)) !== null) {
      out += escapeHtml(s.slice(last, m.index));
      out += `<strong>${escapeHtml(m[1] || m[2])}</strong>`;
      last = boldRe.lastIndex;
    }
    out += escapeHtml(s.slice(last));
    return out;
  };
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let html = '', last = 0, m;
  while ((m = linkRe.exec(raw)) !== null) {
    if (m.index > last) html += renderBold(raw.slice(last, m.index));
    html += `<a href="${escapeHtml(m[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanAnchorLabel(m[1], m[2]))}</a>`;
    last = linkRe.lastIndex;
  }
  if (last < raw.length) html += renderBold(raw.slice(last));
  return html;
};

// ===========================================================================
// Anti-contamination provenance invariant (Pillar 3).
//
// The highest-risk failure mode: a repurpose card for drug A renders drug B's
// patient-specific risks / safety / sources (the shipped "Magnesium card showed
// Lumateperone's data" bug). The client parser already splits a delimiter-less
// merged block on a DUPLICATE field, but a foreign drug's content can still bleed
// into a host card when it arrives in a field the host does not also emit (no
// duplicate to split on). assertNoForeignEntities is the render-time invariant
// that closes that gap: within each CANDIDATE block, a self-describing field
// whose subject is a DIFFERENT candidate's drug — and which does not name the
// host drug — cannot be traced to this card's own provenance, so it is DROPPED
// (loudly flagged) rather than silently attributed to the wrong drug.
// ===========================================================================

// Self-describing fields — their subject MUST be the card's own drug. We do not
// touch mechanism/rationale/evidence prose, which may legitimately name pathway
// cousins, to avoid over-stripping.
const CANDIDATE_SELF_FIELDS = new Set([
  'PATIENT_SPECIFIC_RISKS', 'SAFETY', 'CONFIDENCE', 'EFFICACY_HYPOTHESIS',
  'HOW_TO_DISCUSS_WITH_DOCTOR'
]);

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Identity key for a candidate name — leading drug name, parens dropped, all
// non-alphanumerics removed (mirrors the client de-dup key in index.html so the
// two stay aligned). Hyphenated generics ("N-acetylcysteine") survive intact.
const candidateIdentityKey = (name) =>
  String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '').trim();

// Human-readable search terms used to find a candidate named in another card's
// prose: the leading name phrase (dose/em-dash suffix stripped) plus any ≥4-char
// parenthetical alias. Hyphenated names are preserved (split only on em/en dash
// or a spaced hyphen, never on an in-word hyphen).
const candidateSearchTerms = (name) => {
  const raw = String(name || '').replace(/\*/g, '');
  const terms = [];
  const lead = raw.replace(/\(.*?\)/g, ' ').split(/[—–]|\s-\s|:|\|/)[0].replace(/\s+\d.*$/, '').trim();
  if (lead.length >= 4) terms.push(lead);
  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) {
    for (const piece of paren[1].split(/[,/]/)) {
      const p = piece.trim();
      if (p.length >= 4 && !/^\d/.test(p)) terms.push(p);
    }
  }
  return terms;
};

// Returns { text, flags }. `flags` lists every field dropped for naming a
// foreign candidate, so the caller can log the detection (loud, never silent).
export const assertNoForeignEntities = (text) => {
  if (!text || !/^\s*CANDIDATE:/im.test(String(text))) return { text, flags: [] };
  const flags = [];
  const blocks = String(text).split(/(?=^\s*CANDIDATE:)/im);

  const ident = blocks.map((b) => {
    const m = b.match(/^\s*CANDIDATE:\s*(.+)$/im);
    const name = m ? m[1].trim() : '';
    return { name, key: candidateIdentityKey(name), terms: candidateSearchTerms(name) };
  });

  const out = blocks.map((block, bi) => {
    const self = ident[bi];
    if (!self.key) return block;
    const foreign = ident.filter((x, i) =>
      i !== bi && x.key && !drugKeysMatch(x.key, self.key) && x.terms.length);
    if (!foreign.length) return block;

    const lines = block.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const fm = trimmed.match(/^([A-Z_]+):/);
      if (fm && CANDIDATE_SELF_FIELDS.has(fm[1])) {
        const lower = trimmed.toLowerCase();
        const namesSelf = self.terms.some((t) => lower.includes(t.toLowerCase()));
        const foreignHit = !namesSelf && foreign.find((f) =>
          f.terms.some((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i').test(trimmed)));
        if (foreignHit) {
          flags.push(`${fm[1]} on "${self.terms[0] || self.key}" named foreign candidate "${foreignHit.terms[0] || foreignHit.key}" — dropped`);
          // Drop the field line AND its continuation lines (a multi-line value
          // ends at the next FIELD:, heading, or candidate boundary).
          while (i + 1 < lines.length) {
            const t2 = lines[i + 1].trim();
            if (/^[A-Z_]+:/.test(t2) || t2.startsWith('## ') || /^CANDIDATE:/i.test(t2)) break;
            i++;
          }
          continue;
        }
      }
      kept.push(lines[i]);
    }
    return kept.join('\n');
  });

  return { text: out.join(''), flags };
};

// ===========================================================================
// Loud leak-detector invariant (generalization of the Pillar 3 guard).
//
// A parsed/rendered card field must contain CLEAN content, never the raw
// structural tokens that prove the regex parser failed (a dropped delimiter, a
// missing underscore in a field label, a card-boundary header that bled into
// the previous field). When such a token survives inside a field VALUE, that
// field did not parse — rendering it would show the user a raw ALLCAPS blob or
// the next card's header (the AGA "SOURCES swallowed CARD 2" + "combination
// ideas rendered as a RATIONALE: … EVIDENCETIER: … blob" defects).
//
// detectStructuralLeak is deliberately narrow: it only fires on a STRUCTURAL
// pattern — a card-boundary marker, or a known field label (underscored OR
// not) followed by a colon. Legitimate prose that merely mentions a term like
// "rationale" or an acronym like "FVC:" is NOT flagged, because the captured
// token must normalize to a known delimiter label to count as a leak.
// ===========================================================================

// Every field label the report parsers use as a delimiter, normalized (spaces/
// underscores/markdown stripped, uppercased). A field VALUE that still contains
// any of these followed by a colon was not consumed by the parser. Trial-block
// labels are intentionally excluded: a REFERENCES value legitimately carries
// "NCT…"/"PMID…" identifiers, which are not leak signals.
export const STRUCTURAL_FIELD_LABELS = new Set([
  // approved-treatment card labels
  'PROVIDER', 'TREATMENT', 'FDASTATUS', 'LENGTHFREQUENCY', 'EFFICACY', 'SAFETY',
  'RISKS', 'INTERACTIONS', 'COST', 'REFERENCES',
  // repurposing candidate labels
  'CANDIDATE', 'CLASS', 'APPROVEDFOR', 'WHATITDOES', 'WHYFORTHISCONDITION',
  'WHYITMIGHTHELP', 'MECHANISMTARGET', 'REPURPOSERATIONALE', 'EVIDENCESTRENGTH',
  'SUPPORTINGEVIDENCE', 'EFFICACYHYPOTHESIS', 'CONFIDENCE', 'PATIENTSPECIFICRISKS',
  'HOWTODISCUSSWITHDOCTOR',
  // combination card labels
  'COMBO', 'RATIONALE', 'EVIDENCETIER', 'INTERACTIONRISK'
]);

// A repeated card header — "### 💊 CARD 2 — Minoxidil", "--- ### CARD 3:",
// "CARD 2 —". Mirrors index.html CARD_BOUNDARY_RE; matched anywhere in a value
// (not just at line start) because the leaked header lands mid-field.
const CARD_BOUNDARY_LEAK_RE = /(?:#{1,6}\s*)?(?:💊\s*)?(?:(?:drug|treatment|combo|combination|candidate|supplement)\s+)?CARD\s+\d+\s*[—–:-]/i;
// An ALL-CAPS label run (letters, spaces, underscores) followed by a colon.
const LEAK_LABEL_RE = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9 _]{2,48}?)\s*:/g;

// Returns the distinct structural tokens found inside a single field value.
// Empty array means the field is clean.
export const detectStructuralLeak = (value) => {
  const s = String(value == null ? '' : value);
  if (!s) return [];
  const hits = [];
  if (CARD_BOUNDARY_LEAK_RE.test(s)) hits.push('CARD boundary');
  LEAK_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = LEAK_LABEL_RE.exec(s)) !== null) {
    // The captured run can glue a preceding ALL-CAPS value onto the label
    // (e.g. "SMALL_RCT SUPPORTINGEVIDENCE"); test each space-split suffix so a
    // label is still recognized. Longest matching suffix wins.
    const words = m[1].trim().split(/\s+/);
    for (let k = 0; k < words.length; k++) {
      const norm = words.slice(k).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (STRUCTURAL_FIELD_LABELS.has(norm)) { hits.push(`${words.slice(k).join(' ')}:`); break; }
    }
  }
  return [...new Set(hits)];
};

// Scan every string field of a parsed card. Returns the per-field leaks so the
// caller can render a visible "formatting issue" indicator (loud, never silent)
// INSTEAD of the leaked blob. `fields` defaults to every own string property.
export const auditCardFields = (card, fields) => {
  if (!card || typeof card !== 'object') return [];
  const keys = Array.isArray(fields) && fields.length
    ? fields
    : Object.keys(card).filter((k) => typeof card[k] === 'string');
  const leaks = [];
  for (const f of keys) {
    const tokens = detectStructuralLeak(card[f]);
    if (tokens.length) leaks.push({ field: f, tokens });
  }
  return leaks;
};

export const excludedAgentNames = (evidence) => {
  const excluded = Array.isArray(evidence?.excludedAgents) ? evidence.excludedAgents : [];
  const names = new Set();
  for (const x of excluded) {
    if (x.name) {
      names.add(String(x.name).toLowerCase());
      const first = String(x.name).split(/\s+/)[0].replace(/[^a-z0-9-]/gi, '');
      if (first.length >= 4) names.add(first.toLowerCase());
    }
    for (const a of x.aliases || []) {
      const al = String(a).toLowerCase();
      if (al.length >= 4) names.add(al);
    }
  }
  return [...names];
};

export const filterExcludedRepurposeCandidates = (text, evidence) => {
  const names = excludedAgentNames(evidence);
  if (!text || !names.length) return text;
  const raw = String(text);
  const normalized = /^CANDIDATE:/im.test(raw) ? `\n${raw}` : raw;
  const blocks = normalized.split(/(?=CANDIDATE:)/i);
  if (blocks.length <= 1) return text;
  const filtered = blocks.filter((block) => {
    const trimmed = block.trim();
    if (!/^CANDIDATE:/i.test(trimmed)) return true;
    // Drop a candidate ONLY when the candidate drug ITSELF is an excluded
    // agent — i.e. the excluded name appears in the CANDIDATE name line (or the
    // CLASS line). Scanning the whole block previously deleted legitimate
    // candidates whose rationale/references merely MENTIONED an excluded drug
    // (in IPF, prednisone / metformin / N-acetylcysteine are referenced
    // constantly), which silently collapsed a 12-candidate list down to ~4.
    const nameLine = (trimmed.match(/^CANDIDATE:\s*(.+)$/im) || [])[1] || '';
    const classLine = (block.match(/^CLASS:\s*(.+)$/im) || [])[1] || '';
    const hay = `${nameLine} ${classLine}`.toLowerCase();
    return !names.some((n) => hay.includes(n));
  });
  return filtered.join('').replace(/^\n+/, '');
};

export const filterExcludedAgentMentions = (text, evidence) => {
  if (!text) return text;
  let out = filterExcludedRepurposeCandidates(text, evidence);
  const names = excludedAgentNames(evidence);
  if (!names.length) return out;
  out = out.split('\n').filter((line) => {
    const lower = line.toLowerCase();
    if (/already studied|set aside|excluded|did not help|no benefit|not shown to help|was tried|human data do not/.test(lower)) {
      return true;
    }
    if (/^#{1,3}\s/.test(line.trim())) return true;
    if (/^CANDIDATE:/i.test(line.trim())) return true;
    if (/^COMBO:/i.test(line.trim())) return true;
    return !names.some((n) => n.length >= 5 && lower.includes(n));
  }).join('\n');
  return out;
};

export const applyValidationFixes = (text, validation, evidence, allowedUrls, keepHedges = false) => {
  if (!text) return text;
  let out = text;
  const primary = validation?.primary || validation;
  if (primary) {
    for (const h of primary.hallucinatedCitations || []) {
      const url = h?.url;
      if (!url) continue;
      const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`\\[([^\\]]+)\\]\\(${esc}[^)]*\\)`, 'gi'), '$1');
      out = out.replace(new RegExp(esc, 'g'), '');
    }
    for (const d of primary.disputed || []) {
      if (d?.correction) {
        // Prefer the verbatim quote the validator copied out of the report;
        // fall back to the (paraphrased) claim, which simply will not match
        // and is therefore a safe no-op rather than a corruption.
        out = replaceClaimWithCorrection(out, d.quote || d.claim, d.correction);
      }
      // No correction → leave the text as-is. The disputed claim is still
      // surfaced to the user as a validator badge; deleting prose lines on a
      // paraphrased-claim substring match risks corrupting the report.
    }
    for (const u of primary.unsupported || []) {
      const snippet = String(u.claim || '').trim().slice(0, 35);
      if (snippet.length < 12) continue;
      const needle = snippet.toLowerCase();
      out = out.split('\n').filter((line) => !line.toLowerCase().includes(needle)).join('\n');
    }
  }
  out = filterExcludedAgentMentions(out, evidence);
  out = polishReportForDisplay(out, { keepHedges });
  out = sanitizeMarkdownLinks(out, allowedUrls);
  return out;
};

export const finalizeReportText = (text, { evidence, trials, validation, evidenceGrade } = {}) => {
  if (!text) return text;
  const allowedUrls = collectAllowedUrls(evidence, trials);
  // Keep honest "thin evidence" hedges when grounding is not graded `strong`
  // so a degraded report is never polished into a confident-looking one.
  const keepHedges = !!evidenceGrade && evidenceGrade.tier && evidenceGrade.tier !== 'strong';
  let out = filterExcludedAgentMentions(text, evidence);
  // Pillar 3: drop any candidate field that carries a DIFFERENT drug's content
  // before it can be rendered under the wrong card. Loud — never silent.
  const guarded = assertNoForeignEntities(out);
  if (guarded.flags.length) {
    console.warn(`[report-polish] cross-candidate contamination dropped: ${guarded.flags.join(' | ')}`);
  }
  out = guarded.text;
  out = polishReportForDisplay(out, { keepHedges });
  out = sanitizeMarkdownLinks(out, allowedUrls);
  if (validation) {
    out = applyValidationFixes(out, validation, evidence, allowedUrls, keepHedges);
  }
  return out;
};
