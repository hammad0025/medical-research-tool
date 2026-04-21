// /api/alerts-cron — weekly digest runner.
//
// Triggered by Vercel Cron (vercel.json → crons). For each active
// subscription, runs the same grounded-evidence pipeline the webapp
// uses, diffs against a per-subscription "already sent" ledger, renders
// an HTML digest, and emails it via Resend.
//
// Security: Vercel sends a `CRON_SECRET` header on cron-triggered
// invocations (configured in the Vercel dashboard). We reject anything
// without a matching secret so a random internet visitor can't force
// the cron to blast every subscriber's inbox.
//
// Manual / test invocations: pass ?dryRun=1 to run everything EXCEPT
// actually sending the email. The response contains the rendered
// subjects, recipient counts, and new-item counts so the e2e suite
// can verify the pipeline end-to-end without needing a Resend key.

import evidenceHandler from './evidence.js';
import trialsHandler from './trials.js';
import { listSubscriptions, getSentLedger, addToSentLedger, putSubscription, backendName } from '../lib/alerts-store.js';
import { sendEmail, renderAlertHtml, renderAlertSubject, isEmailConfigured } from '../lib/alerts-email.js';

const invoke = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {}, status(c) { captured.status = c; return this; },
    end() {}, json(o) { captured.body = o; return this; }
  };
  try {
    await handler({ method: 'POST', body, headers: {}, query: {} }, res);
  } catch (e) {
    captured.status = 500;
    captured.body = { error: e.message };
  }
  return captured;
};

// Vercel cron auth: the Vercel scheduler sends `Authorization: Bearer <CRON_SECRET>`.
// We also allow a plain `?secret=` query param so the endpoint can be
// exercised manually from a browser / curl during testing.
const isAuthorised = (req) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // not configured → allow; dev mode
  const auth = req.headers?.authorization || '';
  if (auth === `Bearer ${expected}`) return true;
  if (req.query?.secret === expected) return true;
  return false;
};

const oneRun = async (sub, { dryRun } = {}) => {
  // Pull a fresh evidence pack for this condition. We pass the patient
  // context's medication list (if any) into `treatments` so openFDA
  // labels and interaction searches run against the user's actual
  // regimen — this is what makes the digest personalised.
  const condition = sub.condition;
  const pc = sub.patientContext || {};
  // Build a short treatment list from the patient's med string. Split
  // on commas, grab the first token of each (drug name without dosage).
  const treatments = String(pc.medications || '')
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter((t) => t && t.length >= 3)
    .slice(0, 4);

  const [ev, trials] = await Promise.all([
    invoke(evidenceHandler, {
      condition,
      treatments,
      drugs: treatments,
      manufacturers: [],
      limitPerSource: 6,
      includeFullText: false // Speed: digest only needs abstracts
    }),
    invoke(trialsHandler, { query: condition, limit: 10 })
  ]);

  if (ev.status !== 200) {
    return { subId: sub.id, error: `evidence failed: ${ev.status}`, sent: false };
  }

  // New-item filter: anything whose id (DOI or PMID) is NOT in the
  // per-subscription ledger counts as new. First run of a brand-new
  // subscription would therefore be "everything", which is ~25 items
  // and way too much for a first email. Cap first-run digests to the
  // most recent 8 items by publication year + citation count.
  const ledger = await getSentLedger(sub.id);
  const firstRun = ledger.size === 0;
  const grounded = ev.body.groundedForPrompt || [];
  const newItems = grounded.filter((it) => {
    const id = it.id || '';
    return id && !ledger.has(id);
  });

  // First run: instead of emailing 25 items, email the 8 "freshest"
  // ones (most recent + most cited) so the user sees something useful
  // without being overwhelmed. Everything older is pre-loaded into the
  // ledger so we don't re-email it next week.
  let digestItems, preLoadLedger = [];
  if (firstRun) {
    const sorted = [...newItems].sort((a, b) => {
      const ya = parseInt(a.year || 0); const yb = parseInt(b.year || 0);
      if (ya !== yb) return yb - ya;
      return (b.citations || 0) - (a.citations || 0);
    });
    digestItems = sorted.slice(0, 8);
    preLoadLedger = sorted.slice(8).map((i) => i.id).filter(Boolean);
  } else {
    digestItems = newItems;
  }

  // Trials: for now, just new NCT IDs not seen before. Pack them into
  // the same ledger with a `trial:` prefix so they don't collide with
  // paper IDs.
  const trialList = (trials.body?.trials || trials.body?.studies || []).map((t) => ({
    nctId: t.nctId,
    title: t.title,
    phase: t.phase,
    status: t.status || t.recruitingStatus,
    countries: t.countries || [],
    url: t.url
  })).filter((t) => t.nctId);
  const newTrials = trialList.filter((t) => !ledger.has(`trial:${t.nctId}`));

  // FDA warnings: surfaced from fdaLabels black-box / recent enforcement.
  const fdaActions = [];
  (ev.body.fdaManufacturers || []).forEach((m) => {
    (m.enforcementActions || []).slice(0, 3).forEach((a) => {
      fdaActions.push({
        summary: `${m.manufacturer}: Class ${a.classification} recall (${a.recallInitiationDate}) — ${(a.reason || '').slice(0, 140)}`,
        id: `fda:${m.manufacturer}:${a.recallInitiationDate}:${(a.reason || '').slice(0, 40)}`
      });
    });
  });
  const newFdaActions = fdaActions.filter((a) => !ledger.has(a.id));

  const unsubscribeUrl = sub.unsubscribeUrl ||
    `${process.env.ALERTS_PUBLIC_URL || ''}/unsubscribe?id=${sub.id}&token=${sub.unsubscribeToken}`;

  const html = renderAlertHtml({
    sub,
    newItems: digestItems,
    trials: newTrials,
    fdaActions: newFdaActions,
    qualityBreakdown: ev.body.qualityBreakdown,
    condition,
    unsubscribeUrl
  });
  const subject = renderAlertSubject({
    condition, newItems: digestItems, trials: newTrials
  });

  let emailResult = { skipped: true, reason: 'dryRun' };
  if (!dryRun) {
    emailResult = await sendEmail({ to: sub.email, subject, html });
  }

  // Update ledger so next week's run doesn't re-send the same items.
  // Include everything we considered (digested + pre-loaded first-run
  // overflow) plus new trials and FDA actions.
  const ledgerAdditions = [
    ...digestItems.map((i) => i.id).filter(Boolean),
    ...preLoadLedger,
    ...newTrials.map((t) => `trial:${t.nctId}`),
    ...newFdaActions.map((a) => a.id)
  ];

  if (!dryRun && ledgerAdditions.length) {
    await addToSentLedger(sub.id, ledgerAdditions);
    sub.lastRunAt = new Date().toISOString();
    sub.lastRunStats = {
      screened: ev.body.qualityBreakdown?.totalScreened ?? null,
      newItemsEmailed: digestItems.length,
      newTrials: newTrials.length,
      newFdaActions: newFdaActions.length
    };
    await putSubscription(sub);
  }

  return {
    subId: sub.id,
    email: sub.email,
    condition,
    firstRun,
    screened: ev.body.qualityBreakdown?.totalScreened ?? null,
    newItemsEmailed: digestItems.length,
    newTrials: newTrials.length,
    newFdaActions: newFdaActions.length,
    subject,
    htmlLength: html.length,
    emailResult,
    sent: !dryRun && !emailResult.mocked
  };
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorised(req)) {
    return res.status(401).json({ error: 'unauthorized — CRON_SECRET required' });
  }

  try {
    const dryRun = String(req.query?.dryRun || '').toLowerCase() === '1' ||
                   req.body?.dryRun === true;
    const onlyEmail = req.query?.onlyEmail; // manual targeted run
    const allSubs = await listSubscriptions();
    const subs = allSubs.filter((s) =>
      s.active && (!onlyEmail || s.email === onlyEmail)
    );

    const started = Date.now();
    // Run sequentially to stay polite to the upstream APIs. Cron has
    // a 60s cap per function so we can process ~10-20 subs per run
    // before running out of headroom; beyond that, paginate by
    // cadence or by batching across cron slots.
    const results = [];
    for (const sub of subs) {
      try {
        const r = await oneRun(sub, { dryRun });
        results.push(r);
      } catch (e) {
        results.push({ subId: sub.id, error: e.message, sent: false });
      }
      // Politeness delay between subs so we don't hit PubMed/NCBI's
      // per-IP limits when fanning out many subscriptions.
      if (subs.length > 1) await new Promise((r) => setTimeout(r, 800));
    }

    return res.status(200).json({
      ok: true,
      backend: backendName(),
      emailConfigured: isEmailConfigured(),
      dryRun,
      subsProcessed: results.length,
      durationMs: Date.now() - started,
      results
    });
  } catch (e) {
    console.error('alerts-cron error:', e);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}
