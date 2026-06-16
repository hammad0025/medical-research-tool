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

const replaceClaimWithCorrection = (text, claim, correction) => {
  const c = String(claim || '').trim();
  const fix = String(correction || '').trim();
  if (!c || !fix || c.length < 10) return text;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(esc, 'i').test(text)) return text.replace(new RegExp(esc, 'i'), fix);
  const snippet = c.slice(0, Math.min(48, c.length)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (snippet.length >= 12 && new RegExp(snippet, 'i').test(text)) {
    return text.replace(new RegExp(snippet, 'i'), fix.slice(0, snippet.length));
  }
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
        out = replaceClaimWithCorrection(out, d.claim, d.correction);
      } else {
        const snippet = String(d.claim || '').trim().slice(0, 35);
        if (snippet.length >= 12) {
          const needle = snippet.toLowerCase();
          out = out.split('\n').filter((line) => !line.toLowerCase().includes(needle)).join('\n');
        }
      }
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
