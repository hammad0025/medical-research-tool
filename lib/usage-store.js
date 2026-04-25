// Monthly usage + plan store (IP-based).
//
// Goal:
// - Enforce "first 4 free per IP per month"
// - Allow paid users up to 15 per month
// - Keep the gate server-side (frontend can never bypass it)
//
// Backends:
//   1) Upstash Redis REST (durable) when UPSTASH_* is configured
//   2) In-memory Map fallback (ephemeral; local dev/tests)
//
// Redis key layout:
//   usage:<YYYY-MM>:<ipKey>   -> hash { count, paid }
//   usage:paid-ip:<ipKey>     -> "1" (manual persistent paid flag)
//
// Notes:
// - We intentionally meter only the *entry* call of a run in api/research
//   (phase=all or phase=gather) so split synthesis calls don't double-charge.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const FREE_LIMIT = Number(process.env.MRT_FREE_LIMIT || 4);
const PAID_LIMIT = Number(process.env.MRT_PAID_LIMIT || 15);

const alwaysPaidIps = new Set(
  String(process.env.MRT_PAID_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const paidCodes = new Set(
  String(process.env.MRT_PAID_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const nowMonth = () => {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
};

const ipKey = (ip) => String(ip || 'unknown').trim().toLowerCase();

const upstash = async (command) => {
  if (!useUpstash) throw new Error('Upstash not configured');
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Upstash ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  if (data.error) throw new Error(`Upstash error: ${data.error}`);
  return data.result;
};

const mem = {
  usageByMonthIp: new Map(), // `${month}:${ip}` -> { count, paid }
  paidIp: new Set()
};

const readUsage = async (month, ip) => {
  const key = `${month}:${ip}`;
  if (useUpstash) {
    const raw = await upstash(['HMGET', `usage:${key}`, 'count', 'paid']);
    const count = Number((raw && raw[0]) || 0);
    const paid = String((raw && raw[1]) || '0') === '1';
    return { count, paid };
  }
  const v = mem.usageByMonthIp.get(key) || { count: 0, paid: false };
  return { count: Number(v.count || 0), paid: !!v.paid };
};

const writeUsage = async (month, ip, { count, paid }) => {
  const key = `${month}:${ip}`;
  if (useUpstash) {
    await upstash(['HSET', `usage:${key}`, 'count', String(count), 'paid', paid ? '1' : '0']);
    // Keep month keys around for 45 days so previous month drops naturally.
    await upstash(['EXPIRE', `usage:${key}`, String(45 * 24 * 3600)]);
    return;
  }
  mem.usageByMonthIp.set(key, { count, paid });
};

const getPersistentPaidIp = async (ip) => {
  if (alwaysPaidIps.has(ip)) return true;
  if (useUpstash) {
    const v = await upstash(['GET', `usage:paid-ip:${ip}`]);
    return String(v || '0') === '1';
  }
  return mem.paidIp.has(ip);
};

const setPersistentPaidIp = async (ip) => {
  if (useUpstash) {
    await upstash(['SET', `usage:paid-ip:${ip}`, '1']);
    return;
  }
  mem.paidIp.add(ip);
};

export const limits = () => ({ free: FREE_LIMIT, paid: PAID_LIMIT });

export const verifyPaidCode = (code) => paidCodes.has(String(code || '').trim());

export const activatePaidForIp = async (ip) => {
  const month = nowMonth();
  const key = ipKey(ip);
  await setPersistentPaidIp(key);
  const cur = await readUsage(month, key);
  await writeUsage(month, key, { count: cur.count, paid: true });
  return { month, ip: key };
};

export const getUsage = async (ip) => {
  const month = nowMonth();
  const key = ipKey(ip);
  const cur = await readUsage(month, key);
  const isPaid = cur.paid || (await getPersistentPaidIp(key));
  const limit = isPaid ? PAID_LIMIT : FREE_LIMIT;
  const used = Number(cur.count || 0);
  return {
    month,
    ip: key,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    plan: isPaid ? 'paid' : 'free',
    paid: isPaid
  };
};

export const consumeResearchCredit = async (ip) => {
  const month = nowMonth();
  const key = ipKey(ip);
  const cur = await readUsage(month, key);
  const isPaid = cur.paid || (await getPersistentPaidIp(key));
  const limit = isPaid ? PAID_LIMIT : FREE_LIMIT;
  if (cur.count >= limit) {
    return {
      allowed: false,
      ...{
        month,
        ip: key,
        used: cur.count,
        limit,
        remaining: 0,
        plan: isPaid ? 'paid' : 'free',
        paid: isPaid
      }
    };
  }
  const next = cur.count + 1;
  await writeUsage(month, key, { count: next, paid: isPaid });
  return {
    allowed: true,
    month,
    ip: key,
    used: next,
    limit,
    remaining: Math.max(0, limit - next),
    plan: isPaid ? 'paid' : 'free',
    paid: isPaid
  };
};

export const _resetForTests = () => {
  if (useUpstash) return;
  mem.usageByMonthIp.clear();
  mem.paidIp.clear();
};
