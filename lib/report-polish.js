// Patient-facing report cleanup — strip internal pipeline jargon, bad links,
// and validator-flagged content before display or export.

const INTERNAL_PHRASE_PATTERNS = [
  /^[^\n]*\bNo grounded evidence[^\n]*$/gim,
  /^[^\n]*\bno grounded prevalence[^\n]*$/gim,
  /^[^\n]*\bno grounded prevalence number in pack[^\n]*$/gim,
  /\bNo grounded evidence in pack\b/gi,
  /\bno grounded prevalence number in pack\b/gi,
  /\bconfirmed against grounded evidence\b/gi,
  /\bdossier[- ]sourced\b/gi,
  /\bdossier source\b/gi,
  /\bGROUNDED EVIDENCE PACK\b/gi,
  /\bgrounded evidence pack\b/gi,
  /\bDisease-dossier uncertainty[^.\n]*/gi,
  /\buncertainty score[^.\n]*/gi,
  /\s*\(dossier-sourced[^)]*\)/gi,
  /\s*\(confirmed against grounded evidence[^)]*\)/gi,
  /\s*\[(FULL-TEXT|ABSTRACT-ONLY|METADATA-ONLY|CURATED KB|PREPRINT[^\]]*)\]\s*/gi
];

export const polishReportForDisplay = (text) => {
  if (!text) return text;
  let s = String(text);
  // Models sometimes wrap NOT-approved flags in ~~strikethrough~~ — show plain text.
  s = s.replace(/~~([^~]+)~~/g, '$1');
  for (const pat of INTERNAL_PHRASE_PATTERNS) {
    s = s.replace(pat, pat.global && pat.source.startsWith('^') ? '' : ' ');
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
};

/** Hide Section 3 prose when the UI renders parsed treatment cards separately. */
export const stripApprovedTreatmentsSection = (text) => {
  if (!text) return text;
  const s = String(text);
  const start = s.search(/^##\s*3\.\s*Approved Treatments/im);
  if (start < 0) return s;
  const rest = s.slice(start);
  const end = rest.search(/^##\s*4\./im);
  if (end < 0) return s.slice(0, start).trim();
  return (s.slice(0, start) + s.slice(start + end)).replace(/\n{3,}/g, '\n\n').trim();
};

const normalizeDrugKey = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')      // drop parenthetical brand/generic
    .replace(/[^a-z0-9]/g, '')    // ignore spacing/punctuation
    .trim();

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
  const have = new Set();
  for (const t of list) {
    const k = normalizeDrugKey(t?.treatment);
    if (k) have.add(k);
  }
  const stubs = [];
  const added = new Set();
  for (const d of approved) {
    const key = normalizeDrugKey(d?.name);
    if (!key || added.has(key)) continue;
    const already = drugNameVariants(d).some((nm) => {
      const k = normalizeDrugKey(nm);
      return k && have.has(k);
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
  const have = new Set();
  for (const t of Array.isArray(treatments) ? treatments : []) {
    const k = normalizeDrugKey(t?.treatment);
    if (k) have.add(k);
  }
  return approved.every((d) =>
    drugNameVariants(d).some((nm) => {
      const k = normalizeDrugKey(nm);
      return k && have.has(k);
    })
  );
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
    if (!/^CANDIDATE:/i.test(block.trim())) return true;
    const lower = block.toLowerCase();
    return !names.some((n) => lower.includes(n));
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

export const applyValidationFixes = (text, validation, evidence, allowedUrls) => {
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
  out = polishReportForDisplay(out);
  out = sanitizeMarkdownLinks(out, allowedUrls);
  return out;
};

export const finalizeReportText = (text, { evidence, trials, validation } = {}) => {
  if (!text) return text;
  const allowedUrls = collectAllowedUrls(evidence, trials);
  let out = filterExcludedAgentMentions(text, evidence);
  out = polishReportForDisplay(out);
  out = sanitizeMarkdownLinks(out, allowedUrls);
  if (validation) {
    out = applyValidationFixes(out, validation, evidence, allowedUrls);
  }
  return out;
};
