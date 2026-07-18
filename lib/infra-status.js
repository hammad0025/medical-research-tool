// Production infrastructure readiness — what is configured vs missing.

import { isDynamicKbStoreConfigured, dynamicKbStoreConfigError } from './kb-store.js';
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

  const hasRedisUrl = !!String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const hasRedisToken = !!String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  const hasUpstash = hasRedisUrl && hasRedisToken && isBrainQueueConfigured() && isDynamicKbStoreConfigured();
  if (hasUpstash) ok.push('upstash_redis');
  else {
    missing.push({
      id: 'UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN',
      why: hasRedisUrl !== hasRedisToken
        ? 'Both Redis URL and token are required.'
        : 'Required for persistent brain — dynamic KBs, daily refresh, usage limits.'
    });
  }

  if (process.env.CRON_SECRET) ok.push('cron_secret');
  else warnings.push({
    id: 'CRON_SECRET',
    why: 'Recommended — secures daily brain-cron. Generate: openssl rand -hex 32'
  });

  const brainStore = hasUpstash ? 'upstash-redis' : 'in-memory';
  const usageMeteringEnabled = String(process.env.MRT_DISABLE_USAGE_LIMIT ?? '0').trim() !== '1';
  if (!usageMeteringEnabled) {
    warnings.push({ id: 'MRT_DISABLE_USAGE_LIMIT', why: 'Usage metering is explicitly disabled.' });
  }

  return {
    productionReady: missing.length === 0,
    brainPersistent: hasUpstash,
    brainStore,
    brainQueueConfigured: isBrainQueueConfigured(),
    dynamicKbStoreConfigured: isDynamicKbStoreConfigured(),
    alertsStoreConfigured: alertsStoreConfigured(),
    emailConfigured: isEmailConfigured(),
    usageMeteringEnabled,
    dependencies: {
      anthropic: { required: true, configured: !!process.env.ANTHROPIC_API_KEY, state: process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing' },
      redis: { required: true, configured: hasUpstash, state: hasUpstash ? 'configured' : 'missing' },
      perplexity: { required: false, configured: !!process.env.PERPLEXITY_API_KEY, state: process.env.PERPLEXITY_API_KEY ? 'configured' : 'missing' }
    },
    configError: dynamicKbStoreConfigError() ? 'redis_client_initialization_failed' : null,
    ok,
    missing,
    warnings
  };
};

export const pingUpstash = async () => {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return { ok: false, error: 'not configured' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING']),
      signal: AbortSignal.timeout(3000)
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return data.result === 'PONG'
      ? { ok: true }
      : { ok: false, error: 'unexpected response' };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
};

export const checkInfraStatus = async () => {
  const status = getInfraStatus();
  const redis = status.dependencies.redis.configured
    ? await pingUpstash()
    : { ok: false, error: 'not configured' };
  const dependencies = {
    ...status.dependencies,
    redis: {
      ...status.dependencies.redis,
      state: redis.ok ? 'operational' : (status.dependencies.redis.configured ? 'unavailable' : 'missing')
    }
  };
  return {
    ...status,
    dependencies,
    productionReady: status.productionReady && redis.ok
  };
};
