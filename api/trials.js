// Vercel Serverless Function for live ClinicalTrials.gov v2 API queries.
//
// A user asking "what clinical trials should I look at for my dad with
// Parkinson's" wants THREE categories, not one:
//
//   1. RECRUITING trials — the default, "I want to join a trial"
//   2. EXPANDED ACCESS / COMPASSIONATE USE — "I don't qualify for a trial,
//      can I get the drug anyway?" These are separate studyType=EXPANDED_ACCESS
//      records on CT.gov and are NEVER returned by a recruiting filter.
//   3. OPEN-LABEL EXTENSION (OLE) — "I was in a trial, how do I keep getting
//      the drug?" These are separate NCT records, usually with "extension" or
//      "long-term follow-up" in the title, and recruit only prior-trial
//      participants.
//
// Prior to this fix we ran ONE query (recruiting-only, condition-only) and
// missed expanded access and OLE studies entirely. That is how a user
// researching Retinitis Pigmentosa never saw Johns Hopkins' NAC trial
// extensions or Ocugen's expanded-access pathway.
//
// We now fan out across 4 parallel queries per call:
//   a. Primary condition, recruiting (the old behavior)
//   b. Expanded Access / Compassionate Use for the condition
//   c. Open-Label Extension studies for the condition
//   d. Synonym-expanded query (RP -> retinitis pigmentosa -> rod-cone
//      dystrophy -> inherited retinal dystrophy), recruiting
//
// Results are de-duplicated by NCT ID and each trial is enriched with
// isExpandedAccess / isOpenLabelExtension / hasTopCenter flags.
//
// Public API, no key required. Docs: https://clinicaltrials.gov/data-api/api

import { isTopCenter, topCenterBoost, buildExtendedCenterMatcher } from '../lib/medical-lexicon.js';
import { getDossier } from '../lib/disease-dossier.js';
import { loadKb } from '../lib/kb.js';

const CT_API = 'https://clinicaltrials.gov/api/v2/studies';

const FAST_TRACK_HINTS = ['fast track', 'fast-track'];
const BREAKTHROUGH_HINTS = ['breakthrough therapy', 'breakthrough designation'];
const ORPHAN_HINTS = ['orphan drug', 'orphan designation', 'orphan status'];
const EXPANDED_ACCESS_HINTS = ['expanded access', 'compassionate use', 'individual patient ind',
  'emergency ind', 'pre-approval access', 'named patient'];
const PTA_HINTS = ['post-trial access', 'post trial access', 'continued access',
  'continued availability', 'long-term access'];
const OLE_HINTS = ['open-label extension', 'open label extension', 'ole phase',
  'long-term extension', 'long-term follow-up', 'rollover study', 'extension study'];
const PAY_TO_ACCESS_HINTS = ['patient funded', 'participant funded', 'self-funded',
  'pay to participate', 'self-pay', 'enrollment fee', 'program fee'];

const containsAny = (text, hints) => {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return hints.some(h => lower.includes(h));
};

const extractContacts = (contactsLocationsModule = {}) => {
  const centralContacts = contactsLocationsModule.centralContacts || [];
  const overallOfficials = contactsLocationsModule.overallOfficials || [];
  const locations = (contactsLocationsModule.locations || []).map(loc => ({
    facility: loc.facility,
    city: loc.city,
    state: loc.state,
    country: loc.country,
    status: loc.status,
    contacts: (loc.contacts || []).map(c => ({
      name: c.name,
      role: c.role,
      email: c.email,
      phone: c.phone
    }))
  }));
  return {
    centralContacts: centralContacts.map(c => ({
      name: c.name,
      role: c.role,
      email: c.email,
      phone: c.phone
    })),
    overallOfficials: overallOfficials.map(o => ({
      name: o.name,
      role: o.role,
      affiliation: o.affiliation
    })),
    locations
  };
};

// classifyTrial accepts an optional `isTopCenterFn` so callers can inject a
// dossier-extended top-center matcher (adds disease-specific centers like
// Joslin Diabetes Center for LADA, or Pittsburgh Simmons Center for ILD,
// on top of the Tier-1 safety-floor whitelist). If omitted, falls back to
// the global `isTopCenter` whitelist.
const classifyTrial = (study, isTopCenterFn = isTopCenter) => {
  const protocol = study.protocolSection || {};
  const identification = protocol.identificationModule || {};
  const status = protocol.statusModule || {};
  const design = protocol.designModule || {};
  const arms = protocol.armsInterventionsModule || {};
  const eligibility = protocol.eligibilityModule || {};
  const oversight = protocol.oversightModule || {};
  const sponsor = protocol.sponsorCollaboratorsModule || {};
  const desc = protocol.descriptionModule || {};
  const outcomes = protocol.outcomesModule || {};

  const nctId = identification.nctId;
  const briefTitle = identification.briefTitle;
  const officialTitle = identification.officialTitle;
  const organization = identification.organization?.fullName;

  const overallStatus = status.overallStatus;
  const isRecruiting = ['RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION'].includes(overallStatus);
  const acceptingNew = overallStatus === 'RECRUITING' || overallStatus === 'ENROLLING_BY_INVITATION';

  const studyType = design.studyType;
  const isTreatment = studyType === 'INTERVENTIONAL';
  const isExpandedAccessStudyType = studyType === 'EXPANDED_ACCESS';
  const phases = design.phases || [];
  const allocation = design.designInfo?.allocation;
  const masking = design.designInfo?.maskingInfo?.masking;
  const hasPlacebo = (arms.interventions || []).some(i =>
    i.type === 'OTHER' && /placebo/i.test(i.name || '')
  ) || /placebo/i.test(masking || '');

  // Expanded Access detection is layered:
  //   - studyType == EXPANDED_ACCESS (definitive)
  //   - identificationModule.expandedAccessInfo.hasExpandedAccess (the related-
  //     study flag on a parent interventional trial)
  //   - text hints in summary/description (compassionate use, IND-EA, etc.)
  const hasExpandedAccess =
    isExpandedAccessStudyType ||
    identification.expandedAccessInfo?.hasExpandedAccess === true ||
    containsAny(desc.detailedDescription, EXPANDED_ACCESS_HINTS) ||
    containsAny(desc.briefSummary, EXPANDED_ACCESS_HINTS) ||
    containsAny(briefTitle, EXPANDED_ACCESS_HINTS) ||
    containsAny(officialTitle, EXPANDED_ACCESS_HINTS);

  const hasPTA =
    containsAny(desc.detailedDescription, PTA_HINTS) ||
    containsAny(desc.briefSummary, PTA_HINTS);

  // OLE detection prioritises the title because that's where CT.gov
  // sponsors most reliably label extension studies.
  const hasOLE =
    containsAny(briefTitle, OLE_HINTS) ||
    containsAny(officialTitle, OLE_HINTS) ||
    containsAny(desc.detailedDescription, OLE_HINTS) ||
    containsAny(desc.briefSummary, OLE_HINTS);

  // Pay-to-Access detection is best-effort. Most patient-funded studies
  // disclose fees in the description. Many do NOT, especially company-run
  // "charitable access" programs. When we detect any signal we surface it
  // explicitly so the user knows to ask about cost.
  const hasPayToAccess =
    containsAny(desc.detailedDescription, PAY_TO_ACCESS_HINTS) ||
    containsAny(desc.briefSummary, PAY_TO_ACCESS_HINTS) ||
    containsAny(officialTitle, PAY_TO_ACCESS_HINTS);

  const fastTrack = containsAny(desc.detailedDescription, FAST_TRACK_HINTS) ||
                    containsAny(desc.briefSummary, FAST_TRACK_HINTS);
  const breakthrough = containsAny(desc.detailedDescription, BREAKTHROUGH_HINTS) ||
                       containsAny(desc.briefSummary, BREAKTHROUGH_HINTS);
  const orphan = containsAny(desc.detailedDescription, ORPHAN_HINTS) ||
                 containsAny(desc.briefSummary, ORPHAN_HINTS);

  const contacts = extractContacts(protocol.contactsLocationsModule);
  const countries = [...new Set(contacts.locations.map(l => l.country).filter(Boolean))];

  // Top-center detection looks at sponsor, organization, every facility, and
  // every overall official affiliation. Any single match is enough to flag
  // the trial as "top center" for UI purposes, and matches stack (capped)
  // for scoring.
  const centerTexts = [
    sponsor.leadSponsor?.name,
    ...(sponsor.collaborators || []).map((c) => c.name),
    organization,
    ...contacts.locations.map((l) => l.facility),
    ...contacts.overallOfficials.map((o) => o.affiliation)
  ].filter(Boolean);
  const topCenters = [...new Set(centerTexts.filter(isTopCenterFn))];
  const hasTopCenter = topCenters.length > 0;
  // We still use the hardcoded-whitelist boost for the numeric score (the
  // dossier-extended list would let Claude inflate scores for obscure
  // centers); the dossier's contribution is surfacing whether ANY match
  // exists and naming the center in the UI / prompt context.
  const topCenterScore = topCenterBoost(centerTexts);

  const interventions = (arms.interventions || []).map(i => ({
    type: i.type,
    name: i.name,
    description: i.description
  }));

  const primaryOutcomes = (outcomes.primaryOutcomes || []).map(o => ({
    measure: o.measure,
    description: o.description,
    timeFrame: o.timeFrame
  }));

  const oversightFlags = {
    fdaRegulatedDrug: oversight.isFdaRegulatedDrug,
    fdaRegulatedDevice: oversight.isFdaRegulatedDevice,
    oversightHasDMC: oversight.oversightHasDmc,
    usExportStatus: oversight.isUsExport
  };

  return {
    nctId,
    url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : null,
    briefTitle,
    officialTitle,
    organization,
    sponsor: sponsor.leadSponsor?.name,
    collaborators: (sponsor.collaborators || []).map(c => c.name),

    status: overallStatus,
    acceptingNewPatients: acceptingNew,
    isRecruiting,
    startDate: status.startDateStruct?.date,
    completionDate: status.completionDateStruct?.date,
    lastUpdate: status.lastUpdatePostDateStruct?.date,

    studyType,
    isTreatmentStudy: isTreatment,
    isExpandedAccessStudy: isExpandedAccessStudyType,
    phases,
    allocation,
    masking,
    hasPlacebo,
    interventions,

    designations: {
      fastTrack,
      breakthrough,
      orphan,
      hasExpandedAccess,
      hasPostTrialAccess: hasPTA,
      hasOpenLabelExtension: hasOLE,
      hasPayToAccess
    },

    // Top-line boolean flags that frontend can badge without drilling into
    // designations{}. Redundant but useful.
    isExpandedAccess: hasExpandedAccess,
    isOpenLabelExtension: hasOLE,
    isPayToAccess: hasPayToAccess,
    hasTopCenter,
    topCenters,
    topCenterScore,

    oversight: oversightFlags,

    eligibilityCriteria: eligibility.eligibilityCriteria,
    healthyVolunteers: eligibility.healthyVolunteers,
    sex: eligibility.sex,
    minimumAge: eligibility.minimumAge,
    maximumAge: eligibility.maximumAge,
    stdAges: eligibility.stdAges,

    briefSummary: desc.briefSummary,
    detailedDescription: desc.detailedDescription,
    primaryOutcomes,

    contacts,
    countries
  };
};

// Single CT.gov query wrapper. Returns raw studies[] array or throws.
const queryCtGov = async (paramsDict) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsDict)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  params.set('format', 'json');
  params.set('countTotal', 'true');
  const url = `${CT_API}?${params.toString()}`;
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`ClinicalTrials.gov ${response.status}: ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  return data.studies || [];
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const {
      condition,
      recruitingOnly = true,
      treatmentOnly = true,
      excludePlacebo = false,
      pageSize = 50,
      country
    } = body || {};

    if (!condition || !String(condition).trim()) {
      return res.status(400).json({ error: 'condition is required' });
    }

    // Disease-intake agent. Returns a structured dossier with synonyms,
    // MeSH terms, top centers, etc. for ANY condition (no hardcoded map).
    // We accept a pre-fetched dossier from callers (research.js passes one
    // through so we don't double-call the agent for the same query).
    const dossier =
      (body && body.dossier && body.dossier.canonical)
        ? body.dossier
        : await getDossier(condition);

    const primary = dossier.canonical || condition;
    const aliases = (dossier.synonyms || [])
      .filter((s) => s && s.toLowerCase() !== primary.toLowerCase());
    // MeSH terms let us query CT.gov on controlled vocabulary when the
    // user's colloquial input doesn't match CT.gov's indexing (e.g. "LADA"
    // → "Diabetes Mellitus, Type 1").
    const meshTerms = (dossier.meshTerms || []).filter(Boolean);
    const perSource = Math.min(Number(pageSize) || 50, 100);
    // Extend the top-center matcher with dossier-supplied centers so
    // disease-specific leaders (Joslin for diabetes, Pittsburgh Simmons for
    // ILD, UCSF MAC for dementia) count alongside the global whitelist.
    const isTopCenterExtended = buildExtendedCenterMatcher(dossier.topCenters || []);

    // 4 parallel queries. Each returns raw studies[]; we merge + classify + dedupe later.
    //   (a) Primary condition, recruiting only (if recruitingOnly)
    //   (b) Synonym-fanout: first 3 aliases, recruiting only
    //   (c) Expanded Access — no recruiting filter (these have their own statuses:
    //       AVAILABLE, NO_LONGER_AVAILABLE, APPROVED_FOR_MARKETING, etc.)
    //   (d) Open-Label Extension / Long-Term Follow-Up studies — text search
    const queries = [];

    // (a) Primary recruiting
    queries.push(queryCtGov({
      'query.cond': primary,
      'pageSize': perSource,
      ...(recruitingOnly
        ? { 'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION' }
        : {})
    }));

    // (b) Synonym fan-out (first 3 dossier-supplied aliases)
    for (const alias of aliases.slice(0, 3)) {
      queries.push(queryCtGov({
        'query.cond': alias,
        'pageSize': Math.min(30, perSource),
        ...(recruitingOnly
          ? { 'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION' }
          : {})
      }));
    }

    // (b2) MeSH term fan-out. CT.gov's indexing is more reliable on MeSH
    // headings than on colloquial names (e.g. "Lou Gehrig's" misses plenty
    // of ALS trials that index under "Amyotrophic Lateral Sclerosis").
    for (const mesh of meshTerms.slice(0, 2)) {
      queries.push(queryCtGov({
        'query.term': `AREA[ConditionMeshTerm]"${mesh}"`,
        'pageSize': Math.min(30, perSource),
        ...(recruitingOnly
          ? { 'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION' }
          : {})
      }));
    }

    // (c) Expanded Access studies for the condition, ALL statuses.
    // CT.gov v2 filters Expanded Access via the advanced Essie query expression.
    queries.push(queryCtGov({
      'query.cond': primary,
      'filter.advanced': 'AREA[StudyType]EXPANDED_ACCESS',
      'pageSize': 40
    }));

    // (d) Open-Label Extension / Long-Term Follow-Up. Title search is the most
    // reliable signal (sponsors label extensions with these words by convention).
    queries.push(queryCtGov({
      'query.cond': primary,
      'query.titles': 'extension OR "long-term follow-up" OR rollover',
      'pageSize': 40
    }));

    // (e) Pipeline-drug fan-out. For every drug/NCT in the KB's
    // pipelineDrugs array we query CT.gov explicitly — either by NCT id
    // (most precise) or by drug name. This is what stops us missing
    // Nerandomilast's FIBRONEER trials for IPF or Ocugen's OCU400
    // liMeliGhT trial for RP even when the generic condition query
    // fails to surface them. NCTs queried directly always return the
    // exact trial record, bypassing relevance ranking.
    const kb = await loadKb(condition);
    const pipelineDrugs = Array.isArray(kb.meta?.pipelineDrugs) ? kb.meta.pipelineDrugs : [];
    const pipelineDrugQueryLabels = [];
    for (const drug of pipelineDrugs.slice(0, 6)) {
      if (drug.nct) {
        // Direct NCT lookup — guaranteed match.
        queries.push(queryCtGov({ 'query.id': drug.nct, 'pageSize': 5 }));
        pipelineDrugQueryLabels.push(`nct:${drug.nct}:${drug.name}`);
      }
      if (drug.name) {
        // Intervention-text search. CT.gov's `query.intr` is the
        // intervention field — guaranteed to hit trials that administer
        // this drug, regardless of whether the condition term matches.
        queries.push(queryCtGov({
          'query.cond': primary,
          'query.intr': drug.name,
          'pageSize': 10
        }));
        pipelineDrugQueryLabels.push(`drug:${drug.name}`);
      }
    }

    // Run all of the above in parallel. Any individual failure does NOT kill
    // the whole request — we return what we have and mark which sub-queries
    // failed in the response so the UI can warn.
    const settled = await Promise.allSettled(queries);
    const queryLabels = [
      'primary',
      ...aliases.slice(0, 3).map((a) => `synonym:${a}`),
      ...meshTerms.slice(0, 2).map((m) => `mesh:${m}`),
      'expanded-access',
      'ole-extension',
      ...pipelineDrugQueryLabels
    ];
    const subQueryStats = [];
    const allRaw = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        subQueryStats.push({ label: queryLabels[i], status: 'ok', count: r.value.length });
        allRaw.push(...r.value);
      } else {
        subQueryStats.push({ label: queryLabels[i], status: 'error', error: r.reason?.message });
      }
    });

    // Classify + dedupe by NCT
    const byNct = new Map();
    for (const raw of allRaw) {
      const nct = raw?.protocolSection?.identificationModule?.nctId;
      if (!nct || byNct.has(nct)) continue;
      byNct.set(nct, classifyTrial(raw, isTopCenterExtended));
    }
    let studies = [...byNct.values()];

    // Apply filters AFTER dedupe so we don't accidentally drop an expanded-
    // access record by the recruiting-only filter when the user clicked
    // "include all".
    if (treatmentOnly) {
      // Keep interventional AND expanded-access studies even when treatmentOnly
      // is on — both are "the patient actually gets a drug".
      studies = studies.filter((s) => s.isTreatmentStudy || s.isExpandedAccessStudy);
    }
    if (excludePlacebo) {
      studies = studies.filter((s) => !s.hasPlacebo);
    }
    if (country) {
      const target = String(country).toLowerCase();
      studies = studies.filter(s =>
        (s.countries || []).some(c => String(c).toLowerCase().includes(target))
      );
    }

    // Promise-score. Heavily revised from the previous single-query version:
    //   - Phase bonuses (existing)
    //   - Recruiting + no-placebo + designations (existing)
    //   - NEW: +20 if expanded-access available (it's literally "you can
    //     get the drug right now without winning a trial lottery")
    //   - NEW: +15 if OLE available
    //   - NEW: +3 per top center in sponsor/location/affiliation (capped 15)
    //   - NEW: -15 if the trial is in China/Vietnam/Mexico/India for
    //     the stem-cell safety reasons already used in evidence.js
    const WESTERN = new Set([
      'United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Italy',
      'Spain', 'Netherlands', 'Sweden', 'Denmark', 'Norway', 'Finland', 'Belgium',
      'Switzerland', 'Ireland', 'Austria', 'Australia', 'New Zealand', 'Japan'
    ]);
    const CHINA_LIKE = new Set(['China', 'Vietnam', 'Mexico', 'India']);

    studies.forEach((s) => {
      let score = 0;
      const phase = (s.phases || []).join(',');
      if (phase.includes('PHASE3')) score += 40;
      else if (phase.includes('PHASE2')) score += 25;
      else if (phase.includes('PHASE1')) score += 10;
      if (s.acceptingNewPatients) score += 15;
      if (!s.hasPlacebo) score += 10;
      if (s.designations.fastTrack) score += 5;
      if (s.designations.breakthrough) score += 8;
      if (s.designations.orphan) score += 3;
      if (s.designations.hasExpandedAccess) score += 20;
      if (s.designations.hasOpenLabelExtension) score += 15;
      if (s.designations.hasPostTrialAccess) score += 6;
      score += s.topCenterScore || 0;
      const westernHit = (s.countries || []).some(c => WESTERN.has(c));
      const chinaHit = (s.countries || []).some(c => CHINA_LIKE.has(c));
      if (westernHit) score += 10;
      if (chinaHit) score -= 15;
      if (s.oversight?.oversightHasDMC) score += 4;
      s.promiseScore = score;
    });

    studies.sort((a, b) => (b.promiseScore || 0) - (a.promiseScore || 0));

    // Summary breakdowns so the UI can surface "we found 14 recruiting trials,
    // 3 expanded access programs, 2 open-label extensions, 8 at top centers".
    const breakdown = {
      total: studies.length,
      recruiting: studies.filter((s) => s.acceptingNewPatients).length,
      expandedAccess: studies.filter((s) => s.designations.hasExpandedAccess).length,
      openLabelExtension: studies.filter((s) => s.designations.hasOpenLabelExtension).length,
      payToAccess: studies.filter((s) => s.designations.hasPayToAccess).length,
      atTopCenter: studies.filter((s) => s.hasTopCenter).length,
      phases: {
        phase1: studies.filter((s) => (s.phases || []).join(',').includes('PHASE1')).length,
        phase2: studies.filter((s) => (s.phases || []).join(',').includes('PHASE2')).length,
        phase3: studies.filter((s) => (s.phases || []).join(',').includes('PHASE3')).length,
        phase4: studies.filter((s) => (s.phases || []).join(',').includes('PHASE4')).length
      }
    };

    return res.status(200).json({
      query: { condition, recruitingOnly, treatmentOnly, excludePlacebo, country },
      dossier: {
        canonical: dossier.canonical,
        synonyms: dossier.synonyms,
        meshTerms: dossier.meshTerms,
        subspecialty: dossier.subspecialty,
        uncertainty: dossier.uncertainty,
        cacheHit: dossier.cacheHit,
        generatedBy: dossier.generatedBy
      },
      subQueries: subQueryStats,
      breakdown,
      total: studies.length,
      returned: studies.length,
      studies
    });
  } catch (error) {
    console.error('trials.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
