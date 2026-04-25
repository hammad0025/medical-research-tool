// Runtime frontend config for monetization toggles.
// Keeps ad settings server-side so we can switch without redeploying UI code.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const adsEnabled = String(process.env.MRT_ADS_ENABLED || '').trim() === '1';
  const adsenseClient = String(process.env.MRT_ADSENSE_CLIENT || '').trim(); // e.g. ca-pub-xxxxxxxx

  return res.status(200).json({
    branding: {
      productName: 'researchingmycondition.com'
    },
    monetization: {
      freeRunsPerMonth: Number(process.env.MRT_FREE_LIMIT || 4),
      paidRunsPerMonth: Number(process.env.MRT_PAID_LIMIT || 15),
      paidPriceUsd: Number(process.env.MRT_PAID_PRICE_USD || 10),
      upgradeUrl: String(process.env.MRT_UPGRADE_URL || '').trim() // Stripe/payment link
    },
    ads: {
      enabled: adsEnabled,
      provider: adsEnabled ? 'google-adsense' : 'none',
      adsenseClient,
      slots: {
        researchTop: String(process.env.MRT_AD_SLOT_RESEARCH_TOP || '').trim(),
        repurposeTop: String(process.env.MRT_AD_SLOT_REPURPOSE_TOP || '').trim(),
        trialsTop: String(process.env.MRT_AD_SLOT_TRIALS_TOP || '').trim(),
        footer: String(process.env.MRT_AD_SLOT_FOOTER || '').trim()
      }
    }
  });
}
