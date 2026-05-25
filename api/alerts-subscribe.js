// /api/alerts-subscribe — create, list, or unsubscribe from weekly
// research alerts for a condition.
//
// Endpoints (dispatched by req.method + ?action):
//   POST   /api/alerts-subscribe                 → create subscription
//   GET    /api/alerts-subscribe?email=foo@bar   → list subscriptions for that email
//   POST   /api/alerts-subscribe?action=unsubscribe  → unsubscribe (needs id + token)
//
// The unsubscribe token is a random secret we issue at subscription time
// and embed in the email footer link. Without it, knowing the subscription
// id alone cannot cancel someone else's subscription.

import {
  putSubscription,
  getSubscription,
  deleteSubscription,
  listSubscriptionsByEmail,
  isConfigured,
  backendName
} from '../lib/alerts-store.js';
import { requireAccess } from '../lib/access-gate.js';

const randomId = (len = 16) => {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, len);
};

const isValidEmail = (s) =>
  typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length <= 254;

// Limit what the client can inject into the patient-context blob. We only
// forward fields that are actually useful for personalising the evidence
// pipeline. No free-text notes beyond a short comment. PII-minimising.
const sanitisePatientContext = (p = {}) => ({
  age: typeof p.age === 'string' ? p.age.slice(0, 10) : undefined,
  gender: typeof p.gender === 'string' ? p.gender.slice(0, 30) : undefined,
  stage: typeof p.stage === 'string' ? p.stage.slice(0, 40) : undefined,
  diagnoses: typeof p.diagnoses === 'string' ? p.diagnoses.slice(0, 400) : undefined,
  medications: typeof p.medications === 'string' ? p.medications.slice(0, 400) : undefined,
  allergies: typeof p.allergies === 'string' ? p.allergies.slice(0, 200) : undefined,
  notes: typeof p.notes === 'string' ? p.notes.slice(0, 400) : undefined
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Passcode');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireAccess(req, res)) return;

  try {
    const action = String(req.query?.action || '').toLowerCase();

    // ---- LIST --------------------------------------------------------
    if (req.method === 'GET') {
      const email = req.query?.email;
      if (!isValidEmail(email)) return res.status(400).json({ error: 'valid email query param required' });
      const subs = await listSubscriptionsByEmail(email);
      return res.status(200).json({
        backend: backendName(),
        email,
        count: subs.length,
        // Don't leak unsubscribeTokens back in a list view — that's a
        // private secret tied to the original subscribe call.
        subscriptions: subs.map(({ unsubscribeToken, ...s }) => s)
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};

    // ---- UNSUBSCRIBE -------------------------------------------------
    if (action === 'unsubscribe') {
      const { id, token } = body;
      if (!id || !token) return res.status(400).json({ error: 'id + token required' });
      const sub = await getSubscription(id);
      if (!sub) return res.status(404).json({ error: 'subscription not found' });
      if (sub.unsubscribeToken !== token) return res.status(403).json({ error: 'invalid token' });
      await deleteSubscription(id);
      return res.status(200).json({ ok: true, unsubscribed: id });
    }

    // ---- CREATE ------------------------------------------------------
    const { email, condition, patientContext, cadence } = body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'valid email required' });
    if (!condition || typeof condition !== 'string' || !condition.trim()) {
      return res.status(400).json({ error: 'condition required' });
    }
    if (condition.length > 200) return res.status(400).json({ error: 'condition too long' });

    // Dedupe: one active subscription per (email, condition) pair.
    const existing = await listSubscriptionsByEmail(email);
    const match = existing.find((s) => s.condition.toLowerCase() === condition.toLowerCase());
    if (match) {
      return res.status(200).json({
        ok: true, reactivated: false, alreadyExists: true,
        id: match.id,
        condition: match.condition,
        createdAt: match.createdAt,
        backend: backendName()
      });
    }

    const id = randomId(16);
    const unsubscribeToken = randomId(24);
    const sub = {
      id,
      email: email.trim().toLowerCase(),
      condition: condition.trim(),
      cadence: cadence === 'monthly' ? 'monthly' : 'weekly',
      patientContext: patientContext ? sanitisePatientContext(patientContext) : null,
      unsubscribeToken,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      active: true
    };
    await putSubscription(sub);

    return res.status(201).json({
      ok: true,
      id,
      email: sub.email,
      condition: sub.condition,
      cadence: sub.cadence,
      createdAt: sub.createdAt,
      // Return the unsubscribeToken ONLY at creation time so the client
      // can hold onto it if it wants to offer an unsubscribe button later.
      // Subsequent GET calls never return it.
      unsubscribeToken,
      backend: backendName(),
      ephemeral: !isConfigured(),
      warning: isConfigured()
        ? null
        : 'Store is in-memory and will be lost on next cold start. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Vercel to persist.'
    });
  } catch (e) {
    console.error('alerts-subscribe error:', e);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}
