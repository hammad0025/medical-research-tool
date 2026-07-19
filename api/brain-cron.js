// /api/brain-cron — daily brain refresh.
//
// Runs every day (vercel.json cron). For each condition in the refresh
// queue + stale dynamic KBs + rotating static KBs, pulls:
//   - New PubMed papers
//   - Perplexity live web intel (approvals, trial readouts)
//   - ClinicalTrials.gov recruiting studies
//
// Static hand-curated KBs get a Redis overlay merged at load time.
// Unknown conditions get a full dynamic KB rebuild in Redis.

import { dequeueBrainRefreshBatch } from '../lib/brain-queue.js';
import { pickRefreshBatch, runBrainRefreshBatch } from '../lib/brain-refresh.js';
import { dynamicKbBackendName } from '../lib/kb-store.js';
import { authorizeCron } from '../lib/cron-auth.js';
import { setSameOriginCors } from '../lib/cors.js';
import { logError } from '../lib/privacy-redaction.js';

const dedupeEntries = (entries) => {
  const seen = new Set();
  return entries.filter((e) => {
    if (!e?.slug || seen.has(e.slug)) return false;
    seen.add(e.slug);
    return true;
  });
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'GET,POST,OPTIONS',
    headers: 'Content-Type,Authorization'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = authorizeCron(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.code, code: auth.code });
  }

  if (String(process.env.MRT_BRAIN_CRON || '1').trim() === '0') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'MRT_BRAIN_CRON=0' });
  }

  try {
    const limit = Math.min(Number(req.query?.limit || process.env.MRT_BRAIN_CRON_BATCH || 8), 15);
    const force = String(req.query?.force || '').trim() === '1';
    const started = Date.now();

    const queued = await dequeueBrainRefreshBatch(limit);
    const autoPicked = await pickRefreshBatch({ limit: Math.max(0, limit - queued.length) });
    const batch = dedupeEntries([
      ...queued.map((q) => ({ ...q, reason: 'user-search' })),
      ...autoPicked
    ]).slice(0, limit);

    if (!batch.length) {
      return res.status(200).json({
        ok: true,
        refreshed: 0,
        message: 'Nothing due for refresh',
        store: dynamicKbBackendName(),
        durationMs: Date.now() - started
      });
    }

    const results = await runBrainRefreshBatch(batch, { force });
    const ok = results.filter((r) => r.ok);

    return res.status(200).json({
      ok: true,
      refreshed: ok.length,
      failed: results.length - ok.length,
      store: dynamicKbBackendName(),
      batchSize: batch.length,
      results,
      durationMs: Date.now() - started
    });
  } catch (e) {
    logError('[brain-cron] request failed', e);
    return res.status(500).json({
      error: 'Brain refresh failed.',
      code: 'BRAIN_CRON_FAILED'
    });
  }
}
