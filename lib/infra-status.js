// Production infrastructure readiness — what is configured vs missing.

import { isDynamicKbStoreConfigured } from './kb-store.js';
import { isBrainQueueConfigured } from './brain-queue.js';
import { isEmailConfigured } from './alerts-email.js';
import { isConfigured as alertsStoreConfigured } from './alerts-store.js';

export const getInfraStatus = () => {
  const missing = [];
  const warnings = [];
  const ok = [];

  if (process.env.ANTHROPIC_API_KEY) ok.push('anthropic');
  else missing.push({ id: 'ANTHROPIC_API_KEY', why: 'Required — Claude writes all reports.' });

  if (process.env.PERPLEXITY_API_KEY) ok.push('perplexity');
  else warnings.push({ id: 'PERPLEXITY_API_KEY', why: 'Recommended — live web scout + second-AI check.' });

  if (process.env.MRT_ACCESS_PASSCODE) ok.push('access_gate');
  else warnings.push({ id: 'MRT_ACCESS_PASSCODE', why: 'Set for private demo passcodes.' });

  const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  if (hasUpstash) ok.push('upstash_redis');
  else {
    missing.push({
      id: 'UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN',
      why: 'Required for persistent brain — dynamic KBs, daily refresh, usage limits.'
    });
  }

  if (process.env.CRON_SECRET) ok.push('cron_secret');
  else warnings.push({
    id: 'CRON_SECRET',
    why: 'Recommended — secures daily brain-cron. Generate: openssl rand -hex 32'
  });

  const brainStore = hasUpstash ? 'upstash-redis' : 'in-memory';

  return {
    productionReady: missing.length === 0,
    brainPersistent: hasUpstash,
    brainStore,
    brainQueueConfigured: isBrainQueueConfigured(),
    dynamicKbStoreConfigured: isDynamicKbStoreConfigured(),
    alertsStoreConfigured: alertsStoreConfigured(),
    emailConfigured: isEmailConfigured(),
    ok,
    missing,
    warnings
  };
};

export const pingUpstash = async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, error: 'not configured' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING'])
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: data.result === 'PONG', result: data.result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
};
