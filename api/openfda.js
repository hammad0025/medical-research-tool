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

const LABEL_API      = 'https://api.fda.gov/drug/label.json';
const ADVERSE_API    = 'https://api.fda.gov/drug/event.json';
const ENFORCEMENT_API = 'https://api.fda.gov/drug/enforcement.json';

const fdaUrl = (drug) =>
  `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&applno=&drugname=${encodeURIComponent(drug)}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const { drug, manufacturer, limitEvents = 10 } = body || {};
    if (!drug && !manufacturer)
      return res.status(400).json({ error: 'drug or manufacturer required' });

    const results = {};

    if (drug) {
      // Label
      try {
        const lp = new URLSearchParams({
          search: `openfda.generic_name:"${drug}" OR openfda.brand_name:"${drug}"`,
          limit: '1'
        });
        const lr = await fetch(`${LABEL_API}?${lp.toString()}`);
        if (lr.ok) {
          const ld = await lr.json();
          const lbl = ld.results?.[0];
          if (lbl) {
            results.label = {
              brandName: lbl.openfda?.brand_name,
              genericName: lbl.openfda?.generic_name,
              manufacturer: lbl.openfda?.manufacturer_name,
              route: lbl.openfda?.route,
              productType: lbl.openfda?.product_type,
              boxedWarning: lbl.boxed_warning?.join('\n'),
              indications: lbl.indications_and_usage?.join('\n'),
              warnings: lbl.warnings?.join('\n'),
              contraindications: lbl.contraindications?.join('\n'),
              adverseReactions: lbl.adverse_reactions?.join('\n')?.slice(0, 6000),
              drugInteractions: lbl.drug_interactions?.join('\n')?.slice(0, 6000),
              dosage: lbl.dosage_and_administration?.join('\n')?.slice(0, 2000),
              pregnancy: lbl.pregnancy?.join('\n'),
              geriatric: lbl.geriatric_use?.join('\n'),
              url: fdaUrl(drug)
            };
          }
        }
      } catch {}

      // Adverse events (aggregated by reaction)
      try {
        const ep = new URLSearchParams({
          search: `patient.drug.openfda.generic_name:"${drug}"`,
          count: 'patient.reaction.reactionmeddrapt.exact',
          limit: String(Math.min(Number(limitEvents) || 10, 25))
        });
        const er = await fetch(`${ADVERSE_API}?${ep.toString()}`);
        if (er.ok) {
          const ed = await er.json();
          results.topAdverseEvents = (ed.results || []).map((r) => ({
            reaction: r.term, reports: r.count
          }));
        }
      } catch {}

      // Designations (hint from labels text)
      if (results.label) {
        const lt = [
          results.label.indications, results.label.warnings,
          results.label.boxedWarning, results.label.adverseReactions
        ].filter(Boolean).join('\n').toLowerCase();
        results.designations = {
          orphan: /orphan drug/.test(lt),
          fastTrack: /fast track/.test(lt),
          breakthrough: /breakthrough therapy|breakthrough designation/.test(lt),
          accelerated: /accelerated approval/.test(lt)
        };
      }
    }

    if (manufacturer) {
      // Enforcement / recalls by manufacturer (useful for vetting stem-cell labs)
      try {
        const xp = new URLSearchParams({
          search: `openfda.manufacturer_name:"${manufacturer}"`,
          limit: '10'
        });
        const xr = await fetch(`${ENFORCEMENT_API}?${xp.toString()}`);
        if (xr.ok) {
          const xd = await xr.json();
          results.enforcementActions = (xd.results || []).map((r) => ({
            recallInitiationDate: r.recall_initiation_date,
            classification: r.classification,
            reason: r.reason_for_recall,
            product: r.product_description,
            status: r.status,
            voluntary: r.voluntary_mandated
          }));
        }
      } catch {}
    }

    return res.status(200).json({ drug, manufacturer, ...results });
  } catch (e) {
    console.error('openfda.js', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
