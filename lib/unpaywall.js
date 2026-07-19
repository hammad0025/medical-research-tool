// Legal open-access PDF/HTML locator (Unpaywall API).
//
// Unpaywall is maintained by OurResearch (same people behind OpenAlex). It
// indexes ~30M legal open-access versions of scholarly articles — green-OA
// institutional repositories, author manuscripts on university pages, and
// gold-OA journal editions. When a paper's journal edition is paywalled, an
// OA copy deposited elsewhere often exists; Unpaywall finds it.
//
// This is the single highest-leverage free lever for widening full-text
// coverage of paywalled medical journals, because NIH and EU funders mandate
// that authors post an OA manuscript copy somewhere within 12 months of
// publication. So for NEJM / Lancet / JAMA NIH-funded papers, there is very
// often a legal OA PDF on the author's university site.
//
// API docs: https://unpaywall.org/products/api

import { requireAccess } from './access-gate.js';
import { setSameOriginCors } from './cors.js';
import { fetchWithTimeout, timeoutFor } from './fetch-timeout.js';
import { logError } from './privacy-redaction.js';
// No API key required; must include `email` query parameter.

const UNPAYWALL_TIMEOUT_MS = timeoutFor('unpaywall', 12_000);
const API = (doi) =>
  `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=shaque025@gmail.com`;

export default async function handler(req, res) {
  if (!setSameOriginCors(req, res, {
    methods: 'POST,GET,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAccess(req, res)) return;

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const { doi } = body || {};
    if (!doi || !String(doi).trim())
      return res.status(400).json({ error: 'doi is required' });

    const cleanDoi = String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
    const r = await fetchWithTimeout(API(cleanDoi), {
      headers: { 'User-Agent': 'medical-research-assistant/1.0' },
      signal: req.signal
    }, {
      timeoutMs: UNPAYWALL_TIMEOUT_MS,
      provider: 'Unpaywall'
    });
    if (!r.ok) {
      // 404 = no record; treat as "no OA found" rather than an error.
      if (r.status === 404) {
        return res.status(200).json({ doi: cleanDoi, isOA: false, bestOA: null });
      }
      await r.text().catch(() => '');
      return res.status(r.status).json({
        error: 'The full-text lookup service is temporarily unavailable.',
        code: 'FULL_TEXT_LOOKUP_UNAVAILABLE'
      });
    }
    const data = await r.json();

    const best = data.best_oa_location || null;
    const oaLocations = (data.oa_locations || []).map((loc) => ({
      url: loc.url,
      urlForPdf: loc.url_for_pdf,
      urlForLandingPage: loc.url_for_landing_page,
      hostType: loc.host_type,           // 'publisher' | 'repository'
      version: loc.version,              // 'publishedVersion' | 'acceptedVersion' | 'submittedVersion'
      license: loc.license,
      isBest: loc === best
    }));

    return res.status(200).json({
      doi: cleanDoi,
      title: data.title,
      journal: data.journal_name,
      publisher: data.publisher,
      year: data.year,
      isOA: !!data.is_oa,
      oaStatus: data.oa_status, // 'gold' | 'green' | 'hybrid' | 'bronze' | 'closed'
      bestOA: best
        ? {
            url: best.url,
            urlForPdf: best.url_for_pdf,
            urlForLandingPage: best.url_for_landing_page,
            hostType: best.host_type,
            version: best.version,
            license: best.license
          }
        : null,
      oaLocations
    });
  } catch (e) {
    logError('[unpaywall] request failed', e);
    return res.status(500).json({
      error: 'The full-text lookup service is temporarily unavailable.',
      code: 'FULL_TEXT_LOOKUP_UNAVAILABLE'
    });
  }
}
