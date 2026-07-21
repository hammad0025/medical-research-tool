// Daily freshness overlay for static (hand-curated) KB files we cannot
// rewrite on Vercel's read-only filesystem. Merged at load time.

import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const OVERLAY_PREFIX = 'brain:overlay:';
const REDIS_TIMEOUT_MS = timeoutFor('redis', 5_000);

const upstash = async (command) => {
  if (!useUpstash) throw new Error('Upstash not configured');
  const r = await fetchWithTimeout(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  }, { timeoutMs: REDIS_TIMEOUT_MS, provider: 'Redis' });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
};

const memOverlays = new Map();

export const getBrainOverlay = async (slug) => {
  if (!slug) return null;
  if (useUpstash) {
    const raw = await upstash(['GET', `${OVERLAY_PREFIX}${slug}`]);
    return raw ? JSON.parse(raw) : null;
  }
  return memOverlays.get(slug) || null;
};

export const putBrainOverlay = async (overlay) => {
  if (!overlay?.slug) throw new Error('overlay.slug required');
  overlay.lastRefreshedAt = overlay.lastRefreshedAt || new Date().toISOString();
  if (useUpstash) {
    await upstash(['SET', `${OVERLAY_PREFIX}${overlay.slug}`, JSON.stringify(overlay)]);
  } else {
    memOverlays.set(overlay.slug, overlay);
  }
  return overlay;
};
