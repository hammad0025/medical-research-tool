// Patient-facing report cleanup — strip internal pipeline jargon, bad links,
// and validator-flagged content before display or export.

import {
  buildGroundingIndex,
  groundingIndexFromEvidence,
  groundingItemsFromEvidence,
  isClaimGrounded,
  partitionValidatorFindings,
  buildEvidenceUrlIndex,
  citationRelevantToSubject,
  citationRelevantToCondition
} from './grounding-gate.js';
import { stripDemographicMismatchLines, findingIsDemographicMismatch } from './demographic-gate.js';
import {
  canonicalizeCitationUrl,
  demoteBannedClaimCitations,
  isUnverifiedDocumentUrl,
  rewriteMarkdownLinks,
  isGoogleSearchUrl,
  isDailyMedSearchUrl,
  isDailyMedLabelUrl
} from './citation-gate.js';
import {
  stripForeignDiseaseContamination,
  conditionCiteAllowed
} from './disease-contamination.js';
import { sanitizePublicText, fieldLabelSpellings, READER_FIELD_LABELS, RAW_LABELS } from './public-language.js';
import { sourceCanSupportPatientClaim } from './claim-source-proof.js';
import {
  enforceTrialRegistryNarrative,
  normalizeNctId
} from './trial-registry-gate.js';
import {
  enforceFdaLabelNarrative,
  filterVerifiedFdaEvidence
} from './fda-label-gate.js';
import { enforceGuidanceFreshnessNarrative } from './guidance-freshness-gate.js';
import {
  allApprovedDrugsRendered,
  drugBaseKey,
  drugKeysMatch,
  injectApprovedTreatmentStubs
} from './drug-card-utils.js';
export {
  allApprovedDrugsRendered,
  drugBaseKey,
  drugKeysMatch,
  injectApprovedTreatmentStubs
} from './drug-card-utils.js';

// Honest "thin evidence" hedges — rewritten to plain English (never shown as
// internal "grounded/pack/dossier" jargon). When keepHedges is false we drop
// them; when true we keep an honest plain-English limit notice.
const HEDGE_STRIP_PATTERNS = [
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

const CONFIDENTIAL_BLOCK_START = /^\s*(?:===+\s*(?:BEGIN\s+)?(?:(?:SYSTEM|DEVELOPER|HIDDEN|INTERNAL)\s+(?:PROMPT|MESSAGE|INSTRUCTIONS?)|PREVIOUSLY CAUGHT ERRORS|REQUIRED MENTIONS\s*\(anti-omission|CANONICAL FACTS\s*\(curated ground truth)|BEGIN\s+(?:SYSTEM|DEVELOPER|HIDDEN|INTERNAL)\s+(?:PROMPT|MESSAGE|INSTRUCTIONS?))/i;
const CONFIDENTIAL_BLOCK_END = /(?:END |===\s*END\s+)(?:SYSTEM|DEVELOPER|HIDDEN|INTERNAL|PREVIOUSLY CAUGHT|REQUIRED MENTIONS|CANONICAL FACTS)/i;
const CONFIDENTIAL_LINE = /\b(?:system prompt|developer message|hidden instructions?|chain[- ]of[- ]thought|private orchestration|internal-only instruction|trade secret|previously caught errors|required mentions\s*\(anti-omission|canonical facts\s*\(curated ground truth|API[_ -]?KEY|authorization:\s*bearer)\b/i;

export const stripConfidentialOutput = (text) => {
  const lines = String(text || '').split('\n');
  const kept = [];
  let droppingBlock = false;
  for (const line of lines) {
    if (CONFIDENTIAL_BLOCK_START.test(line)) {
      droppingBlock = !CONFIDENTIAL_BLOCK_END.test(line);
      continue;
    }
    if (droppingBlock) {
      if (CONFIDENTIAL_BLOCK_END.test(line)) droppingBlock = false;
      continue;
    }
    if (CONFIDENTIAL_LINE.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/**
 * Patient-facing rewrites for leftover pipeline jargon.
 * Dorothy mandate: no "evidence pack", no grounded/dossier speak, no FAERS acronym.
 */
export const rewritePatientJargon = (s) =>
  sanitizePublicText(String(s || '')
    // Longer / specific phrases first.
    .replace(
      /\bthe evidence[- ]pack does not (?:provide|include|contain|list)\s+FAERS\b[^.|]*/gi,
      'FDA post-market report counts were not available in the sources we reviewed'
    )
    .replace(/\bthe evidence[- ]pack does not (?:provide|include|contain|list)\b/gi, 'we did not find')
    .replace(/\b(?:in|from|among|within)\s+(?:this|the)\s+evidence[- ]pack\b/gi, 'in the sources we reviewed')
    .replace(/\b[Nn]o evidence[- ]pack items?\b/g, 'No published source found here')
    .replace(/\bevidence[- ]pack items?\b/gi, 'published sources')
    .replace(/\bthe evidence[- ]pack\b/gi, 'the sources we reviewed')
    .replace(/\bthis evidence[- ]pack\b/gi, 'the sources we reviewed')
    .replace(/\ban? evidence[- ]pack\b/gi, 'the sources we reviewed')
    .replace(/\bevidence[- ]pack\b/gi, 'sources')
    .replace(/\bevidence[\s-]*packs?\b/gi, 'source collections')
    .replace(/\bK[\s-]*8\b/gi, 'quality review')
    .replace(/\bdiligence[\s-]*packets?\b/gi, 'review materials')
    .replace(/\bdemo[\s-]*rehearsals?\b/gi, 'presentation checks')
    .replace(/\bchallenge[\s-]*suites?\b/gi, 'safety checks')
    .replace(/\bNo grounded evidence\b/gi, 'No published source found')
    .replace(/\bno grounded prevalence(?: number)?(?: in pack)?\b/gi, 'no published prevalence figure')
    .replace(/\bgrounded evidence\b/gi, 'published research')
    .replace(/\bdossier[- ]sourced\b/gi, '')
    .replace(/\bdossier source\b/gi, '')
    .replace(/\s*\(dossier-sourced[^)]*\)/gi, '')
    .replace(/\bDisease-dossier\b/gi, 'Condition')
    .replace(/\bFAERS\b/g, 'FDA post-market reports')
    .replace(/There is no research on this specific drug for ([^.\n]+)\./gi, 'No condition-specific study identified in this search for $1.')
    .replace(/\bnever (?:been )?researched for\b/gi, 'had no condition-specific study identified in this search for')
    .replace(/However,\s+our research suggests it may help,\s+and here is why\./gi, 'The indirect rationale comes from biological research in another context and does not imply benefit.')
    .replace(/\bresearch (?:on [^.\n]+ )?shows promise\b/gi, 'research was identified')
    .replace(/^INTERACTIONS:\s*None identified\.?\s*$/gim, 'INTERACTIONS: No interaction was identified in the reviewed information. A pharmacist or clinician should check the complete medication and supplement list.')
    .replace(/\bACTIVE_NOT_RECRUITING\b/g, 'Active, not recruiting')
    .replace(/\bNOT_YET_RECRUITING\b/g, 'Not yet recruiting')
    .replace(/\bENROLLING_BY_INVITATION\b/g, 'Enrolling by invitation')
    .replace(/\bNO_LONGER_AVAILABLE\b/g, 'No longer available')
    .replace(/\bPHASE([1-4])\b/g, 'Phase $1')
    // Fix botched prior rewrites ("in this sources").
    .replace(/\bin this sources\b/gi, 'in the sources we reviewed')
    .replace(/\bthe sources gathered here\b/gi, 'the sources we reviewed')
    .replace(/[ \t]{2,}/g, ' '));

export const polishReportForDisplay = (text, { keepHedges = false } = {}) => {
  if (!text) return text;
  let s = stripConfidentialOutput(text);
  // Models sometimes wrap NOT-approved flags in ~~strikethrough~~ — show plain text.
  s = s.replace(/~~([^~]+)~~/g, '$1');
  if (keepHedges) {
    // Keep an honest limit notice — but never in pipeline jargon.
    s = s.replace(/\bNo grounded evidence in pack\b/gi, 'Limited published sources were found for this claim');
    s = s.replace(/\bno grounded prevalence number in pack\b/gi, 'no published prevalence figure was found');
    s = s.replace(/\bdossier[- ]sourced\b/gi, '');
    for (const pat of INTERNAL_PHRASE_PATTERNS) {
      s = s.replace(pat, pat.global && pat.source.startsWith('^') ? '' : ' ');
    }
  } else {
    for (const pat of [...HEDGE_STRIP_PATTERNS, ...INTERNAL_PHRASE_PATTERNS]) {
      s = s.replace(pat, pat.global && pat.source.startsWith('^') ? '' : ' ');
    }
  }
  s = rewritePatientJargon(s);
  return s.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * Hide Section 3 prose when the UI renders parsed treatment cards separately,
 * but KEEP a short "## 3. Approved Treatments" placeholder so the report
 * numbering stays continuous (1, 2, 3, 4…) instead of jumping 1, 2, 4.
 */
export const SECTION_3_PLACEHOLDER =
  '## 3. Approved Treatments\n\nSee the treatment cards above for the approved options identified in this search, with dosing, evidence, and patient-specific interaction notes.';

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

const normalizeUrl = (u) => canonicalizeCitationUrl(u);

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

// Option B — prefer a reader-verifiable link. An evidence-pack item frequently
// carries SEVERAL URLs for the SAME source: a publisher/landing page (often
// paywalled or 403-blocking bots) alongside an open-access alternative (PMC
// full text, an Unpaywall OA copy, the PubMed record, or the DOI). When both
// exist we cite the reader-accessible one so a reader can actually open the
// citation. We ONLY reorder URLs that ALREADY EXIST on the item — we never
// fabricate, guess, or derive a new link — and if only a publisher URL exists
// we keep it. Deterministic: same item in → same URL out.
//
// Rank (0 = most reader-verifiable): PMC full text > PubMed record > DOI
// (doi.org) > ClinicalTrials.gov study > Europe PMC article > everything else
// (publisher / landing / unknown-host OA copy).
const verifiableUrlRank = (u) => {
  const s = String(u || '').toLowerCase();
  if (/^https?:\/\/(pmc\.ncbi\.nlm\.nih\.gov|(www\.)?ncbi\.nlm\.nih\.gov\/pmc\/)/.test(s)) return 0;
  if (/^https?:\/\/(www\.)?europepmc\.org\/article\/pmc\//.test(s)) return 0;
  if (/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+/.test(s)) return 1;
  if (/^https?:\/\/(dx\.)?doi\.org\//.test(s)) return 2;
  if (/^https?:\/\/(www\.)?clinicaltrials\.gov\/study\//.test(s)) return 3;
  if (/^https?:\/\/(www\.)?europepmc\.org\/article\//.test(s)) return 4;
  return 5;
};

// Field-priority order. This is ALSO the tiebreaker among equal-rank URLs, so
// e.g. an open-access copy (oaUrl) is chosen over the publisher `url` when both
// resolve to the same "other" rank.
const VERIFIABLE_URL_FIELDS = ['pmcUrl', 'oaUrl', 'pubmedUrl', 'europePmcUrl', 'doiUrl', 'url', 'landingUrl'];

export const preferVerifiableUrl = (a, fallback = '') => {
  if (!a) return normalizeUrl(fallback) || '';
  const cands = [];
  for (const f of VERIFIABLE_URL_FIELDS) {
    const n = normalizeUrl(a[f]);
    if (n && /^https?:\/\//i.test(n)) cands.push(n);
  }
  // Curated-KB items carry bare `pmid` / `doi` identifiers rather than
  // pre-built *Url fields. Derive the reader-accessible PubMed record and DOI
  // resolver from them so a paywalled publisher `url` (e.g. a ScienceDirect
  // 403) is never cited when a free PubMed/DOI copy of the SAME paper exists.
  // We only derive from identifiers the item already has — never invent one.
  if (a.pmid) {
    const digits = String(a.pmid).replace(/\D/g, '');
    if (digits) cands.push(`https://pubmed.ncbi.nlm.nih.gov/${digits}/`);
  }
  if (a.doi) {
    const doi = String(a.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    if (doi) cands.push(normalizeUrl(`https://doi.org/${doi}`));
  }
  if (!cands.length) return normalizeUrl(fallback) || '';
  // Drop known-dead hosts (offline RetNet) before ranking — never cite them.
  const live = cands.filter((u) => !isKnownDeadUrl(u));
  const pool = live.length ? live : [];
  if (!pool.length) return '';
  let best = pool[0];
  let bestRank = verifiableUrlRank(best);
  for (let i = 1; i < pool.length; i++) {
    const r = verifiableUrlRank(pool[i]);
    if (r < bestRank) { best = pool[i]; bestRank = r; }
  }
  return best;
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
  // FDA labels gathered for patient meds / cards — specific DailyMed setid pages.
  for (const f of evidence?.fdaLabels || []) {
    const lbl = f?.label || f;
    if (lbl?.dailyMedUrl) addArticleUrls(urls, { url: lbl.dailyMedUrl });
    if (f?.dailyMedUrl) addArticleUrls(urls, { url: f.dailyMedUrl });
  }
  // Repurpose drug pool and screen — URLs from drug registry evidence.
  for (const d of evidence?.repurposeDrugPool || []) {
    if (d.pmid) addArticleUrls(urls, { pmid: d.pmid });
    if (d.dailyMedUrl) addArticleUrls(urls, { url: d.dailyMedUrl });
    addArticleUrls(urls, { url: d.url });
  }
  for (const d of evidence?.repurposeDrugScreen?.fillPool || []) {
    if (d.dailyMedUrl) addArticleUrls(urls, { url: d.dailyMedUrl });
  }
  // Centres, clinicians, advocacy organisations and supportive-care measures
  // carry their own URLs. Those entries are REQUIRED to have a link — an
  // unlinked one is dropped — so stripping the link here as "not in the pack"
  // defeated the whole point: the advocacy list rendered as bare names a
  // reader could not check, and a guideline link decayed to a bare domain.
  const dossier = evidence?.dossier || {};
  for (const list of [
    dossier.topCenters, dossier.keyInvestigators, dossier.patientAdvocacy,
    evidence?.lifestyleRecommendations
  ]) {
    for (const entry of list || []) {
      if (entry?.url) addArticleUrls(urls, { url: entry.url });
    }
  }
  return urls;
};

// Navigational / search URLs are ALWAYS acceptable: they resolve to a live
// results page (a search or a canonical registry record), not a specific
// factual claim, so they cannot be a "cited paper that doesn't say that"
// hallucination. The model is explicitly told (api/research.js LINK SOURCE
// PRIORITY) to fall back to these for naming/navigation of non-claim entities.
// Keeping them exempt means tightening the grounding gate below never strips a
// legitimate search link.
// Navigational exemptions are ONLY for URLs that cannot be "invented papers":
// search pages and specific registry records. Specific PubMed PMIDs, DOIs, PMC
// articles, and ClinicalTrials.gov /study/NCT… records must appear on the
// allowlist (evidence pack / trials pull) — invented IDs no longer sneak
// through as "always allowed."
//
// DailyMed CHANGE (client mandate): a DailyMed `search.cfm?query=…` page is NOT
// a citation. It resolves to a results list (e.g. query=minoxidil → 1,576
// mostly third-party packager entries), never an authoritative label, and does
// not support the specific claim next to it. Only a SPECIFIC label monograph
// (`drugInfo.cfm?setid=<SPL_SETID>`) is acceptable. So the allowlist now permits
// ONLY the setid label form; every DailyMed search link is treated as
// ungrounded and demoted to plain text (see stripDailyMedSearchLinks).
const NAVIGATIONAL_URL_PATTERNS = [
  // Google / PubMed / CT.gov SEARCH pages are NOT navigational exemptions —
  // they are banned claim citations (lib/citation-gate.js). Only registry
  // records and specific label monographs stay exempt from the allowlist.
  /^https?:\/\/dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=/i,
  /^https?:\/\/(www\.)?accessdata\.fda\.gov\/scripts\/cder\/daf\//i
];

export const isNavigationalUrl = (href) =>
  NAVIGATIONAL_URL_PATTERNS.some((re) => re.test(String(href || '')));

// Confirmed-dead hosts/paths that must never render as clickable citations
// (live probe optional). RetNet's SPH host currently returns an IT error page.
const KNOWN_DEAD_URL_RES = [
  /^https?:\/\/(www\.)?web\.sph\.uth\.edu\/RetNet\b/i,
  /^https?:\/\/(www\.)?sph\.uth\.edu\/RetNet\b/i
];

export const isKnownDeadUrl = (url) => {
  const u = String(url || '').trim();
  if (KNOWN_DEAD_URL_RES.some((re) => re.test(u))) return true;
  // Empty applno= Drugs@FDA overview is a broken citation.
  if (/accessdata\.fda\.gov\/scripts\/cder\/daf\//i.test(u) && /[?&]applno=(?:&|$)/i.test(u)) return true;
  return false;
};

// A specific citation link is allowed only when it is grounded in the evidence
// pack. Previously this returned TRUE whenever the allowlist was empty and used
// a loose bidirectional prefix match — so an ungrounded deep link (the exact
// dead-link / "says something else" failure mode) passed through. Now:
//   - navigational/search links always pass (see above);
//   - an empty allowlist means NO specific deep link is grounded → strip it;
//   - a specific URL passes only on an exact / canonical (origin+path) match, or
//     when it is a DEEPER path of an allowed doc (allowed → allowed#section is
//     fine); the reverse (a bare domain matching a specific allowed article) is
//     no longer treated as a match.
const urlIsAllowed = (href, allowedUrls) => {
  if (!href) return true;
  if (isKnownDeadUrl(href)) return false;
  if (isNavigationalUrl(href)) return true;
  if (!allowedUrls?.size) return false;
  const h = normalizeUrl(href);
  if (allowedUrls.has(h)) return true;
  for (const a of allowedUrls) {
    if (normalizeUrl(a) === h) return true;
  }
  return false;
};

// True only for a real, openable citation / document URL. Empty, bare "#",
// whitespace, javascript:, about:blank, and relative scraps are NEVER valid —
// the client previously rendered these as clickable "source ↗" that open a
// blank tab. In-page jumps like "#live-clinical-trials" are allowed separately.
const isValidCiteUrl = (url) => {
  const h = String(url || '').trim();
  if (!h) return false;
  if (isKnownDeadUrl(h)) return false;
  if (/^https?:\/\/.+/i.test(h)) return true;
  return false;
};

const isInPageJumpHref = (url) => /^#[A-Za-z][\w:-]*$/.test(String(url || '').trim());

/**
 * Demote markdown anchors with empty / bare-hash / non-http(s) hrefs to plain
 * text. Never leave `[source ↗]()`, `[source ↗](#)`, or whitespace hrefs as
 * clickable links (blank-tab defect). Keeps real https?:// URLs and intentional
 * in-page jumps (`#live-clinical-trials`). Invalid "source ↗" cites (incl.
 * surrounding parens) are removed entirely rather than left as orphan words.
 */
export const stripInvalidMarkdownAnchors = (text) => {
  if (!text) return text;
  let s = String(text);
  // Parenthesized source cites with a bad href: drop the whole " (source ↗)" unit.
  s = s.replace(/\s*\(\s*\[([^\]]*source[^\]]*)\]\(([^)]*)\)\s*\)/gi, (m, label, href) => {
    const h = String(href || '').trim();
    if (isValidCiteUrl(h) || isInPageJumpHref(h)) return m;
    return '';
  });
  // Known-dead HTTP links are handled by the balanced URL seal below. This
  // expression intentionally handles only non-HTTP hrefs so a `)` inside a
  // valid URL cannot truncate/corrupt the markdown link.
  s = s.replace(/\[([^\]]+)\]\(((?!https?:\/\/)[^)]*)\)/gi, (m, label, href) => {
    const h = String(href || '').trim();
    if (isKnownDeadUrl(h)) {
      return /^source\s*↗?$/i.test(String(label || '').trim()) ? '' : label;
    }
    if (isValidCiteUrl(h) || isInPageJumpHref(h)) return m;
    if (/^source\s*↗?$/i.test(String(label || '').trim())) return '';
    return label;
  });
  return s
    .replace(/\s*\(\s*(?:source|citation|reference|link)\s*↗?\s*\)/gi, '')
    .replace(/\[(?:source|citation|reference|link)\s*↗?\](?!\()/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([.,;:)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '');
};

export const sanitizeMarkdownLinks = (text, allowedUrls) => {
  // NB: we intentionally run even when `allowedUrls` is empty. An empty pack
  // means nothing is grounded, so any SPECIFIC deep link is ungrounded and must
  // be demoted to plain text; navigational/search links still pass via
  // urlIsAllowed's exemption. (Previously this short-circuited and let every
  // link through when the pack was empty — the dead-link leak Dorothy hit.)
  if (!text) return text;
  let s = stripInvalidMarkdownAnchors(text);
  s = rewriteMarkdownLinks(s, (m, label, url) =>
    urlIsAllowed(url, allowedUrls) ? m : label);
  s = s.replace(/(?<![(\[])(https?:\/\/[^\s)\]"']+)/g, (url) => {
    const clean = normalizeUrl(url);
    return urlIsAllowed(clean, allowedUrls)
      ? `[${clean.replace(/^https?:\/\//, '').slice(0, 50)}](${clean})`
      : clean.replace(/^https?:\/\//, '');
  });
  return s;
};

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

// Google-as-paper: a REFERENCES / SUPPORTING_EVIDENCE line whose ONLY http(s)
// links are Google searches must not present those searches as paper citations.
// Demote [label](google…) → label (plain text). Orgs/centers elsewhere may still
// use a clearly labeled Search ↗ via cleanAnchorLabel; this pass targets source
// fields so Google never masquerades as "the paper."
const CITATION_FIELD_LINE_RE =
  /^(REFERENCES|SUPPORTING_EVIDENCE|SUPPORTING EVIDENCE)\s*:/i;

export const demoteGoogleAsPaperCitations = (text) => {
  if (!text) return text;
  return String(text)
    .split('\n')
    .map((line) => {
      if (!CITATION_FIELD_LINE_RE.test(line.trim())) return line;
      const urls = [];
      const mdRe = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
      let m;
      while ((m = mdRe.exec(line)) !== null) urls.push(m[1]);
      const bareRe = /(?<![(\[])(https?:\/\/[^\s)\]"'<>]+)/g;
      while ((m = bareRe.exec(line)) !== null) urls.push(m[1]);
      if (!urls.length) return line;
      if (!urls.every(isGoogleSearchUrl)) return line;
      let out = line;
      out = out.replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?google\.[a-z.]+\/search[^)]*\)/gi, '$1');
      out = out.replace(/(?<![(\[])https?:\/\/(?:www\.)?google\.[a-z.]+\/search[^\s)\]"'<>]*/gi, '');
      return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
    })
    .join('\n');
};

// Client / Dorothy: never ship a Google search as a clickable "profile" or
// institutional link (experts, centers, patient-assistance). Real URL or plain
// text — never a search-engine placeholder. Runs on the whole report, not just
// REFERENCES fields (those are already handled by demoteGoogleAsPaperCitations).
export const stripGoogleSearchMarkdownLinks = (text) => {
  if (!text) return text;
  return String(text)
    .replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?google\.[a-z.]+\/search[^)]*\)/gi, '$1')
    .replace(/(?<![(\[])https?:\/\/(?:www\.)?google\.[a-z.]+\/search[^\s)\]"'<>]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ');
};

// Lone fabricated EFFICACY / EFFICACY_HYPOTHESIS "NN%" score without a real
// measured endpoint (mL/year, episodes, relapse reduction with study language,
// or an inline source link). Rewrite to an honest "no measured outcome" line
// so leftover 45%/48%/50%-style meters cannot ship.
const EFFICACY_FIELD_RE = /^(EFFICACY(?:_HYPOTHESIS)?)\s*:\s*(.+)$/i;
// Real endpoint language / units — keep these even when a % appears.
const REAL_ENDPOINT_RE =
  /\b(mL\/?(?:year|yr)|FVC|FEV1|relapses?|episodes?|hazard\s*ratio|\bHR\s*[=:]|vs\.?\s*placebo|versus\s+placebo|per\s+year|absolute\s+risk|slowed\s+(?:the\s+)?(?:rate\s+of\s+)?(?:decline|progression)|improved\s+by|reduced\s+by\s+\d)/i;
const HAS_SOURCE_LINK_RE = /\[[^\]]+\]\(https?:\/\/[^)]+\)/i;
const STUDYISH_RE =
  /\b(patients?|participants?|subjects?|weeks?|months?|years?|study|trial|placebo|versus|vs\.?|cohort|randomized|randomised)\b/i;

export const isFabricatedEfficacyScore = (value) => {
  const v = String(value == null ? '' : value).replace(/\*/g, '').trim();
  if (!v) return false;
  if (HAS_SOURCE_LINK_RE.test(v) || REAL_ENDPOINT_RE.test(v)) return false;
  // Naked "NN%" with no justification → fabricated meter residue.
  if (/^\s*\d{1,3}\s*%\s*$/.test(v)) return true;
  // "NN% — fluff" without another number, without study-ish language, short rest.
  const m = v.match(/^\s*(\d{1,3})\s*%\s*[—–-]\s*(.+)$/i);
  if (!m) return false;
  const rest = m[2].trim();
  if (/\d/.test(rest)) return false;
  if (STUDYISH_RE.test(rest)) return false;
  return rest.length > 0 && rest.length < 70;
};

export const sanitizeFabricatedEfficacyScores = (text) => {
  if (!text) return text;
  const replacement =
    'A source-supported measured outcome was not available in this search. Ask your clinician or review the linked guideline.';
  return String(text)
    .split('\n')
    .map((line) => {
      const m = line.match(EFFICACY_FIELD_RE);
      if (!m) return line;
      const field = m[1];
      const value = m[2];
      if (!isFabricatedEfficacyScore(value)) return line;
      return `${field}: ${replacement}`;
    })
    .join('\n');
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
  // Strip DailyMed SEARCH links (not citations) before rendering — kept in
  // lockstep with the index.html <InlineMD> component.
  const raw = stripDailyMedSearchLinks(String(text == null ? '' : text));
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
// Fields that describe THIS card's drug. Naming a different card's drug in one
// of them is contamination, not context — the Candesartan card cited the
// spironolactone label under "Usually used for". CLASS and WHAT_IT_DOES are
// excluded on purpose: a class description legitimately names a comparator
// ("same family as axatilimab"), so guarding them removed whole valid cards.
const CANDIDATE_SELF_FIELDS = new Set([
  'PATIENT_SPECIFIC_RISKS', 'SAFETY', 'CONFIDENCE', 'EFFICACY_HYPOTHESIS',
  'HOW_TO_DISCUSS_WITH_DOCTOR', 'APPROVED_FOR'
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

  // Preserve the newline that separated CANDIDATE blocks. Joining with an
  // empty string merges the next header into the prior field value, erasing
  // provenance boundaries and recreating the exact cross-card bleed we guard.
  return { text: out.join('\n'), flags };
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
  'CANDIDATE', 'ITEMKIND', 'CLASS', 'APPROVEDFOR', 'WHATITDOES', 'WHYFORTHISCONDITION',
  'WHYITMIGHTHELP', 'MECHANISMTARGET', 'REPURPOSERATIONALE', 'REPURPOSESECTION',
  'EVIDENCESTRENGTH', 'SUPPORTINGEVIDENCE', 'EFFICACYHYPOTHESIS', 'CONFIDENCE',
  'PATIENTSPECIFICRISKS', 'HOWTODISCUSSWITHDOCTOR',
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

/** Names/aliases of KB pipeline drugs already approved for THIS condition. */
export const approvedSocNames = (evidence) => {
  const pipeline = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  const names = new Set();
  for (const d of pipeline) {
    if (!/^approved/i.test(String(d?.approvalStatus || ''))) continue;
    for (const n of [d.name, ...(Array.isArray(d.aliases) ? d.aliases : [])]) {
      const s = String(n || '').trim().toLowerCase();
      if (s.length >= 4) names.add(s);
      const first = s.split(/\s+/)[0].replace(/[^a-z0-9-]/gi, '');
      if (first.length >= 4) names.add(first);
    }
  }
  return [...names];
};

/**
 * Strip CANDIDATE / COMBO blocks that re-list drugs already FDA-approved for
 * this condition (Dorothy: "why is Esbriet in drug ideas?"). Those belong in
 * Approved Treatments only — not EveryCure-style repurposing.
 */
export const filterApprovedSocFromRepurpose = (text, evidence) => {
  const names = approvedSocNames(evidence);
  if (!text || !names.length) return text;
  const raw = String(text);
  const hasCandidate = /^CANDIDATE:/im.test(raw);
  const hasCombo = /^COMBO:/im.test(raw);
  if (!hasCandidate && !hasCombo) return text;

  let out = raw;
  if (hasCandidate) {
    const normalized = /^CANDIDATE:/im.test(out) ? `\n${out}` : out;
    const blocks = normalized.split(/(?=CANDIDATE:)/i);
    out = blocks.filter((block) => {
      const trimmed = block.trim();
      if (!/^CANDIDATE:/i.test(trimmed)) return true;
      const nameLine = (trimmed.match(/^CANDIDATE:\s*(.+)$/im) || [])[1] || '';
      const hay = nameLine.toLowerCase();
      return !names.some((n) => hay.includes(n));
    }).join('').replace(/^\n+/, '');
  }
  if (hasCombo) {
    const normalized = /^COMBO:/im.test(out) ? `\n${out}` : out;
    const blocks = normalized.split(/(?=COMBO:)/i);
    out = blocks.filter((block) => {
      const trimmed = block.trim();
      if (!/^COMBO:/i.test(trimmed)) return true;
      const nameLine = (trimmed.match(/^COMBO:\s*(.+)$/im) || [])[1] || '';
      const hay = nameLine.toLowerCase();
      // Drop only if EVERY agent in the combo is SOC — a SOC + novel pairing can stay.
      const parts = hay.split(/\s*\+\s*/).map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) return !names.some((n) => hay.includes(n));
      const allSoc = parts.every((p) => names.some((n) => p.includes(n)));
      return !allSoc;
    }).join('').replace(/^\n+/, '');
  }
  return out;
};

export const filterExcludedAgentMentions = (text, evidence) => {
  if (!text) return text;
  let out = filterExcludedRepurposeCandidates(text, evidence);
  out = tracePass('filterApprovedSocFromRepurpose', out, filterApprovedSocFromRepurpose(out, evidence));
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

// Demote every inline markdown link to plain text on the line(s) that contain
// the disputed claim. Bare URLs on that line are dropped. Prose is preserved.
// Navigational/search links are LEFT intact — they don't assert a specific
// factual claim, so a dispute about the claim's substance doesn't invalidate a
// "search for X" navigation aid. Matching is whitespace-tolerant and requires a
// reasonably specific needle to avoid nuking unrelated lines.
const demoteLinksOnMatchingLine = (text, claim) => {
  const needleRaw = String(claim || '').trim();
  if (needleRaw.length < 12) return text;
  const needle = normalizeWhitespace(needleRaw).toLowerCase().slice(0, 60);
  if (needle.length < 12) return text;
  return String(text).split('\n').map((line) => {
    if (!normalizeWhitespace(line).toLowerCase().includes(needle)) return line;
    let out = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) =>
      isNavigationalUrl(url) ? m : label);
    out = out.replace(/(?<![(\[])(https?:\/\/[^\s)\]"'<>]+)/g, (url) =>
      isNavigationalUrl(url) ? url : '');
    return out;
  }).join('\n');
};

// Remove the line(s) carrying an unsupported/unfixable-disputed claim. Since we
// no longer show a "disagreed with" / "not backed by sources" panel, an
// ungrounded claim left in the prose would reach the reader with no flag —
// Dorothy: "if it's not backed up it should be removed." Matching is
// whitespace-tolerant and needs a reasonably specific needle so we never nuke
// an unrelated line. Section headers (## ...) are never removed so a matched
// claim can't take a whole section's heading with it.
const removeClaimLine = (text, claim) => {
  const needleRaw = String(claim || '').trim();
  if (needleRaw.length < 12) return text;
  const needle = normalizeWhitespace(needleRaw).toLowerCase().slice(0, 60);
  if (needle.length < 12) return text;
  return String(text).split('\n').filter((line) => {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return true;
    return !normalizeWhitespace(line).toLowerCase().includes(needle);
  }).join('\n');
};

export const applyValidationFixes = (text, validation, evidence, allowedUrls, keepHedges = false, opts = {}) => {
  if (!text) return text;
  let out = text;
  const patient = opts?.patient || null;
  const primary = validation?.primary || validation;
  if (primary) {
    // GROUNDING GATE (medical safety — see lib/grounding-gate.js). The validator
    // is not infallible: it once flagged our KB-grounded "~87% of IPF patients
    // have acid reflux (GERD)" fact and the antacid guidance as wrong. Before we
    // destructively remove or rewrite ANY disputed/unsupported claim, cross-check
    // it against our own grounding (the condition's canonical facts + the exact
    // evidence pack the first AI was given). A claim our grounding supports is
    // KEPT — the validator is overruled — and (in api/research.js + validate.js)
    // is NOT persisted to the error store. Only genuinely ungrounded claims fall
    // through to removal/rewrite. Bias is toward keeping: a false deletion of an
    // accurate medical fact is the worst outcome. Hallucinated citations are NOT
    // gated here (a dead URL is objectively checkable) — only their link is
    // handled, and never at the cost of deleting an otherwise-grounded claim.
    const groundingIndex = groundingIndexFromEvidence(evidence);
    const { disputed, unsupported, overruled } =
      partitionValidatorFindings(primary, groundingIndex);
    if (overruled.length) {
      console.warn(
        `[report-polish] validator OVERRULED on ${overruled.length} grounded finding(s) — kept in report: ` +
        overruled.map((o) => `[${o._kind}] "${String(o.quote || o.claim || '').slice(0, 60)}"`).join(' | ')
      );
    }

    // BAD LINKS + CITATION-CLAIM MISMATCH (validator catch-all). The validator
    // now flags dead links, DailyMed/Google SEARCH pages, non-specific URLs, AND
    // real-but-off-topic links (a live page whose source does not support the
    // claim/drug) all under hallucinatedCitations. We ENFORCE by stripping the
    // link to plain text wherever the exact URL appears. This is destructive on
    // the LINK only (never the surrounding claim) so a mismatched citation is
    // removed but the sentence it sat on survives as plain text.
    for (const h of primary.hallucinatedCitations || []) {
      const url = h?.url;
      if (!url) continue;
      const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`\\[([^\\]]+)\\]\\(${esc}[^)]*\\)`, 'gi'), '$1');
      out = out.replace(new RegExp(esc, 'g'), '');
    }
    // DEMOGRAPHIC / ELIGIBILITY MISMATCH (validator catch-all). A study/trial
    // surfaced for a patient it does not fit (female-only for a male patient,
    // pediatric for an adult, wrong-condition pull) is REMOVED, not labeled.
    // Confirmed against the patient profile first so a hallucinated flag cannot
    // delete a legitimate line — driven by patient sex/age, not a hardcoded
    // condition. Runs whether or not the patient profile is available (the
    // findingIsDemographicMismatch check is conservative when it is not).
    for (const dm of primary.demographicMismatches || []) {
      const quote = dm?.quote || dm?.claim;
      if (!quote) continue;
      if (patient && !findingIsDemographicMismatch(quote, patient)) continue;
      out = removeClaimLine(out, quote);
    }
    for (const d of disputed) {
      if (d?.correction) {
        // Prefer the verbatim quote the validator copied out of the report;
        // fall back to the (paraphrased) claim, which simply will not match
        // and is therefore a safe no-op rather than a corruption.
        out = replaceClaimWithCorrection(out, d.quote || d.claim, d.correction);
      } else {
        // Disputed and the validator offered no correction — it believes the
        // claim is wrong but can't rewrite it. Dorothy: "we should just remove
        // things the AI disagrees with if it's not accurate." Now that the
        // validator receives the full patient snapshot (see buildValidatorUser)
        // AND we've confirmed the claim is NOT grounded (the gate above), these
        // disputes reflect real problems, so we remove the offending line.
        out = removeClaimLine(out, d.quote || d.claim);
      }
    }
    // Unsupported = no evidence in the pack backs this up. Dorothy: "if it's not
    // backed up it should be removed." We no longer show a "not backed by
    // sources" panel, so remove the offending line rather than strand an
    // unflagged, ungrounded claim in the prose — but ONLY after the grounding
    // gate has confirmed our own canonical facts / pack don't already support it.
    for (const u of unsupported) {
      out = removeClaimLine(out, u.claim);
    }
  }
  out = tracePass('filterExcludedAgentMentions', out, filterExcludedAgentMentions(out, evidence));
  out = tracePass('sanitizeFabricatedEfficacyScores', out, sanitizeFabricatedEfficacyScores(out));
  out = tracePass('demoteGoogleAsPaperCitations', out, demoteGoogleAsPaperCitations(out));
  out = tracePass('stripGoogleSearchMarkdownLinks', out, stripGoogleSearchMarkdownLinks(out));
  out = tracePass('demoteBannedClaimCitations', out, demoteBannedClaimCitations(out));
  out = tracePass('polishReportForDisplay', out, polishReportForDisplay(out, { keepHedges }));
  out = tracePass('sanitizeMarkdownLinks', out, sanitizeMarkdownLinks(out, allowedUrls));
  return out;
};

// ===========================================================================
// Post-cleanup link audit (Fix 4 — "links on everything" was not re-verified).
//
// The guardrails require every named entity to be a clickable link, but
// sanitizeMarkdownLinks + the dead-link gate can DEMOTE a link to plain text
// (an ungrounded deep link, or a URL that 404s), and nothing re-checked
// afterward — so a named entity could end up as bold-but-dead text. This audit
// runs AFTER sanitize + dead-link stripping and re-attaches a FALLBACK link per
// the LINK SOURCE PRIORITY (a PubMed/Google search URL is explicitly acceptable
// in the guardrails, and these navigational links always pass urlIsAllowed).
//
// Deliberately CONSERVATIVE — we only touch a **bolded** entity when its whole
// line carries NO link at all (i.e. the citation was demoted off the line), and
// only when the bold text clearly names an entity (a proper noun / acronym /
// NCT id), never a percentage, dose, phone number, or a section-label word. A
// search link is a safe, honest fallback; a dead bold entity is the failure.
// ===========================================================================

// Bolded words that are formatting/labels, not named entities — never linkified.
const NON_ENTITY_BOLD = new Set([
  'note', 'important', 'warning', 'caution', 'key', 'summary', 'disclaimer',
  'tip', 'example', 'sources', 'source', 'references', 'reference', 'efficacy',
  'safety', 'risks', 'risk', 'dosing', 'dose', 'cost', 'mechanism', 'why',
  'how', 'what', 'interactions', 'new', 'approved', 'not approved', 'pros',
  'cons', 'background', 'overview', 'yes', 'no', 'none', 'n/a'
]);

// Small connector words allowed lowercase inside a Title Case proper noun
// ("Pulmonary Fibrosis Foundation", "American Academy of Dermatology").
const TITLE_CASE_CONNECTORS = new Set([
  'of', 'the', 'and', 'for', 'a', 'an', 'to', 'in', 'on', 'with', 'or', '&',
  'de', 'la', 'von', 'van', 'at', 'by'
]);

// Does a bold span clearly NAME an entity (drug/trial/center/org/person/NCT)?
// Tightened (client mandate): a MULTI-WORD span counts only when it is a
// Title Case proper noun — every SIGNIFICANT word capitalized (small connectors
// of/the/and/for/& allowed) — OR a single drug-like token OR an NCT id. This
// rejects prose that happens to be bolded ("Initial shedding", "Start treatment
// early", "Sudden or patchy hair loss", "Finasteride sexual side effects"),
// which the old check accepted and then wrapped in a fabricated search link.
export const isNamedEntityBold = (raw) => {
  const t = String(raw || '').trim();
  if (t.length < 3 || t.length > 80) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (/^NCT\d+$/i.test(t)) return true;
  if (/%/.test(t)) return false;
  if (/\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|kg|ml|l|units?|mg\/day)\b/i.test(t)) return false;
  if (/\d{3}[).\-\s]\d/.test(t)) return false;      // phone-number-ish
  if (/[:]\s*$/.test(t)) return false;               // trailing colon → a label
  if (NON_ENTITY_BOLD.has(t.toLowerCase())) return false;
  if (!/[A-Z]/.test(t)) return false;                // proper noun / acronym only
  const words = t.split(/\s+/);
  // Single token: a drug / brand / acronym / code (already has an uppercase).
  if (words.length === 1) return /^[A-Za-z0-9][A-Za-z0-9'’.\-]*$/.test(t);
  if (words.length > 6) return false;                // a sentence, not a name
  // Multi-word: require Title Case. Every significant (non-connector) word must
  // begin with an uppercase letter or a digit (drug codes like "BI 1015550").
  // A significant word that starts lowercase means this is prose, not a name.
  for (let i = 0; i < words.length; i++) {
    const bare = words[i].replace(/[^A-Za-z0-9&]/g, '');
    if (!bare) continue;
    if (i > 0 && TITLE_CASE_CONNECTORS.has(bare.toLowerCase())) continue;
    if (!/^[A-Z0-9&]/.test(bare)) return false;
  }
  return true;
};

// Fallback link for a named entity whose citation was demoted off its line.
// Prefer a real URL from the evidence/trials entity index. Otherwise only
// synthesize a SPECIFIC ClinicalTrials.gov study link for bare NCT IDs.
// Never fabricate DailyMed/Google SEARCH links.
const fallbackEntityUrl = (name, entityIndex = null) => {
  const t = String(name || '').trim();
  const fromIndex = lookupEntityUrl(entityIndex, t);
  if (fromIndex) return fromIndex;
  if (/^NCT\d{8}$/i.test(t)) return `https://clinicaltrials.gov/study/${t.toUpperCase()}`;
  return '';
};

/**
 * DEMO / PRESENTATION SWITCH — MRT_PERMISSIVE_CITATIONS=1.
 *
 * OFF (default, correct): a citation marker that has lost its URL — "(Title ↗)"
 * — does not count as a source. An unsourced claim is deleted rather than shown
 * wearing a citation it cannot back up.
 *
 * ON: the URL-less marker counts as a link, so claims survive that the pack
 * cannot actually source. The report LOOKS fuller and reads as fully cited
 * while some statements are not traceable to any document. This is a
 * presentation aid only. Do not enable it for anything a patient will read.
 */
const PERMISSIVE_CITATION_MARKERS =
  String(process.env.MRT_PERMISSIVE_CITATIONS || '').trim() === '1';

if (PERMISSIVE_CITATION_MARKERS) {
  console.warn(
    '[report-polish] MRT_PERMISSIVE_CITATIONS=1 — URL-less citation markers count as sources. ' +
    'Unsourced claims WILL be shown as cited. Presentation use only.'
  );
}

// Detect a REAL link: markdown [text](url) or a bare URL. Every consumer of
// this pattern is deciding whether a claim is sourced, so a citation marker
// that lost its URL must not count unless the switch above is on.
const LINE_HAS_LINK_RE = PERMISSIVE_CITATION_MARKERS
  ? /\[[^\]]+\]\((https?:\/\/[^)]+)\)|(?<![(\[])https?:\/\/\S+|\([^)]*↗[^)]*\)/
  : /\[[^\]]+\]\((https?:\/\/[^)]+)\)|(?<![(\[])https?:\/\/\S+/;

// A parenthesised citation marker with no URL is the residue of a link that
// an earlier pass demoted. Left in place it accumulates nested wrappers across
// finalize passes and, worse, disguises an unsourced claim as a sourced one.
const stripOrphanCitationMarkers = (text) => {
  if (PERMISSIVE_CITATION_MARKERS) return String(text || '');
  return String(text || '')
    .replace(/\s*\(\s*\[?[^()]*?↗[^()]*?\]?\s*\)/g, (match) =>
      /https?:\/\//i.test(match) ? match : ''
    );
};
const BOLD_SPAN_RE = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;

// Returns { text, reattached, skipped }. When `entityIndex` is supplied (from
// buildEntityUrlIndex), bold named entities — including in TABLE rows — get
// real pack/trial/label links. Without an index, table rows stay unlinked
// (CENTER-LINK RULE: no fabricated Google search for centers).
export const reattachEntityLinks = (text, entityIndex = null) => {
  if (!text) return { text, reattached: [], skipped: [] };
  const reattached = [];
  const skipped = [];
  const lines = String(text).split('\n');
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (/^\s{0,3}#{1,6}\s/.test(line)) return line;   // headings are not entities
    if (!/\*\*|__/.test(line)) return line;           // no bold entity to consider
    const isTableRow = /^\s{0,3}\|/.test(line);
    // If the line already has a link, still try to link OTHER bold entities
    // that are not already wrapped in a markdown link.
    BOLD_SPAN_RE.lastIndex = 0;
    return line.replace(BOLD_SPAN_RE, (m, a, b, offset) => {
      const name = (a || b || '').trim();
      if (!isNamedEntityBold(name)) return m;
      // Already inside a markdown link? e.g. [**Name**](url)
      const after = line.slice(offset + m.length, offset + m.length + 4);
      if (/^\s*\]\(/.test(after)) return m;
      const url = fallbackEntityUrl(name, entityIndex);
      if (!url) {
        if (isTableRow) skipped.push(name);
        return m;
      }
      reattached.push(name);
      return `[${m}](${url})`;
    });
  });
  return { text: out.join('\n'), reattached, skipped };
};

// ===========================================================================
// Unsupported gene-eligibility / "gene-agnostic" qualifier stripper.
//
// WHY THIS EXISTS — the NAC / CERKL leak:
//   A repurpose card rendered "Phase 1 showed improved vision sharpness and
//   retinal sensitivity over 24 weeks [#6]. Gene-agnostic — CERKL-eligible."
//   The cited AJO 2019 paper genuinely supports the phase-1 finding, but it
//   says NOTHING about this CERKL patient being "eligible" or the drug being
//   "gene-agnostic." Because the qualifier is APPENDED to a genuinely-grounded
//   sentence, the grounding gate (which is biased toward keeping grounded
//   content and evaluates the sentence as a whole) treats the whole line as
//   grounded and the validator's live-URL check sees a real paper — so the
//   dangerous patient-specific eligibility claim survives. This is both a
//   citation-integrity and a patient-safety defect (implying a specific patient
//   qualifies for a therapy the source never established they do).
//
// The rule: a therapy's gene-eligibility / gene-coverage claim survives ONLY
// when the evidence pack EXPLICITLY supports it — the named gene appears in the
// evidence together with eligibility/coverage language, or (for a gene-agnostic
// claim with no specific gene) the evidence itself asserts genotype-agnostic
// coverage. Otherwise the qualifier is stripped SURGICALLY, leaving the
// genuinely-cited finding intact. A drug's mechanism being non-gene-specific
// does NOT license claiming the patient's gene is "eligible" — that inference
// must be dropped, not stated (extends NO-INVENTED-PATIENT-FACTS to therapy
// gene-eligibility).
// ===========================================================================

// A plausible gene symbol: an ALL-CAPS token (letters, optional trailing
// digits) 2-10 chars — CERKL, RPGR, USH2A, RPE65, ABCA4, RHO. Case-sensitive so
// "patient-eligible" / "trial-eligible" / "Medicare-eligible" never match.
const GENE_SYMBOL = '[A-Z][A-Z0-9]{1,9}';

// ALL-CAPS tokens that pattern-match a gene symbol but are actually condition
// abbreviations, organizations, or plumbing acronyms — never a patient's gene.
// Excluded so "relevant to RP patients" / "applies to IPF" (condition framing)
// is NOT mistaken for a gene-eligibility claim and mangled.
const NON_GENE_TOKENS = new Set([
  'RP', 'MS', 'AD', 'PD', 'RA', 'ALS', 'IPF', 'LCA', 'LADA', 'COPD', 'CKD',
  'CF', 'MG', 'SLE', 'IBD', 'UC', 'GERD', 'HIV', 'AMD', 'DR', 'ROP',
  'US', 'FDA', 'NIH', 'NHS', 'WHO', 'OLE', 'EA', 'NCT', 'DNA', 'RNA', 'MRNA',
  'RCT', 'FVC', 'FEV', 'ERG', 'OCT', 'MRI', 'CT', 'IV', 'IM', 'PO', 'QT'
]);

// A captured token counts as a GENE (vs. a condition/acronym) only when it is
// ≥3 chars and not on the exclusion list. Genes like RHO/CRX/NRL (3 chars) pass;
// 2-letter condition abbreviations (RP, MS) and listed acronyms do not.
const isGeneToken = (tok) => {
  const t = String(tok || '').toUpperCase();
  if (t.length < 3) return false;
  return !NON_GENE_TOKENS.has(t);
};

// Eligibility / gene-coverage markers. Each entry either names a specific gene
// (captured group) or is a gene-agnostic assertion (no specific gene). These
// cover the shapes seen live: repurpose/treatment card fields, Section-4 trial
// annotations ("… · Gene-agnostic — relevant to CERKL patients"), and the
// "Priority picks for this <GENE> patient … (drug, gene-agnostic)" line.
const ELIGIBILITY_MARKER_RES = [
  { re: new RegExp(`\\b(${GENE_SYMBOL})[-\\s]?eligible\\b`), gene: 1 },
  { re: new RegExp(`\\beligible for (?:the )?(${GENE_SYMBOL})\\b`), gene: 1 },
  { re: new RegExp(`\\bcovers (?:all )?(${GENE_SYMBOL})\\b`), gene: 1 },
  { re: new RegExp(`\\brelevant (?:to|for) (?:the )?(${GENE_SYMBOL})[- ]?(?:patients?|variant|mutation|cases?)\\b`), gene: 1 },
  { re: new RegExp(`\\brelevant (?:to|for) patients with (?:the )?(${GENE_SYMBOL})\\b`), gene: 1 },
  { re: new RegExp(`\\b(?:applies|applicable) (?:to|for) (?:the )?(${GENE_SYMBOL})\\b`), gene: 1 },
  { re: new RegExp(`\\b(${GENE_SYMBOL})[-\\s]?agnostic\\b`), gene: 1 },
  { re: /\bgene[-\s]?agnostic\b/i, gene: 0 },
  { re: /\bgenotype[-\s]?agnostic\b/i, gene: 0 },
  { re: /\bmutation[-\s]?agnostic\b/i, gene: 0 },
  { re: /\bgene[-\s]?independent\b/i, gene: 0 },
  { re: /\bregardless of (?:the )?(?:gene|mutation|genotype)\b/i, gene: 0 },
  { re: /\b(?:works|effective|benefits?) (?:for|across) (?:all )?(?:gene|genetic|genotype)/i, gene: 0 },
  { re: /\b(?:all|any) (?:genetic (?:forms|subtypes|variants)|genotypes?|mutations?)\b/i, gene: 0 }
];

// Evidence-side language that, when present alongside a named gene IN THE SAME
// SOURCE ITEM, makes an eligibility claim for THAT gene grounded (an
// approved/indicated gene therapy, an explicit "eligible/qualifies" statement).
// Deliberately TIGHT — a disease-mechanism paper that merely says "patients
// with CERKL-associated RP" must NOT ground an eligibility claim, so weak
// phrases like "patients with" / "biallelic" are NOT accepted here.
const ELIGIBILITY_CONTEXT_RE =
  /\b(eligible|eligibility|indicated for|approved for|candidates? for|qualif(?:y|ies|ied|ication)|fda[- ]approved for)\b/i;

// Evidence-side language that makes a gene-AGNOSTIC claim (no specific gene)
// grounded — the source item itself must assert genotype-independent benefit.
const AGNOSTIC_EVIDENCE_RE =
  /\b(gene[- ]agnostic|genotype[- ]agnostic|mutation[- ]agnostic|gene[- ]independent|genotype[- ]independent|independent of (?:the )?(?:gene|genotype|mutation)|regardless of (?:the )?(?:gene|genotype|mutation)|all genotypes|any (?:mutation|genotype))\b/i;

const itemHasToken = (item, token) => {
  if (!item || !token) return false;
  return new RegExp(`\\b${escapeRegExp(String(token).toLowerCase())}\\b`).test(item);
};

// Is a single eligibility marker actually supported by the evidence? Checked
// PER SOURCE ITEM so the gene and the eligibility/coverage language must
// co-occur within one source, not merely somewhere across the whole pack.
const eligibilityMarkerGrounded = (gene, items) => {
  if (!Array.isArray(items) || !items.length) return false;
  if (gene) {
    const g = String(gene).toLowerCase();
    return items.some((it) => itemHasToken(it, g) && ELIGIBILITY_CONTEXT_RE.test(it));
  }
  return items.some((it) => AGNOSTIC_EVIDENCE_RE.test(it));
};

// Collect every UNGROUNDED eligibility marker in a piece of text, sorted by
// position. Empty array means nothing to strip.
const ungroundedEligibilityMarkers = (text, items) => {
  const hits = [];
  for (const { re, gene } of ELIGIBILITY_MARKER_RES) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const rx = new RegExp(re.source, flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m.index === rx.lastIndex) rx.lastIndex++; // guard zero-width
      const geneToken = gene ? m[gene] : null;
      if (gene && !isGeneToken(geneToken)) continue; // condition abbrev, not a gene
      if (eligibilityMarkerGrounded(geneToken, items)) continue;
      hits.push({ index: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
};

const hasAnyEligibilityMarker = (text) =>
  ELIGIBILITY_MARKER_RES.some(({ re }) => re.test(text));

// Words that remain "substantive" after qualifier phrases are removed. A
// sentence with < 3 such words was essentially just the qualifier and is
// dropped whole.
const substantiveWordCount = (s) =>
  String(s || '')
    .replace(/[—–·•|\-;,():]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => /[a-z0-9]/i.test(w) && w.replace(/[^a-z0-9]/gi, '').length >= 2)
    .length;

// Structural separators that introduce an appended trailing qualifier clause
// (em/en dash, middle dot, bullet, pipe, semicolon, or a spaced hyphen). A
// comma / colon / paren is NOT here — those weave through normal prose and
// list items, so we remove qualifiers embedded there IN PLACE instead of
// truncating (which would drop a sibling list item, e.g. a second NCT).
const TRAILING_SEP_RE = /[—–·•|;]|\s-\s/g;

// "Real content" we must never truncate away — a pack citation, an NCT id, or
// a URL. Eligibility qualifiers never carry these, so their presence AFTER a
// candidate cut point means the tail holds genuine content → do not truncate.
const REAL_CONTENT_RE = /\[#\d+\]|\bNCT\d{4,}\b|https?:\/\//i;

// Remove qualifier phrases IN PLACE and tidy the punctuation they leave behind
// (stranded commas inside parens, doubled separators, dangling connectors).
const removeMarkersInPlace = (sentence, items) => {
  let v = sentence;
  for (const { re, gene } of ELIGIBILITY_MARKER_RES) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    v = v.replace(new RegExp(re.source, flags), (mt, ...rest) => {
      const geneToken = gene ? rest[gene - 1] : null;
      if (gene && !isGeneToken(geneToken)) return mt;            // condition abbrev, keep
      return eligibilityMarkerGrounded(geneToken, items) ? mt : '';
    });
  }
  return v
    .replace(/,\s*\)/g, ')')            // "(disulfiram, )" → "(disulfiram)"
    .replace(/\(\s*,\s*/g, '(')          // "( , cell)" → "(cell)"
    .replace(/,\s*,/g, ',')              // ", ," → ","
    .replace(/\(\s*\)/g, '')             // empty "()"
    .replace(/\s+([.,;:)])/g, '$1')      // " ," → ","
    .replace(/([—–·•|])\s*\1/g, '$1')    // doubled separators
    .replace(/\s*[—–·•|]\s*$/g, '')      // trailing dangling separator
    .replace(/\s{2,}/g, ' ')
    .trim();
};

// Clean ONE sentence. Priority: (1) if the qualifier sits in a trailing clause
// after a structural separator and NOTHING real (citation / NCT / URL) follows
// that cut point, truncate there — this keeps the cited finding, NCT id, and
// status while dropping "… — relevant to CERKL patients". (2) Otherwise remove
// the qualifier phrases in place (preserves sibling list items). (3) If nothing
// substantive survives, drop the sentence.
const cleanEligibilityFromSentence = (sentence, items) => {
  const markers = ungroundedEligibilityMarkers(sentence, items);
  if (!markers.length) return sentence;

  const earliest = markers[0].index;
  // Last structural separator at or before the earliest ungrounded marker.
  let cut = -1;
  TRAILING_SEP_RE.lastIndex = 0;
  let sep;
  while ((sep = TRAILING_SEP_RE.exec(sentence)) !== null) {
    if (sep.index < earliest) cut = sep.index;
    else break;
  }
  if (cut >= 0) {
    const tail = sentence.slice(cut);
    if (!REAL_CONTENT_RE.test(tail)) {
      const head = sentence.slice(0, cut).replace(/[\s—–·•|;,(-]+$/, '').trim();
      if (substantiveWordCount(head) >= 3) return head;
    }
  }

  const inPlace = removeMarkersInPlace(sentence, items);
  if (substantiveWordCount(inPlace) < 3) return '';
  return inPlace;
};

// Split a line's text into sentences (keeping terminal punctuation) so a
// trailing qualifier sentence can be dropped without disturbing the rest.
const splitSentences = (s) => String(s).match(/[^.!?]*[.!?]+(?:\s|$)|[^.!?]+$/g) || [String(s)];

// Strip unsupported gene-eligibility / "gene-agnostic" qualifiers across the
// FULL report text — repurpose cards, approved-treatment cards, Section-4
// trial annotations, and the "priority picks" line all flow through
// finalizeReportText, so operating line-by-line here covers every surface.
export const stripUnsupportedEligibilityClaims = (text, evidence) => {
  if (!text) return { text, stripped: [] };
  const items = groundingItemsFromEvidence(evidence);
  const stripped = [];
  const out = String(text)
    .split('\n')
    .map((line) => {
      if (!hasAnyEligibilityMarker(line)) return line;
      if (!ungroundedEligibilityMarkers(line, items).length) return line; // all grounded
      const sentences = splitSentences(line);
      const kept = [];
      for (const sent of sentences) {
        const trailingWs = (sent.match(/\s+$/) || [''])[0];
        const core = sent.slice(0, sent.length - trailingWs.length);
        const cleaned = cleanEligibilityFromSentence(core, items);
        if (cleaned && cleaned.trim()) {
          const needsStop = /[.!?]$/.test(core) && !/[.!?]$/.test(cleaned);
          kept.push(cleaned + (needsStop ? '.' : '') + trailingWs);
        } else if (cleaned !== core) {
          // sentence dropped
        } else {
          kept.push(sent);
        }
      }
      const rebuilt = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
      if (rebuilt !== line) {
        const marker = ELIGIBILITY_MARKER_RES.map(({ re }) => (line.match(re) || [])[0]).find(Boolean);
        stripped.push(marker || 'gene-eligibility qualifier');
      }
      return rebuilt;
    })
    .join('\n');
  return { text: out, stripped };
};

// ===========================================================================
// Inline citation resolution (client's #1 requirement).
//
// The model emits bare reference MARKERS at the point of a claim — numeric
// "[#3]" (indexing the evidence-pack list the synthesis prompt numbered) and
// free-text markers like "[JAMA Dermatology / Clinical Review]" — and defers
// the actual clickable link to a bottom "All sources & links" bibliography.
// The reader sees a strong statement with a non-clickable marker and has to
// scroll to the bottom to find the source. The requirement: EVERY significant
// claim carries its supporting citation as an INLINE clickable link right at
// the claim.
//
// resolveInlineReferenceMarkers rewrites "[#N]" markers into an inline
// "([source ↗](real-url))" using a map built from the SAME ordered evidence
// pack the "[#N]" numbering came from. A marker that cannot be resolved to a
// real supporting URL is DELETED (never left dangling, never turned into a
// fabricated search link). Free-text citation markers with no resolvable URL
// are likewise removed to plain text.
// ===========================================================================

const orderedReferenceItems = (evidence) =>
  (evidence && (
    (evidence.groundedForPrompt && evidence.groundedForPrompt.length && evidence.groundedForPrompt) ||
    (evidence.topRanked && evidence.topRanked.length && evidence.topRanked) ||
    (evidence.evidencePack && evidence.evidencePack.length && evidence.evidencePack)
  )) || [];

// Map 1-based "[#N]" indices → a reader-verifiable URL, mirroring the numbering
// buildGroundingBlock (api/research.js) assigns to evidence.groundedForPrompt.
// A DailyMed search URL is never used (not a citation). Falls back to topRanked
// / evidencePack ordering only when groundedForPrompt is absent.
export const buildReferenceUrlMap = (evidence) => {
  const map = new Map();
  const items = orderedReferenceItems(evidence);
  items.forEach((it, i) => {
    const url = preferVerifiableUrl(it, it && it.url);
    if (url && /^https?:\/\//i.test(url) && !isDailyMedSearchUrl(url)) map.set(i + 1, url);
  });
  return map;
};

const citationAnchorLabel = (item, url) => {
  const authored = String(
    item?.title || item?.name || item?.nctId || item?.nct || item?.journal || ''
  );
  const raw = rewriteMarkdownLinks(authored, (_match, label) => label)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[[\]()*_`↗]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw) return raw.length > 96 ? `${raw.slice(0, 93).trimEnd()}…` : raw;
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
};

const inlineCiteAnchor = (url, item = null) => {
  const u = String(url || '').trim();
  if (!isValidCiteUrl(u)) return '';
  return `[${citationAnchorLabel(item, u)} ↗](${u})`;
};

const GENERIC_CITATION_LABEL_RE = /^(?:source|citation|reference|link)\s*↗?$/i;

// Tidy whitespace/punctuation left behind after a marker is dropped or
// replaced (a stranded space before a period, doubled spaces, empty parens).
const tidyAfterMarkerEdit = (s) =>
  String(s)
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([.,;:)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '');

// Free-text bracket markers that are citations, not prose. Deliberately
// specific so ordinary bracketed prose is left alone.
const CITATION_TEXTMARKER_RE =
  /(\bet al\b|\breview\b|\btrials?\b|\bstudy\b|\bstudies\b|\bguideline|\bconsensus\b|\bmeta[- ]?analysis\b|\bcohort\b|\bPMID\b|\bNCT\d|\bdoi\b|\b(?:19|20)\d{2}\b|\bJAMA\b|\bLancet\b|\bNEJM\b|\bBMJ\b|\bCochrane\b|Journal|Dermatology|Cardiology|Oncology|Medicine)/i;

const looksLikeCitationTextMarker = (inner) => {
  const t = String(inner || '').trim();
  if (!t || t.length > 120) return false;
  if (/^#/.test(t)) return true;                       // leftover "[#..]"
  if (CITATION_TEXTMARKER_RE.test(t)) return true;
  // "Journal / Something" slash-joined title-case fragment.
  if (t.includes('/') && /[A-Z]/.test(t)) return true;
  return false;
};

export const resolveInlineReferenceMarkers = (text, evidence) => {
  if (!text) return text;
  const map = buildReferenceUrlMap(evidence);
  const referenceItems = orderedReferenceItems(evidence);
  const citationItemsByUrl = new Map(
    collectCitationItems(evidence, null)
      .filter((item) => item?.url)
      .map((item) => [canonicalizeCitationUrl(item.url), item])
  );
  let s = String(text);
  // Provider-written markdown may already contain a valid URL but use an
  // unhelpful label such as "source". Replace it with the matching source
  // title from the evidence record, or the source hostname when no title is
  // available. Reader-facing links must never be labeled only "source".
  s = rewriteMarkdownLinks(s, (match, label, href) => {
    const cleanLabel = String(label || '').replace(/[*_`]/g, '').trim();
    if (!GENERIC_CITATION_LABEL_RE.test(cleanLabel)) return match;
    const item = citationItemsByUrl.get(canonicalizeCitationUrl(href)) || null;
    return inlineCiteAnchor(href, item);
  });
  // Numeric markers: [#3], [#1, #2], [#1,2], [#1][#2] (each bracket handled).
  s = s.replace(/\[#\s*(\d+(?:\s*,\s*#?\d+)*)\s*\]/g, (m, group) => {
    const nums = (String(group).match(/\d+/g) || []).map(Number);
    const refs = [];
    for (const n of nums) {
      const u = map.get(n);
      if (u && !refs.some((ref) => ref.url === u)) refs.push({ url: u, item: referenceItems[n - 1] });
    }
    if (!refs.length) return '';                       // unresolved → drop marker
    return `(${refs.map((ref) => inlineCiteAnchor(ref.url, ref.item)).join(' ')})`;
  });
  // Free-text citation markers with no resolvable URL → drop to plain text.
  // (?!\() keeps real markdown links [label](url) — including the inline
  // ([source ↗](url)) we just wrote — untouched.
  s = s.replace(/\[([^\]\n]+)\](?!\()/g, (m, inner) =>
    looksLikeCitationTextMarker(inner) ? '' : m);
  return tidyAfterMarkerEdit(s);
};

// ---------------------------------------------------------------------------
// Link bare NCT IDs that the model bolded or left plain without a URL.
// Only synthesizes ClinicalTrials.gov /study/ links (specific records).
// ---------------------------------------------------------------------------
export const linkBareNctIds = (text) => {
  if (!text) return text;
  const s = String(text);
  // Already-linked destinations: skip NCT inside ](…NCT…) or [NCT…](
  return s.replace(/\bNCT(\d{8})\b/gi, (m, digits, offset) => {
    const id = `NCT${digits}`;
    const before = s.slice(Math.max(0, offset - 12), offset);
    const after = s.slice(offset + m.length, offset + m.length + 12);
    if (/https?:\/\/\S*$/i.test(before)) return m;           // inside a bare URL
    if (/\]\([^)]*$/.test(before)) return m;                 // inside (url)
    if (/^\s*\]\(https?:/i.test(after)) return m;            // label of [NCT](url)
    if (/\[$/.test(before) && /^\s*\]\(/.test(after)) return m;
    return `[${id}](https://clinicaltrials.gov/study/${id})`;
  });
};

// ---------------------------------------------------------------------------
// FUNDAMENTAL RULE — link after every claim.
//
// Walk every sentence in the report. If it states a fact and has no inline
// link, attach the best-matching pack / trial / pipeline URL. If it is a
// HARD claim (number, %, NCT, named efficacy) and nothing in the pack
// supports it, strip that sentence rather than leave an unsourced assertion.
// Never invents URLs. Never attaches a DailyMed/Google search page.
// ---------------------------------------------------------------------------

const STOP_TOKENS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'were', 'their', 'about', 'into',
  'also', 'only', 'than', 'then', 'when', 'which', 'while', 'after', 'before',
  'under', 'over', 'your', 'you', 'will', 'would', 'could', 'should', 'must',
  'does', 'did', 'doing', 'they', 'them', 'there', 'these', 'those', 'such',
  'more', 'most', 'some', 'many', 'much', 'very', 'just', 'like',
  'and', 'the', 'for', 'are', 'was', 'not', 'but', 'can', 'may', 'its', 'any',
  'all', 'our', 'out', 'how', 'who', 'why', 'get', 'got', 'new', 'old', 'use',
  'used', 'using', 'has', 'had', 'his', 'her', 'him', 'she', 'per', 'via',
  'each', 'both', 'few', 'own', 'same', 'other', 'than', 'too', 'very',
  'patient', 'patients', 'doctor', 'physician', 'discuss', 'condition',
  'research', 'suggests', 'studies', 'report', 'literature', 'evidence',
  'guidelines', 'physicians', 'generally', 'often'
]);

const claimTokens = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_TOKENS.has(w));

// Structural card labels — a line that only carries one of these is never a
// claim sentence. Both spellings must be listed: this pass runs AFTER
// polishReportForDisplay has renamed the raw keys for the reader, so matching
// only the raw spelling deletes every renamed label line as "unsourced".
const NON_CLAIM_FIELD_LABELS = fieldLabelSpellings([
  'CANDIDATE', 'ITEM_KIND', 'CLASS', 'REPURPOSE_SECTION', 'EVIDENCE_STRENGTH',
  'SUPPORTING_EVIDENCE', 'REFERENCES', 'HOW_TO_DISCUSS_WITH_DOCTOR',
  'TREATMENT', 'CONFIDENCE'
]);
const NON_CLAIM_FIELD_RE = new RegExp(
  `^(?:${NON_CLAIM_FIELD_LABELS.map(escapeRegExp).join('|')})\\s*:`, 'i'
);
// Card fields that assert a fact even when short, so they still need a source.
const FACTUAL_CARD_FIELD_LABELS = fieldLabelSpellings([
  'EFFICACY', 'SAFETY', 'RISKS', 'INTERACTIONS', 'COST', 'WHAT_IT_DOES',
  'WHY_FOR_THIS_CONDITION', 'REPURPOSE_RATIONALE', 'SUPPORTING_EVIDENCE',
  'EFFICACY_HYPOTHESIS', 'PATIENT_SPECIFIC_RISKS'
]);
const FACTUAL_CARD_FIELD_RE = new RegExp(
  `^(?:${FACTUAL_CARD_FIELD_LABELS.map(escapeRegExp).join('|')})\\s*:\\s*\\S`, 'i'
);

// A sentence is a CLAIM when it asserts a medical/scientific fact — not a
// heading, not pure navigation, not a bare field label.
const isClaimSentence = (s) => {
  const t = String(s || '').trim().replace(/^[-*•]\s+/, '').replace(/^\*\*[^*]+\*\*[:\s]*/, '');
  const factualCardField = FACTUAL_CARD_FIELD_RE.test(t);
  if (!t || (t.length < 24 && !factualCardField)) return false;
  if (/^\s{0,3}#{1,6}\s/.test(t)) return false;
  if (NON_CLAIM_FIELD_RE.test(t)) return false;
  if (/^(note for this patient|what these terms mean|exports include|disclaimer)\b/i.test(t)) return false;
  if (/^(jump to|tap |sort by|see section|ask your|please discuss|discuss with your physician before)\b/i.test(t)) return false;
  return true;
};

// MUST have an inline link (or be stripped): sourced-framing + hard facts +
// condition-snapshot statements the client requires cited.
const MUST_CITE_RE =
  /\b(research suggests|studies (?:report|show|found|estimate)|literature (?:reports|cautions|notes|warns|supports)|evidence suggests|guidelines?\b|physicians? (?:generally |often )?(?:caution|advise|recommend)|prevalence|incidence|typical path|without treatment|primary specialty|falls? risk|neurodegenerat|dopamine|tremor|stiffness|impulse control|neuroleptic|sparx|lsvt|mds\b|leading (?:researcher|authority|expert)|investigator site|research program|high-volume|insurance|medicare|covered|coverage|costs?|patient assistance|warning letters?|trial finder|enrolls?)\b/i;

// Hard claims MUST be sourced or removed (numbers, %, NCT, phase, efficacy verbs).
const isHardClaim = (s) =>
  /\b(NCT\d{8}|phase\s*[123]|FDA[- ]approved|approved|withdrawn|discontinued|commercially available|\d{1,3}\s*%|\d+\s*(?:mg|mcg|µg|mL|years?|weeks?|months?|patients?|people)|improved|reduced|slowed|increased|decreased|enrolling|recruiting|prevalence|incidence|research suggests|studies (?:report|show|found|estimate)|literature (?:reports|cautions|notes)|evidence suggests|guidelines?\s+\w+)/i.test(
    String(s || '')
  );

const isMustCite = (s) => MUST_CITE_RE.test(String(s || '')) || isHardClaim(s);

// General disease definition / path claims may use a condition-overview pack item
// when no tighter match exists (still a real PD/condition source — not a random drug).
const isGeneralConditionClaim = (s) => {
  const t = String(s || '');
  if (/\b(SPARX|LSVT|NCT\d{8}|pramipexole|ropinirole|levodopa|foslevodopa|vyalev|duopa|apomorphine|rasagiline|safinamide|opicapone)\b/i.test(t)) {
    return false;
  }
  return /\b(is a |are a |disorder|disease where|nerve cells|brain disorder|typical path|without treatment|prevalence|primary specialty|slowly (?:die|get worse)|balance problems|loss of independence)\b/i.test(t);
};

const scorePackOverlap = (claimToks, item) => {
  if (!claimToks.length || !item) return 0;
  const blob = `${item.title || ''} ${item.text || ''} ${item.summary || ''} ${item.journal || ''} ${item.name || ''}`.toLowerCase();
  if (!blob.trim()) return 0;
  let hits = 0;
  let weight = 0;
  for (const t of claimToks) {
    weight += 1;
    if (blob.includes(t)) hits += t.length >= 6 ? 1.35 : 1;
  }
  for (const t of claimToks) {
    if (t.length >= 7 && blob.includes(t)) hits += 0.5;
  }
  return weight ? hits / weight : 0;
};

const collectCitationItems = (evidence, trials) => {
  const items = [];
  const seen = new Set();
  const push = (it) => {
    const url = preferVerifiableUrl(it, it?.url);
    if (!url || !/^https?:\/\//i.test(url) || isDailyMedSearchUrl(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      ...it,
      url,
      text: it.text || it.summary || it.abstract || '',
      summary: it.summary || ''
    });
  };
  for (const list of [
    evidence?.groundedForPrompt,
    evidence?.topRanked,
    evidence?.evidencePack
  ]) {
    for (const it of list || []) push(it);
  }
  for (const d of evidence?.pipelineDrugs || []) {
    const url = preferVerifiableUrl(d, d?.url) ||
      (d?.nct ? `https://clinicaltrials.gov/study/${String(d.nct).toUpperCase()}` : '') ||
      (d?.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${String(d.pmid).replace(/\D/g, '')}/` : '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title: d.name || '',
      name: d.name || '',
      text: `${d.name || ''} ${d.summary || d.mechanism || ''} ${d.nct || ''}`,
      url
    });
  }
  for (const f of evidence?.fdaLabels || []) {
    const lbl = f?.label || f;
    const url = lbl?.dailyMedUrl || f?.dailyMedUrl || '';
    if (!isDailyMedLabelUrl(url)) continue;
    const name = lbl?.genericName?.[0] || lbl?.genericName || f?.drug || '';
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title: String(name),
      name: String(name),
      text: [
        name,
        lbl?.indications,
        lbl?.indicationsAndUsage,
        lbl?.dosage,
        lbl?.dosageAndAdministration,
        lbl?.activeIngredient,
        lbl?.route,
        lbl?.dosageForm
      ].flat().filter(Boolean).join(' ').slice(0, 4000),
      url
    });
  }
  for (const s of trials?.studies || []) {
    const nct = String(s.nctId || s.nct || '').toUpperCase();
    const url = s.url || (nct ? `https://clinicaltrials.gov/study/${nct}` : '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title: s.title || nct,
      name: nct,
      text: `${s.title || ''} ${nct} ${(s.conditions || []).join(' ')}`,
      url
    });
  }
  return items;
};

const splitClaimSentences = (line) => {
  const s = String(line || '');
  if (!s.trim()) return [s];
  // A markdown bullet / numbered item is one claim unit even without a period.
  if (/^\s*[-*•]\s+/.test(s) || /^\s*\d+[.)]\s+/.test(s)) return [s];
  const parts = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    buf += ch;
    if (/[.!?]/.test(ch)) {
      const next = s[i + 1] || '';
      const prev = s[i - 1] || '';
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      if (/[A-Z]/.test(prev) && next === ' ') continue;
      if (
        ch === '.' &&
        /\b(?:vs|e\.g|i\.e|etc|dr|mr|mrs|ms|prof|approx|ca|no|st)\.$/i.test(buf)
      ) continue;
      if (next && !/[\s"'”)\]|]/.test(next)) continue;
      parts.push(buf);
      buf = '';
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [s];
};

const sentenceHasLink = (s) => LINE_HAS_LINK_RE.test(s);

export const hasQuantitativeClaim = (s) =>
  /(?:\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|kg|mL|ml|L|units?|patients?|people|years?|months?|weeks?|days?|hours?|metres?|meters?)\b|\bNCT\d{8}\b)/i
    .test(String(s || ''));

const citationItemSupportsClaim = (sentence, item, { condition = '' } = {}) => {
  const claim = String(sentence || '')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/^\s*[A-Z][A-Z0-9_ -]{2,}:\s*/, '')
    .replace(CLAIM_LABEL_PREFIX_RE, '')
    .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;])/g, '$1');
  return sourceCanSupportPatientClaim(claim, item, { condition });
};

const bestItemForClaim = (sentence, items, options = {}) => {
  const toks = claimTokens(sentence);
  if (toks.length < 2) return { item: null, score: 0 };
  const nct = (String(sentence).match(/\bNCT\d{8}\b/i) || [])[0];
  if (nct) {
    const hit = items.find((it) =>
      String(it.url || '').toUpperCase().includes(nct.toUpperCase()) ||
      String(it.name || '').toUpperCase() === nct.toUpperCase()
    );
    if (hit) return { item: hit, score: 1 };
  }
  // Prefer items whose title/text contain distinctive claim tokens (SPARX, LSVT, MDS…).
  const distinctive = toks.filter((t) => t.length >= 5);
  let best = null;
  let bestScore = 0;
  for (const it of items) {
    if (!citationItemSupportsClaim(sentence, it, options)) continue;
    const sc = scorePackOverlap(toks, it);
    let bonus = 0;
    const blob = `${it.title || ''} ${it.text || ''}`.toLowerCase();
    for (const t of distinctive) {
      if (blob.includes(t)) bonus += 0.08;
    }
    const total = sc + bonus;
    if (total > bestScore) {
      bestScore = total;
      best = it;
    }
  }
  return { item: best, score: bestScore };
};

// A field label is never part of the claim: leaving it attached pollutes the
// token-overlap check and sinks a well-sourced sentence below the support
// threshold. Driven off the shared label map so a rename can't reintroduce
// the gap ("What the research says" was missing here and its whole card body
// was being deleted as unsupported).
const LEGACY_READER_LABELS = [
  'Risks for this patient specifically', 'Why it might help', 'Full reasoning', 'What it is'
];
const CLAIM_LABEL_PREFIX_RE = new RegExp(
  `^\\s*(?:${[...READER_FIELD_LABELS, ...LEGACY_READER_LABELS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')}):\\s*`,
  'i'
);

/**
 * A quantitative sentence may keep only citations whose own source text
 * supports its exact value/unit plus intervention, condition and outcome
 * context. If no cited source passes, remove the claim rather than leave a
 * precise but unsupported patient-facing assertion.
 */
export const enforceQuantitativeCitationSupport = (
  text,
  evidence,
  trials = null,
  { condition = '' } = {}
) => {
  if (!text) return { text, stripped: 0, demoted: 0 };
  const byUrl = new Map();
  for (const item of collectCitationItems(evidence, trials)) {
    byUrl.set(canonicalizeCitationUrl(item.url), item);
  }
  let stripped = 0;
  let demoted = 0;
  const out = String(text).split('\n').map((line) => {
    if ((!hasQuantitativeClaim(line) && !isMustCite(line)) || isMarkdownTableRow(line)) return line;
    // Models sometimes emit "Claim. ([paper](url))." Treat the detached link as
    // belonging to the preceding claim so it cannot bypass claim/source proof.
    const citationJoinedLine = line.replace(
      /[.]\s+(\(\[[^\]]+\]\(https?:\/\/[^)]+\)\))[.]?/gi,
      ' $1.'
    );
    return splitClaimSentences(citationJoinedLine).map((sentence) => {
      if (
        (!hasQuantitativeClaim(sentence) && !isMustCite(sentence)) ||
        !sentenceHasLink(sentence)
      ) return sentence;
      let supported = 0;
      const rewritten = rewriteMarkdownLinks(sentence, (match, label, href) => {
        const item = byUrl.get(canonicalizeCitationUrl(href));
        if (item && citationItemSupportsClaim(sentence, item, { condition })) {
          supported += 1;
          return match;
        }
        demoted += 1;
        return label;
      });
      if (supported > 0) return rewritten;
      stripped += 1;
      return '';
    }).join('');
  }).join('\n');
  return { text: tidyAfterMarkerEdit(out), stripped, demoted };
};

const DIRECT_TREATMENT_VERB =
  '(?:start|stop|take|begin|initiate|increase|decrease|reduce|raise|lower|change|adjust|switch|inject|dose|use|continue|resume|hold|discontinue|taper|administer)';
const DIRECT_TREATMENT_RE = new RegExp(
  `(?:^|^\\s*[-*•]\\s*)(?:please\\s+)?${DIRECT_TREATMENT_VERB}\\b|` +
  `\\b(?:you\\s+(?:should|must|need\\s+to|can)|i\\s+(?:recommend|advise)\\s+(?:that\\s+)?you)\\s+${DIRECT_TREATMENT_VERB}\\b`,
  'i'
);
const UNKNOWN_PATIENT_FACT_RE =
  /\b(?:unknown|not (?:known|provided|reported|available)|was not (?:provided|reported|performed)|missing|needs? confirmation|cannot determine)\b/i;
const PATIENT_FACT_RES = [
  { field: ['scans', 'imaging'], re: /\b(?:your|the patient's?)\s+(?:HRCT|CT|MRI|scan|imaging|x-?ray|ultrasound)\b/i },
  { field: ['labWork', 'labs'], re: /\b(?:your|the patient's?)\s+(?:A1c|HbA1c|eGFR|FVC|DLCO|glucose|creatinine|bilirubin|AST|ALT|lab|labs|bloodwork)\b/i },
  { field: ['stage'], re: /\b(?:your|the patient's?)\s+(?:disease\s+)?(?:is\s+)?stage\b|\b(?:you|the patient)\s+(?:are|is)\s+stage\b/i },
  { field: ['medications', 'currentMedications'], re: /\b(?:you|the patient)\s+(?:take|takes|use|uses|are taking|is taking)\b|\byour medications?\b/i },
  { field: ['geneticVariant', 'genetics'], re: /\b(?:your|the patient's?)\s+(?:genetic|genomic|mutation|variant|genotype)\b/i },
  { field: ['diagnoses', 'condition'], re: /\b(?:you|the patient)\s+(?:definitely\s+)?(?:have|has|are diagnosed|is diagnosed)\b|\byour diagnosis\b/i },
  { field: ['symptoms'], re: /\b(?:your|the patient's?)\s+(?:symptom|symptoms)\b/i },
  { field: ['stage', 'scans', 'imaging'], re: /\b(?:your|the patient's?)\s+disease\s+(?:is|has)\s+(?:progress|stable|worsen|improv)/i }
];
const PATIENT_MATCH_STOP = new Set([
  'your', 'patient', 'patients', 'the', 'this', 'that', 'with', 'from', 'have',
  'has', 'are', 'was', 'were', 'shows', 'showed', 'disease', 'diagnosis',
  'medication', 'medications', 'take', 'takes', 'taking', 'stage', 'mild',
  'moderate', 'severe', 'right', 'left', 'lower', 'upper', 'quickly'
]);

const patientFieldText = (patient, fields) => fields
  .flatMap((field) => {
    const value = patient?.[field];
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') return Object.values(value);
    return [value];
  })
  .filter(Boolean)
  .join(' ');

const normalizedFactTokens = (value) => String(value || '')
  .toLowerCase()
  .match(/[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?%?/g) || [];

const patientStatementSupported = (sentence, patient, fields) => {
  const supplied = patientFieldText(patient, fields);
  if (!supplied) return false;
  const source = new Set(normalizedFactTokens(supplied));
  const claim = normalizedFactTokens(sentence).filter((token) =>
    !PATIENT_MATCH_STOP.has(token) && token.length >= 3
  );
  const numeric = claim.filter((token) => /\d/.test(token));
  if (numeric.some((token) => !source.has(token))) return false;
  const words = claim.filter((token) => !/\d/.test(token));
  if (!words.length) return numeric.length > 0;
  const hits = words.filter((token) => source.has(token)).length;
  return hits >= 1 && hits / words.length >= 0.5;
};

const isSupportedPatientStatement = (sentence, patient) => {
  const patientFact = PATIENT_FACT_RES.find(({ re }) => re.test(sentence));
  return !!patientFact && patientStatementSupported(sentence, patient, patientFact.field);
};

const treatmentDiscussionRewrite = (sentence) => {
  const plain = String(sentence || '')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/^.*?\b(?:start|stop|take|begin|initiate|increase|decrease|reduce|raise|lower|change|adjust|switch|inject|dose|use|continue|resume|hold|discontinue|taper|administer)\b\s*/i, '')
    .split(/\b(?:today|tomorrow|tonight|immediately|now|once|twice|every|daily|weekly|monthly|and then|and follow|without)\b|[.;]/i)[0]
    .replace(/\b(?:at|to)\s+\d[\d,]*(?:\.\d+)?\s*(?:mg|mcg|µg|g|mL|units?)(?:\/\w+)?\b.*$/i, '')
    .replace(/\b(?:the|your)\s+(?:dose|dosage)\b.*$/i, '')
    .trim()
    .replace(/^(?:a|an|the)\s+/i, '');
  const subject = !/\b(?:dose|dosage|plan|schedule|regimen)\b/i.test(plain) &&
    /^[a-z0-9][a-z0-9 -]{1,60}$/i.test(plain) ? plain : '';
  return subject
    ? `Discuss whether ${subject} is appropriate with a licensed clinician.`
    : 'Discuss any treatment change with a licensed clinician.';
};

/**
 * Final patient-facing clinical boundary. It rewrites direct treatment
 * commands and drops patient-specific findings that cannot be deterministically
 * matched to the supplied profile. Population facts and descriptive
 * study/label regimens do not use patient-directed syntax and remain intact.
 */
const enforcePatientFacingClinicalBoundary = (text, patient = {}) => {
  if (!text) return { text, rewritten: 0, stripped: 0 };
  let rewritten = 0;
  let stripped = 0;
  const out = String(text).split('\n').map((line) => {
    if (isMarkdownTableRow(line)) return line;
    return splitClaimSentences(line).map((sentence) => {
      if (DIRECT_TREATMENT_RE.test(sentence)) {
        rewritten += 1;
        return treatmentDiscussionRewrite(sentence);
      }
      if (UNKNOWN_PATIENT_FACT_RE.test(sentence)) return sentence;
      const patientFact = PATIENT_FACT_RES.find(({ re }) => re.test(sentence));
      if (patientFact && !patientStatementSupported(sentence, patient, patientFact.field)) {
        stripped += 1;
        return '';
      }
      return sentence;
    }).join('');
  }).join('\n');
  return {
    text: out.replace(/[ \t]+([.,;:)])/g, '$1').replace(/\n{3,}/g, '\n\n').trim(),
    rewritten,
    stripped
  };
};

// Resolve the patient/report condition (+ synonyms) used to refuse wrong-disease
// citation attaches. Condition-agnostic: no disease denylist — a source must
// mention this condition's distinctive tokens (see citationRelevantToCondition).
const resolveReportConditionSubject = (patient, evidence) => {
  // Return one canonical subject, never a bag of tokens/aliases. Concatenating
  // aliases let a generic word from any one of them validate a foreign source.
  const candidates = [
    evidence?.dossier?.canonical,
    evidence?.knowledgeBase?.condition,
    evidence?.condition,
    patient?.condition
  ];
  return String(candidates.find((s) => String(s || '').trim()) || '')
    .replace(/\*/g, '')
    .trim();
};

const conditionOverviewItem = (items, conditionSubject = '', urlIndex = null) => {
  if (!items.length) return null;
  // Never promote a wrong-disease paper as the overview fallback (e.g. a sickle
  // cell guideline winning because its title has "disease" / "review").
  const pool = conditionSubject && urlIndex
    ? items.filter((it) => conditionCiteAllowed(
      citationRelevantToCondition(it.url, conditionSubject, urlIndex),
      it.url
    ))
    : items;
  if (!pool.length) return null;
  // Prefer guideline / review / curated overview over a single drug label.
  const ranked = [...pool].sort((a, b) => {
    const score = (it) => {
      const blob = `${it.title || ''} ${it.category || ''} ${it.kbCategory || ''}`.toLowerCase();
      let s = 0;
      if (/guideline|review|evidence-based|overview|epidemiolog|pathophysiol/.test(blob)) s += 5;
      if (it.isCuratedKB) s += 2;
      if (conditionSubject && citationRelevantToCondition(it.url, conditionSubject, urlIndex) === true) s += 3;
      if (/fda|label|prescribing/.test(blob)) s -= 2;
      return s;
    };
    return score(b) - score(a);
  });
  return ranked[0] || null;
};

const appendCite = (sentence, item) => {
  const url = typeof item === 'string' ? item : item?.url;
  const anchor = inlineCiteAnchor(url, typeof item === 'string' ? null : item);
  if (!anchor) return String(sentence);
  const cite = ` (${anchor})`;
  const s = String(sentence);
  if (/[.!?]["']?\s*$/.test(s.trimEnd())) {
    return s.replace(/([.!?]["']?)(\s*)$/, `${cite}$1$2`);
  }
  // Bullets / lines without terminal punctuation — still put the link at the end.
  return `${s.replace(/\s+$/, '')}${cite}`;
};

// GFM pipe tables (Pipeline Watch, centers, trials). Claim-link injection and
// orphan ")" from demoted [Name](url) smash these into literal pipe junk.
export const isMarkdownTableRow = (line) => {
  const t = String(line || '').trim();
  if (!t.includes('|')) return false;
  // Header separator: |---|---| or ---|---
  if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(t)) return true;
  // A data/header row with at least two cells.
  const cells = t.split('|').filter((c, i, a) => !(i === 0 && c.trim() === '') && !(i === a.length - 1 && c.trim() === ''));
  return cells.length >= 2;
};

// Negative / empty findings must never get a decorative citation. "None
// identified in this pull" is not a literature claim — citing ABCA4/RetNet here
// is both wrong and enraging.
export const isNegativeOrEmptyFinding = (s) => {
  const t = String(s || '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/\*/g, '').trim();
  if (!t) return false;
  return (
    /\bnone\s+identified\b/i.test(t) ||
    /\bnone\s+found\b/i.test(t) ||
    /\bnot\s+identified\b/i.test(t) ||
    /\bnothing\s+(?:identified|found|reported)\b/i.test(t) ||
    /\bno\s+(?:published\s+)?sources?\s+(?:gathered\s+here\s+)?(?:establish|support|identify)\b/i.test(t) ||
    /\bno\s+evidence[- ]pack\s+items?\b/i.test(t) ||
    /\bno\s+published\s+source\s+gathered\s+here\b/i.test(t) ||
    /\binsufficient verified FDA\/DailyMed label evidence\b/i.test(t) ||
    /\bnone\s+in\s+this\s+pull\b/i.test(t) ||
    (/\bin\s+this\s+pull\b/i.test(t) && /\bnone\b/i.test(t))
  );
};

/**
 * Strip inline source anchors from negative/empty-finding lines (and never
 * leave a dangling "source ↗"). Prefer honest plain text over a fake cite.
 */
export const stripNegativeFindingCitations = (text) => {
  if (!text) return text;
  return String(text)
    .split('\n')
    .map((line) => {
      if (isMarkdownTableRow(line)) return line;
      if (!isNegativeOrEmptyFinding(line)) return line;
      let s = line;
      s = s.replace(/\s*\(\s*\[[^\]]+\]\(https?:\/\/[^)]+\)\s*\)/gi, '');
      s = s.replace(/\s*\[[^\]]+\]\(https?:\/\/[^)]+\)/gi, '');
      s = s.replace(/\s*\(\s*\[[^\]]*source[^\]]*\]\([^)]*\)\s*\)/gi, '');
      s = s.replace(/\s*\[[^\]]*source[^\]]*\]\([^)]*\)/gi, '');
      // Orphan source markers left after empty-href tidy: ([source ↗]) / [source ↗]
      s = s.replace(/\s*\(\s*\[?\s*source\s*↗?\s*\]?\s*\)/gi, '');
      s = s.replace(/\[source\s*↗?\](?!\()/gi, '');
      s = s.replace(/\bsource\s*↗\b/gi, '');
      return s
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]+([.,;:)])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/gm, '');
    })
    .join('\n');
};

/**
 * Strip malformed nested citation patterns that can accumulate when
 * finalizeReportText runs multiple times on the same text. These look like:
 *   "([Title ([Title ([Title (Title ↗). ↗). ↗). ↗)"
 * Keep only the innermost citation with the actual markdown link.
 */
const collapseNestedCitations = (text) => {
  if (!text) return text;
  let s = String(text);
  // Pattern: nested parens containing repeated ↗ arrows without proper markdown links.
  // Keep collapsing until stable (handles arbitrary nesting depth).
  let prev;
  do {
    prev = s;
    // Strip orphan outer citation wrappers: "( ... ↗)." that wrap another citation
    s = s.replace(/\(\s*\(([^()]*↗[^()]*)\)\s*↗?\s*\)\s*\./g, '($1).');
    // Strip "(text (text ↗). ↗)" -> "(text ↗)."
    s = s.replace(/\(([^()↗]+)\s*\(\1[^)]*↗[^)]*\)\s*↗?\s*\)/g, '([$1 ↗])');
    // Strip "([Title ([Title ↗](url)) ↗](url))" nesting
    s = s.replace(/\(\[([^\]]+)\s*\(\[[^\]]+↗\]\([^)]+\)\)\s*↗\]\([^)]+\)\)/g, '([$1 ↗])');
    // Remove empty/malformed citation artifacts
    s = s.replace(/\(\s*↗\s*\)/g, '');
    s = s.replace(/↗\s*\)\s*\.\s*↗\s*\)/g, '↗).');
  } while (s !== prev);
  return s;
};

/**
 * FUNDAMENTAL: every significant claim sentence gets an inline pack link,
 * or a must-cite / hard claim without support is stripped.
 * Returns { text, attached, stripped }.
 *
 * opts.conditionSubject / opts.patient — patient condition (+ synonyms). When
 * set, a pack item whose known text is about a different disease is never
 * attached (Condition Snapshot / research prose had the same wrong-paper class
 * as candidate cards).
 */
export const attachMissingClaimCitations = (text, evidence, trials = null, opts = {}) => {
  if (!text) return { text, attached: 0, stripped: 0 };
  // Clean up any existing nested citation artifacts before processing, then
  // drop URL-less citation markers so a claim is judged on the sources it
  // actually still has.
  const cleanedText = stripOrphanCitationMarkers(collapseNestedCitations(String(text)));
  const items = collectCitationItems(evidence, trials);
  const urlIndex = buildEvidenceUrlIndex(evidence);
  const conditionSubject = String(
    opts.conditionSubject || resolveReportConditionSubject(opts.patient, evidence) || ''
  ).trim();
  const overview = conditionOverviewItem(items, conditionSubject, urlIndex);
  // A curated reference pinned to THIS condition stays eligible even when its
  // text never uses the condition's name. Filtering it out here removed it
  // from the candidate pool entirely, so no later check could rescue it: the
  // curated Luxturna label could not cite a Luxturna claim on a retinitis
  // pigmentosa report.
  const itemCuratedForCondition = (it) => {
    if (!it || !(it.isCuratedKB || it.curated || it.kbCategory)) return false;
    const tagged = String(it.kbCondition || it.conditionSlug || '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!tagged) return true;
    const subject = String(conditionSubject || '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return !subject || tagged.includes(subject) || subject.includes(tagged);
  };
  const conditionEligibleItems = conditionSubject
    ? items.filter((it) => itemCuratedForCondition(it) || conditionCiteAllowed(
      citationRelevantToCondition(it.url, conditionSubject, urlIndex),
      it.url
    ))
    : items;

  let attached = 0;
  let stripped = 0;
  let currentSubject = '';
  const lines = cleanedText.split('\n');
  const tableHeaderRows = new Set();
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (
      isMarkdownTableRow(lines[i]) &&
      /^\s*\|?\s*:?-{3,}(?:\s*\|\s*:?-{3,})+\s*\|?\s*$/.test(lines[i + 1])
    ) tableHeaderRows.add(i);
  }
  const out = lines.map((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    {
      const cm = trimmed.match(
        /^(?:CANDIDATE|TREATMENT|PROVIDER|Drug or supplement idea|Treatment|Treatment type):\s*(.+)$/i
      );
      if (cm) currentSubject = cm[1].replace(/\*/g, '').split(/[—–\-:|]/)[0].trim();
      if (/^---+$/.test(trimmed) || /^\s{0,3}#{1,6}\s/.test(line)) currentSubject = '';
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) return line;
    if (/^(?:CANDIDATE|TREATMENT|PROVIDER|Drug or supplement idea|Treatment|Treatment type):/im.test(trimmed)) return line;
    if (isMarkdownTableRow(line)) {
      if (tableHeaderRows.has(lineIndex)) return line;
      if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed)) return line;
      // Trial rows were already checked against the structured registry above.
      // Their exact NCT link is the adjacent source for the complete row.
      if (/clinicaltrials\.gov\/study\/NCT\d{8}/i.test(line)) return line;
      const hasOuterPipes = trimmed.startsWith('|') && trimmed.endsWith('|');
      const cells = trimmed.split('|');
      const start = hasOuterPipes ? 1 : 0;
      const end = hasOuterPipes ? cells.length - 1 : cells.length;
      for (let i = start; i < end; i++) {
        const cell = cells[i].trim();
        if (!cell || sentenceHasLink(cell) || !isClaimSentence(cell)) continue;
        const { item, score } = bestItemForClaim(
          cell,
          conditionEligibleItems,
          { condition: conditionSubject }
        );
        const rowClaim = cells.slice(start, end).map((value) => value.trim()).filter(Boolean).join(' ');
        const grounded = item && citationItemSupportsClaim(
          rowClaim,
          item,
          { condition: conditionSubject }
        );
        const relevant = item && score >= 0.10 && grounded
          && isValidCiteUrl(item.url)
          && (!conditionSubject || conditionCiteAllowed(
            citationRelevantToCondition(item.url, conditionSubject, urlIndex),
            item.url
          ));
        if (relevant) {
          cells[i] = ` ${appendCite(cell, item)} `;
          attached += 1;
        } else {
          cells[i] = ' Not established from the gathered sources. ';
          stripped += 1;
        }
      }
      const rebuiltRow = `${line.match(/^\s*/)?.[0] || ''}${cells.join('|')}`;
      if (
        (
          /Not established from the gathered sources/i.test(rebuiltRow) ||
          !sentenceHasLink(rebuiltRow)
        ) &&
        /\b(?:avoid|contraindicated|high|moderate(?:-high)?|severe)\b/i.test(rebuiltRow)
      ) {
        stripped += 1;
        return '';
      }
      if (
        !sentenceHasLink(rebuiltRow) &&
        !isNegativeOrEmptyFinding(rebuiltRow) &&
        !isSupportedPatientStatement(rebuiltRow, opts.patient || {})
      ) {
        stripped += 1;
        return '';
      }
      return rebuiltRow;
    }
    const lead = line.match(/^\s*/)?.[0] || '';
    const sentences = splitClaimSentences(line);
    const rebuilt = [];
    for (const sent of sentences) {
      const st = sent.trim();
      if (!st) {
        rebuilt.push(sent);
        continue;
      }
      // A supplied patient fact is grounded in the profile, not in a paper.
      // Do not decorate it with a literature citation or strip it as unsourced.
      if (isSupportedPatientStatement(st, opts.patient || {})) {
        rebuilt.push(sent);
        continue;
      }
      // Negative / empty findings are NOT literature claims — leave unlinked.
      if (isNegativeOrEmptyFinding(st)) {
        rebuilt.push(sent);
        continue;
      }
      if (sentenceHasLink(sent) || !isClaimSentence(st)) {
        rebuilt.push(sent);
        continue;
      }
      const { item, score } = bestItemForClaim(
        st,
        conditionEligibleItems,
        { condition: conditionSubject }
      );
      const subjectRelevant = (url) =>
        !currentSubject || citationRelevantToSubject(url, currentSubject, urlIndex) !== false;
      // A curated reference was pinned to this condition by a human reviewer,
      // so it is on-topic even when its text never spells the condition's name
      // — the Luxturna label says "biallelic RPE65 mutation-associated retinal
      // dystrophy", never "retinitis pigmentosa", and was therefore rejected as
      // a wrong-disease citation for the very condition it was curated under.
      const curatedForThisCondition = (item) => {
        if (!item || !(item.isCuratedKB || item.curated || item.kbCategory)) return false;
        if (!conditionSubject) return true;
        const tagged = String(item.kbCondition || item.conditionSlug || '')
          .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!tagged) return true;
        const subject = String(conditionSubject)
          .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return !!subject && (tagged.includes(subject) || subject.includes(tagged));
      };
      const conditionRelevant = (url, item = null) =>
        !conditionSubject ||
        curatedForThisCondition(item) ||
        conditionCiteAllowed(
          citationRelevantToCondition(url, conditionSubject, urlIndex),
          url
        );
      const mayAttach = (url, item = null) =>
        isValidCiteUrl(url) && subjectRelevant(url) && conditionRelevant(url, item);
      const groundedByItem = item && citationItemSupportsClaim(
        st,
        item,
        { condition: conditionSubject }
      );
      if (item && score >= 0.10 && groundedByItem && mayAttach(item.url, item)) {
        attached += 1;
        rebuilt.push(appendCite(sent, item));
        continue;
      }
      if (
        !isHardClaim(st) &&
        isGeneralConditionClaim(st) &&
        overview?.url &&
        citationItemSupportsClaim(st, overview, { condition: conditionSubject }) &&
        mayAttach(overview.url, overview)
      ) {
        attached += 1;
        rebuilt.push(appendCite(sent, overview));
        continue;
      }
      if (isMustCite(st) && item && score >= 0.14 && groundedByItem && mayAttach(item.url, item)) {
        attached += 1;
        rebuilt.push(appendCite(sent, item));
        continue;
      }
      // This is already a factual sentence: if no exact source could be
      // attached above, it cannot reach the reader merely because it missed a
      // narrow keyword list.
      stripped += 1;
    }
    if (!rebuilt.length) return '';
    const joined = rebuilt.join('');
    if (lead && !joined.startsWith(lead)) return lead + joined.trimStart();
    return joined;
  });
  return {
    text: tidyAfterMarkerEdit(out.filter((l, i) => l !== '' || lines[i] === '').join('\n')),
    attached,
    stripped
  };
};

/**
 * Build name → URL index from evidence/trials so bold entities and table cells
 * can carry real links (pipeline drugs, NCT studies, FDA labels).
 */
export const buildEntityUrlIndex = (evidence, trials = null) => {
  const map = new Map();
  const add = (name, url) => {
    const n = String(name || '').replace(/\*/g, '').trim();
    const u = String(url || '').trim();
    if (!n || n.length < 3 || !/^https?:\/\//i.test(u) || isDailyMedSearchUrl(u)) return;
    map.set(n.toLowerCase(), u);
    const first = n.split(/[\s(/]/)[0];
    if (first && first.length >= 5 && !map.has(first.toLowerCase())) {
      map.set(first.toLowerCase(), u);
    }
  };
  for (const d of evidence?.pipelineDrugs || []) {
    const url = preferVerifiableUrl(d, d?.url) ||
      (d?.nct ? `https://clinicaltrials.gov/study/${String(d.nct).toUpperCase()}` : '') ||
      (d?.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${String(d.pmid).replace(/\D/g, '')}/` : '');
    add(d?.name, url);
    for (const a of d?.aliases || []) add(a, url);
  }
  for (const f of evidence?.fdaLabels || []) {
    const lbl = f?.label || f;
    const url = lbl?.dailyMedUrl || f?.dailyMedUrl || '';
    add(lbl?.genericName?.[0] || lbl?.genericName || f?.drug, url);
    add(lbl?.brandName?.[0] || lbl?.brandName, url);
  }
  for (const s of trials?.studies || []) {
    const nct = String(s.nctId || s.nct || '').toUpperCase();
    if (nct) add(nct, s.url || `https://clinicaltrials.gov/study/${nct}`);
  }
  for (const it of evidence?.groundedForPrompt || []) {
    if (it?.nct) add(it.nct, preferVerifiableUrl(it, it.url));
  }
  return map;
};

const lookupEntityUrl = (index, name) => {
  if (!index?.size) return '';
  const n = String(name || '').replace(/\*/g, '').trim();
  if (!n) return '';
  return index.get(n.toLowerCase()) ||
    index.get(n.split(/[\s(/—–-]/)[0].toLowerCase()) ||
    '';
};

// Belt-and-suspenders: strip EVERY DailyMed search.cfm link (markdown or bare)
// to plain text no matter how it entered the report, keeping the anchor text.
// A specific label monograph (drugInfo.cfm?setid=…) is preserved.
export const stripDailyMedSearchLinks = (text) => {
  if (!text) return text;
  let s = String(text);
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm[^)]*)\)/gi,
    '$1'
  );
  s = s.replace(
    /(?<![(\[])https?:\/\/(?:www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm[^\s)\]"'<>]*/gi,
    ''
  );
  return tidyAfterMarkerEdit(s);
};

// ===========================================================================
// Citation-claim RELEVANCE enforcement on CANDIDATE / card blocks (Task B).
//
// A citation that resolves (live, non-search, specific) can still be WRONG: a
// generic disease review linked on a specific drug's card that never mentions
// that drug. sanitizeMarkdownLinks cannot catch this (the URL is real). Here we
// walk each CANDIDATE block, take its subject (the drug/supplement name), and
// demote to plain text any REFERENCES / SUPPORTING_EVIDENCE link whose SOURCE
// TEXT is known (in the evidence pack) and does NOT mention that subject.
//
// Conservative by construction (citationRelevantToSubject returns null → keep):
//   - a URL not in the evidence pack (we cannot see its text) is KEPT;
//   - a subject too short to tokenize (e.g. "NAC") is KEPT.
// So this only strips a link we can POSITIVELY show is off-topic — never a
// citation we simply cannot verify. Condition-agnostic (no drug/disease list).
// ===========================================================================
// Public-language rewrite turns CANDIDATE: into "Drug or supplement idea:"
// and TREATMENT: into "Treatment:" before or during finalization. Subject
// gates must recognize both the raw schema labels and the reader labels.
const CARD_SUBJECT_RE =
  /^(?:CANDIDATE|TREATMENT|PROVIDER|Drug or supplement idea|Treatment|Treatment type)\s*:\s*(.+)$/im;
const CARD_SUBJECT_SPLIT_RE =
  /(?=^(?:CANDIDATE|TREATMENT|PROVIDER|Drug or supplement idea|Treatment|Treatment type)\s*:)/gim;

export const enforceCandidateCitationRelevance = (text, evidence) => {
  if (!text || !CARD_SUBJECT_RE.test(String(text))) return { text, demoted: [] };
  const urlIndex = buildEvidenceUrlIndex(evidence);
  const demoted = [];
  const blocks = String(text).split(CARD_SUBJECT_SPLIT_RE);
  const out = blocks
    .map((block) => {
      const subj = (block.match(CARD_SUBJECT_RE) || [])[1];
      if (!subj) return block;
      const subject = String(subj).replace(/\*/g, '').split(/[—–\-:|]/)[0].trim();
      if (!subject) return block;
      return block
        .split('\n')
        .map((line) => {
          // Scan EVERY line's inline links, not just REFERENCES/SUPPORTING_EVIDENCE.
          // Off-topic citations most often appear in REPURPOSE_RATIONALE / WHY /
          // EFFICACY bullets; limiting to cite-lines let those slip through.
          if (!/\[[^\]]+\]\((https?:\/\/[^)]+)\)/.test(line)) return line;
          return line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => {
            const rel = urlIndex.size
              ? citationRelevantToSubject(url, subject, urlIndex)
              : (isUnverifiedDocumentUrl(url) ? false : null);
            if (rel === false) {
              demoted.push(`${subject}: ${url}`);
              return label;
            }
            return m;
          });
        })
        .join('\n');
    })
    .join('');
  return { text: out, demoted };
};

/**
 * Drop nameless card fragments left after FDA/label gates remove a treatment
 * name but leave "FDA status: Unknown" / safety prose. Those orphans were
 * rendering under the previous card (Luxturna + NAC citation).
 */
export const stripOrphanCardFragments = (text) => {
  if (!text) return text;
  const fieldLine = /^(?:FDA[_\s-]?STATUS|APPROVAL_STATUS|LABEL_STATUS|FDA status|Sources|REFERENCES|RISKS|Risks|SAFETY|Safety(?: concern)?|EFFICACY|What studies found|LENGTH_FREQUENCY|Dose and schedule|INTERACTIONS|Medication interactions|COST|Cost and access)\s*:/i;
  const orphanProse = /\bFull safety data are not yet published\b/i;
  const lines = String(text).split('\n');
  const out = [];
  let named = false;
  let droppingOrphan = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      named = false;
      droppingOrphan = false;
      out.push(line);
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      // Keep separators, but stay in orphan-drop mode so a following
      // citation-only safety line cannot reattach to the prior named card.
      named = false;
      out.push(line);
      continue;
    }
    if (CARD_SUBJECT_RE.test(trimmed)) {
      named = true;
      droppingOrphan = false;
      out.push(line);
      continue;
    }
    if (!named && (fieldLine.test(trimmed) || orphanProse.test(trimmed))) {
      droppingOrphan = true;
      continue;
    }
    if (droppingOrphan) {
      if (!trimmed) {
        droppingOrphan = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const TABLE_SEPARATOR_RE = /^\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * Terminal cleanup. Every stripper above exempts headings and table headers so
 * a deleted claim can't take a whole section's structure with it — but nothing
 * then removed the structure left standing over nothing. The reader saw
 * numbered sections, sub-headings and column headers promising content that
 * had all been stripped, which reads as "we found nothing worth saying here"
 * at best and as missing data at worst.
 *
 * A table whose data rows are gone is removed. A heading with no surviving
 * content gets an explicit line saying so, rather than silently implying
 * coverage we don't have.
 */
export const dropEmptyStructure = (text, { emptyNote = '' } = {}) => {
  if (!text) return text;
  const note = emptyNote ||
    'Nothing was found for this section in the sources reviewed in this search.';
  const lines = String(text).split('\n');

  // Pass 1: drop header+separator pairs that have no data rows under them.
  const keptRows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    const isHeaderPair =
      isMarkdownTableRow(line) &&
      !TABLE_SEPARATOR_RE.test(line.trim()) &&
      next !== undefined &&
      TABLE_SEPARATOR_RE.test(String(next).trim());
    if (isHeaderPair) {
      let j = i + 2;
      let dataRows = 0;
      while (j < lines.length && isMarkdownTableRow(lines[j])) {
        if (!TABLE_SEPARATOR_RE.test(lines[j].trim())) dataRows += 1;
        j += 1;
      }
      if (dataRows === 0) {
        // Replace the gutted table rather than deleting it, so any caption
        // above it ("Drug-Drug Interactions") still has a body and the reader
        // is told the table was empty instead of being left to infer it.
        if (keptRows[keptRows.length - 1] !== note) keptRows.push(note);
        i = j - 1;
        continue;
      }
    }
    // A lone table row with no table row above or below it cannot render as a
    // table — the reader sees literal pipe characters mid-paragraph. It is the
    // residue of a table whose other rows were removed, so the remnant goes too.
    if (
      isMarkdownTableRow(line) &&
      !TABLE_SEPARATOR_RE.test(line.trim()) &&
      !isMarkdownTableRow(lines[i - 1] || '') &&
      !isMarkdownTableRow(lines[i + 1] || '')
    ) {
      if (keptRows[keptRows.length - 1] !== note) keptRows.push(note);
      continue;
    }
    // A separator with no header above it is the residue of an already-gutted
    // table (the bare "|---|" under Clinical Trials).
    if (TABLE_SEPARATOR_RE.test(line.trim()) && !isMarkdownTableRow(lines[i - 1] || '')) {
      if (keptRows[keptRows.length - 1] !== note) keptRows.push(note);
      continue;
    }
    keptRows.push(line);
  }

  // Pass 2: annotate headings whose body is now empty. The model writes its own
  // sub-headings ("What happens if untreated?", "Key safety flags:") that are
  // not markdown headings, and those strand just as visibly.
  const isHeading = (line) => /^\s{0,3}#{1,6}\s/.test(line || '');
  const isSubHeading = (line) => {
    const t = String(line || '').trim().replace(/^[-*•]\s+/, '');
    if (!t || t.length > 90 || /\]\(/.test(t)) return false;
    return /^\*\*[^*]+\*\*:?$/.test(t) || /^[A-Z][^.!]*[:?]$/.test(t);
  };
  const isBoundary = (line) => isHeading(line) || isSubHeading(line);
  const headingLevel = (line) => (String(line).match(/^\s{0,3}(#{1,6})\s/)?.[1] || '').length;
  // A section is empty only when NOTHING renders before the next heading of the
  // same or higher level. Treating "next line is a sub-heading" as empty put
  // "Nothing was found for this section" directly above content that was
  // present — a heading whose first child is a sub-heading is not empty.
  const hasContentBefore = (start, stopLevel) => {
    for (let j = start; j < keptRows.length; j += 1) {
      const line = keptRows[j];
      if (!String(line).trim()) continue;
      // A horizontal rule is punctuation, not content. Counting it as content
      // left "## 6. Cell, Gene & Advanced Therapies" standing over nothing but
      // "---" in a sickle cell report — a heading promising gene therapies with
      // no note saying none were found.
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
      const level = headingLevel(line);
      // A markdown heading of the same or higher level ends this section.
      if (level && stopLevel && level <= stopLevel) return false;
      // A sub-heading owns only the run of text until the NEXT boundary of any
      // kind. Scanning past it let "Typical path if untreated:" borrow the
      // content of a later section and so never report itself as empty.
      if (!stopLevel && isBoundary(line)) return false;
      if (!isBoundary(line)) return true;
    }
    return false;
  };
  const out = [];
  for (let i = 0; i < keptRows.length; i += 1) {
    out.push(keptRows[i]);
    const line = keptRows[i];
    if (!isBoundary(line)) continue;
    const level = headingLevel(line);
    if (hasContentBefore(i + 1, level)) continue;
    out.push('');
    out.push(note);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * Demote inline citations whose pack source text is about a DIFFERENT disease
 * than the patient's condition. Catches model-authored links, [#N] resolutions,
 * and any attach misses in Condition Snapshot / free-form research prose.
 * Same conservative three-valued contract as the card drug gate (null → keep).
 */
export const enforceConditionCitationRelevance = (text, evidence, patient = null) => {
  if (!text) return { text, demoted: [] };
  const conditionSubject = resolveReportConditionSubject(patient, evidence);
  if (!conditionSubject) return { text, demoted: [] };
  const urlIndex = buildEvidenceUrlIndex(evidence);
  const demoted = [];
  const out = String(text)
    .split('\n')
    .map((line) => {
      // Do not demote inside GFM tables — partial demotion of [Drug (alias)](url)
      // leaves orphan ")" and destroys Pipeline Watch markup.
      if (isMarkdownTableRow(line)) return line;
      return line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => {
        const rel = urlIndex.size
          ? citationRelevantToCondition(url, conditionSubject, urlIndex)
          : (isUnverifiedDocumentUrl(url) ? false : null);
        if (!conditionCiteAllowed(rel, url)) {
          demoted.push(`${conditionSubject}: ${url}`);
          if (/^source\s*↗?$/i.test(String(label).trim())) return '';
          return label;
        }
        return m;
      });
    })
    .join('\n');
  return { text: tidyAfterMarkerEdit(out), demoted };
};

const READABLE_REGISTRY_VALUES = {
  NA: 'Not applicable',
  EARLY_PHASE1: 'Early phase 1',
  PHASE1: 'Phase 1',
  PHASE2: 'Phase 2',
  PHASE3: 'Phase 3',
  PHASE4: 'Phase 4',
  ACTIVE_NOT_RECRUITING: 'Active, not recruiting',
  NOT_YET_RECRUITING: 'Not yet recruiting',
  ENROLLING_BY_INVITATION: 'Enrolling by invitation',
  NO_LONGER_AVAILABLE: 'No longer available',
  APPROVED_FOR_MARKETING: 'Approved for marketing',
  UNKNOWN: 'Unknown status'
};
const readableRegistryValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase().replace(/\s+/g, '_');
  if (READABLE_REGISTRY_VALUES[key]) return READABLE_REGISTRY_VALUES[key];
  return raw
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\bphase\s*([1-4])\b/g, 'phase $1')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const replaceClinicalTrialsSection = (text, trials) => {
  const source = String(text || '');
  const sectionPattern = /(^|\n)##\s*4\.[^\n]*\n[\s\S]*?(?=\n##\s*5\.|$)/i;
  if (!sectionPattern.test(source)) return source;
  const studies = (Array.isArray(trials?.studies) ? trials.studies : [])
    .map((study) => {
      const nctId = normalizeNctId(study?.nctId);
      if (!nctId) return null;
      const title = String(study?.briefTitle || study?.officialTitle || nctId)
        .replace(/[[\]|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const phase = (study?.phases || []).map(readableRegistryValue).join('/') || 'Phase not listed';
      const status = readableRegistryValue(study?.status) || 'Status not listed';
      return {
        nctId,
        title,
        phase,
        status,
        url: `https://clinicaltrials.gov/study/${nctId}`
      };
    })
    .filter(Boolean);
  const SECTION_TRIAL_LIMIT = 25;
  const shown = studies.slice(0, SECTION_TRIAL_LIMIT);
  const truncationNote = studies.length > shown.length
    ? `Showing the first ${shown.length} of ${studies.length} matching records; the full list is in the clinical trials table.`
    : '';
  // A single-column table is not recognised as a table by the downstream
  // claim/citation passes (they require at least two cells), so every row was
  // treated as loose unsourced prose and deleted, leaving the heading and a
  // bare separator behind. Real columns keep the rows intact and read better.
  const body = shown.length
    ? [
        '## 4. Clinical Trials',
        'The following records came directly from ClinicalTrials.gov in this search.',
        ...(truncationNote ? [truncationNote] : []),
        '',
        '| Study | Study stage | Study status | Record |',
        '|---|---|---|---|',
        ...shown.map((study) =>
          `| [${study.title}](${study.url}) | ${study.phase} | ${study.status} | [${study.nctId}](${study.url}) |`
        )
      ].join('\n')
    : trials && typeof trials === 'object'
      ? [
        '## 4. Clinical Trials',
        'No matching ClinicalTrials.gov records were returned in this search. This does not prove that no trials exist.'
      ].join('\n')
      : [
        '## 4. Clinical Trials',
        'ClinicalTrials.gov results were unavailable during this search, so this section is incomplete.'
      ].join('\n');
  return source.replace(sectionPattern, (match, lead) => `${lead}${body}\n`);
};


/**
 * Section 2 is a rendering of curated, human-reviewed facts (the same centres
 * and investigators shown in the panel above the report), not model claims.
 * Left to the model it lost most of them, and the table-cell citation gate
 * blanked the survivors' cells to "Not established from the gathered sources"
 * because a curated centre has no paper to cite. Render it directly.
 */
// A field label carrying no value is model residue, not content. The label
// rewriter only maps "LABEL:" with a colon, so a bare "TREATMENT" on the last
// line of a card survived every pass and rendered as the literal word
// TREATMENT under the drug's name.
const VALUELESS_FIELD_LABEL_RE = new RegExp(
  `^[ \\t>*#-]*(?:${[...Object.keys(RAW_LABELS), ...READER_FIELD_LABELS]
    .map((l) => String(l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\s*:?\\s*$`,
  'i'
);

export const dropValuelessFieldLabels = (text) => String(text || '')
  .split('\n')
  .filter((line) => !VALUELESS_FIELD_LABEL_RE.test(line))
  .join('\n');

export const replaceCentersSection = (text, dossier) => {
  const source = String(text || '');
  const sectionPattern = /(^|\n)##\s*2\.[^\n]*\n[\s\S]*?(?=\n##\s*3\.|$)/i;
  if (!sectionPattern.test(source)) return source;
  const centers = Array.isArray(dossier?.topCenters) ? dossier.topCenters : [];
  const experts = Array.isArray(dossier?.keyInvestigators) ? dossier.keyInvestigators : [];
  if (!centers.length && !experts.length) return source;

  const cell = (value) => String(value || '').replace(/[|\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const lines = ['## 2. Condition-Focused Centers & Experts'];
  if (centers.length) {
    lines.push(
      'Centers identified for specialized expertise in this condition. This is not a quality ranking, and it is not a referral.',
      '',
      '| Center | Location | Focus for this condition |',
      '|---|---|---|',
      ...centers.map((c) => {
        const place = [cell(c.city), cell(c.country)].filter(Boolean).join(', ');
        const name = cell(c.name);
        // Searched entries carry a link; curated ones generally do not.
        const label = /^https?:\/\//i.test(String(c.url || '')) ? `[${name}](${c.url})` : name;
        return `| ${label} | ${place || 'Not listed'} | ${cell(c.why) || 'Not listed'} |`;
      })
    );
  }
  if (experts.length) {
    lines.push(
      '',
      'Clinicians and researchers publishing on this condition:',
      '',
      ...experts.map((e) => {
        const who = /^https?:\/\//i.test(String(e.url || ''))
          ? `[${cell(e.name)}](${e.url})`
          : cell(e.name);
        const where = cell(e.affiliation);
        const why = cell(e.why);
        return `- ${who}${where ? ` — ${where}` : ''}${why ? `. ${why}` : ''}`;
      })
    );
  }
  return source.replace(sectionPattern, (match, lead) => `${lead}${lines.join('\n')}\n`);
};


/**
 * Sections 7 (advocacy) and 8 (safety) were rendering empty while the curated
 * dossier held four reviewed safety flags, six comorbidities and advocacy
 * organisations with real URLs — all of it already displayed in the panel
 * above the report. Like section 2, these are verified facts rather than model
 * claims, so they are rendered directly and written after the gates.
 */
const bullet = (value) => `- ${String(value || '').replace(/\s+/g, ' ').trim()}`;

export const replaceCuratedSafetySection = (text, dossier) => {
  const source = String(text || '');
  // Section 8 is the last section, so when it is empty its heading is the final
  // line of the document and earlier passes have trimmed the trailing newline.
  // Requiring a newline after the heading meant the renderer never matched in
  // exactly the case it exists for — an empty safety section.
  const pattern = /(^|\n)##\s*8\.[^\n]*(?:\n[\s\S]*)?$/i;
  if (!pattern.test(source)) return source;
  const flags = (dossier?.redFlags || []).filter(Boolean);
  const comorbid = (dossier?.commonComorbidities || []).filter(Boolean);
  if (!flags.length && !comorbid.length) return source;
  const lines = ['## 8. Safety Considerations Reported in Literature'];
  if (flags.length) {
    lines.push(
      'Cautions reported in the literature for this condition. Discuss any that apply to you with your clinician.',
      '',
      ...flags.map(bullet)
    );
  }
  if (comorbid.length) {
    lines.push('', 'Other conditions reported alongside this one, worth asking about:', '', ...comorbid.map(bullet));
  }
  return source.replace(pattern, (match, lead) => `${lead}${lines.join('\n')}\n`);
};

export const replaceAdvocacySubsection = (text, dossier) => {
  const source = String(text || '');
  const orgs = (dossier?.patientAdvocacy || []).filter((o) => o && o.name);
  if (!orgs.length) return source;
  // Replace the advocacy sub-heading's body wherever it sits inside section 7.
  const pattern = /(^|\n)(#{0,6}\s*Patient Advocacy[^\n]*)\n[\s\S]*?(?=\n#{0,6}\s*(?:Insurance|Drug-Drug|Non-Drug)|\n##\s*\d|$)/i;
  if (!pattern.test(source)) return source;
  const rows = orgs.map((o) => {
    const name = String(o.name).replace(/[|\n]/g, ' ').trim();
    const why = String(o.why || '').replace(/[|\n]/g, ' ').trim();
    const link = o.url ? `[${name}](${o.url})` : name;
    return `- ${link}${why ? ` — ${why}` : ''}`;
  });
  return source.replace(pattern, (match, lead, heading) =>
    `${lead}${heading}\n\n${rows.join('\n')}\n`);
};


/**
 * Curated lifestyle guidance, rendered rather than routed through the model.
 * The prompt requires a pack citation on every lifestyle bullet, so the
 * citation pass deleted them all and the sub-section rendered empty — the same
 * failure as the centres and safety sections. These are clinician-reviewed
 * entries; where one carries its own reference it is linked.
 */
export const replaceLifestyleSubsection = (text, dossier, evidence) => {
  const source = String(text || '');
  const categories = (dossier?.lifestyleCategories || evidence?.lifestyleCategories || []).filter(Boolean);
  const recommendations = (evidence?.lifestyleRecommendations || dossier?.lifestyleRecommendations || [])
    .map((r) => (typeof r === 'string' ? { recommendation: r } : r))
    .filter((r) => r && r.recommendation);
  if (!categories.length && !recommendations.length) return source;
  const pattern = /(^|\n)(#{0,6}\s*Non-Drug\s*\/?\s*Lifestyle[^\n]*)\n[\s\S]*?(?=\n#{0,6}\s*(?:Patient Advocacy|Insurance|Drug-Drug)|\n##\s*\d|$)/i;
  if (!pattern.test(source)) return source;
  const lines = [];
  for (const rec of recommendations.slice(0, 8)) {
    const body = String(rec.recommendation).replace(/\s+/g, ' ').trim();
    const url = String(rec.url || '').trim();
    lines.push(/^https?:\/\//i.test(url) ? `- ${body} ([source](${url}))` : `- ${body}`);
  }
  for (const category of categories.slice(0, 8)) {
    const label = String(category).replace(/\s+/g, ' ').trim();
    if (label && !lines.some((l) => l.toLowerCase().includes(label.slice(0, 24).toLowerCase()))) {
      lines.push(`- ${label}`);
    }
  }
  if (!lines.length) return source;
  return source.replace(pattern, (match, lead, heading) =>
    `${lead}${heading}\n\nSupportive-care topics reviewed for this condition. Discuss what applies to you with your clinician.\n\n${lines.join('\n')}\n`);
};


// Gene therapy, cell therapy, optogenetics and gene editing. Deliberately
// narrow: matching "cell" alone swept in anything whose mechanism mentioned
// cone or nerve cells.
const ADVANCED_MODALITY = [
  [/\b(?:crispr|cas9|gene[- ]edit(?:ing)?|base edit|prime edit)\b/i, 'Gene editing'],
  [/\b(?:optogenetic|opsin|photoswitch)\b/i, 'Optogenetic therapy'],
  [/\b(?:aav\d*|lentivir|adeno[- ]associated|gene therapy|gene replacement|gene augmentation|[a-z]+parvovec)\b/i, 'Gene therapy'],
  [/\b(?:stem cell|progenitor cell|hesc|ipsc|cell therapy|cell transplant|retinal pigment epithelium transplant)\b/i, 'Cell therapy'],
  [/\b(?:antisense oligonucleotide|exon[- ]skip|rna therap|sirna|mrna therap)\b/i, 'RNA therapy']
];

const advancedModality = (drug) => {
  const blob = [drug?.name, drug?.mechanism, drug?.approvalStatus].filter(Boolean).join(' ');
  for (const [pattern, label] of ADVANCED_MODALITY) {
    if (pattern.test(blob)) return label;
  }
  return '';
};

/**
 * Section 6 rendered empty on every report while the curated pipeline held
 * eight gene and cell therapy programmes for the condition. The prompt caps it
 * at three bullets and the citation pass then removed the unlinked ones, so
 * nothing survived. These are curated programme records with registry ids, so
 * they are rendered directly — and this is where the gene and cell therapies
 * excluded from the drug-idea lists actually belong.
 */
export const replaceAdvancedTherapiesSection = (text, evidence, dossier) => {
  const source = String(text || '');
  const pattern = /(^|\n)##\s*6\.[^\n]*\n[\s\S]*?(?=\n##\s*7\.|$)/i;
  if (!pattern.test(source)) return source;
  const drugs = (evidence?.pipelineDrugs || []).filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (const drug of drugs) {
    const modality = advancedModality(drug);
    if (!modality) continue;
    const name = String(drug.name || '').replace(/[|\n]/g, ' ').trim();
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const nct = String(drug.nct || '').match(/NCT\d{8}/)?.[0] || '';
    const url = nct
      ? `https://clinicaltrials.gov/study/${nct}`
      : (drug.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${drug.pmid}/` : '');
    const status = String(drug.status || drug.approvalStatus || 'Status not listed')
      .replace(/[|\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 170);
    const record = url ? `[${nct || 'source'}](${url})` : 'Not listed';
    rows.push(`| ${name} | ${modality} | ${status} | ${record} |`);
  }
  if (!rows.length) return source;
  const caution = (dossier?.redFlags || evidence?.redFlags || [])
    .find((flag) => /stem[- ]cell|offshore|unproven|clinic/i.test(String(flag)));
  const lines = [
    '## 6. Cell, Gene & Advanced Therapies',
    'Cell, gene and other advanced-modality programs identified for this condition. Listing a program is not a statement that it is available to you, or that it works.',
    '',
    '| Program | Modality | Status | Record |',
    '|---|---|---|---|',
    ...rows
  ];
  if (caution) lines.push('', String(caution).replace(/\s+/g, ' ').trim());
  return source.replace(pattern, (match, lead) => `${lead}${lines.join('\n')}\n`);
};

// MRT_PASS_TRACE=1 logs what each pass in finalizeReportText actually changes
// on a real report. This pipeline accumulated 46 sequential passes, and the
// only way to tell a live one from sediment is to measure. Note what the
// measurement does NOT show: a guard that never fires on clean output is doing
// its job, not sitting idle — sanitizePublicText and demoteBannedClaimCitations
// both read as "no change" on a healthy report and must stay.
const MRT_PASS_TRACE = String(process.env.MRT_PASS_TRACE || '') === '1';
const tracePass = (label, before, after) => {
  if (!MRT_PASS_TRACE) return after;
  const b = String(before || ''), a = String(after || '');
  if (b !== a) console.log(`[pass] ${label}: ${b.length} -> ${a.length} (${a.length - b.length})`);
  else console.log(`[pass] ${label}: no change`);
  return after;
};


/**
 * Re-seal citations only.
 *
 * finalizeReportText ran TWICE on every report — 48 passes each, on text the
 * first pass had already finished with. The second existed for one narrow
 * reason: dead-link removal and entity re-attachment run between the two, and
 * both can introduce a link, so the citation allowlist has to be applied again.
 * Re-running the whole pipeline to catch that also re-ran every deletion pass,
 * which is how the second pass came to strip links the first had just added.
 *
 * This does the narrow job the second pass was actually for.
 */
export const resealCitations = (text, { evidence, trials } = {}) => {
  if (!text) return text;
  const pack = filterVerifiedFdaEvidence(evidence || {});
  const allowedUrls = collectAllowedUrls(pack, trials);
  let out = stripDailyMedSearchLinks(String(text));
  out = sanitizeMarkdownLinks(out, allowedUrls);
  out = demoteBannedClaimCitations(out);
  out = stripGoogleSearchMarkdownLinks(out);
  return sanitizePublicText(out);
};

export const finalizeReportText = (text, {
  evidence, trials, validation, evidenceGrade, patient, dossier
} = {}) => {
  if (!text) return text;
  evidence = filterVerifiedFdaEvidence(evidence || {});
  const allowedUrls = collectAllowedUrls(evidence, trials);
  // Keep honest "thin evidence" hedges when grounding is not graded `strong`
  // so a degraded report is never polished into a confident-looking one.
  const keepHedges = !!evidenceGrade && evidenceGrade.tier && evidenceGrade.tier !== 'strong';
  if (evidenceGrade?.tier === 'dossier-only') {
    return 'We could not verify enough published research to produce a reliable report for this condition.';
  }
  let out = filterExcludedAgentMentions(text, evidence);
  const reportCondition = resolveReportConditionSubject(patient, evidence) ||
    String(trials?.query?.condition || '').trim();
  const trialClaims = enforceTrialRegistryNarrative(out, trials, {
    expectedConditions: reportCondition ? [reportCondition] : []
  });
  if (trialClaims.removed.length) {
    console.warn(
      `[report-polish] removed ${trialClaims.removed.length} registry-mismatched trial claim unit(s): ` +
      trialClaims.issues.join(', ')
    );
  }
  out = trialClaims.text;
  // Preserve an explicit Unknown status when no exact, sealed product label can
  // establish the card's FDA/label status. Other label claims continue through
  // ordinary claim-source proof and receive the full label boundary at the end.
  out = enforceFdaLabelNarrative(out, evidence.fdaLabels, { statusOnly: true }).text;
  // FDA/label gates can remove a TREATMENT name while leaving "FDA status:
  // Unknown" + safety prose. Drop those nameless fragments before they glue
  // onto the previous card (Luxturna + unrelated NAC citation).
  out = tracePass('stripOrphanCardFragments', out, stripOrphanCardFragments(out));
  // Pillar 3: drop any candidate field that carries a DIFFERENT drug's content
  // before it can be rendered under the wrong card. Loud — never silent.
  const guarded = assertNoForeignEntities(out);
  if (guarded.flags.length) {
    console.warn(`[report-polish] cross-candidate contamination dropped: ${guarded.flags.join(' | ')}`);
  }
  out = guarded.text;
  // Strip therapy gene-eligibility / "gene-agnostic — <GENE>-eligible"
  // qualifiers the evidence pack does not explicitly support, while preserving
  // the genuinely-cited finding they were appended to (the NAC/CERKL leak).
  // Loud — never silent.
  const elig = stripUnsupportedEligibilityClaims(out, evidence);
  if (elig.stripped.length) {
    console.warn(
      `[report-polish] stripped ${elig.stripped.length} unsupported gene-eligibility qualifier(s): ` +
      [...new Set(elig.stripped)].slice(0, 12).join(', ')
    );
  }
  out = elig.text;
  // Fail closed before any citation attachment: direct prescriptions and
  // patient-specific facts absent from the supplied profile cannot reach any
  // report, chat, or export path that uses finalization.
  const clinicalBoundary = enforcePatientFacingClinicalBoundary(out, patient || {});
  if (clinicalBoundary.rewritten || clinicalBoundary.stripped) {
    console.warn(
      `[report-polish] clinical boundary: rewritten-instructions=${clinicalBoundary.rewritten} ` +
      `stripped-unsupported-patient-facts=${clinicalBoundary.stripped}`
    );
  }
  out = clinicalBoundary.text;
  out = tracePass('sanitizeFabricatedEfficacyScores', out, sanitizeFabricatedEfficacyScores(out));
  out = tracePass('demoteGoogleAsPaperCitations', out, demoteGoogleAsPaperCitations(out));
  out = tracePass('stripGoogleSearchMarkdownLinks', out, stripGoogleSearchMarkdownLinks(out));
  out = tracePass('demoteBannedClaimCitations', out, demoteBannedClaimCitations(out));
  // Evaluate candidate relevance while machine-readable CANDIDATE labels are
  // still present. Display polishing renames those labels for readers.
  const authoredRelevance = enforceCandidateCitationRelevance(out, evidence);
  if (authoredRelevance.demoted.length) {
    console.warn(
      `[report-polish] demoted ${authoredRelevance.demoted.length} authored off-topic card citation(s): ` +
      [...new Set(authoredRelevance.demoted)].slice(0, 12).join(' | ')
    );
  }
  out = authoredRelevance.text;
  out = tracePass('polishReportForDisplay', out, polishReportForDisplay(out, { keepHedges }));
  // Client's #1 requirement: turn in-text reference MARKERS ("[#3]", text
  // markers) into INLINE clickable citations at the claim, resolving them
  // against the evidence pack. Runs BEFORE sanitizeMarkdownLinks so the new
  // pack-URL links are validated by the allowlist like any other link.
  out = tracePass('resolveInlineReferenceMarkers', out, resolveInlineReferenceMarkers(out, evidence));
  // Link bare NCT IDs to their exact ClinicalTrials.gov records before the
  // claim pass. This includes table cells, so a factual trial row carries its
  // source in that same row instead of relying on a detached source list.
  out = tracePass('linkBareNctIds', out, linkBareNctIds(out));
  const quantitativeCites = enforceQuantitativeCitationSupport(
    out,
    evidence,
    trials,
    { condition: resolveReportConditionSubject(patient, evidence) }
  );
  if (quantitativeCites.demoted || quantitativeCites.stripped) {
    console.warn(
      `[report-polish] quantitative citation boundary: demoted=${quantitativeCites.demoted} ` +
      `stripped=${quantitativeCites.stripped}`
    );
  }
  out = quantitativeCites.text;
  // FUNDAMENTAL: every claim sentence gets an inline pack/trial link, or a
  // hard unsourced claim is stripped. Not optional.
  const entityIndex = buildEntityUrlIndex(evidence, trials);
  const conditionSubject = resolveReportConditionSubject(patient, evidence);
  const claimCite = attachMissingClaimCitations(out, evidence, trials, { patient, conditionSubject });
  if (claimCite.attached || claimCite.stripped) {
    console.warn(
      `[report-polish] claim-link pass: attached=${claimCite.attached} stripped-unsourced=${claimCite.stripped || 0}`
    );
  }
  out = claimCite.text;
  // Version-sensitive medical claims require a current, identified guidance
  // source. Stable primary research remains eligible for ordinary claim proof,
  // but cannot by itself establish a current dose, approval, recommendation,
  // warning, screening interval, or eligibility rule.
  {
    const freshness = enforceGuidanceFreshnessNarrative(out, evidence);
    if (freshness.audit.removed) {
      console.warn(
        `[report-polish] guidance freshness boundary removed=${freshness.audit.removed} ` +
        `reasons=${JSON.stringify(freshness.audit.reasons)}`
      );
    }
    out = freshness.text;
  }
  // Negative/empty findings never keep a decorative source ↗.
  out = tracePass('stripNegativeFindingCitations', out, stripNegativeFindingCitations(out));
  // Never keep a DailyMed search page as a citation (client mandate).
  out = tracePass('stripDailyMedSearchLinks', out, stripDailyMedSearchLinks(out));
  out = tracePass('sanitizeMarkdownLinks', out, sanitizeMarkdownLinks(out, allowedUrls));
  // (A second stripNegativeFindingCitations ran here. Only link-removal
  // passes sit between it and the first, and removing a link cannot create
  // a negative-finding citation, so it could never do anything.)
  // Wrong-disease citations in free-form research prose (Condition Snapshot,
  // lifestyle, etc.): demote when the pack source does not mention the patient's
  // condition. Condition-agnostic — no per-disease denylist.
  const conditionRelevance = enforceConditionCitationRelevance(out, evidence, patient);
  if (conditionRelevance.demoted.length) {
    console.warn(
      `[report-polish] demoted ${conditionRelevance.demoted.length} wrong-disease citation(s) ` +
      `(source does not mention the patient's condition): ${[...new Set(conditionRelevance.demoted)].slice(0, 12).join(' | ')}`
    );
  }
  out = conditionRelevance.text;
  // Hard wrong-disease prose scrub: drop sentences naming sickle cell (etc.)
  // when the patient does not have that disease — even if no citation was attached.
  {
    const foreign = stripForeignDiseaseContamination(out, conditionSubject || patient?.condition || '');
    if (foreign.stripped.length) {
      console.warn(
        `[report-polish] stripped ${foreign.stripped.length} wrong-disease sentence(s): ` +
        [...new Set(foreign.stripped.map((s) => s.split(':')[0]))].slice(0, 8).join(', ')
      );
    }
    out = foreign.text;
  }
  // Task A fail-safe: deterministically remove prose lines surfacing a study/
  // trial the patient demographically cannot fit (opposite-sex-only / wrong age
  // band). Driven by patient sex/age, condition-agnostic. Holds the line even
  // when the validator errors or returns nothing.
  const demo = stripDemographicMismatchLines(out, patient || {});
  if (demo.removed.length) {
    console.warn(
      `[report-polish] removed ${demo.removed.length} demographic-mismatch study line(s): ` +
      `${[...new Set(demo.removed)].join(', ')}`
    );
  }
  out = demo.text;
  if (validation) {
    out = applyValidationFixes(out, validation, evidence, allowedUrls, keepHedges, { patient });
  }
  // After validator fixes may re-introduce patterns, re-run efficacy + citation seal.
  out = tracePass('sanitizeFabricatedEfficacyScores', out, sanitizeFabricatedEfficacyScores(out));
  out = tracePass('demoteGoogleAsPaperCitations', out, demoteGoogleAsPaperCitations(out));
  out = tracePass('stripGoogleSearchMarkdownLinks', out, stripGoogleSearchMarkdownLinks(out));
  out = tracePass('demoteBannedClaimCitations', out, demoteBannedClaimCitations(out));
  // Re-attach real entity links (pipeline drugs / NCT / FDA labels) — including
  // table cells when the entity index has a specific URL.
  const relinked = reattachEntityLinks(out, entityIndex);
  if (relinked.reattached.length) {
    console.warn(
      `[report-polish] re-attached fallback link to ${relinked.reattached.length} named entity(ies) ` +
      `left without one: ${[...new Set(relinked.reattached)].slice(0, 12).join(', ')}`
    );
  }
  if (relinked.skipped.length) {
    console.warn(
      `[report-polish] ${relinked.skipped.length} table-row entity(ies) lack a link ` +
      `(not auto-linked per CENTER-LINK RULE): ${[...new Set(relinked.skipped)].slice(0, 12).join(', ')}`
    );
  }
  // Final seal: no search placeholders / banned cites / DailyMed search pages
  // reach the reader — even after validator fixes or entity reattach.
  let sealed = stripDailyMedSearchLinks(relinked.text);
  sealed = tracePass('demoteBannedClaimCitations', sealed, demoteBannedClaimCitations(sealed));
  sealed = enforcePatientFacingClinicalBoundary(sealed, patient || {}).text;
  sealed = enforceQuantitativeCitationSupport(
    sealed,
    evidence,
    trials,
    { condition: conditionSubject }
  ).text;
  {
    const foreign = stripForeignDiseaseContamination(sealed, conditionSubject || patient?.condition || '');
    sealed = foreign.text;
  }
  sealed = enforceTrialRegistryNarrative(sealed, trials, {
    expectedConditions: reportCondition ? [reportCondition] : []
  }).text;
  sealed = enforceFdaLabelNarrative(sealed, evidence.fdaLabels).text;
  sealed = tracePass('stripOrphanCardFragments', sealed, stripOrphanCardFragments(sealed));
  sealed = enforceGuidanceFreshnessNarrative(sealed, evidence).text;
  sealed = tracePass('sanitizeMarkdownLinks', sealed, sanitizeMarkdownLinks(sealed, allowedUrls));
  sealed = tracePass('sanitizePublicText', sealed, sanitizePublicText(sealed));
  // Public-language rewrite can rename TREATMENT/CANDIDATE headers after the
  // earlier orphan pass — run once more on the reader-facing labels.
  sealed = tracePass('stripOrphanCardFragments', sealed, stripOrphanCardFragments(sealed));
  // Sections 2 and 4 are renderings of verified data — curated centres and
  // ClinicalTrials.gov records — not model prose. Rendering them BEFORE the
  // claim passes meant those passes deleted their rows for having no citation,
  // which broke the trials table into loose pipe characters and blanked the
  // centre cells. They are written last, so what the reader sees is exactly
  // what the registry and the curated data say.
  sealed = tracePass('replaceClinicalTrialsSection', sealed, replaceClinicalTrialsSection(sealed, trials));
  // Take the dossier from whichever source actually has one. Relying on
  // `evidence.dossier` alone means any caller that does not thread it through
  // silently loses centres, experts, advocacy, lifestyle and curated safety at
  // once — the reader then sees "Nothing was found for this section" in five
  // places while the page's own side panel lists eight centres and eight
  // researchers. An explicit `dossier` option removes that coupling.
  const curatedDossier = dossier || evidence?.dossier || patient?.dossier || null;
  // Production has produced that empty-section report on builds where a local
  // run of the same commit renders every section, so log what the finalizer
  // actually received. Without this the next occurrence is another guess.
  if (/^##\s*2\./m.test(sealed) && !(curatedDossier?.topCenters || []).length) {
    console.warn(
      '[report-polish] section 2 will render empty:',
      `dossierArg=${dossier ? 'present' : 'absent'}`,
      `evidence.dossier=${evidence?.dossier ? 'present' : 'absent'}`,
      `patient.dossier=${patient?.dossier ? 'present' : 'absent'}`,
      `centers=${(curatedDossier?.topCenters || []).length}`,
      `experts=${(curatedDossier?.keyInvestigators || []).length}`
    );
  }
  sealed = tracePass('replaceCentersSection', sealed, replaceCentersSection(sealed, curatedDossier));
  sealed = tracePass('replaceAdvocacySubsection', sealed, replaceAdvocacySubsection(sealed, curatedDossier));
  sealed = tracePass('replaceLifestyleSubsection', sealed, replaceLifestyleSubsection(sealed, curatedDossier, evidence));
  sealed = tracePass('replaceAdvancedTherapiesSection', sealed, replaceAdvancedTherapiesSection(sealed, evidence, curatedDossier));
  sealed = replaceCuratedSafetySection(sealed, {
    ...(curatedDossier || {}),
    redFlags: curatedDossier?.redFlags?.length ? curatedDossier.redFlags : (evidence?.redFlags || []),
    commonComorbidities: curatedDossier?.commonComorbidities?.length
      ? curatedDossier.commonComorbidities
      : (evidence?.commonComorbidities || [])
  });
  // Then remove any structure left standing over content the passes above
  // removed, so the reader never sees a heading promising content that
  // isn't there.
  sealed = tracePass('dropValuelessFieldLabels', sealed, dropValuelessFieldLabels(sealed));
  return dropEmptyStructure(sealed);
};
