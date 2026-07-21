import { createHash, randomUUID } from 'node:crypto';
import { RETENTION_SECONDS } from './privacy-governance.js';
import { safeEqual } from './safe-compare.js';
import { clientIp } from './client-ip.js';

const WINDOW_SECONDS = 15 * 60;
const MAX_UPGRADE_ATTEMPTS = 5;
const SECURITY_AUDIT_RETENTION_SECONDS = RETENTION_SECONDS.securityAudit;
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const hasRedis = !!(UPSTASH_URL && UPSTASH_TOKEN);
const localAttempts = globalThis.__mrtUpgradeAttempts || new Map();
const localAudit = globalThis.__mrtSecurityAudit || [];
globalThis.__mrtUpgradeAttempts = localAttempts;
globalThis.__mrtSecurityAudit = localAudit;

const productionDeployment = () =>
  ['production', 'preview'].includes(String(process.env.VERCEL_ENV || '').toLowerCase()) ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const enforcementError = (message) => {
  const error = new Error(message);
  error.code = 'DURABLE_ENFORCEMENT_UNAVAILABLE';
  return error;
};

const assertDurableStore = () => {
  if (productionDeployment() && !hasRedis) {
    throw enforcementError('Durable privileged-action enforcement is unavailable');
  }
};

const digest = (value) =>
  createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 32);

const cookieValue = (req) => String(req.headers?.cookie || '')
  .split(';')
  .map((part) => part.trim())
  .find((part) => part.startsWith('mrt_access_session=')) || '';

const actorId = (req) => digest(
  cookieValue(req) ||
  req.headers?.['x-access-passcode'] ||
  `ip:${clientIp(req)}`
);

const redis = async (command) => {
  if (!hasRedis) throw enforcementError('Durable privileged-action enforcement is unavailable');
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw enforcementError(`Privileged-action store returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw enforcementError('Privileged-action store rejected command');
  return body.result;
};

export const requireReviewerAuthorization = (req, res) => {
  const expected = String(process.env.MRT_REVIEWER_TOKEN || '').trim();
  if (!expected) {
    res.status(503).json({
      error: 'Reviewer authorization is not configured.',
      code: 'REVIEWER_AUTH_UNAVAILABLE'
    });
    return null;
  }
  const supplied = String(req.headers?.['x-reviewer-token'] || '').trim();
  if (!safeEqual(supplied, expected)) {
    res.status(403).json({
      error: 'Reviewer authorization is required for this action.',
      code: 'REVIEWER_AUTH_REQUIRED'
    });
    return null;
  }
  return { purpose: 'error-memory.write', actor: `reviewer:${digest(supplied)}` };
};

const pruneLocal = (key, now) => {
  const current = localAttempts.get(key);
  if (!current || current.expiresAt <= now) {
    const fresh = { count: 0, expiresAt: now + WINDOW_SECONDS * 1000 };
    localAttempts.set(key, fresh);
    return fresh;
  }
  return current;
};

export const reserveUpgradeAttempt = async (req) => {
  assertDurableStore();
  const ip = digest(clientIp(req));
  const actor = actorId(req);
  const keys = [`security:upgrade-attempt:ip:${ip}`, `security:upgrade-attempt:user:${actor}`];
  if (hasRedis) {
    const result = await redis([
      'EVAL',
      `local ipCount = tonumber(redis.call('GET', KEYS[1]) or '0')
       local userCount = tonumber(redis.call('GET', KEYS[2]) or '0')
       local max = tonumber(ARGV[1])
       if ipCount >= max or userCount >= max then return {0, ipCount, userCount} end
       ipCount = redis.call('INCR', KEYS[1])
       userCount = redis.call('INCR', KEYS[2])
       if ipCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
       if userCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
       return {1, ipCount, userCount}`,
      '2', ...keys, String(MAX_UPGRADE_ATTEMPTS), String(WINDOW_SECONDS)
    ]);
    return {
      allowed: Number(result?.[0]) === 1,
      actor,
      ip,
      remaining: Math.max(0, MAX_UPGRADE_ATTEMPTS - Math.max(Number(result?.[1]), Number(result?.[2])))
    };
  }

  const now = Date.now();
  const ipEntry = pruneLocal(keys[0], now);
  const userEntry = pruneLocal(keys[1], now);
  if (ipEntry.count >= MAX_UPGRADE_ATTEMPTS || userEntry.count >= MAX_UPGRADE_ATTEMPTS) {
    return { allowed: false, actor, ip, remaining: 0 };
  }
  ipEntry.count += 1;
  userEntry.count += 1;
  return {
    allowed: true,
    actor,
    ip,
    remaining: Math.max(0, MAX_UPGRADE_ATTEMPTS - Math.max(ipEntry.count, userEntry.count))
  };
};

export const createAuditContext = ({ action, actor, target }) => ({
  eventId: randomUUID(),
  action,
  actor: String(actor || 'system'),
  target: digest(target),
  timestamp: new Date().toISOString()
});

export const appendSecurityAudit = async (event) => {
  assertDurableStore();
  const record = event?.eventId && event?.timestamp
    ? Object.freeze({ ...event })
    : createAuditContext(event);
  if (hasRedis) {
    await redis([
      'XADD', 'security:audit:v1', 'MAXLEN', '~', '10000', '*',
      'eventId', record.eventId,
      'action', record.action,
      'actor', record.actor,
      'target', record.target,
      'timestamp', record.timestamp
    ]);
    await redis(['EXPIRE', 'security:audit:v1', String(SECURITY_AUDIT_RETENTION_SECONDS)]);
  } else {
    localAudit.push(Object.freeze({ ...record }));
  }
  return record;
};

export const privilegedSecurityConfig = {
  maxUpgradeAttempts: MAX_UPGRADE_ATTEMPTS,
  windowSeconds: WINDOW_SECONDS,
  auditRetentionSeconds: SECURITY_AUDIT_RETENTION_SECONDS
};

export const _resetSecurityEnforcementForTests = () => {
  if (hasRedis) return;
  localAttempts.clear();
  localAudit.length = 0;
};

export const _auditEventsForTests = () => [...localAudit];
