// Identity tests for a drug/supplement card.
//
// Both of these lived inline in src/app.jsx, where nothing could import them
// and so nothing tested them. The report shipped two defects as a result: an
// agent appearing twice under two spellings with contradictory conclusions,
// and an investigational agent rendering under "Approved Treatments".

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
 * Whether a card explicitly declares itself NOT approved.
 *
 * Deliberately matches an explicit denial rather than testing for an
 * "approved" prefix: the status a model actually writes is "FDA-approved for
 * OAB", which no prefix test accepts. An absent or unrecognised status is not
 * treated as a denial — only an explicit one drops a card.
 */
export const declaresNotApproved = (value) => {
  const v = String(value || '').toLowerCase();
  return /\b(?:investigational|experimental|unapproved)\b/.test(v) ||
    /\bnot\s+(?:yet\s+)?(?:fda[-\s])?approved\b/.test(v);
};
