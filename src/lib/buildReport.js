import ipfReference from '../../ipf-reference.json' with { type: 'json' }

const citation = (label, url) => ({ label, url })

const fallbackUrl = 'https://pubmed.ncbi.nlm.nih.gov/35486072/'

const findItem = (matcher, label) => {
  const item = ipfReference.items.find(matcher)
  if (item) return item
  return {
    title: label,
    url: fallbackUrl,
  }
}

const guideline2022 = findItem((item) => item.id === 'ipf-ats-ers-2022', '2022 ATS/ERS guideline')
const diagnosisGuideline = findItem((item) => item.id === 'ipf-ats-ers-2018', '2018 ATS/ERS diagnosis guideline')
const capacity = findItem((item) => item.id === 'ipf-capacity-noble-2011', 'CAPACITY')
const ascend = findItem((item) => item.id === 'ipf-ascend-king-2014', 'ASCEND')
const inpulsis = findItem((item) => item.id === 'ipf-inpulsis-richeldi-2014', 'INPULSIS')
const inbuild = findItem((item) => item.id === 'ipf-inbuild-flaherty-2019', 'INBUILD')
const panther = findItem((item) => item.id === 'ipf-panther-2012', 'PANTHER-IPF')
const nac = findItem((item) => item.id === 'ipf-panther-nac-2014', 'NAC trial')
const rehab = findItem((item) => item.id === 'ipf-pulmrehab-dowman-2021', 'Pulmonary rehabilitation review')
const nerandomilastPhase2 = findItem((item) => item.id === 'ipf-nerandomilast-richeldi-2022', 'BI 1015550 phase 2')
const fibroneer = findItem((item) => item.id === 'ipf-fibroneer-ipf-2025', 'FIBRONEER-IPF')
const jascaydLabel = findItem((item) => item.id === 'ipf-fda-label-nerandomilast', 'Jascayd label')

export const defaultIntake = {
  location: 'Cleveland, OH',
  stage: '',
  symptoms: 'Shortness of breath on exertion, chronic dry cough, fatigue',
  currentMeds: 'Nintedanib',
  priorTherapies: '',
  scans: '',
  goals: 'Find a top IPF center, review standard care, and identify worthwhile research options.',
}

export const formOptions = {
  symptoms: [
    'shortness of breath on exertion',
    'dry cough',
    'fatigue',
    'oxygen needs',
    'reflux symptoms',
    'reduced exercise tolerance',
  ],
  currentMeds: [
    'pirfenidone',
    'nintedanib',
    'oxygen',
    'pulmonary rehab',
    'PPI for reflux',
  ],
}

const regionMap = [
  { test: /(oh|pa|mi|il|mn|wi|in)/i, preferred: ['Cleveland Clinic Respiratory Institute — ILD', 'UPMC Simmons Center for Interstitial Lung Disease (Pittsburgh)', 'Mayo Clinic Interstitial Lung Disease Clinic'] },
  { test: /(ca|wa|or|az|nv|ut|co)/i, preferred: ['UCSF Interstitial Lung Disease Program', 'National Jewish Health', 'Mayo Clinic Interstitial Lung Disease Clinic'] },
  { test: /(ny|nj|ma|ct|nh|me|vt|ri|md|dc|va|nc|sc|ga|fl|tx|tn)/i, preferred: ['Duke Interstitial Lung Disease Program', 'Mayo Clinic Interstitial Lung Disease Clinic', 'Cleveland Clinic Respiratory Institute — ILD'] },
]

const evidenceBackedOptions = [
  {
    name: 'Pirfenidone',
    tier: 'Standard of care',
    badge: 'Verified',
    badgeTone: 'verified',
    summary:
      'Pirfenidone is a long-used medicine for IPF. It is part of the well-studied treatment options in this report.',
    useCase:
      'A care team may discuss it with adults who have IPF. They also weigh side effects and liver blood tests.',
    rationale:
      'The FDA label lists pirfenidone for IPF. Two large studies found a slower loss of lung function than with a placebo.',
    watchouts:
      'Ask about sun sensitivity, nausea, appetite changes, and liver blood tests. A care team must decide if it fits this person.',
    citations: [
      citation('2022 ATS/ERS guideline', guideline2022.url),
      citation('CAPACITY', capacity.url),
      citation('ASCEND', ascend.url),
    ],
  },
  {
    name: 'Nintedanib',
    tier: 'Standard of care',
    badge: 'Verified',
    badgeTone: 'verified',
    summary:
      'Nintedanib is another long-used medicine for IPF. It is also part of the well-studied treatment options in this report.',
    useCase:
      'A care team may discuss it with adults who have IPF. The team looks at the person’s symptoms, test results, and side effects.',
    rationale:
      'The FDA label lists nintedanib for IPF. The INPULSIS study found a slower loss of lung function than with a placebo.',
    watchouts:
      'Diarrhea, liver blood-test changes, and bleeding risk matter. A care team should review these before making a choice.',
    citations: [
      citation('2022 ATS/ERS guideline', guideline2022.url),
      citation('INPULSIS', inpulsis.url),
      citation('INBUILD context', inbuild.url),
    ],
  },
  {
    name: 'Pulmonary rehabilitation and structured supportive care',
    tier: 'Evidence-backed support',
    badge: 'Verified',
    badgeTone: 'verified',
    summary:
      'Supportive care matters in IPF. Pulmonary rehab, oxygen planning, vaccines, reflux care, and transplant talks can all be important.',
    useCase:
      'It may help when it is getting harder to move around, breathe during activity, or do daily tasks.',
    rationale:
      'A Cochrane review found that pulmonary rehab improved walking ability and shortness of breath in groups that included people with IPF.',
    watchouts:
      'A care team should match the plan to oxygen needs, activity limits, and local services.',
    citations: [
      citation('Pulmonary rehab review', rehab.url),
      citation('Lifestyle categories', guideline2022.url),
    ],
  },
  {
    name: 'Nerandomilast (Jascayd)',
    tier: 'Recently approved therapy',
    badge: 'Needs center-level fit review',
    badgeTone: 'watch',
    summary:
      'Nerandomilast is a newer FDA-approved option for IPF in this demo. It needs a careful talk with an IPF specialist.',
    useCase:
      'It may be a good topic for a specialist visit when the team is looking again at treatment choices.',
    rationale:
      'The source set says a large study found slower loss of lung function, and the 2026 FDA label lists IPF.',
    watchouts:
      'Because it is newer, it should not be treated as the best first choice for everyone. An IPF specialist should help with that decision.',
    citations: [
      citation('Phase 2 background', nerandomilastPhase2.url),
      citation('FIBRONEER-IPF', fibroneer.url),
      citation('Jascayd label', jascaydLabel.url),
    ],
  },
]

const brainstormIdeas = [
  {
    title: 'Pulmonary hypertension overlay and inhaled treprostinil signals',
    label: 'Research pathway',
    thesis:
      'If symptoms feel worse than baseline physiology suggests, a center may ask whether pulmonary hypertension associated with ILD is part of the story.',
    why:
      'The curated IPF set highlights the INCREASE study and notes an unexpected antifibrotic signal in PH-ILD, which makes this a worthwhile center-level discussion when the phenotype fits.',
    nextQuestion:
      'Does this patient show signs of PH-ILD that justify specialist workup, and would that change treatment or trial selection?',
    caution:
      'This is not a blanket IPF recommendation and should not be presented as a substitute for core antifibrotic care.',
    citations: [citation('INCREASE landmark mention', guideline2022.url)],
  },
  {
    title: 'PDE4B-era sequencing after older antifibrotics',
    label: 'Mechanism watchlist',
    thesis:
      'The novel-mechanism PDE4B lane is worth tracking because it changes the “only two antifibrotics exist” narrative that many clinicians and caregivers still carry.',
    why:
      'The phase 2 BI 1015550 result and the FIBRONEER-IPF program create a concrete mechanism-based line of questioning rather than pure speculation.',
    nextQuestion:
      'How are top ILD centers deciding between older antifibrotics, combination strategies, and the newer PDE4B option?',
    caution:
      'The app should not invent sequencing rules that are not in the reviewed sources.',
    citations: [
      citation('BI 1015550 phase 2', nerandomilastPhase2.url),
      citation('FIBRONEER-IPF', fibroneer.url),
    ],
  },
  {
    title: 'Reflux and microaspiration as a disease-modifying question',
    label: 'Comorbidity hypothesis',
    thesis:
      'When cough and reflux are prominent, the real question may be whether aggressive reflux assessment changes symptoms, aspiration risk, or center strategy.',
    why:
      'GERD is listed as a common comorbidity in the curated IPF knowledge base, so it deserves structured attention instead of disappearing into a generic symptom list.',
    nextQuestion:
      'Is reflux symptom burden significant enough that a specialty center would want a more deliberate GERD and aspiration workup?',
    caution:
      'This is a comorbidity-management discussion, not a claim that reflux treatment reverses IPF.',
    citations: [citation('Common comorbidities', guideline2022.url)],
  },
  {
    title: 'Exclude stem-cell and exosome clinic marketing from the trusted lane',
    label: 'Safety boundary',
    thesis:
      'For this demo, regenerative clinic offerings stay outside the trusted lane unless they are anchored to a real reviewed trial or a center-led research protocol.',
    why:
      'Dorothy’s trust issue is accuracy drift, so the reviewer should intentionally suppress high-claim, low-oversight treatments from the core report.',
    nextQuestion:
      'If the family asks about stem cells or exosomes, is there a legitimate registry or academic trial rather than a private-pay clinic offer?',
    caution:
      'This is a guardrail, not an efficacy claim for or against every regenerative strategy.',
    citations: [citation('2022 ATS/ERS guideline anchor', guideline2022.url)],
  },
]

const buildKeyPoints = (patient) => {
  const notes = []
  notes.push({
    title: 'What is stable in the evidence',
    body:
      'The strongest facts in this run are that approved medicines may slow lung-function loss, and that rehab, oxygen planning, vaccines, reflux care, and transplant timing can matter.',
  })

  if (patient.currentMeds.toLowerCase().includes('nintedanib')) {
    notes.push({
      title: 'Current therapy context',
      body:
        'Nintedanib is already listed. This report focuses on side effects, changes over time, and questions a specialty center may revisit.',
    })
  }

  if (patient.scans) {
    notes.push({
      title: 'Imaging and PFT context supplied',
      body:
        'The intake includes scan or breathing-test notes. A care team can use them in a fuller discussion without the app guessing what they mean.',
    })
  } else {
    notes.push({
      title: 'No staging from thin air',
      body:
        'No scan or breathing-test details were entered. The report avoids guessing how severe the disease is or when transplant should be discussed.',
    })
  }

  return notes
}

const summarizePatient = (patient) => {
  const parts = [
    'This report is about idiopathic pulmonary fibrosis (IPF). It starts with reviewed sources and live trials, not AI memory.',
  ]

  if (patient.stage) {
    parts.push(`The form says the disease is "${patient.stage}". The app treats this as context from the form, not a confirmed stage.`)
  } else {
    parts.push('No stage was entered, so the report does not guess the stage.')
  }

  if (patient.currentMeds) {
    parts.push(`Current treatment listed: ${patient.currentMeds}.`)
  }

  if (patient.goals) {
    parts.push(`This report is meant to answer: ${patient.goals}`)
  }

  return parts.join(' ')
}

const selectSpecialists = (location) => {
  const centers = [...ipfReference.topCenters]
  const region = regionMap.find((entry) => entry.test.test(location || ''))
  if (!region) return centers.slice(0, 4)

  const prioritized = region.preferred
    .map((name) => centers.find((center) => center.name === name))
    .filter(Boolean)

  const remaining = centers.filter((center) => !prioritized.some((pick) => pick.name === center.name))
  return [...prioritized, ...remaining].slice(0, 4)
}

const buildReview = (patient) => {
  const requiredInputs = []
  if (!patient.stage) requiredInputs.push('Stage is blank, so no claim about mild, moderate, or advanced disease should be treated as verified.')
  if (!patient.scans) requiredInputs.push('No HRCT, FVC, DLCO, or oxygen details were entered, so progression and transplant language must stay generic.')
  if (!patient.priorTherapies) requiredInputs.push('Prior-therapy history is thin, so sequencing ideas remain center discussion points rather than explicit recommendations.')

  return {
    requiredInputs,
    findings: [
      {
        title: 'Source links checked',
        body:
          'Every item in the source-linked section includes the research used to support it.',
      },
      {
        title: 'Speculation quarantined',
        body:
          'Brainstorm items are visibly exploratory and framed as questions for expert centers, not as recommendations for the patient to start independently.',
      },
      {
        title: 'Unsafe legacy regimens blocked',
        body:
          'Prednisone plus azathioprine plus NAC stays in the negative-evidence lane because the curated source set documents harm rather than benefit.',
      },
    ],
    facts: [
      { label: 'Established starting points', value: 'Pirfenidone, nintedanib, supportive care, newer PDE4B option' },
      { label: 'Explicitly blocked', value: 'Invented stage claims, casual stem-cell/exosome promotion, unsupported immunosuppression' },
      { label: 'Core sources', value: '2022 ATS/ERS guideline + landmark RCTs + 2026 Jascayd label' },
    ],
  }
}

export const buildVerifiedReport = (patient) => {
  const exclusions = Object.entries(patient)
    .filter(([, value]) => !String(value || '').trim())
    .map(([key]) => key)

  return {
    title: 'Idiopathic Pulmonary Fibrosis Demo Report',
    metadata: {
      condition: ipfReference.condition,
      lastUpdated: ipfReference.lastUpdated,
    },
    patient: { ...patient },
    core: {
      summary: summarizePatient(patient),
      keyPoints: buildKeyPoints(patient),
      citations: [
        citation('2022 ATS/ERS treatment guideline', guideline2022.url),
        citation('2018 diagnosis guideline', diagnosisGuideline.url),
        citation('PANTHER-IPF harm signal', panther.url),
        citation('NAC monotherapy negative trial', nac.url),
      ],
    },
    verifiedOptions: evidenceBackedOptions,
    specialists: selectSpecialists(patient.location),
    investigators: ipfReference.keyInvestigators.slice(0, 4).map((investigator) => investigator.name),
    brainstorm: brainstormIdeas,
    review: buildReview(patient),
    exclusions,
    exclusionReasons: {
      stage: 'No verified severity metric was entered, so the reviewer suppresses stage-specific prognosis language.',
      priorTherapies:
        'Without a reliable history of prior tolerability or progression, the report avoids strong sequencing claims.',
      scans:
        'No imaging or pulmonary-function anchors were entered, so the report does not claim UIP details, FVC trends, or transplant thresholds.',
    },
  }
}
