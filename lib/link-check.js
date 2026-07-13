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
//   - A "dud" is dead too (Dorothy's real complaint): a paywalled / bot-blocked
//     publisher page that answers 401/403/451 is useless to a reader who clicks
//     it, so it is treated as dead and stripped — UNLESS it is on a host that
//     reliably resolves for humans (PubMed, PMC, DOI, ClinicalTrials.gov, FDA,
//     Europe PMC). Open-access alternatives are already promoted upstream by
//     preferVerifiableUrl, so a 403 on a bare publisher URL here means there was
//     no free copy to cite — the reader hits a wall, and we must not present it.
//   - Fail-OPEN only on transient ambiguity: a timeout, 429, or 5xx is treated
//     as "probably alive but momentarily unavailable" and left intact — we must
//     not strip real citations on a flaky network.
//   - Navigational/search links (Google/PubMed/ClinicalTrials/DailyMed/DOI)
//     are assumed live and skipped entirely — they always resolve.

import { isNavigationalUrl } from './report-polish.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MRT_LINKCHECK_TIMEOUT_MS || 6000);
const DEFAULT_CONCURRENCY = Number(process.env.MRT_LINKCHECK_CONCURRENCY || 12);
// Hard ceiling on total wall-clock spent link-checking one report, so a batch
// of slow hosts can never push us toward the function timeout. A 25-candidate
// RP/CERKL report carries ~45 risky publisher links after always-live hosts are
// skipped; at concurrency 12 with a 6s per-URL cap that is ~4 waves, so 45s of
// budget guarantees every publisher link is actually probed (the previous 25s
// ran out mid-report and let a ScienceDirect 403 dud slip through). The
// function itself has a 300s cap, so this is comfortably safe.
const DEFAULT_BUDGET_MS = Number(process.env.MRT_LINKCHECK_BUDGET_MS || 45000);

// Hosts that reliably resolve for a human even when they answer 401/403 to our
// bot (rate-limiting / HEAD-hostility), so a blocked status from them is NOT
// treated as a dud. These are the canonical, reader-accessible citation hosts.
const TRUSTED_LIVE_HOSTS = [
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',   // covers pmc.ncbi.nlm.nih.gov
  'nlm.nih.gov',        // covers dailymed.nlm.nih.gov
  'doi.org',
  'clinicaltrials.gov',
  'fda.gov',            // covers accessdata.fda.gov, www.fda.gov
  'europepmc.org'
];

export const isTrustedLiveHost = (url) => {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TRUSTED_LIVE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
};

// Hosts whose SPECIFIC links are guaranteed to resolve, so we can skip probing
// them entirely and spend the time budget on risky publisher links. This is a
// STRICT subset of TRUSTED_LIVE_HOSTS: it deliberately EXCLUDES fda.gov, whose
// deep label-PDF paths (accessdata.fda.gov/drugsatfda_docs/label/…) rotate and
// 404 often — those must still be probed and stripped when dead. The 403
// fail-open tolerance in classifyProbeStatus still covers fda.gov separately.
const ALWAYS_LIVE_HOSTS = [
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',   // pmc.ncbi.nlm.nih.gov
  'doi.org',
  'clinicaltrials.gov',
  'europepmc.org'
];

const isAlwaysLiveHost = (url) => {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALWAYS_LIVE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
};

// Classify an HTTP status for a given URL into 'dead' | 'alive'. Pure and
// synchronous so it can be unit-tested without hitting the network.
//   404 / 410            → dead (definitively gone)
//   401 / 403 / 451      → dead, UNLESS the host is a trusted reader-accessible
//                          host (then it's a bot-block, keep it)
//   everything else      → alive (2xx/3xx, and transient 429/5xx/timeouts)
export const classifyProbeStatus = (url, status) => {
  if (status === 404 || status === 410) return 'dead';
  if (status === 401 || status === 403 || status === 451) {
    return isTrustedLiveHost(url) ? 'alive' : 'dead';
  }
  return 'alive';
};

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

// Probe a single URL. Returns { url, dead }. Tries HEAD first (cheap), falls
// back to a ranged GET for servers that reject HEAD. A HEAD that reports a
// dead-ish status (404/410) or a blocked status (401/403/451) is always
// re-confirmed with a real GET, because many servers mis-answer HEAD.
const probeUrl = async (url, timeoutMs) => {
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

  const res = await attempt('HEAD');
  if (res.ok) {
    if (classifyProbeStatus(url, res.status) === 'alive') return { url, dead: false };
    // HEAD said dead/blocked — confirm with a real GET (HEAD-hostile servers
    // routinely 403/405 a HEAD they would happily answer for GET).
    const confirm = await attempt('GET', { Range: 'bytes=0-2048' });
    if (confirm.ok) return { url, dead: classifyProbeStatus(url, confirm.status) === 'dead' };
    if (confirm.aborted) return { url, dead: false }; // timeout → transient → keep
    return { url, dead: true };                       // network/DNS error → dead
  }
  if (res.aborted) return { url, dead: false };        // timeout → transient → keep
  // HEAD threw a network/DNS error. Retry once with GET to rule out
  // HEAD-hostile servers before treating it as dead.
  const confirm = await attempt('GET', { Range: 'bytes=0-2048' });
  if (confirm.ok) return { url, dead: classifyProbeStatus(url, confirm.status) === 'dead' };
  if (confirm.aborted) return { url, dead: false };    // timeout → transient → keep
  return { url, dead: true };                          // both non-timeout errors → dead
};

// Check every non-navigational URL in `urls`. Returns a Set of URL strings
// that are definitively dead. Bounded by concurrency + a total time budget.
export const findDeadLinks = async (urls, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  budgetMs = DEFAULT_BUDGET_MS
} = {}) => {
  const dead = new Set();
  // Only probe links that could actually be a dud. Navigational/search links
  // always resolve, and trusted reader-accessible hosts (PubMed/PMC/DOI/CT.gov/
  // FDA/DailyMed/EuropePMC) fail open by policy — probing them would only burn
  // the time budget before we reach the untrusted publisher links that might be
  // dead. Skipping them keeps the whole publisher set within budget on a
  // link-heavy 25-candidate report (the RP/CERKL run that slipped a dud past
  // the gate had ~80 links).
  const toCheck = [...new Set(urls.map(normalize))].filter(
    (u) => /^https?:\/\//i.test(u) && !isNavigationalUrl(u) && !isAlwaysLiveHost(u)
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

// Build a reader-verifiable replacement link for a dead citation. Rather than
// leave a bare claim after stripping a dud, we point the same label at a search
// that reliably resolves: the exact trial on ClinicalTrials.gov for an NCT id,
// otherwise a PubMed search of the citation label scoped to the condition. Both
// are navigational hosts, so they pass the allowlist and never dead-check.
export const buildFallbackSearchUrl = (label, condition) => {
  const raw = String(label || '')
    .replace(/[↗⧉➚]/g, ' ')                    // strip external-link glyphs
    .replace(/\[[^\]]*\]/g, ' ')                // strip [#6] citation markers
    .replace(/[|*_`]+/g, ' ')                   // strip markdown noise
    .replace(/\s+/g, ' ')
    .trim();
  const nct = raw.match(/\bNCT\d{8}\b/i);
  if (nct) return `https://clinicaltrials.gov/study/${nct[0].toUpperCase()}`;
  const cond = String(condition || '').trim();
  const terms = [raw, cond].filter(Boolean).join(' ').trim();
  if (!terms) return '';
  return `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(terms)}`;
};

// Replace dead links in the report. A dead markdown citation
// [label](deadUrl) becomes [label](scopedSearchUrl) when we can build one, so
// the reader still gets a working way to find the source; otherwise it degrades
// to plain text `label`. Bare dead URLs are stripped. Live citations untouched.
export const stripDeadLinksFromText = (text, deadUrls, { condition = '' } = {}) => {
  if (!text || !deadUrls?.size) return text;
  let s = String(text);
  for (const url of deadUrls) {
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(${esc}[^)]*\\)`, 'gi'),
      (whole, label) => {
        const replacement = buildFallbackSearchUrl(label, condition);
        return replacement ? `[${label}](${replacement})` : label;
      }
    );
    s = s.replace(new RegExp(`(?<![\\[(])${esc}[^\\s)\\]"'<>]*`, 'gi'), '');
  }
  return s;
};

// Convenience: extract → probe → strip in one call. Returns { text, deadUrls }.
export const removeDeadLinks = async (text, opts = {}) => {
  if (!text) return { text, deadUrls: new Set() };
  const { condition, ...probeOpts } = opts;
  const urls = extractReportUrls(text);
  const deadUrls = await findDeadLinks(urls, probeOpts);
  return { text: stripDeadLinksFromText(text, deadUrls, { condition }), deadUrls };
};
