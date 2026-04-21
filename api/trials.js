// Vercel Serverless Function for live ClinicalTrials.gov v2 API queries.
//
// Returns a structured list of trials relevant to a condition, enriched with
// every field that actually matters for a treatment decision:
//   - phase, recruiting status, accepting new patients
//   - placebo vs all-gets-drug (inferred from design + interventions)
//   - country / locations / contacts
//   - IRB / ethics approval, DSMB, FDA-regulated
//   - fast-track / orphan / breakthrough designation (from keywords)
//   - Expanded Access / Compassionate Use / Post-Trial Access / OLE signals
//   - treatment vs observational (only treatment by default)
//   - direct link to clinicaltrials.gov page
//
// Public API, no key required. Docs: https://clinicaltrials.gov/data-api/api

const CT_API = 'https://clinicaltrials.gov/api/v2/studies';

const FAST_TRACK_HINTS = ['fast track', 'fast-track'];
const BREAKTHROUGH_HINTS = ['breakthrough therapy', 'breakthrough designation'];
const ORPHAN_HINTS = ['orphan drug', 'orphan designation', 'orphan status'];
const EXPANDED_ACCESS_HINTS = ['expanded access', 'compassionate use'];
const PTA_HINTS = ['post-trial access', 'post trial access', 'continued access'];
const OLE_HINTS = ['open-label extension', 'open label extension', 'ole phase'];

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

const classifyTrial = (study) => {
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
  const phases = design.phases || [];
  const allocation = design.designInfo?.allocation;
  const masking = design.designInfo?.maskingInfo?.masking;
  const hasPlacebo = (arms.interventions || []).some(i =>
    i.type === 'OTHER' && /placebo/i.test(i.name || '')
  ) || /placebo/i.test(masking || '');

  const hasExpandedAccess =
    identification.expandedAccessInfo?.hasExpandedAccess === true ||
    containsAny(desc.detailedDescription, EXPANDED_ACCESS_HINTS) ||
    containsAny(desc.briefSummary, EXPANDED_ACCESS_HINTS);

  const hasPTA =
    containsAny(desc.detailedDescription, PTA_HINTS) ||
    containsAny(desc.briefSummary, PTA_HINTS);

  const hasOLE =
    containsAny(desc.detailedDescription, OLE_HINTS) ||
    containsAny(desc.briefSummary, OLE_HINTS) ||
    containsAny(briefTitle, OLE_HINTS) ||
    containsAny(officialTitle, OLE_HINTS);

  const fastTrack = containsAny(desc.detailedDescription, FAST_TRACK_HINTS) ||
                    containsAny(desc.briefSummary, FAST_TRACK_HINTS);
  const breakthrough = containsAny(desc.detailedDescription, BREAKTHROUGH_HINTS) ||
                       containsAny(desc.briefSummary, BREAKTHROUGH_HINTS);
  const orphan = containsAny(desc.detailedDescription, ORPHAN_HINTS) ||
                 containsAny(desc.briefSummary, ORPHAN_HINTS);

  const contacts = extractContacts(protocol.contactsLocationsModule);
  const countries = [...new Set(contacts.locations.map(l => l.country).filter(Boolean))];

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
      hasOpenLabelExtension: hasOLE
    },

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
      minAge,
      country
    } = body || {};

    if (!condition || !String(condition).trim()) {
      return res.status(400).json({ error: 'condition is required' });
    }

    const params = new URLSearchParams();
    params.set('query.cond', condition);
    params.set('pageSize', String(Math.min(Number(pageSize) || 50, 100)));
    params.set('format', 'json');
    params.set('countTotal', 'true');

    if (recruitingOnly) {
      params.set('filter.overallStatus', 'RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION');
    }

    const url = `${CT_API}?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: 'ClinicalTrials.gov request failed',
        status: response.status,
        body: text.slice(0, 1000)
      });
    }

    const data = await response.json();
    const rawStudies = data.studies || [];
    let studies = rawStudies.map(classifyTrial);

    if (treatmentOnly) {
      studies = studies.filter(s => s.isTreatmentStudy);
    }
    if (excludePlacebo) {
      studies = studies.filter(s => !s.hasPlacebo);
    }
    if (country) {
      const target = String(country).toLowerCase();
      studies = studies.filter(s =>
        (s.countries || []).some(c => String(c).toLowerCase().includes(target))
      );
    }

    // Promise-score heuristic: later phase + recruiting + no placebo + treatment + US/EU presence.
    const WESTERN = new Set([
      'United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Italy',
      'Spain', 'Netherlands', 'Sweden', 'Denmark', 'Norway', 'Finland', 'Belgium',
      'Switzerland', 'Ireland', 'Austria', 'Australia', 'New Zealand', 'Japan'
    ]);
    const CHINA_LIKE = new Set(['China', 'Vietnam', 'Mexico', 'India']);

    studies.forEach(s => {
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
      const westernHit = (s.countries || []).some(c => WESTERN.has(c));
      const chinaHit = (s.countries || []).some(c => CHINA_LIKE.has(c));
      if (westernHit) score += 10;
      if (chinaHit) score -= 15;
      if (s.oversight?.oversightHasDMC) score += 4;
      s.promiseScore = score;
    });

    studies.sort((a, b) => (b.promiseScore || 0) - (a.promiseScore || 0));

    return res.status(200).json({
      query: { condition, recruitingOnly, treatmentOnly, excludePlacebo, country },
      total: data.totalCount || rawStudies.length,
      returned: studies.length,
      studies
    });
  } catch (error) {
    console.error('trials.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
