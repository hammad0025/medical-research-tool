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
  createSubscription,
  getSubscription,
  deleteSubscription,
  listSubscriptionsByEmail,
  isConfigured
} from '../lib/alerts-store.js';
import { requireAccess } from '../lib/access-gate.js';
import { setSameOriginCors } from '../lib/cors.js';
import { requireTermsConsent } from '../lib/terms-consent.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import {
  PUBLIC_PROVIDER_LIMITATIONS,
  RETENTION_SECONDS,
  SERVER_DATA_INVENTORY
} from '../lib/privacy-governance.js';
import { logError, publicError } from '../lib/privacy-redaction.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';
import { timingSafeEqual } from 'node:crypto';

const randomId = (len = 16) => {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, len);
};

const isValidEmail = (s) =>
  typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length <= 254;

const tokenMatches = (provided, stored) => {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(stored || ''));
  return a.length === b.length && a.length >= 16 && timingSafeEqual(a, b);
};

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

const publicSubscription = (sub) => ({
  id: sub.id,
  condition: sub.condition,
  cadence: sub.cadence,
  createdAt: sub.createdAt,
  expiresAt: sub.expiresAt,
  lastRunAt: sub.lastRunAt || null,
  active: sub.active === true
});

const exportableSubscription = (sub) => ({
  ...publicSubscription(sub),
  email: sub.email,
  patientContext: sub.patientContext || null
});

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'GET,POST,DELETE,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireAccess(req, res)) return;
  if (!requireTermsConsent(req, res)) return;

  try {
    const action = String(req.query?.action || '').toLowerCase();

    // ---- LIST --------------------------------------------------------
    if (req.method === 'GET') {
      if (action === 'inventory') {
        return res.status(200).json({
          scope: 'Repository-enforced data handling; not a legal compliance certification.',
          serverData: SERVER_DATA_INVENTORY,
          externalProviderLimitations: PUBLIC_PROVIDER_LIMITATIONS
        });
      }
      if (action === 'export') {
        const id = String(req.query?.id || '');
        const token = String(req.query?.token || '');
        if (!id || !token) {
          return res.status(400).json({
            error: 'This export link is incomplete. Open the alert settings page and try again.',
            code: 'EXPORT_AUTH_REQUIRED'
          });
        }
        const sub = await getSubscription(id);
        if (!sub || !tokenMatches(token, sub.ownerToken || sub.unsubscribeToken)) {
          return res.status(403).json({
            error: 'We could not verify this export link. It may be invalid or expired.',
            code: 'OWNER_TOKEN_INVALID'
          });
        }
        return res.status(200).json({
          exportedAt: new Date().toISOString(),
          subscription: exportableSubscription(sub)
        });
      }
      const email = req.query?.email;
      const token = req.query?.token;
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!token) {
        return res.status(403).json({
          error: 'Open the alert-management link that was provided when you subscribed.',
          code: 'OWNER_TOKEN_REQUIRED'
        });
      }
      const subs = await listSubscriptionsByEmail(email);
      const owned = subs.filter((sub) =>
        tokenMatches(token, sub.ownerToken || sub.unsubscribeToken)
      );
      if (!owned.length) {
        return res.status(403).json({
          error: 'We could not verify this alert-management link. It may be invalid or expired.',
          code: 'OWNER_TOKEN_INVALID'
        });
      }
      return res.status(200).json({
        count: owned.length,
        // Explicit allow-list: list responses must not expose email, patient
        // context, capability tokens, provider IDs, or future private fields.
        subscriptions: owned.map(publicSubscription)
      });
    }

    const body = requireJsonObjectBody(req, res, { maxBytes: 32 * 1024 });
    if (!body) return;

    // ---- UNSUBSCRIBE -------------------------------------------------
    if (action === 'unsubscribe' || req.method === 'DELETE') {
      const { id, token } = body;
      if (!id || !token) {
        return res.status(400).json({ error: 'This unsubscribe link is incomplete.' });
      }
      const sub = await getSubscription(id);
      if (!sub) return res.status(404).json({ error: 'This alert subscription was not found.' });
      if (!tokenMatches(token, sub.unsubscribeToken) && !tokenMatches(token, sub.ownerToken)) {
        return res.status(403).json({
          error: 'We could not verify this unsubscribe link. It may be invalid or expired.',
          code: 'OWNER_TOKEN_INVALID'
        });
      }
      await deleteSubscription(id);
      return res.status(200).json({ ok: true, deleted: id, unsubscribed: id });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ---- CREATE ------------------------------------------------------
    const { email, condition, patientContext, cadence } = body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!condition || typeof condition !== 'string' || !condition.trim()) {
      return res.status(400).json({ error: 'Enter the condition you want to follow.' });
    }
    if (condition.length > 200) {
      return res.status(400).json({ error: 'The condition name is too long. Use 200 characters or fewer.' });
    }

    // Dedupe: one active subscription per (email, condition) pair.
    const existing = await listSubscriptionsByEmail(email);
    const match = existing.find((s) =>
      typeof s.condition === 'string' &&
      s.condition.toLowerCase() === condition.trim().toLowerCase()
    );
    if (match) {
      return res.status(409).json({
        error: 'A subscription already exists for this email and condition.',
        code: 'SUBSCRIPTION_EXISTS'
      });
    }

    const id = randomId(16);
    const unsubscribeToken = randomId(24);
    const ownerToken = randomId(24);
    const sub = {
      id,
      email: email.trim().toLowerCase(),
      condition: condition.trim(),
      cadence: cadence === 'monthly' ? 'monthly' : 'weekly',
      patientContext: patientContext ? sanitisePatientContext(patientContext) : null,
      unsubscribeToken,
      ownerToken,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RETENTION_SECONDS.alerts * 1000).toISOString(),
      lastRunAt: null,
      active: true
    };
    // The store enforces this uniqueness atomically too, closing the race
    // between concurrent subscribe requests.
    const created = await createSubscription(sub);
    if (!created) {
      return res.status(409).json({
        error: 'A subscription already exists for this email and condition.',
        code: 'SUBSCRIPTION_EXISTS'
      });
    }

    return res.status(201).json({
      ok: true,
      id,
      email: sub.email,
      condition: sub.condition,
      cadence: sub.cadence,
      createdAt: sub.createdAt,
      expiresAt: sub.expiresAt,
      // Return the unsubscribeToken ONLY at creation time so the client
      // can hold onto it if it wants to offer an unsubscribe button later.
      // Subsequent GET calls never return it.
      unsubscribeToken,
      ownerToken,
      ephemeral: !isConfigured(),
      warning: isConfigured()
        ? null
        : 'This alert is temporary and may stop after the service restarts. Do not rely on it for urgent or time-sensitive medical information.'
    });
  } catch (e) {
    logError('[alerts-subscribe]', e);
    return res.status(500).json(publicError());
  }
}
