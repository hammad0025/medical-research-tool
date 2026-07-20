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

import evidenceHandler from '../lib/evidence.js';
import trialsHandler from './trials.js';
import {
  listSubscriptionsPage,
  getAlertCronCursor,
  setAlertCronCursor,
  getSentLedger,
  claimDelivery,
  releaseDeliveryClaim,
  completeDelivery,
  backendName
} from '../lib/alerts-store.js';
import { sendEmail, renderAlertHtml, renderAlertSubject, isEmailConfigured, emailReadiness } from '../lib/alerts-email.js';
import { asInternalReq } from '../lib/internal-call.js';
import { authorizeCron } from '../lib/cron-auth.js';
import { logError } from '../lib/privacy-redaction.js';
import {
  isAlertMonitoringConfigured,
  notifyAlertFailure
} from '../lib/alerts-monitor.js';
import { setSameOriginCors } from '../lib/cors.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';

const invoke = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {}, status(c) { captured.status = c; return this; },
    end() {}, json(o) { captured.body = o; return this; }
  };
  try {
    await handler(asInternalReq({ method: 'POST', body, headers: {}, query: {} }), res);
  } catch (e) {
    logError('[alerts-cron] internal subrequest failed', e);
    captured.status = 500;
    captured.body = {
      error: 'Internal subrequest failed.',
      code: 'INTERNAL_SUBREQUEST_FAILED'
    };
  }
  return captured;
};

const periodKey = (cadence, date = new Date()) => {
  const iso = date.toISOString();
  if (cadence === 'monthly') return `monthly:${iso.slice(0, 7)}`;
  const day = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
  return `weekly:${Math.floor(day / 7)}`;
};

const isDue = (sub, now = new Date()) => {
  if (!sub.lastRunAt) return true;
  const previous = new Date(sub.lastRunAt);
  if (Number.isNaN(previous.getTime())) return true;
  return periodKey(sub.cadence, previous) !== periodKey(sub.cadence, now);
};

const oneRun = async (sub, {
  dryRun,
  now = new Date(),
  deadlineAt = Number.POSITIVE_INFINITY,
  invokeFn = invoke,
  sendEmailFn = sendEmail
} = {}) => {
  const runKey = periodKey(sub.cadence, now);
  if (!isDue(sub, now)) {
    return { subId: sub.id, skipped: 'cadence', sent: false };
  }

  const claimToken = crypto.randomUUID();
  if (!dryRun) {
    const claim = await claimDelivery(sub.id, runKey, claimToken, 240_000);
    if (claim !== 'claimed') {
      return { subId: sub.id, skipped: claim, sent: false };
    }
  }

  try {
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
    invokeFn(evidenceHandler, {
      condition,
      treatments,
      drugs: treatments,
      manufacturers: [],
      limitPerSource: 6,
      includeFullText: false // Speed: digest only needs abstracts
    }),
    invokeFn(trialsHandler, { query: condition, limit: 10 })
  ]);

  if (ev.status !== 200) {
    throw new Error(`evidence failed: ${ev.status}`);
  }
  if (trials.status !== 200) {
    throw new Error(`trials failed: ${trials.status}`);
  }
  if (Date.now() >= deadlineAt) {
    throw new Error('alert run deadline exceeded');
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
    title: t.title || t.briefTitle || t.officialTitle,
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
        id: `fda:${m.manufacturer}:${a.recallInitiationDate}:${(a.reason || '').slice(0, 40)}`,
        url: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm'
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
    condition, newItems: digestItems, trials: newTrials, fdaActions: newFdaActions
  });

  let emailResult = { skipped: true, reason: 'dryRun' };
  if (!dryRun) {
    emailResult = await sendEmailFn({
      to: sub.email,
      subject,
      html,
      // Resend de-duplicates retries after a crash between provider
      // acceptance and our atomic ledger commit.
      idempotencyKey: `alerts:${sub.id}:${runKey}`
    });
    if (emailResult.mocked || !emailResult.id) {
      await releaseDeliveryClaim(sub.id, runKey, claimToken);
      return {
        subId: sub.id,
        error: emailResult.mocked ? 'email provider not configured' : 'email provider id missing',
        sent: false,
        stateAdvanced: false
      };
    }
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

  let completion = 'dry-run';
  if (!dryRun) {
    completion = await completeDelivery({
      subId: sub.id,
      runKey,
      token: claimToken,
      providerId: emailResult.id,
      itemIds: ledgerAdditions,
      lastRunAt: now.toISOString(),
      lastRunStats: {
      screened: ev.body.qualityBreakdown?.totalScreened ?? null,
      newItemsEmailed: digestItems.length,
      newTrials: newTrials.length,
      newFdaActions: newFdaActions.length
      }
    });
    if (completion !== 'completed' && completion !== 'delivered') {
      return {
        subId: sub.id,
        error: `delivery state commit ${completion}`,
        providerId: emailResult.id,
        sent: true,
        stateAdvanced: false
      };
    }
  }

  return {
    subId: sub.id,
    firstRun,
    screened: ev.body.qualityBreakdown?.totalScreened ?? null,
    newItemsEmailed: digestItems.length,
    newTrials: newTrials.length,
    newFdaActions: newFdaActions.length,
    emailResult: dryRun
      ? { skipped: true, reason: 'dryRun' }
      : { provider: emailResult.provider, id: emailResult.id },
    sent: !dryRun,
    stateAdvanced: !dryRun && completion === 'completed'
  };
  } catch (error) {
    if (!dryRun) await releaseDeliveryClaim(sub.id, runKey, claimToken).catch(() => {});
    throw error;
  }
};

export const _alertsCronTest = { periodKey, isDue, oneRun, invoke };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'GET,POST,OPTIONS',
    headers: 'Content-Type,Authorization'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = authorizeCron(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.code, code: auth.code });
  }
  const body = req.method === 'POST'
    ? requireJsonObjectBody(req, res, { maxBytes: 4 * 1024, allowEmpty: true })
    : {};
  if (!body) return;

  try {
    const dryRun = String(req.query?.dryRun || '').toLowerCase() === '1' ||
                   body.dryRun === true;
    const delivery = emailReadiness();
    if (!dryRun && (!delivery.ready || !isAlertMonitoringConfigured())) {
      return res.status(503).json({
        error: 'Alert delivery is not production-ready.',
        code: 'ALERT_DELIVERY_MISCONFIGURED',
        missing: [
          ...delivery.missing,
          ...(!isAlertMonitoringConfigured() ? ['ALERTS_MONITOR_WEBHOOK_URL'] : [])
        ]
      });
    }
    const onlyEmail = req.query?.onlyEmail; // manual targeted run
    const requestedCursor = req.query?.cursor;
    const cursor = /^\d+$/.test(String(requestedCursor || ''))
      ? String(requestedCursor)
      : await getAlertCronCursor();
    const batchSize = Math.max(1, Math.min(10, Number(req.query?.limit) || 10));
    const started = Date.now();
    const deadlineAt = started + 45_000;
    const results = [];
    let deadlineReached = false;
    let nextCursor = cursor;
    let malformedSkipped = 0;
    let scannedSubscriptions = 0;
    let pagesProcessed = 0;
    const seenCursors = new Set();
    do {
      if (Date.now() >= deadlineAt || seenCursors.has(nextCursor)) {
        deadlineReached = Date.now() >= deadlineAt;
        break;
      }
      seenCursors.add(nextCursor);
      const pageCursor = nextCursor;
      const page = await listSubscriptionsPage({ cursor: pageCursor, limit: batchSize });
      malformedSkipped += page.malformed;
      scannedSubscriptions += page.subscriptions.length;
      const subs = page.subscriptions.filter((s) =>
        s.active && (!onlyEmail || s.email === onlyEmail)
      );
      let completedPage = true;
      for (const sub of subs) {
        if (Date.now() >= deadlineAt) {
          deadlineReached = true;
          completedPage = false;
          break;
        }
        try {
          const r = await oneRun(sub, { dryRun, deadlineAt });
          results.push(r);
        } catch (e) {
          logError('[alerts-cron] subscription run failed', e);
          results.push({
            subId: sub.id,
            error: 'Subscription processing failed.',
            code: 'SUBSCRIPTION_PROCESSING_FAILED',
            sent: false
          });
        }
        if (subs.length > 1 && Date.now() + 800 < deadlineAt) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!completedPage) {
        nextCursor = pageCursor;
        break;
      }
      nextCursor = page.cursor;
      pagesProcessed += 1;
      if (!dryRun) await setAlertCronCursor(nextCursor);
    } while (nextCursor !== '0' && pagesProcessed < 25 && Date.now() < deadlineAt);
    if (nextCursor !== '0' && (pagesProcessed >= 25 || Date.now() >= deadlineAt)) {
      deadlineReached = true;
    }

    const attempted = results.filter((r) => !r.skipped).length;
    const failures = results.filter((r) => r.error).length;
    const successes = attempted - failures;
    const meaningfulFailure =
      (attempted > 0 && failures === attempted) ||
      (failures > 0 && failures >= successes) ||
      (malformedSkipped > 0 && scannedSubscriptions === 0);
    let monitoring = { sent: false, reason: 'not-needed' };
    if (meaningfulFailure) {
      monitoring = await notifyAlertFailure({
        attempted,
        failures,
        backend: backendName()
      }).catch((error) => {
        logError('[alerts-cron] monitoring notification failed', error);
        return { sent: false, reason: 'monitoring notification failed' };
      });
    }
    const status = meaningfulFailure ? 503 : 200;
    return res.status(status).json({
      ok: !meaningfulFailure,
      backend: backendName(),
      emailConfigured: isEmailConfigured(),
      dryRun,
      subsProcessed: results.length,
      failures,
      malformedSkipped,
      cursor: nextCursor,
      pagesProcessed,
      deadlineReached,
      durationMs: Date.now() - started,
      monitoring,
      results
    });
  } catch (e) {
    logError('[alerts-cron] request failed', e);
    return res.status(500).json({
      error: 'Internal server error.',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}
