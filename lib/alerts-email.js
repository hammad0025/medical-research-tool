// Email delivery + HTML digest rendering.
//
// Provider: Resend (https://resend.com). Chosen because it works in
// serverless runtimes (plain fetch), has a generous free tier (3k/month
// as of writing), and returns proper error bodies. No SDK — we call the
// REST API directly so we don't add a dependency.
//
// Degraded mode: if RESEND_API_KEY is missing the sender returns
// { mocked: true, subject, to, htmlLength } instead of throwing. The
// cron handler treats that as a no-op and logs it so the prototype is
// usable in dev without signing up for anything.

import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';
import { sanitizePublicHtml, sanitizePublicText } from './public-language.js';
import { canonicalReportUrl } from './report-links.js';

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_KEY = process.env.RESEND_API_KEY;
const RESEND_TIMEOUT_MS = timeoutFor('resend', 10_000);
// The From address has to be a domain you've verified in Resend. For
// initial testing Resend accepts "onboarding@resend.dev" without domain
// verification — swap to your own domain for production.
const FROM =
  process.env.ALERTS_EMAIL_FROM ||
  'Medical Research Alerts <onboarding@resend.dev>';

export const emailReadiness = () => {
  const missing = [];
  if (!RESEND_KEY) missing.push('RESEND_API_KEY');
  if (!String(process.env.ALERTS_EMAIL_FROM || '').trim()) missing.push('ALERTS_EMAIL_FROM');
  if (!String(process.env.ALERTS_PUBLIC_URL || '').trim()) missing.push('ALERTS_PUBLIC_URL');
  return { ready: missing.length === 0, missing };
};

export const isEmailConfigured = () => emailReadiness().ready;

const NAMED_TEXT_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  middot: '·',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  times: '×',
  copy: '©',
  reg: '®'
};

const decodeHtmlEntities = (value) => String(value || '')
  .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (match, hex, decimal) => {
    const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
    try {
      return Number.isSafeInteger(point) ? String.fromCodePoint(point) : match;
    } catch {
      return match;
    }
  })
  .replace(/&([a-z]+);/gi, (match, name) =>
    Object.hasOwn(NAMED_TEXT_ENTITIES, name.toLowerCase())
      ? NAMED_TEXT_ENTITIES[name.toLowerCase()]
      : match);

export const alertHtmlToText = (html) => {
  const withDestinations = String(html || '').replace(
    /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote, href, labelHtml) => {
      const label = decodeHtmlEntities(String(labelHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      const destination = decodeHtmlEntities(href).trim();
      return label && label !== destination ? `${label} (${destination})` : destination;
    }
  );
  return decodeHtmlEntities(withDestinations
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/td|\/table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
};

export const sendEmail = async ({ to, subject, html, text, replyTo, idempotencyKey }) => {
  if (!to || !subject || !html) {
    throw new Error('sendEmail requires { to, subject, html }');
  }
  const safeSubject = sanitizePublicText(subject);
  const safeHtml = sanitizePublicHtml(html);
  const safeText = text ? sanitizePublicText(text) : undefined;
  if (!RESEND_KEY) {
    // Dev mode — loudly no-op so the cron job still exercises the rest of
    // its pipeline. Tests rely on this to keep running without secrets.
    return { mocked: true, provider: 'none', to, subject: safeSubject, htmlLength: safeHtml.length };
  }
  const r = await fetchWithTimeout(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {})
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      subject: safeSubject,
      html: safeHtml,
      text: safeText || alertHtmlToText(safeHtml),
      reply_to: replyTo || undefined
    })
  }, { timeoutMs: RESEND_TIMEOUT_MS, provider: 'Resend' });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  if (!data?.id || typeof data.id !== 'string') {
    throw new Error('Resend response missing provider message id');
  }
  return { mocked: false, provider: 'resend', id: data.id, to, subject };
};

// ---------- HTML template helpers ---------------------------------------

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Unsubscribe URLs carry a capability token, so their contract is stricter
// than ordinary source links: they must be absolute HTTPS URLs.
const canonicalUnsubscribeUrl = (value) => {
  const canonical = canonicalReportUrl(value);
  if (!canonical) return null;
  try {
    const parsed = new URL(canonical);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
};

const trunc = (s = '', n = 260) => {
  const str = String(s);
  return str.length > n ? str.slice(0, n).trim() + '…' : str;
};

// Build compact source-attribute labels for the email. These labels are based
// only on explicit publication, study, registry, and regulator attributes.
// Author nationality, country, and region must never affect integrity labels.
const flagPill = (label, color) =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:${color};background:${color}22;border:1px solid ${color}55;margin-right:4px;margin-top:2px;">${esc(label)}</span>`;

const renderFlags = (item) => {
  const bits = [];
  if (item.isRetracted) bits.push(flagPill('Retracted publication', '#ef4444'));
  else if (item.isRetractionNotice) bits.push(flagPill('Retraction notice', '#ef4444'));
  if (item.tier === 'A+' || item.tier === 'A') bits.push(flagPill(`${item.tier} tier journal`, '#10b981'));
  if (item.isMetaAnalysis) bits.push(flagPill('Meta-analysis', '#10b981'));
  else if (item.isSystematicReview) bits.push(flagPill('Systematic review', '#10b981'));
  else if (item.isRCT) bits.push(flagPill('Randomized controlled trial', '#10b981'));
  if (item.isCuratedKB) bits.push(flagPill('Curated reference', '#4a9eff'));
  if (item.isPreprint) bits.push(flagPill('Preprint (not peer-reviewed)', '#eab308'));
  if (item.registryStatus === 'registered' || item.isRegistered === true) {
    bits.push(flagPill('Study registration reported', '#4a9eff'));
  }
  if (item.protocolAvailable === true) bits.push(flagPill('Protocol available', '#4a9eff'));
  if (item.reportingComplete === false) bits.push(flagPill('Reporting incomplete', '#eab308'));
  if (/^(?:openfda|fda|dailymed)$/i.test(String(item.source || ''))) {
    bits.push(flagPill('Regulator record', '#4a9eff'));
  }
  return bits.join('');
};

const humanizeToken = (value, fallback) => {
  const text = String(Array.isArray(value) ? value.join(', ') : value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bPhase\s*(\d)/g, 'Phase $1');
};

const renderItemCard = (it, idx) => {
  const url = canonicalReportUrl(it.url) || '';
  const excerpt = trunc(sanitizePublicText(it.text || ''), 320);
  return `
  <tr>
    <td style="padding:14px 16px;border-top:1px solid #e2e8f0;">
      <div style="font-size:11px;color:#64748b;letter-spacing:0.5px;font-weight:600;text-transform:uppercase;margin-bottom:4px;">
        #${idx + 1} &middot; ${esc(sanitizePublicText(it.journal || 'Journal not reported', { sourceTitle: true }))}${it.year ? ` &middot; ${it.year}` : ''}${typeof it.citations === 'number' ? ` &middot; cited ${it.citations}×` : ''}
      </div>
      <div data-mrt-source-title="1" style="font-size:15px;font-weight:600;color:#0f172a;line-height:1.35;margin-bottom:6px;">
        ${esc(sanitizePublicText(it.title || 'Title not reported', { sourceTitle: true }))}
      </div>
      <div style="margin-bottom:8px;">${renderFlags(it)}</div>
      ${excerpt ? `<div style="font-size:13px;color:#334155;line-height:1.55;font-style:italic;margin-bottom:8px;">"${esc(excerpt)}"</div>` : ''}
      ${url ? `<a href="${esc(url)}" style="font-size:12px;color:#2563eb;text-decoration:none;word-break:break-all;">${esc(url)}</a>` : ''}
    </td>
  </tr>`;
};

// Group stronger comparative designs and evidence reviews first while keeping
// the wording clear that design alone does not establish relevance or quality.
const sectionFor = (newItems) => {
  const rctOrMeta = newItems.filter((i) => i.isRCT || i.isMetaAnalysis || i.isSystematicReview);
  const everythingElse = newItems.filter((i) => !rctOrMeta.includes(i));
  return { rctOrMeta, everythingElse };
};

export const renderAlertHtml = ({ sub, newItems, trials = [], fdaActions = [], qualityBreakdown, condition, unsubscribeUrl }) => {
  const { rctOrMeta, everythingElse } = sectionFor(newItems);
  const nothing = newItems.length === 0 && trials.length === 0 && fdaActions.length === 0;
  const safeUnsubscribeUrl = canonicalUnsubscribeUrl(unsubscribeUrl);

  const kbNote = sub && sub.patientContext
    ? '<div style="font-size:13px;color:#475569;margin-top:4px;">Personalized using the alert details you provided.</div>'
    : '';

  const qbLine = qualityBreakdown
    ? `<div style="font-size:12px;color:#64748b;margin-top:8px;">Screened ${Number(qualityBreakdown.totalScreened || 0)} sources · excluded ${Number(qualityBreakdown.retractedExcluded || 0)} retracted publication${Number(qualityBreakdown.retractedExcluded || 0) === 1 ? '' : 's'} and ${Number(qualityBreakdown.predatoryExcluded || 0)} publication${Number(qualityBreakdown.predatoryExcluded || 0) === 1 ? '' : 's'} from specifically identified publishers with documented integrity concerns.</div>`
    : '';

  return sanitizePublicHtml(`<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 0;">
<tr><td align="center">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="640" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

  <tr><td style="padding:24px 24px 16px;background:linear-gradient(90deg,#1e3a8a 0%,#2563eb 100%);color:#ffffff;">
    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Medical Research Assistant · Weekly digest</div>
    <div style="font-size:22px;font-weight:700;margin-top:4px;">${esc(condition || sub.condition)}</div>
    ${kbNote}
  </td></tr>

  ${nothing ? `
  <tr><td style="padding:32px 24px;text-align:center;">
    <div style="font-size:16px;color:#334155;">No new peer-reviewed research, no new clinical trials, and no new FDA actions since your last digest.</div>
    <div style="font-size:13px;color:#64748b;margin-top:8px;">You're up to date — we checked ${qualityBreakdown ? qualityBreakdown.totalScreened : '?'} sources this week.</div>
  </td></tr>
  ` : `

  ${rctOrMeta.length ? `
  <tr><td style="padding:20px 24px 4px;">
    <div style="font-size:13px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.5px;">New randomized trials and evidence reviews</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">${rctOrMeta.length} new item${rctOrMeta.length === 1 ? '' : 's'}. These designs often provide stronger evidence, but relevance and quality still vary.</div>
  </td></tr>
  <tr><td><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    ${rctOrMeta.map(renderItemCard).join('')}
  </table></td></tr>
  ` : ''}

  ${everythingElse.length ? `
  <tr><td style="padding:20px 24px 4px;">
    <div style="font-size:13px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:0.5px;">Other new research</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">${everythingElse.length} new item${everythingElse.length === 1 ? '' : 's'}. Publication status is shown on each item; preprints have not been peer reviewed.</div>
  </td></tr>
  <tr><td><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    ${everythingElse.map(renderItemCard).join('')}
  </table></td></tr>
  ` : ''}

  ${trials.length ? `
  <tr><td style="padding:20px 24px 4px;">
    <div style="font-size:13px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:0.5px;">New clinical trials</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">${trials.length} trial${trials.length === 1 ? '' : 's'} recruiting or recently posted.</div>
  </td></tr>
  <tr><td style="padding:0 24px 12px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${trials.slice(0, 8).map((t) => `
        <tr><td style="padding:10px 0;border-top:1px solid #e2e8f0;">
          <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${esc(humanizeToken(t.phase || t.phases, 'Phase not reported'))} · ${esc(humanizeToken(t.status || t.overallStatus, 'Recruitment status not reported'))} · ${esc((t.countries || []).slice(0, 3).join(', ') || 'Location not reported')}${Array.isArray(t.contacts) && t.contacts.length ? ' · Study contact listed' : ''}</div>
          <div data-mrt-source-title="1" style="font-size:14px;font-weight:600;color:#0f172a;line-height:1.35;margin-top:4px;">${esc(t.title || t.briefTitle || t.nctId || 'Study title not reported')}</div>
          ${canonicalReportUrl(t.url || (t.nctId ? `https://clinicaltrials.gov/study/${t.nctId}` : ''))
            ? `<a href="${esc(canonicalReportUrl(t.url || `https://clinicaltrials.gov/study/${t.nctId}`))}" style="font-size:12px;color:#2563eb;text-decoration:none;">${esc(t.nctId || '')}</a>`
            : ''}
        </td></tr>
      `).join('')}
    </table>
  </td></tr>
  ` : ''}

  ${fdaActions.length ? `
  <tr><td style="padding:20px 24px 4px;">
    <div style="font-size:13px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:0.5px;">FDA actions this week</div>
  </td></tr>
  <tr><td style="padding:0 24px 12px;">
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#334155;line-height:1.6;">
      ${fdaActions.slice(0, 10).map((a) => {
        const destination = canonicalReportUrl(a.url);
        const label = esc(a.summary || a.reason || 'FDA action');
        return `<li>${label}${destination
          ? ` — <a href="${esc(destination)}" style="color:#2563eb;text-decoration:none;">Open the FDA recall database</a>`
          : ''}</li>`;
      }).join('')}
    </ul>
  </td></tr>
  ` : ''}
  `}

  ${qbLine ? `<tr><td style="padding:0 24px 12px;">${qbLine}</td></tr>` : ''}

  <tr><td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;line-height:1.6;">
    <div><strong>How this digest is built.</strong> Every week we search PubMed, Europe PMC, OpenAlex, Cochrane-indexed records, FDA records, and the product's reviewed reference collection. Known retractions and publications from specifically identified publishers with documented integrity concerns are excluded. An independent source-support check reviews the generated summaries.</div>
    <div style="margin-top:8px;"><strong>Not medical advice.</strong> This is research support — review with a licensed physician before any treatment decision.</div>
    ${safeUnsubscribeUrl ? `<div style="margin-top:8px;"><a href="${esc(safeUnsubscribeUrl)}" style="color:#64748b;">Unsubscribe</a></div>` : ''}
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`);
};

export const renderAlertSubject = ({ condition, newItems = [], trials = [], fdaActions = [] }) => {
  const n = newItems.length + trials.length + fdaActions.length;
  if (n === 0) return sanitizePublicText(`Medical research digest · ${condition} · no updates this week`);
  if (fdaActions.length > 0 && newItems.length === 0 && trials.length === 0) {
    return sanitizePublicText(`Medical research digest · ${condition} · ${fdaActions.length} new FDA action${fdaActions.length === 1 ? '' : 's'}`);
  }
  const strongerDesignCount = newItems.filter((i) => i.isRCT || i.isMetaAnalysis || i.isSystematicReview).length;
  if (strongerDesignCount > 0) {
    return sanitizePublicText(`Medical research digest · ${condition} · ${strongerDesignCount} new randomized trial or evidence review${strongerDesignCount === 1 ? '' : 's'}${n > strongerDesignCount ? ` + ${n - strongerDesignCount} more` : ''}`);
  }
  return sanitizePublicText(`Medical research digest · ${condition} · ${n} new item${n === 1 ? '' : 's'}`);
};
