import { activatePaidForIp, verifyPaidCode, getUsage } from '../lib/usage-store.js';

const getClientIp = (req) => {
  const xff = String(req.headers?.['x-forwarded-for'] || '').trim();
  if (xff) return xff.split(',')[0].trim();
  return String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code is required' });

  if (!verifyPaidCode(code)) {
    return res.status(403).json({ error: 'Invalid upgrade code' });
  }

  try {
    const ip = getClientIp(req);
    await activatePaidForIp(ip);
    const usage = await getUsage(ip);
    return res.status(200).json({
      ok: true,
      message: 'Paid plan activated for this IP.',
      usage
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Plan activation failed' });
  }
}
