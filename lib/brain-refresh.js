// Daily brain refresh — pull new PubMed papers, Perplexity web intel, and
// ClinicalTrials.gov recruiting studies, then update the dynamic KB or store
// a freshness overlay for static hand-curated KBs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherPubMedPapers, buildKnowledgeBase, slugFromCondition } from './kb-builder.js';
import perplexitySearchHandler from './perplexity-search.js';
import { getDynamicKb, putDynamicKb, listDynamicKbSlugs } from './kb-store.js';
import { putBrainOverlay, getBrainOverlay } from './brain-overlay.js';
import { asInternalReq } from './internal-call.js';
import { matchKb } from './kb.js';
import { ackBrainRefresh, retryBrainRefresh } from './brain-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, '..', 'data', 'kb');
const CT_API = 'https://clinicaltrials.gov/api/v2/studies';

const invokeHandler = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(c) { captured.status = c; return this; },
    end() {},
    json(o) { captured.body = o; return this; }
  };
  await handler(asInternalReq({ method: 'POST', body, headers: {}, query: {} }), res);
  return captured;
};

const perplexityHints = async (condition) => {
  if (!process.env.PERPLEXITY_API_KEY) return [];
  const res = await invokeHandler(perplexitySearchHandler, { condition, drugs: [] });
  return res.status === 200 ? (res.body?.articles || []) : [];
};

const fetchTrialHighlights = async (condition, limit = 8) => {
  try {
    const params = new URLSearchParams({
      'query.cond': condition,
      'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION',
      pageSize: String(limit),
      format: 'json'
    });
    const r = await fetch(`${CT_API}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'medical-research-assistant/1.0' }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.studies || []).map((study) => {
      const p = study.protocolSection || {};
      const id = p.identificationModule || {};
      const status = p.statusModule || {};
      const design = p.designModule || {};
      return {
        nctId: id.nctId,
        title: id.briefTitle || id.officialTitle,
        status: status.overallStatus,
        phases: (design.phases || []).join(', '),
        url: id.nctId ? `https://clinicaltrials.gov/study/${id.nctId}` : null
      };
    }).filter((t) => t.nctId);
  } catch (e) {
    console.warn('[brain-refresh] trials fetch failed:', e?.message || e);
    return [];
  }
};

const overlayIsStale = (overlay) => {
  if (!overlay?.lastRefreshedAt) return true;
  const hours = Number(process.env.MRT_BRAIN_REFRESH_HOURS || 24);
  return Date.now() - new Date(overlay.lastRefreshedAt).getTime() > hours * 60 * 60 * 1000;
};

const kbIsStale = (kb) => {
  const ts = kb?.lastRefreshedAt || kb?.dynamicBuiltAt || kb?.lastUpdated;
  if (!ts) return true;
  const hours = Number(process.env.MRT_BRAIN_REFRESH_HOURS || 24);
  return Date.now() - new Date(ts).getTime() > hours * 60 * 60 * 1000;
};

async function listStaticSlugs() {
  try {
    const files = await fs.readdir(KB_DIR);
    return files.filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function pickRefreshBatch({ limit = 8 } = {}) {
  const batch = [];
  const seen = new Set();
  const add = (canonical, slug, reason) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    batch.push({ canonical, slug, reason });
  };

  const dynamicSlugs = await listDynamicKbSlugs();
  for (const slug of dynamicSlugs) {
    const kb = await getDynamicKb(slug);
    if (kb && kbIsStale(kb)) add(kb.condition || slug, slug, 'dynamic-stale');
    if (batch.length >= limit) return batch.slice(0, limit);
  }

  const staticSlugs = await listStaticSlugs();
  const dayIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const perDay = Math.max(2, Math.ceil(staticSlugs.length / 7));
  for (let i = 0; i < perDay && batch.length < limit; i++) {
    const slug = staticSlugs[(dayIndex + i) % staticSlugs.length];
    const overlay = await getBrainOverlay(slug);
    if (overlayIsStale(overlay)) {
      try {
        const raw = await fs.readFile(path.join(KB_DIR, `${slug}.json`), 'utf8');
        const kb = JSON.parse(raw);
        add(kb.condition || slug, slug, 'static-rotation');
      } catch {
        add(slug, slug, 'static-rotation');
      }
    }
  }

  return batch.slice(0, limit);
}

export async function refreshBrainForCondition(canonical, slug, { force = false } = {}) {
  const name = String(canonical || '').trim();
  const s = slug || slugFromCondition(name);
  if (!name) throw new Error('canonical required');

  const staticMatch = await matchKb(name);
  const hasStaticFile = staticMatch?.kb?.slug === s || !!staticMatch?.kb;

  const [papers, webHints, trialHighlights] = await Promise.all([
    gatherPubMedPapers(name, { mode: 'fast' }),
    perplexityHints(name),
    fetchTrialHighlights(name)
  ]);

  const now = new Date().toISOString();

  if (hasStaticFile && staticMatch?.kb) {
    const overlay = {
      slug: staticMatch.kb.slug || s,
      condition: staticMatch.kb.condition || name,
      lastRefreshedAt: now,
      webUpdates: webHints.slice(0, 8).map((w) => ({
        title: w.title,
        finding: (w.abstract || '').replace(/^Web-search finding: /, ''),
        url: w.url,
        year: w.year
      })),
      trialHighlights,
      pubmedPaperCount: papers.length,
      refreshSource: 'daily-brain-cron'
    };
    await putBrainOverlay(overlay);
    return { slug: overlay.slug, type: 'overlay', overlay };
  }

  const existing = await getDynamicKb(s);
  if (!force && existing && !kbIsStale(existing)) {
    return { slug: s, type: 'skipped', reason: 'fresh' };
  }

  const kb = await buildKnowledgeBase({
    condition: name,
    slug: s,
    aliases: existing?.aliases || staticMatch?.kb?.aliases || [],
    mode: 'fast'
  });
  kb.lastRefreshedAt = now;
  kb.refreshCount = (existing?.refreshCount || 0) + 1;
  kb.trialHighlights = trialHighlights;
  kb.webUpdates = webHints.slice(0, 8).map((w) => ({
    title: w.title,
    finding: (w.abstract || '').replace(/^Web-search finding: /, ''),
    url: w.url,
    year: w.year
  }));
  await putDynamicKb(kb);
  return { slug: s, type: 'full', kb };
}

export async function runBrainRefreshBatch(entries, { force = false } = {}) {
  const results = [];
  for (const entry of entries) {
    const started = Date.now();
    const publicEntry = {
      canonical: entry.canonical,
      slug: entry.slug,
      reason: entry.reason,
      queuedAt: entry.queuedAt
    };
    try {
      const r = await refreshBrainForCondition(entry.canonical, entry.slug, { force });
      if (entry.leaseToken && !(await ackBrainRefresh(entry))) {
        throw new Error('queue acknowledgement failed or lease expired');
      }
      results.push({
        ...publicEntry,
        ok: true,
        refreshType: r.type,
        durationMs: Date.now() - started
      });
    } catch (e) {
      if (entry.leaseToken) {
        try {
          await retryBrainRefresh(entry);
        } catch (retryError) {
          console.warn('[brain-refresh] failed to schedule retry:', retryError?.message || retryError);
        }
      }
      results.push({
        ...publicEntry,
        ok: false,
        error: e?.message || String(e),
        durationMs: Date.now() - started
      });
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return results;
}
