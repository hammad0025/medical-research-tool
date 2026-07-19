export const canonicalReportUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    const canonical = parsed.href.replace(/\/$/, '');
    if (/^https?:\/\/(?:www\.)?google\.[^/]+\/search\b/i.test(canonical)) return null;
    if (/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=/i.test(canonical)) return null;
    if (/^https?:\/\/(?:www\.)?clinicaltrials\.gov\/search\b/i.test(canonical)) return null;
    if (/^https?:\/\/(?:www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm/i.test(canonical)) return null;
    if (/sph\.uth\.edu\/RetNet/i.test(canonical)) return null;
    return canonical;
  } catch {
    return null;
  }
};

export const normalizeReportUrlAllowlist = (allowedUrls) => new Set(
  [...(allowedUrls || [])]
    .map(canonicalReportUrl)
    .filter(Boolean)
);

export const allowedReportUrl = (href, allowedUrls) => {
  const canonical = canonicalReportUrl(href);
  if (!canonical) return null;
  return normalizeReportUrlAllowlist(allowedUrls).has(canonical) ? canonical : null;
};

export const filterAllowedReportLinks = (links, allowedUrls) =>
  (links || [])
    .map((link) => ({ ...link, url: allowedReportUrl(link?.url, allowedUrls) }))
    .filter((link) => !!link.url);

const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const sanitizeReportHtml = (
  html,
  allowedUrls,
  {
    DOMParserImpl = globalThis.DOMParser,
    baseUrl = globalThis.location?.origin || 'https://invalid.local'
  } = {}
) => {
  if (!DOMParserImpl) return escapeHtml(html);
  const doc = new DOMParserImpl().parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
  const allowed = new Set([
    'A', 'P', 'BR', 'STRONG', 'EM', 'DEL', 'UL', 'OL', 'LI',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR'
  ]);
  const blocked = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'IMG']);
  [...doc.body.querySelectorAll('*')].forEach((node) => {
    if (blocked.has(node.tagName)) {
      node.remove();
      return;
    }
    if (!allowed.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    const rawHref = node.tagName === 'A' ? (node.getAttribute('href') || '') : '';
    [...node.attributes].forEach((attr) => node.removeAttribute(attr.name));
    if (node.tagName !== 'A') return;
    if (rawHref.startsWith('#')) {
      node.setAttribute('href', rawHref);
      return;
    }
    let safeHref = null;
    try {
      safeHref = allowedReportUrl(new URL(rawHref, baseUrl).href, allowedUrls);
    } catch {}
    if (!safeHref) {
      node.replaceWith(...node.childNodes);
      return;
    }
    node.setAttribute('href', safeHref);
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  return doc.body.innerHTML;
};
