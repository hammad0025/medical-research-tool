// /api/unpaywall — legal open-access PDF/HTML locator.
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

import { requireAccess } from '../lib/access-gate.js';
// No API key required; must include `email` query parameter.

const API = (doi) =>
  `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=shaque025@gmail.com`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Passcode');
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
    const r = await fetch(API(cleanDoi), {
      headers: { 'User-Agent': 'medical-research-assistant/1.0' }
    });
    if (!r.ok) {
      // 404 = no record; treat as "no OA found" rather than an error.
      if (r.status === 404) {
        return res.status(200).json({ doi: cleanDoi, isOA: false, bestOA: null });
      }
      const t = await r.text();
      return res.status(r.status).json({ error: 'Unpaywall failed', body: t.slice(0, 400) });
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
    console.error('unpaywall.js', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
