// Identity, approval and text-shortening for a drug/supplement card.
//
// These decisions used to be made in six-to-eight places each, with no shared
// definition, and they disagreed. That is the single root behind a long run of
// reader-visible defects: one agent shipping twice under two spellings with
// contradictory conclusions, investigational drugs rendering under "Approved
// Treatments", and text cut mid-word ("...through ClinicalT", "...used for
// centuries in Chinese medicin"). Every lane and both render paths go through
// this module so those cannot drift apart again.

/**
 * Keys under which a candidate name should be considered "already seen".
 *
 * Keying on the name with its parenthetical stripped is not enough: the shared
 * identity of two spellings often lives ONLY in the parenthetical. "DHA
 * (omega-3 fatty acid)" and "Docosahexaenoic acid (DHA)" are one agent, and
 * they shipped as two cards — one stating a hypothesis, one reporting a null
 * result — because the parenthetical was discarded before comparing.
 *
 * Only a single short token counts as an abbreviation. A descriptive phrase
 * like "(omega-3 fatty acid)" names a class rather than an agent, and keying
 * on it would wrongly merge EPA into DHA.
 */
export const agentDedupKeys = (name) => {
  const raw = String(name || '').toLowerCase();
  const base = raw
    .replace(/\(.*?\)/g, '')      // drop parenthetical brand/generic
    .replace(/[^a-z0-9]/g, '')    // ignore spacing/punctuation
    .trim();
  const keys = base ? [base] : [];
  for (const [, inner] of raw.matchAll(/\(([^)]*)\)/g)) {
    const token = inner.trim();
    if (!token || /\s/.test(token) || token.length > 8) continue;
    const abbrev = token.replace(/[^a-z0-9]/g, '');
    if (abbrev.length >= 2) keys.push(abbrev);
  }
  return keys;
};

/**
 * Whether an FDA-status value AFFIRMATIVELY states approval.
 *
 * This is a whitelist on purpose. The previous test blacklisted words like
 * "investigational", which let the single most common non-approved value in
 * this product — "Unknown — insufficient verified FDA/DailyMed label
 * evidence", written by the label gate itself — walk straight into the
 * approved section. Four investigational programmes reached a heading that
 * said "Approved Treatments" that way.
 *
 * Absence of evidence is not approval, so anything unrecognised is false.
 */
/**
 * Whether a status means "we could not establish what this drug's regulatory
 * standing is" — as opposed to a known standing.
 *
 * This is the test the approved section actually needs, and it is NOT the
 * complement of isAffirmativelyApproved. "Off-label for androgenetic
 * alopecia" is a KNOWN status: the drug carries a real FDA label, just for
 * another indication, and the product deliberately shows such options with a
 * flag. "Unknown — insufficient verified FDA/DailyMed label evidence" is the
 * label gate saying it verified nothing. Only the second is disqualifying.
 */
export const isUnverifiedRegulatoryStatus = (value) => {
  const v = String(value || '').toLowerCase().trim();
  if (!v) return false;
  if (/\b(?:unknown|unclear|insufficient|unverified|pending|under review|investigational|experimental)\b/.test(v)) {
    return true;
  }
  return /\bnot\s+(?:yet\s+)?(?:fda[-\s])?approved\b/.test(v);
};

export const isAffirmativelyApproved = (value) => {
  const v = String(value || '').toLowerCase().trim();
  if (!v) return false;
  // "Unknown", "not approved", "not yet approved", "pending", "under review".
  if (/\b(?:unknown|unclear|insufficient|pending|under review|investigational|experimental|unapproved)\b/.test(v)) {
    return false;
  }
  if (/\bnot\s+(?:yet\s+)?(?:fda[-\s])?approved\b/.test(v)) return false;
  // Accepts "approved", "FDA-approved for X", "FDA approved 2017".
  return /\bapproved\b/.test(v);
};

/**
 * Shorten text without lying about it.
 *
 * Six independent constants (400, 300, 150, 110, 96, 90) each did a bare
 * slice. A bare slice ends mid-word and reads as broken scraping; a slice
 * with no marker at all is worse, because a title cut at a word boundary
 * looks complete when it isn't. Prefer a whole sentence, else a whole word,
 * and always mark the cut.
 *
 * The marker is "…" (U+2026). sanitizePublicText NFKC-rewrites that into
 * three ASCII periods, which is safe now that splitClaimSentences treats a
 * markdown link as atomic — but callers writing INSIDE a link label should
 * still prefer a budget generous enough that shortening is rare.
 */
export const clampText = (value, limit, { marker = '…' } = {}) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!limit || text.length <= limit) return text;
  const window = text.slice(0, limit);
  const sentence = window.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (sentence && sentence[0].trim().length >= limit * 0.5) return sentence[0].trim();
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > limit * 0.4 ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[\s,;:—–-]+$/, '')}${marker}`;
};

/**
 * A citation's visible label.
 *
 * Falls back to the agent's own name when the title is missing or is actually
 * a rationale sentence: the web discovery lane assigned its one-sentence
 * "finding" to `title`, so whole sentences rendered as link text. A generous
 * budget keeps real paper titles intact — most sit well under 160 characters,
 * and a shortened one is marked.
 */
export const citationLabel = ({ title, name } = {}, limit = 160) => {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const fallback = String(name || '').replace(/\s+/g, ' ').trim();
  if (!raw) return clampText(fallback, limit);
  return clampText(raw, limit);
};
