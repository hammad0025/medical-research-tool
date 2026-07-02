// Dead-link gate for the patient-facing report.
//
// Dorothy's demo failure: the report cited a link that 404'd ("page not
// found") next to a "48% efficacy" claim. The allowlist gate in
// report-polish.js keeps ungrounded/hallucinated URLs out, but a URL can be
// in the evidence pack (grounded) and STILL be dead by the time the reader
// clicks it. This module actually opens each linked URL and demotes any that
// do not resolve to plain text, so a dead link can never render as clickable.
//
// Design constraints:
//   - Runs server-side only (needs fetch to arbitrary hosts).
//   - Bounded latency: capped concurrency + short per-URL timeout, and every
//     URL is checked at most once (deduped) per report.
//   - Fail-OPEN on ambiguity: only a clear "this URL is dead" signal (DNS
//     failure, connection error, or a definitive 404/410) strips a link. A
//     timeout, 403, 429, or 5xx is treated as "probably alive but blocking
//     bots" and left intact — we must not strip real citations on a flaky
//     network.
//   - Navigational/search links (Google/PubMed/ClinicalTrials/DailyMed/DOI)
//     are assumed live and skipped entirely — they always resolve.

import { isNavigationalUrl } from './report-polish.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MRT_LINKCHECK_TIMEOUT_MS || 6000);
const DEFAULT_CONCURRENCY = Number(process.env.MRT_LINKCHECK_CONCURRENCY || 8);
// Hard ceiling on total wall-clock spent link-checking one report, so a batch
// of slow hosts can never push us toward the function timeout.
const DEFAULT_BUDGET_MS = Number(process.env.MRT_LINKCHECK_BUDGET_MS || 25000);

const normalize = (u) => String(u || '').trim().replace(/[.,;)]+$/, '');

// Pull every distinct http(s) URL out of the report: markdown links first,
// then bare URLs. Returns normalized URL strings.
export const extractReportUrls = (text) => {
  const urls = new Set();
  const s = String(text || '');
  const mdRe = /\[[^\]]+\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = mdRe.exec(s)) !== null) urls.add(normalize(m[1]));
  const bareRe = /(?<![(\[])(https?:\/\/[^\s)\]"'<>]+)/g;
  while ((m = bareRe.exec(s)) !== null) urls.add(normalize(m[1]));
  return [...urls];
};

// Probe a single URL. Returns { url, dead } where dead === true ONLY on a
// definitive dead signal. Tries HEAD first (cheap), falls back to a ranged GET
// for servers that reject HEAD.
const probeUrl = async (url, timeoutMs) => {
  const isDeadStatus = (status) => status === 404 || status === 410;
  const attempt = async (method, extraHeaders) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; researchingmycondition-linkcheck/1.0)',
          ...extraHeaders
        }
      });
      return { ok: true, status: r.status };
    } catch (err) {
      // AbortError (timeout) or network/DNS error.
      return { ok: false, aborted: err?.name === 'AbortError' };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt('HEAD');
  // Many hosts 405/501 on HEAD, or return a non-dead status; confirm dead-ish
  // results with a light ranged GET before declaring anything dead.
  if (res.ok && isDeadStatus(res.status)) {
    const confirm = await attempt('GET', { Range: 'bytes=0-2048' });
    if (confirm.ok) return { url, dead: isDeadStatus(confirm.status) };
    return { url, dead: false }; // GET failed/timed out → ambiguous → keep
  }
  if (!res.ok && res.aborted) return { url, dead: false }; // timeout → keep
  if (!res.ok) {
    // HEAD threw a network/DNS error. Retry once with GET to rule out
    // HEAD-hostile servers before treating it as dead.
    const confirm = await attempt('GET', { Range: 'bytes=0-2048' });
    if (confirm.ok) return { url, dead: isDeadStatus(confirm.status) };
    // Both HEAD and GET failed with a non-timeout network error → dead.
    return { url, dead: !confirm.aborted };
  }
  return { url, dead: false };
};

// Check every non-navigational URL in `urls`. Returns a Set of URL strings
// that are definitively dead. Bounded by concurrency + a total time budget.
export const findDeadLinks = async (urls, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  budgetMs = DEFAULT_BUDGET_MS
} = {}) => {
  const dead = new Set();
  const toCheck = [...new Set(urls.map(normalize))].filter(
    (u) => /^https?:\/\//i.test(u) && !isNavigationalUrl(u)
  );
  if (!toCheck.length) return dead;

  const deadline = Date.now() + budgetMs;
  let idx = 0;
  const worker = async () => {
    while (idx < toCheck.length && Date.now() < deadline) {
      const url = toCheck[idx++];
      const { dead: isDead } = await probeUrl(url, timeoutMs);
      if (isDead) dead.add(url);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, toCheck.length) }, worker)
  );
  return dead;
};

// Demote dead links in the report to plain text: [label](deadUrl) → label,
// and strip bare dead URLs. Grounded, live citations are untouched.
export const stripDeadLinksFromText = (text, deadUrls) => {
  if (!text || !deadUrls?.size) return text;
  let s = String(text);
  for (const url of deadUrls) {
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\[([^\\]]+)\\]\\(${esc}[^)]*\\)`, 'gi'), '$1');
    s = s.replace(new RegExp(`(?<![\\[(])${esc}[^\\s)\\]"'<>]*`, 'gi'), '');
  }
  return s;
};

// Convenience: extract → probe → strip in one call. Returns { text, deadUrls }.
export const removeDeadLinks = async (text, opts = {}) => {
  if (!text) return { text, deadUrls: new Set() };
  const urls = extractReportUrls(text);
  const deadUrls = await findDeadLinks(urls, opts);
  return { text: stripDeadLinksFromText(text, deadUrls), deadUrls };
};
