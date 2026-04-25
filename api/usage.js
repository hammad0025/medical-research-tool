import { getUsage, limits } from '../lib/usage-store.js';

const getClientIp = (req) => {
  const xff = String(req.headers?.['x-forwarded-for'] || '').trim();
  if (xff) return xff.split(',')[0].trim();
  return String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const ip = getClientIp(req);
    const usage = await getUsage(ip);
    return res.status(200).json({
      ok: true,
      usage,
      limits: limits(),
      pricing: {
        freeTier: '4 runs / month',
        paidTier: '$10/month for up to 15 runs'
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch usage' });
  }
}
