// Runtime "dynamic brain" — build and persist a KB when a user searches a
// condition we do not have a static reference pack for yet.

import { buildKnowledgeBase, slugFromCondition } from './kb-builder.js';
import { getDynamicKb, putDynamicKb, lookupDynamicKb, dynamicKbBackendName } from './kb-store.js';

const inflight = new Map();

export const isDynamicKbEnabled = () =>
  String(process.env.MRT_DYNAMIC_KB || '1').trim() !== '0';

const refreshDays = () =>
  Math.max(1, Number(process.env.MRT_DYNAMIC_KB_REFRESH_DAYS || 1));

const isStale = (kb) => {
  const built = kb?.dynamicBuiltAt || kb?.lastUpdated;
  if (!built) return true;
  const ageMs = Date.now() - new Date(built).getTime();
  return ageMs > refreshDays() * 24 * 60 * 60 * 1000;
};

const buildTimeoutMs = () =>
  Math.max(8000, Number(process.env.MRT_DYNAMIC_KB_BUILD_TIMEOUT_MS || 28000));

async function runBuild(canonical, dossier) {
  const slug = slugFromCondition(canonical);
  const kb = await buildKnowledgeBase({
    condition: canonical,
    slug,
    aliases: dossier?.synonyms || [],
    dossier,
    mode: 'fast'
  });
  // Persistence is MANDATORY: a successfully-built dynamic KB must land in the
  // store (Upstash or in-process memory) so the next user for this condition
  // gets a cache hit instead of rebuilding (Pillar 4 — lazy persistence). We
  // read it back to confirm; a failed write is logged loudly rather than
  // silently dropping the build.
  await putDynamicKb(kb);
  const persisted = (await getDynamicKb(kb.slug)) || (await lookupDynamicKb(canonical));
  if (!persisted) {
    console.warn(`[kb-bootstrap] WARNING: dynamic KB for ${slug} did not persist to ${dynamicKbBackendName()}`);
  } else {
    console.log(`[kb-bootstrap] dynamic KB persisted for ${slug} → ${dynamicKbBackendName()} (qa.validated=${kb.qa?.validated})`);
  }
  return kb;
}

// Try to return a dynamic KB for this condition. Waits up to timeoutMs on
// first build; if that elapses, the build continues in the background for
// the next user. Returns null on failure/timeout.
export async function ensureDynamicKb(canonical, dossier = {}, options = {}) {
  if (!isDynamicKbEnabled()) return null;
  const name = String(canonical || '').trim();
  if (!name) return null;
  if (typeof dossier?.uncertainty === 'number' && dossier.uncertainty >= 0.75) {
    return null;
  }

  const slug = slugFromCondition(name);
  const existing = (await getDynamicKb(slug)) || (await lookupDynamicKb(name));
  if (existing && !isStale(existing)) return existing;

  if (inflight.has(slug)) {
    try {
      return await Promise.race([
        inflight.get(slug),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), options.timeoutMs || buildTimeoutMs())
        )
      ]);
    } catch {
      return existing || null;
    }
  }

  const buildP = runBuild(name, dossier)
    .catch((err) => {
      console.warn(`[kb-bootstrap] build failed for ${slug}:`, err?.message || err);
      return null;
    })
    .finally(() => inflight.delete(slug));

  inflight.set(slug, buildP);

  try {
    return await Promise.race([
      buildP,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), options.timeoutMs || buildTimeoutMs())
      )
    ]);
  } catch (err) {
    if (err?.message === 'timeout') {
      console.warn(`[kb-bootstrap] ${slug} build still running — will be ready on next search`);
      return existing || null;
    }
    return null;
  }
}
