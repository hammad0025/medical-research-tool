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

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_KEY = process.env.RESEND_API_KEY;
// The From address has to be a domain you've verified in Resend. For
// initial testing Resend accepts "onboarding@resend.dev" without domain
// verification — swap to your own domain for production.
const FROM =
  process.env.ALERTS_EMAIL_FROM ||
  'Medical Research Alerts <onboarding@resend.dev>';

export const isEmailConfigured = () => !!RESEND_KEY;

export const sendEmail = async ({ to, subject, html, text, replyTo }) => {
  if (!to || !subject || !html) {
    throw new Error('sendEmail requires { to, subject, html }');
  }
  if (!RESEND_KEY) {
    // Dev mode — loudly no-op so the cron job still exercises the rest of
    // its pipeline. Tests rely on this to keep running without secrets.
    return { mocked: true, provider: 'none', to, subject, htmlLength: html.length };
  }
  const r = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      reply_to: replyTo || undefined
    })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  return { mocked: false, provider: 'resend', id: data.id, to, subject };
};

// ---------- HTML template helpers ---------------------------------------

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const trunc = (s = '', n = 260) => {
  const str = String(s);
  return str.length > n ? str.slice(0, n).trim() + '…' : str;
};

// Build a compact "quality flag" row inline in the email. The taxonomy
// exactly matches computeQualityFlags() in api/evidence.js so a recipient
// sees the same integrity signals the webapp shows.
const flagPill = (label, color) =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:${color};background:${color}22;border:1px solid ${color}55;margin-right:4px;margin-top:2px;">${esc(label)}</span>`;

const renderFlags = (item) => {
  const bits = [];
  if (item.tier === 'A+' || item.tier === 'A') bits.push(flagPill(`${item.tier} tier journal`, '#10b981'));
  if (item.isMetaAnalysis) bits.push(flagPill('Meta-analysis', '#10b981'));
  else if (item.isSystematicReview) bits.push(flagPill('Systematic review', '#10b981'));
  else if (item.isRCT) bits.push(flagPill('RCT', '#10b981'));
  if (item.isCuratedKB) bits.push(flagPill('Curated landmark', '#4a9eff'));
  if (item.isPreprint) bits.push(flagPill('Preprint (not peer-reviewed)', '#eab308'));
  const concernCountries = ['CN', 'RU', 'IR', 'PK', 'IN', 'VN'];
  if (item.firstAuthorCountry && concernCountries.includes(item.firstAuthorCountry)) {
    bits.push(flagPill(`${item.firstAuthorCountry} first author · integrity concern`, '#ef4444'));
  } else if (item.firstAuthorCountry) {
    bits.push(flagPill(item.firstAuthorCountry, '#94a3b8'));
  }
  return bits.join('');
};

const renderItemCard = (it, idx) => {
  const url = it.url || '';
  const excerpt = trunc(it.text || '', 320);
  return `
  <tr>
    <td style="padding:14px 16px;border-top:1px solid #e2e8f0;">
      <div style="font-size:11px;color:#64748b;letter-spacing:0.5px;font-weight:600;text-transform:uppercase;margin-bottom:4px;">
        #${idx + 1} &middot; ${esc(it.journal || 'Unknown journal')}${it.year ? ` &middot; ${it.year}` : ''}${typeof it.citations === 'number' ? ` &middot; cited ${it.citations}×` : ''}
      </div>
      <div style="font-size:15px;font-weight:600;color:#0f172a;line-height:1.35;margin-bottom:6px;">
        ${esc(it.title || '(untitled)')}
      </div>
      <div style="margin-bottom:8px;">${renderFlags(it)}</div>
      ${excerpt ? `<div style="font-size:13px;color:#334155;line-height:1.55;font-style:italic;margin-bottom:8px;">"${esc(excerpt)}"</div>` : ''}
      ${url ? `<a href="${esc(url)}" style="font-size:12px;color:#2563eb;text-decoration:none;word-break:break-all;">${esc(url)}</a>` : ''}
    </td>
  </tr>`;
};

// Group items into sections for the digest. RCTs and meta-analyses go
// first because those are the ones a clinician / patient actually wants
// to see week over week.
const sectionFor = (newItems) => {
  const rctOrMeta = newItems.filter((i) => i.isRCT || i.isMetaAnalysis || i.isSystematicReview);
  const everythingElse = newItems.filter((i) => !rctOrMeta.includes(i));
  return { rctOrMeta, everythingElse };
};

export const renderAlertHtml = ({ sub, newItems, trials = [], fdaActions = [], qualityBreakdown, condition, unsubscribeUrl }) => {
  const { rctOrMeta, everythingElse } = sectionFor(newItems);
  const nothing = newItems.length === 0 && trials.length === 0 && fdaActions.length === 0;

  const kbNote = sub && sub.patientContext
    ? `<div style="font-size:13px;color:#475569;margin-top:4px;">Personalised for: age ${esc(sub.patientContext.age || '?')}, current meds: ${esc(trunc(sub.patientContext.medications || 'n/a', 120))}.</div>`
    : '';

  const qbLine = qualityBreakdown
    ? `<div style="font-size:12px;color:#64748b;margin-top:8px;">Screened ${qualityBreakdown.totalScreened} sources · filtered ${qualityBreakdown.retractedExcluded} retracted, ${qualityBreakdown.predatoryExcluded} from integrity-flagged publishers from the prompt pack · ${qualityBreakdown.topTierInPromptPack} A+/A-tier in pack.</div>`
    : '';

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
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
    <div style="font-size:13px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.5px;">New RCTs · Meta-analyses · Systematic reviews</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">${rctOrMeta.length} new item${rctOrMeta.length === 1 ? '' : 's'}. These are the highest-quality study designs — read these first.</div>
  </td></tr>
  <tr><td><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    ${rctOrMeta.map(renderItemCard).join('')}
  </table></td></tr>
  ` : ''}

  ${everythingElse.length ? `
  <tr><td style="padding:20px 24px 4px;">
    <div style="font-size:13px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:0.5px;">Other new peer-reviewed research</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">${everythingElse.length} new item${everythingElse.length === 1 ? '' : 's'}. Observational studies, reviews, case series, preprints.</div>
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
          <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${esc(t.phase || 'phase ?')} · ${esc(t.status || 'status ?')} · ${esc((t.countries || []).slice(0, 3).join(', ') || 'country ?')}</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;line-height:1.35;margin-top:4px;">${esc(t.title || t.nctId)}</div>
          <a href="${esc(t.url || `https://clinicaltrials.gov/study/${t.nctId}`)}" style="font-size:12px;color:#2563eb;text-decoration:none;">${esc(t.nctId || '')}</a>
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
      ${fdaActions.slice(0, 10).map((a) => `<li>${esc(a.summary || a.reason || 'FDA action')}</li>`).join('')}
    </ul>
  </td></tr>
  ` : ''}
  `}

  ${qbLine ? `<tr><td style="padding:0 24px 12px;">${qbLine}</td></tr>` : ''}

  <tr><td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;line-height:1.6;">
    <div><strong>How this digest is built.</strong> Every week we re-run the same grounded-evidence pipeline the webapp uses: PubMed, Europe PMC, OpenAlex, Cochrane, openFDA, plus your curated knowledge base. Retracted papers and papers from integrity-flagged publishers are filtered from the prompt pack. Geographic integrity weighting is applied. An independent second AI audits the first AI's summaries.</div>
    <div style="margin-top:8px;"><strong>Not medical advice.</strong> This is research support — review with a licensed physician before any treatment decision.</div>
    ${unsubscribeUrl ? `<div style="margin-top:8px;"><a href="${esc(unsubscribeUrl)}" style="color:#64748b;">Unsubscribe</a></div>` : ''}
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
};

export const renderAlertSubject = ({ condition, newItems = [], trials = [] }) => {
  const n = newItems.length + trials.length;
  if (n === 0) return `Medical research digest · ${condition} · no updates this week`;
  const rctCount = newItems.filter((i) => i.isRCT || i.isMetaAnalysis || i.isSystematicReview).length;
  if (rctCount > 0) {
    return `Medical research digest · ${condition} · ${rctCount} new RCT/meta-analysis${rctCount === 1 ? '' : 's'}${n > rctCount ? ` + ${n - rctCount} more` : ''}`;
  }
  return `Medical research digest · ${condition} · ${n} new item${n === 1 ? '' : 's'}`;
};
