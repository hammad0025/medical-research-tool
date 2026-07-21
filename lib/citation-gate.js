// Single citation authority for the product.
//
// North star: a clickable link is allowed ONLY when it is a real document from
// the evidence pack / trials / FDA labels — never a search placeholder, never
// an invented PMID/DOI, never a dead dud. Prefer plain text over a wrong link.
//
// Server finalize, dead-link strip, and (mirrored) client render must all obey
// this policy. Soft "links on everything" density never overrides integrity.

const GOOGLE_SEARCH_RE = /^https?:\/\/(www\.)?google\.[a-z.]+\/search\b/i;
const DAILYMED_SEARCH_RE =
  /^https?:\/\/(www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm/i;
const PUBMED_SEARCH_RE = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=/i;
const CT_SEARCH_RE = /^https?:\/\/(www\.)?clinicaltrials\.gov\/search\b/i;
const KNOWN_DEAD_RES = [
  /^https?:\/\/(www\.)?web\.sph\.uth\.edu\/RetNet\b/i,
  /^https?:\/\/(www\.)?sph\.uth\.edu\/RetNet\b/i
];

/**
 * Parse a URL without changing case-sensitive path/query bytes. Hosts and
 * schemes are case-insensitive; paths are not. A trailing sentence mark is
 * removed only when it is not a balanced part of the URL.
 */
export const canonicalizeCitationUrl = (value) => {
  let raw = String(value || '').trim();
  while (/[.,;]$/.test(raw)) raw = raw.slice(0, -1);
  while (raw.endsWith(')')) {
    const opens = (raw.match(/\(/g) || []).length;
    const closes = (raw.match(/\)/g) || []).length;
    if (closes <= opens) break;
    raw = raw.slice(0, -1);
  }
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.href.replace(/\/$/, parsed.pathname === '/' && !parsed.search ? '' : '/');
  } catch {
    return '';
  }
};

/**
 * Balanced markdown-link walker. Unlike `[^)]+`, this preserves URLs such as
 * `/article/Drug_(medicine)` and passes the complete URL to the callback.
 */
export const rewriteMarkdownLinks = (text, replacer) => {
  const input = String(text || '');
  let out = '';
  let cursor = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== '[') continue;
    const labelEnd = input.indexOf('](', i + 1);
    if (labelEnd < 0) continue;
    const label = input.slice(i + 1, labelEnd);
    if (label.includes('\n')) continue;
    const urlStart = labelEnd + 2;
    if (!/^https?:\/\//i.test(input.slice(urlStart))) continue;
    let depth = 0;
    let urlEnd = -1;
    for (let j = urlStart; j < input.length; j += 1) {
      if (input[j] === '(') depth += 1;
      else if (input[j] === ')') {
        if (depth === 0) { urlEnd = j; break; }
        depth -= 1;
      }
    }
    if (urlEnd < 0) continue;
    out += input.slice(cursor, i);
    const url = input.slice(urlStart, urlEnd);
    out += replacer(input.slice(i, urlEnd + 1), label, url);
    cursor = urlEnd + 1;
    i = urlEnd;
  }
  return out + input.slice(cursor);
};

/** FDA Drugs@FDA overview with empty applno= — broken / useless citation. */
export const isBrokenFdaDafUrl = (url) => {
  const u = String(url || '').trim();
  if (!/accessdata\.fda\.gov\/scripts\/cder\/daf\//i.test(u)) return false;
  return /[?&]applno=(?:&|$)/i.test(u) || /[?&]applno=(?=&|$)/i.test(u);
};

export const isGoogleSearchUrl = (url) => GOOGLE_SEARCH_RE.test(String(url || ''));
export const isDailyMedSearchUrl = (url) => DAILYMED_SEARCH_RE.test(String(url || ''));
// The only acceptable DailyMed citation — a SPECIFIC label monograph, as
// opposed to isDailyMedSearchUrl's search-results-page rejection above.
export const isDailyMedLabelUrl = (url) =>
  /^https?:\/\/(www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=[^&\s)]+/i.test(String(url || ''));
export const isPubMedSearchUrl = (url) => PUBMED_SEARCH_RE.test(String(url || ''));
export const isClinicalTrialsSearchUrl = (url) => CT_SEARCH_RE.test(String(url || ''));
export const isKnownDeadUrl = (url) =>
  KNOWN_DEAD_RES.some((re) => re.test(String(url || '').trim())) || isBrokenFdaDafUrl(url);

/** URLs that must never appear as clickable claim/profile citations. */
export const isBannedClaimCitation = (url) => {
  const u = String(url || '').trim();
  if (!u) return true;
  if (isKnownDeadUrl(u)) return true;
  if (isBrokenFdaDafUrl(u)) return true;
  if (isGoogleSearchUrl(u)) return true;
  if (isDailyMedSearchUrl(u)) return true;
  if (isPubMedSearchUrl(u)) return true;
  if (isClinicalTrialsSearchUrl(u)) return true;
  return false;
};

/**
 * Demote every banned markdown / bare citation URL to plain text.
 * Keeps the human-readable label; never leaves a search engine or dud clickable.
 */
export const demoteBannedClaimCitations = (text) => {
  if (!text) return text;
  let s = String(text);
  s = rewriteMarkdownLinks(s, (m, label, url) =>
    isBannedClaimCitation(canonicalizeCitationUrl(url) || url) ? label : m);
  s = s.replace(/(?<![(\[])(https?:\/\/[^\s)\]"'<>]+)/g, (url) => {
    const clean = url.replace(/[.,;)]+$/, '');
    return isBannedClaimCitation(clean) ? '' : url;
  });
  return s.replace(/[ \t]{2,}/g, ' ').replace(/ \n/g, '\n');
};

/**
 * After a dead link is confirmed, the ONLY acceptable replacement is a
 * specific ClinicalTrials.gov study page when the label carries an NCT ID.
 * Never invent a PubMed search as a "citation." Otherwise → plain text.
 */
export const buildDeadLinkReplacement = (label) => {
  const raw = String(label || '')
    .replace(/[↗⧉➚]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[|*_`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const nct = raw.match(/\bNCT\d{8}\b/i);
  if (nct) return `https://clinicaltrials.gov/study/${nct[0].toUpperCase()}`;
  return '';
};

/**
 * Document-like URL that needs pack text to verify relevance.
 * Registry study pages / DailyMed setid / FDA DAF are exempt (not papers).
 */
export const isUnverifiedDocumentUrl = (url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (isBannedClaimCitation(u)) return true;
  if (/clinicaltrials\.gov\/study\//i.test(u)) return false;
  if (/dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=/i.test(u)) return false;
  if (/accessdata\.fda\.gov\/scripts\/cder\/daf\//i.test(u)) return false;
  if (/pubmed\.ncbi\.nlm\.nih\.gov\/\d{5,9}/i.test(u)) return true;
  if (/doi\.org\/10\.\d/i.test(u)) return true;
  if (/ncbi\.nlm\.nih\.gov\/pmc\//i.test(u)) return true;
  if (/\.(nature|science|cell|lancet|nejm|jamanetwork|bmj|springer|wiley|sciencedirect|elsevier|oup|tandfonline|karger|lww)\./i.test(u)) {
    return true;
  }
  return /\/(articles?|papers?|full|pdf|doi)\b/i.test(u);
};

/** Fail-closed fallback when citation verification infrastructure is down. */
export const demoteUnverifiedDocumentCitations = (text) =>
  rewriteMarkdownLinks(text, (m, label, url) =>
    isUnverifiedDocumentUrl(canonicalizeCitationUrl(url) || url) ? label : m);
