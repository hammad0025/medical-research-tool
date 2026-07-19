// openFDA endpoint — real FDA data on drugs.
//
//   label          : FDA prescribing information (indications, warnings, black box,
//                    adverse reactions, drug interactions, dosage, contraindications)
//   adverse_events : actual FAERS post-market reports by drug, aggregated by reaction
//   enforcement    : recalls / enforcement actions against a manufacturer
//
// Combined, these give the AI layer real, citable FDA content — not inferred
// — for every drug it recommends. This includes FDA warning-letter signals
// (e.g. against stem-cell source labs) and real post-market side-effect
// frequencies aggregated from FAERS reports.
//
// API docs: https://open.fda.gov/apis/

import { requireAccess } from './access-gate.js';
import { parsePageSize } from './normalize.js';
import { fetchWithTimeout, isTimeoutError, timeoutFor } from './fetch-timeout.js';
import { setSameOriginCors } from './cors.js';
import { logError } from './privacy-redaction.js';

const LABEL_API      = 'https://api.fda.gov/drug/label.json';
const ADVERSE_API    = 'https://api.fda.gov/drug/event.json';
const ENFORCEMENT_API = 'https://api.fda.gov/drug/enforcement.json';
const OPENFDA_TIMEOUT_MS = timeoutFor('openfda', 12_000);

// Prefer a real DailyMed monograph. Never emit Drugs@FDA with empty applno=
// (broken citation — demoted by citation-gate).
const dailyMedLabelUrl = (setid) => {
  const id = String(setid || '').trim();
  return id ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(id)}` : '';
};

const values = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const normalizedToken = (value) => String(value || '').trim().toLowerCase();

export const selectBestLabel = (labels, { drug = '', route = '', formulation = '' } = {}) => {
  const requestedDrug = normalizedToken(drug);
  const requestedRoute = normalizedToken(route);
  const requestedForm = normalizedToken(formulation);
  const scored = values(labels).map((label, index) => {
    const names = [
      ...values(label?.openfda?.generic_name),
      ...values(label?.openfda?.brand_name),
      ...values(label?.openfda?.substance_name)
    ].map(normalizedToken);
    const routes = values(label?.openfda?.route).map(normalizedToken);
    const forms = values(label?.openfda?.dosage_form).map(normalizedToken);
    const exactName = names.some((name) => name === requestedDrug);
    const nameMatch = exactName || names.some((name) => name.includes(requestedDrug) || requestedDrug.includes(name));
    const routeMatch = !requestedRoute || routes.some((value) => value.includes(requestedRoute) || requestedRoute.includes(value));
    const formMatch = !requestedForm || forms.some((value) => value.includes(requestedForm) || requestedForm.includes(value));
    const mismatch = (requestedRoute && (!routes.length || !routeMatch)) ||
      (requestedForm && (!forms.length || !formMatch));
    return { label, index, mismatch, score: (exactName ? 8 : nameMatch ? 4 : 0) + (routeMatch ? 2 : 0) + (formMatch ? 1 : 0) };
  });
  const compatible = scored.filter((entry) => !entry.mismatch);
  return compatible.sort((a, b) => b.score - a.score || a.index - b.index)[0]?.label || null;
};

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
    const { drug, manufacturer, limitEvents = 10, route = '', formulation = '' } = body || {};
    if (!drug && !manufacturer)
      return res.status(400).json({ error: 'drug or manufacturer required' });

    const results = {};
    const providerErrors = [];
    const recordFailure = (operation, error) => {
      providerErrors.push({
        provider: `openFDA ${operation}`,
        reason: isTimeoutError(error) ? 'timeout' : error?.status ? `http-${error.status}` : 'network-error'
      });
    };
    const checkedFetch = async (url, operation) => {
      const response = await fetchWithTimeout(url, {
        signal: req.signal
      }, {
        timeoutMs: OPENFDA_TIMEOUT_MS,
        provider: `openFDA ${operation}`
      });
      if (!response.ok) {
        const error = new Error(`openFDA ${operation} HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response;
    };

    if (drug) {
      // Label
      try {
        const lp = new URLSearchParams({
          search: `openfda.generic_name:"${drug}" OR openfda.brand_name:"${drug}"`,
          limit: '10'
        });
        const lr = await checkedFetch(`${LABEL_API}?${lp.toString()}`, 'label');
        const ld = await lr.json();
        const lbl = selectBestLabel(ld.results, { drug, route, formulation });
        if (lbl) {
            // spl_set_id is the DailyMed setid — build the specific label
            // monograph URL so downstream cards can cite an authoritative
            // label page instead of an (banned) DailyMed search results page.
            const splSetId = lbl.openfda?.spl_set_id?.[0] || lbl.set_id || '';
            const dmLabel = dailyMedLabelUrl(splSetId);
            results.label = {
              brandName: lbl.openfda?.brand_name,
              genericName: lbl.openfda?.generic_name,
              manufacturer: lbl.openfda?.manufacturer_name,
              route: lbl.openfda?.route,
              dosageForm: lbl.openfda?.dosage_form,
              productType: lbl.openfda?.product_type,
              splSetId: splSetId || undefined,
              dailyMedUrl: dmLabel || undefined,
              boxedWarning: lbl.boxed_warning?.join('\n'),
              indications: lbl.indications_and_usage?.join('\n'),
              warnings: lbl.warnings?.join('\n'),
              contraindications: lbl.contraindications?.join('\n'),
              adverseReactions: lbl.adverse_reactions?.join('\n')?.slice(0, 6000),
              drugInteractions: lbl.drug_interactions?.join('\n')?.slice(0, 6000),
              dosage: lbl.dosage_and_administration?.join('\n')?.slice(0, 2000),
              pregnancy: lbl.pregnancy?.join('\n'),
              geriatric: lbl.geriatric_use?.join('\n'),
              // Prefer DailyMed setid monograph. Never ship empty-applno DAF.
              url: dmLabel || undefined
            };
        }
      } catch (error) {
        recordFailure('label', error);
      }

      // Adverse events (aggregated by reaction)
      try {
        const ep = new URLSearchParams({
          search: `patient.drug.openfda.generic_name:"${drug}"`,
          count: 'patient.reaction.reactionmeddrapt.exact',
          limit: String(parsePageSize(limitEvents, { fallback: 10, max: 25 }))
        });
        const er = await checkedFetch(`${ADVERSE_API}?${ep.toString()}`, 'adverse events');
        const ed = await er.json();
        results.topAdverseEvents = (ed.results || []).map((r) => ({
          reaction: r.term, reports: r.count
        }));
      } catch (error) {
        recordFailure('adverse events', error);
      }

      // Approval/designation status is not inferred from incidental label prose.
      // A label can mention another product, indication, or a negated status.
    }

    if (manufacturer) {
      // Enforcement / recalls by manufacturer (useful for vetting stem-cell labs)
      try {
        const xp = new URLSearchParams({
          search: `openfda.manufacturer_name:"${manufacturer}"`,
          limit: '10'
        });
        const xr = await checkedFetch(`${ENFORCEMENT_API}?${xp.toString()}`, 'enforcement');
        const xd = await xr.json();
        results.enforcementActions = (xd.results || []).map((r) => ({
          recallInitiationDate: r.recall_initiation_date,
          classification: r.classification,
          reason: r.reason_for_recall,
          product: r.product_description,
          status: r.status,
          voluntary: r.voluntary_mandated
        }));
      } catch (error) {
        recordFailure('enforcement', error);
      }
    }

    return res.status(200).json({
      drug,
      manufacturer,
      ...results,
      ...(providerErrors.length ? { degraded: true, providerErrors } : {})
    });
  } catch (e) {
    logError('[openfda] request failed', e);
    return res.status(500).json({
      error: 'The regulator-record search is temporarily unavailable.',
      code: 'REGULATOR_SEARCH_UNAVAILABLE'
    });
  }
}
