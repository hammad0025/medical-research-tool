import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  buildVerifiedReport,
  defaultIntake,
  formOptions,
} from './lib/buildReport.js'
import { findDirectIdentifier, findProfilePrivacyIssue, privacyIssueMessage } from './lib/privacy.js'
import { createPdfDocument, createWordDocument, downloadExport, reportFilename } from './lib/reportExports.js'
import { extractResearchIntake, getResearchHealth, getSiteAccessStatus, loginSiteAccess, logoutSiteAccess, runResearchReview } from './lib/researchApi.js'
import { citationText, citationsFor, citationsForClaim, sourceLabel, verificationLinks } from './lib/sourceLinks.js'
import { buildLifestyleFallbackTopics } from './lib/lifestyleFallback.js'

const conditions = [
  { value: 'Idiopathic Pulmonary Fibrosis', label: 'IPF' },
  { value: "Crohn's Disease", label: "Crohn's" },
  { value: 'Multiple Sclerosis', label: 'MS' },
  { value: 'LADA', label: 'LADA' },
  { value: 'Retinitis Pigmentosa', label: 'RP' },
  { value: 'Huntington Disease', label: 'Huntington' },
]

const createInitialProfile = (overrides = {}) => ({
  ...defaultIntake,
  condition: '',
  location: '',
  stage: '',
  symptoms: '',
  currentMeds: '',
  priorTherapies: '',
  scans: '',
  goals: '',
  age: '',
  gender: '',
  weight: '',
  smoking: '',
  activity: '',
  diagnoses: '',
  allergies: '',
  geneticVariant: '',
  ...overrides,
})

const demoProfiles = [
  {
    id: 'ipf-moderate',
    label: 'IPF - moderate',
    tag: 'IPF',
    profile: createInitialProfile({
      condition: 'Idiopathic Pulmonary Fibrosis',
      stage: 'Moderate',
      currentMeds: 'Nintedanib',
      symptoms: 'Shortness of breath on exertion, dry cough, fatigue',
      goals: 'Review source-linked evidence, active trials, and specialty-center discussion points.',
    }),
  },
  {
    id: 'ipf-advanced',
    label: 'IPF - advanced',
    tag: 'IPF',
    profile: createInitialProfile({
      condition: 'Idiopathic Pulmonary Fibrosis',
      stage: 'Advanced',
      currentMeds: 'Pirfenidone, supplemental oxygen',
      symptoms: 'Breathlessness with minimal activity, dry cough, fatigue',
      goals: 'Map current evidence, recruiting studies, and questions for an ILD center.',
    }),
  },
  {
    id: 'rp-ush2a',
    label: 'Retinitis pigmentosa - USH2A',
    tag: 'RP',
    profile: createInitialProfile({
      condition: 'Retinitis Pigmentosa - USH2A',
      geneticVariant: 'USH2A',
      symptoms: 'Progressive night-vision difficulty and peripheral-vision loss',
      goals: 'Find source-linked research, active trials, and questions for an inherited-retinal-disease center.',
    }),
  },
  {
    id: 'lada-caregiver',
    label: 'LADA - caregiver demo',
    tag: 'LADA',
    profile: createInitialProfile({
      condition: 'LADA',
      currentMeds: 'Insulin',
      symptoms: 'Fatigue',
      goals: 'Review evidence, research questions, and recruiting trials for LADA.',
    }),
  },
]

const baselinePipeline = [
  { id: 'curated', label: 'Curated evidence packet', status: 'passed', detail: 'Pinned IPF sources, not model memory.' },
  { id: 'trials', label: 'Live trials registry', status: 'ready', detail: 'Fetched only when a report is run.' },
  { id: 'writer', label: 'AI research writer', status: 'ready', detail: 'Can draft only against the source packet.' },
  { id: 'reviewer', label: 'Second source-check pass', status: 'ready', detail: 'A separate AI pass is used when configured; it is independent only when a different provider checks the draft.' },
]

const searchTermsFor = (result) => Array.isArray(result?.exploration?.searchTerms) ? result.exploration.searchTerms : []

const displayConditionName = (condition) => {
  const value = String(condition || '').trim()
  if (/^parkinson(?:'s|s)?(?:\s+disease)?$/i.test(value)) return "Parkinson's Disease"
  return value
}

const claimCitations = (result, item, condition, { verifyWhenEmpty = false } = {}) => {
  const trialCitations = Array.isArray(item?.trials) ? item.trials.filter((trial) => trial?.url) : []
  if (trialCitations.length) return trialCitations
  return citationsForClaim({
    result,
    sourceIds: item?.sourceIds,
    condition,
    searchTerms: searchTermsFor(result),
    verifyWhenEmpty,
  })
}

const FDA_EXPANDED_ACCESS_SOURCE = {
  id: 'fda-expanded-access-patients',
  title: 'FDA expanded access information for patients',
  url: 'https://www.fda.gov/news-events/expanded-access/expanded-access-information-patients',
  origin: 'U.S. Food and Drug Administration',
}

const isDisplayableTrialIntervention = (title) => !/^(?:arm|group|cohort)\s*(?:\d+|[a-z])$|^(?:placebo|sham|no intervention|standard(?: care| treatment)?|usual(?: care| treatment)?|routine(?: care| treatment)?|supportive care|observation(?:al)?)(?:\b|:)|\b(?:blood (?:test|draw|sample)|biomarker|imaging|scan|mri|pet|diagnostic|diagnosis|screening|assessment|questionnaire|survey|monitoring|registry|observation)\b|\b(?:clinical|sham)\s+(?:dbs\s+)?(?:setting|configuration|programming)\b|\bimmunosuppressive regimen\b|\bcustomized microinjection device\b/i.test(title)

const treatmentInterventionTypes = new Set([
  'DRUG',
  'BIOLOGICAL',
  'COMBINATION_PRODUCT',
  'DIETARY_SUPPLEMENT',
  'GENETIC',
  'DEVICE',
  'PROCEDURE',
  'RADIATION',
])

const treatmentCategoryForType = (type) => ({
  GENETIC: 'Gene therapy research',
  BIOLOGICAL: 'Biologic or cell research',
  DRUG: 'Drug research',
  COMBINATION_PRODUCT: 'Combination research',
  DIETARY_SUPPLEMENT: 'Supplement research',
  DEVICE: 'Device research',
  PROCEDURE: 'Procedure research',
  RADIATION: 'Procedure research',
}[String(type || '').toUpperCase()] || 'Treatment research')

const cleanTreatmentDisplayName = (title) => String(title || '')
  .replace(/^(?:drug|biological|combination product|dietary supplement|genetic|device|procedure|radiation):\s*/i, '')
  .replace(/\s*\((?:high|low|intermediate|selected) dose(?: and standard corticosteroid regimen)?\)/ig, '')
  .replace(/\b(?:low|high|intermediate|selected)\s+dose\b/ig, '')
  .replace(/\b(?:standard|modified)\s+corticosteroid regimen\b/ig, '')
  .replace(/-\s+/g, '-')
  .replace(/\s{2,}/g, ' ')
  .replace(/[;,\s]+$/, '')
  .trim()

const treatmentInterventionsForTrial = (trial) => {
  if (trial?.conditionMatch === 'broad') return []
  const details = Array.isArray(trial?.interventionDetails) ? trial.interventionDetails : []
  if (details.length) {
    return details
      .filter((entry) => treatmentInterventionTypes.has(String(entry?.type || '').toUpperCase()))
      .map((entry) => ({ title: entry?.name, type: String(entry?.type || '').toUpperCase() }))
  }

  return (Array.isArray(trial?.interventions) ? trial.interventions : [trial?.interventions])
    .map((title) => ({ title, type: '' }))
}

const trialStatusPriority = (status) => ({
  RECRUITING: 5,
  ENROLLING_BY_INVITATION: 4,
  ACTIVE_NOT_RECRUITING: 3,
  NOT_YET_RECRUITING: 2,
}[String(status || '').toUpperCase()] || 1)

const treatmentTypePriority = (type) => {
  if (type === 'GENETIC') return 6
  if (type === 'BIOLOGICAL') return 5
  if (['DRUG', 'COMBINATION_PRODUCT'].includes(type)) return 4
  if (['DEVICE', 'PROCEDURE', 'RADIATION'].includes(type)) return 3
  if (type === 'DIETARY_SUPPLEMENT') return 1
  return 2
}

const trialInterventionIdeas = (trials, condition) => {
  const byIntervention = new Map()
  const conditionLabel = String(condition || 'this condition').trim() || 'this condition'
  let appearanceOrder = 0

  for (const trial of trials || []) {
    const interventions = treatmentInterventionsForTrial(trial)

    for (const intervention of interventions) {
      const title = cleanTreatmentDisplayName(intervention?.title)
      if (title.length < 2 || !isDisplayableTrialIntervention(title)) continue

      const key = treatmentIdeaKey(title) || title.toLocaleLowerCase()
      const priority = treatmentTypePriority(intervention?.type) * 10 + trialStatusPriority(trial?.status)
      const idea = byIntervention.get(key) || {
        title,
        category: treatmentCategoryForType(intervention?.type),
        type: String(intervention?.type || '').toUpperCase(),
        trials: [],
        priority,
        appearanceOrder: appearanceOrder++,
      }
      idea.priority = Math.max(idea.priority, priority)
      if (!idea.trials.some((source) => source.id === trial.id)) idea.trials.push(trial)
      byIntervention.set(key, idea)
    }
  }

  return [...byIntervention.values()]
    .sort((left, right) => right.priority - left.priority || right.trials.length - left.trials.length || left.appearanceOrder - right.appearanceOrder)
    .slice(0, 12)
    .map((idea) => {
      const studyCount = idea.trials.length
      const studyLabel = studyCount === 1 ? 'study' : 'studies'
      const caution = idea.trials.map((trial) => trial.caution).find(Boolean)
      return {
        ...idea,
        title: cleanTreatmentDisplayName(idea.title),
        rationale: `This treatment is in ${studyCount} current ${studyLabel} for ${conditionLabel}.`,
        boundary: caution || 'A study listing only shows that researchers are testing it. It does not show that it works, is safe, or is right for this person.',
        requiresExtraReview: Boolean(caution),
      }
    })
}

const treatmentIdeaKey = (title) => String(title || '')
  .toLowerCase()
  .replace(/^(?:drug|biological|combination product|dietary supplement|genetic|device|procedure|radiation):\s*/g, '')
  .replace(/\b(?:dietary\s+)?supplement(?:ation)?\b/g, '')
  .replace(/\b(?:low|high|intermediate|selected)\s+dose\b/g, '')
  .replace(/\b(?:standard|modified)\s+corticosteroid regimen\b/g, '')
  .replace(/\bgene therapy\b/g, '')
  .replace(/\b(?:hydrochloride|dihydrochloride|tartrate|mesylate|sodium|tablets?|capsules?|extended[- ]release)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

const researchGeneFromText = (text) => {
  const matches = [
    text.match(/\b([A-Z][A-Z0-9-]{2,12})[- ]associated\b/),
    text.match(/\b(?:mutation|variant|variants?)\s+(?:in|of)\s+([A-Z][A-Z0-9-]{2,12})\b/i),
    text.match(/\b(?:caused by|due to)\s+(?:a\s+)?(?:mutation|variant)\s+(?:in\s+)?([A-Z][A-Z0-9-]{2,12})\b/i),
  ]
  return matches.map((match) => match?.[1]).find(Boolean) || ''
}

const sourceTreatmentCandidates = (source) => {
  const text = `${source?.title || ''} ${source?.summary || ''}`
  const candidates = []
  const add = (title, category) => {
    const cleanTitle = cleanTreatmentDisplayName(title)
    if (!cleanTitle || !isDisplayableTrialIntervention(cleanTitle)) return
    if (!candidates.some((candidate) => treatmentIdeaKey(candidate.title) === treatmentIdeaKey(cleanTitle))) {
      candidates.push({ title: cleanTitle, category })
    }
  }
  const gene = researchGeneFromText(text)
  const aav = text.match(/\b(?:r?AAV[\w.-]+)(?:\s*\([^)]{2,90}\))?/i)?.[0]

  for (const candidate of source?.candidateLeads || []) {
    const category = String(candidate?.category || '').toLowerCase()
    const displayCategory = /supplement|food|nutrition/i.test(category)
      ? 'Supplement or food research'
      : /medicine|drug|repurpos/i.test(category)
        ? 'Medicine research'
        : /procedure|device/i.test(category)
          ? 'Procedure or device research'
          : /gene|cell|rna|biologic/i.test(category)
            ? 'Gene or cell research'
            : 'Treatment research'
    add(candidate?.name, displayCategory)
  }

  if (aav) add(aav, 'Gene therapy research')
  if (/\bantisense oligonucleotide\b/i.test(text)) add(gene ? `${gene} antisense oligonucleotide` : 'Antisense oligonucleotide', 'RNA treatment research')
  if (/\b(?:gene therapy|gene editing)\b/i.test(text)) add(gene ? `${gene} gene therapy` : 'Gene therapy', 'Gene therapy research')
  if (/\boptogenetic/i.test(text)) add('Optogenetic therapy', 'Gene or device research')
  if (/\b(?:stem cell|cell therapy|extracellular vesicle|exosome)\b/i.test(text)) add('Cell or extracellular-vesicle research', 'Cell or exosome research')
  if (/\bN-?acetylcysteine\b|\bNAC\b/i.test(text)) add('N-acetylcysteine', 'Drug research')
  if (/\bcataract surgery\b/i.test(text)) add('Cataract surgery', 'Procedure research')
  if (/\b(?:retinal implant|retinal prosthe)\b/i.test(text)) add('Retinal implant research', 'Device research')
  if (/\b(?:micropulse|laser)\b/i.test(text)) add('Laser treatment research', 'Procedure research')
  if (/\bvitamin\s+A\b/i.test(text)) add('Vitamin A', 'Supplement research')
  if (/\b(?:fish oil|omega[- ]?3)\b/i.test(text)) add('Fish oil or omega-3', 'Supplement research')

  return candidates
}

const isArticleTitleLike = (title) => /\b(?:systematic review|meta-analysis|safety and efficacy|phase\s*\d|a study comparing|clinical trial|review of)\b/i.test(String(title || ''))
const isSupplementIdea = (idea) => /supplement|food|vitamin|fish oil|omega[- ]?3|dietary/i.test(`${idea?.category || ''} ${idea?.title || ''}`)
const looksLikeAdvancedResearch = (idea) => /gene|rna|cell|biologic|radiation|optogenetic|implant|exosome|stem/i.test(`${idea?.category || ''} ${idea?.type || ''} ${idea?.title || ''}`)

const sourceTreatmentIdeas = (sources, condition) => {
  const ideas = []
  const used = new Set()
  for (const source of sources || []) {
    if (!source?.id || isOfficialLabelSource(source)) continue
    for (const candidate of sourceTreatmentCandidates(source)) {
      const key = treatmentIdeaKey(candidate.title)
      if (!key || used.has(key)) continue
      used.add(key)
      ideas.push({
        title: candidate.title,
        category: candidate.category,
        summary: `This source discusses ${candidate.title} in research on ${condition || 'this condition'}.`,
        whyItMayMatter: 'Open the source to check the study group, subtype, and results.',
        caution: 'A research article is not proof that a treatment works or is right for one person. Review the full source with a clinician.',
        sourceIds: [source.id],
        kind: 'source',
      })
      if (ideas.length === 10) return ideas
    }
  }
  return ideas
}

const isOfficialLabelSource = (source) => source?.origin === 'openFDA'
  || source?.origin === 'U.S. Food and Drug Administration'
  || /FDA (?:drug label|approval record)/i.test(source?.type || '')

const plainOfficialLabelSummary = (source, title, conditionLabel) => {
  const normalizeForMatch = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const labelText = normalizeForMatch(source?.summary)
  const conditionText = normalizeForMatch(conditionLabel)
  const directlyTreatsCondition = conditionText && (
    labelText.includes(`treatment of ${conditionText}`)
    || labelText.includes(`treatment for ${conditionText}`)
  )

  return directlyTreatsCondition
    ? `This official U.S. label lists ${title} for treatment of ${conditionLabel}. Open the full label for the exact approved use and limits.`
    : `This official U.S. label mentions ${conditionLabel}. Open the full label for the exact approved use, symptom, or diagnosis it covers.`
}

const officialLabelIdeasForReport = (result, condition) => {
  const seen = new Set()
  const conditionLabel = displayConditionName(condition) || 'this condition'
  return (result?.sources || [])
    .filter(isOfficialLabelSource)
    .map((source) => {
      const title = cleanTreatmentDisplayName(sourceLabel(source).replace(/^FDA (?:label|approval):\s*/i, ''))
      const key = treatmentIdeaKey(title)
      if (!key || seen.has(key) || /^drug product$/i.test(title)) return null
      seen.add(key)
      return {
        title,
        category: source.approvalScope === 'subtype' ? 'Official U.S. approval for a subtype' : 'Official U.S. label',
        summary: source.approvalScope ? source.summary : plainOfficialLabelSummary(source, title, conditionLabel),
        caution: source.caution || 'A label applies to a specific diagnosis and situation. A clinician must decide whether it applies here.',
        sourceIds: [source.id],
        kind: 'fda',
      }
    })
    .filter(Boolean)
    .slice(0, 8)
}

const allTreatmentIdeasForReport = (result, condition) => {
  const sourceById = new Map((result?.sources || []).map((source) => [source.id, source]))
  const sourcedIdeas = (Array.isArray(result?.review?.treatmentIdeas) ? result.review.treatmentIdeas : [])
    .filter((idea) => !(idea?.sourceIds || []).some((sourceId) => isOfficialLabelSource(sourceById.get(sourceId))))
  const treatmentIdeas = []
  const treatmentKeys = new Set()

  for (const idea of sourcedIdeas) {
    const key = treatmentIdeaKey(idea?.title)
    if (!key || treatmentKeys.has(key) || isArticleTitleLike(idea?.title)) continue
    treatmentKeys.add(key)
    treatmentIdeas.push({ ...idea, title: cleanTreatmentDisplayName(idea.title), kind: 'source' })
  }
  for (const idea of trialInterventionIdeas(result?.trials, condition).slice(0, 10)) {
    const key = treatmentIdeaKey(idea?.title)
    if (!key || treatmentKeys.has(key)) continue
    treatmentKeys.add(key)
    treatmentIdeas.push({ ...idea, kind: 'trial' })
  }
  for (const trial of result?.trials || []) {
    const candidates = sourceTreatmentCandidates({
      title: trial?.title,
      summary: `${trial?.summary || ''} ${(trial?.interventions || []).join(' ')}`,
      candidateLeads: trial?.candidateLeads,
    })
    for (const candidate of candidates) {
      const key = treatmentIdeaKey(candidate.title)
      if (!key || treatmentKeys.has(key)) continue
      treatmentKeys.add(key)
      treatmentIdeas.push({
        ...candidate,
        trials: [trial],
        rationale: `This named research approach appears in a current study for ${condition || 'this condition'}.`,
        boundary: trial.caution || 'A study listing only shows that researchers are testing it. It does not show that it works, is safe, or is right for this person.',
        requiresExtraReview: Boolean(trial.caution),
        kind: 'trial',
      })
    }
  }
  for (const idea of sourceTreatmentIdeas(result?.sources, condition)) {
    const key = treatmentIdeaKey(idea?.title)
    if (!key || treatmentKeys.has(key)) continue
    treatmentKeys.add(key)
    treatmentIdeas.push(idea)
  }
  const practicalityScore = (idea) => {
    let score = idea.kind === 'source' ? 80 : 0
    if (!looksLikeAdvancedResearch(idea)) score += 40
    if (isSupplementIdea(idea)) score += 8
    if (idea.kind === 'trial') score -= 18
    return score
  }

  return treatmentIdeas
    .sort((left, right) => practicalityScore(right) - practicalityScore(left))
    .slice(0, 20)
}

const uniqueIdeas = (ideas, limit = 10) => {
  const used = new Set()
  return (ideas || []).filter((idea) => {
    const key = `${idea?.title || ''}|${idea?.verificationQuery || ''}`.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key || used.has(key)) return false
    used.add(key)
    return true
  }).slice(0, limit)
}

const explorationTheoryIdeas = (result, condition) => (Array.isArray(result?.exploration?.treatmentPaths) ? result.exploration.treatmentPaths : [])
  .map((idea) => ({
    title: idea.title,
    category: 'AI theory to verify',
    whyItCouldConnect: idea.whyItMayMatter || idea.summary,
    whyNotEstablished: `This starting map did not find a source-backed treatment lead for ${condition || 'this condition'}.`,
    caution: idea.caution || 'This is an AI theory to verify, not a personal treatment recommendation.',
    verificationQuery: `${condition || 'this condition'} ${idea.title}`,
    sourceIds: [],
    kind: 'exploration',
  }))
  .filter((idea) => idea.title && idea.whyItCouldConnect && idea.caution)

const theoryIdeasForReport = (result, condition) => {
  const reviewedIdeas = Array.isArray(result?.review?.theoryIdeas) ? result.review.theoryIdeas : []
  return reviewedIdeas.length
    ? uniqueIdeas(reviewedIdeas.map((idea) => ({ ...idea, kind: idea.kind || 'theory' })), 10)
    : uniqueIdeas(explorationTheoryIdeas(result, condition), 10)
}

const theoryVerificationLinks = (condition, idea) => verificationLinks({
  condition,
  searchTerms: [idea?.verificationQuery || `${condition || 'this condition'} ${idea?.title || 'research'}`],
})

const lifestyleVerificationLinks = (condition, item) => verificationLinks({
  condition,
  searchTerms: [item?.verificationQuery || `${condition || 'this condition'} daily life support`],
})

const lifestyleSourceMatchers = [
  { title: 'Rehabilitation and activity', pattern: /pulmonary rehabilitation|physical therapy|exercise training|exercise program|vision rehabilitation|occupational therapy/i },
  { title: 'Tobacco and smoke exposure', pattern: /smoking cessation|tobacco|secondhand smoke|smoke exposure/i },
  { title: 'Food and nutrition', pattern: /\b(?:diet|nutrition|nutritional|dietary)\b/i },
  { title: 'Sleep and daily routine', pattern: /\b(?:sleep|insomnia|circadian)\b/i },
  { title: 'Environmental exposures', pattern: /\b(?:environmental|occupational|air pollution|sun exposure|ultraviolet)\b/i },
  { title: 'Daily-life support', pattern: /\b(?:quality of life|low vision|daily living|activities of daily living)\b/i },
]

const plainLifestyleFallbackSummary = (title) => ({
  'Rehabilitation and activity': 'This source looks at rehabilitation or activity programs for people with this condition.',
  'Tobacco and smoke exposure': 'This source discusses tobacco or smoke exposure in people with this condition.',
  'Food and nutrition': 'This source discusses food or nutrition in people with this condition.',
  'Sleep and daily routine': 'This source discusses sleep or daily routine in people with this condition.',
  'Environmental exposures': 'This source discusses environmental exposures that may matter for this condition.',
  'Daily-life support': 'This source looks at a day-to-day support topic for people living with this condition.',
}[title] || 'This source discusses a daily-life topic that may matter for this condition.')

const usableLifestyleIdea = (item) => item?.title && item?.summary && item?.caution

const lifestyleIdeasForReport = (result, condition) => {
  const reviewedIdeas = (Array.isArray(result?.review?.lifestyle) ? result.review.lifestyle : [])
    .filter(usableLifestyleIdea)
  const sourceFallbackIdeas = []
  const usedTopics = new Set()
  for (const source of result?.sources || []) {
    const sourceText = `${source?.title || ''} ${source?.summary || ''}`
    const match = lifestyleSourceMatchers.find((entry) => entry.pattern.test(sourceText))
    if (!match || usedTopics.has(match.title) || !source?.id) continue
    usedTopics.add(match.title)
    sourceFallbackIdeas.push({
      title: match.title,
      summary: plainLifestyleFallbackSummary(match.title),
      caution: 'This is a research finding in groups, not a personal plan. Discuss whether it fits the person’s condition and safety needs with a clinician.',
      sourceIds: [source.id],
      sourceLinkedFallback: true,
    })
    if (sourceFallbackIdeas.length === 5) break
  }

  const explorationIdeas = (Array.isArray(result?.exploration?.lifestyle) ? result.exploration.lifestyle : [])
    .map((item) => ({ ...item, sourceIds: [], needsVerification: true }))
    .filter(usableLifestyleIdea)
  const primaryIdeas = reviewedIdeas.length ? reviewedIdeas : sourceFallbackIdeas.length ? sourceFallbackIdeas : explorationIdeas
  const usedTitles = new Set(primaryIdeas.map((item) => String(item.title).toLowerCase()))

  if (primaryIdeas.length >= 4) return primaryIdeas.slice(0, 5)

  const topUpIdeas = buildLifestyleFallbackTopics(condition)
    .filter((item) => !usedTitles.has(String(item.title).toLowerCase()))
    .slice(0, Math.max(0, 5 - primaryIdeas.length))

  return [...primaryIdeas, ...topUpIdeas].slice(0, 5)
}

const safetySourceMatchers = [
  { title: 'Treatment safety needs specialist review', pattern: /\b(?:safety|harm|adverse|serious|warning|caution|contraindic|toxic|unsafe)\b/i },
  { title: 'Investigational cell or exosome therapies', pattern: /\b(?:stem cell|exosome|extracellular vesicle|regenerative)\b/i },
  { title: 'Potential interaction or monitoring concern', pattern: /\b(?:interaction|monitoring|liver|kidney|pregnan|bleeding|infection)\b/i },
]

const plainSafetyFallbackSummary = (title) => ({
  'Treatment safety needs specialist review': 'This source reports safety concerns that may affect treatment choices for this condition.',
  'Investigational cell or exosome therapies': 'This source says these cell or exosome treatments are still being studied and need careful review.',
  'Potential interaction or monitoring concern': 'This source reports safety warnings or possible medicine interactions that need clinician review.',
}[title] || 'This source reports a safety concern that may matter for this condition.')

const safetyIdeasForReport = (result) => {
  const reviewedItems = Array.isArray(result?.review?.safety) ? result.review.safety : []
  if (reviewedItems.length) return reviewedItems

  const fallbackItems = []
  const usedTopics = new Set()
  for (const source of result?.sources || []) {
    const sourceText = `${source?.title || ''} ${source?.summary || ''}`
    const match = safetySourceMatchers.find((entry) => entry.pattern.test(sourceText))
    if (!match || usedTopics.has(match.title) || !source?.id) continue
    usedTopics.add(match.title)
    fallbackItems.push({
      title: match.title,
      summary: plainSafetyFallbackSummary(match.title),
      caution: 'This is a source-linked caution, not a personal treatment instruction. Review it with a qualified clinician before acting on it.',
      sourceIds: [source.id],
      sourceLinkedFallback: true,
    })
    if (fallbackItems.length === 3) break
  }

  if (fallbackItems.length) return fallbackItems

  return (Array.isArray(result?.exploration?.safety) ? result.exploration.safety : [])
    .map((item) => ({ ...item, sourceIds: [], needsVerification: true }))
    .filter((item) => item.title && item.summary && item.caution)
}

function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  const paths = {
    spark: <><path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>,
    shield: <><path d="M12 3 20 6.5V12c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6.5L12 3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
    arrows: <><path d="M7 7h10" /><path d="m13 3 4 4-4 4" /><path d="M17 17H7" /><path d="m11 21-4-4 4-4" /></>,
    brain: <><path d="M9.5 4A3.5 3.5 0 0 0 6 7.5c0 .4.1.8.2 1.1A3.4 3.4 0 0 0 5 15a3.5 3.5 0 0 0 4.5 3.3" /><path d="M14.5 4A3.5 3.5 0 0 1 18 7.5c0 .4-.1.8-.2 1.1A3.4 3.4 0 0 1 19 15a3.5 3.5 0 0 1-4.5 3.3" /><path d="M12 3v18" /><path d="M8 10c1.1.1 2 .6 2.5 1.5" /><path d="M16 10c-1.1.1-2 .6-2.5 1.5" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    external: <><path d="M14 3h7v7" /><path d="m21 3-9 9" /><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h6" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4.2 3.5-6.3 8-6.3s7.2 2.1 8 6.3" /></>,
    list: <><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>,
    check: <path d="m5 12 4.2 4L19.5 6" />,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  }
  return <svg {...common}>{paths[name] || paths.spark}</svg>
}

function SiteAccessGate({ access, onGranted }) {
  const [passcode, setPasscode] = useState('')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const setupRequired = access.status === 'setup-required'
  const unavailable = access.status === 'offline'

  useEffect(() => {
    if (!access.message) return
    setStatus('error')
    setMessage(access.message)
  }, [access.message])

  const submit = async (event) => {
    event.preventDefault()
    if (!passcode) {
      setStatus('error')
      setMessage('Enter the passcode to open this demo.')
      return
    }

    setStatus('working')
    setMessage('')
    try {
      const result = await loginSiteAccess(passcode)
      setPasscode('')
      setStatus('ready')
      onGranted(result)
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'The passcode could not be checked. Try again.')
    }
  }

  return (
    <main className="mrc-access-shell">
      <section className="mrc-access-card" aria-labelledby="site-access-title">
        <div className="mrc-access-mark"><Icon name="lock" size={24} /></div>
        <p className="mrc-kicker">Private research demo</p>
        <h1 id="site-access-title">Enter the site passcode.</h1>
        <p>This demo is for invited users. It is a research tool, not a medical service.</p>
        <div className="mrc-access-notice">
          <Icon name="shield" size={18} />
          <p><strong>Privacy and safety:</strong> This demo is not HIPAA-ready. Do not enter a real person’s name, birthday, address, phone number, email, medical record number, or other identifying detail. It does not give medical advice or medical recommendations.</p>
        </div>
        {setupRequired ? (
          <p className="mrc-access-message mrc-access-message--error">Passcode protection has not been set up on the server yet.</p>
        ) : unavailable ? (
          <p className="mrc-access-message mrc-access-message--error">The local access service is not available right now.</p>
        ) : access.status === 'checking' ? (
          <p className="mrc-access-message">Checking secure access...</p>
        ) : (
          <form className="mrc-access-form" onSubmit={submit}>
            <label>
              <span>Passcode</span>
              <input type="password" value={passcode} onChange={(event) => setPasscode(event.target.value)} autoComplete="current-password" autoFocus aria-describedby="site-access-help" />
            </label>
            <button className="mrc-button mrc-button--primary" type="submit" disabled={status === 'working'}>
              {status === 'working' ? <><span className="mrc-spinner" /> Opening demo</> : <><Icon name="lock" size={16} /> Open research demo</>}
            </button>
            {message ? <p className={`mrc-access-message mrc-access-message--${status}`} role="alert">{message}</p> : null}
          </form>
        )}
        <p id="site-access-help" className="mrc-access-help">The passcode is checked by the server. It is not stored in the page code.</p>
        <p className="mrc-access-footnote">If this may be an emergency, call 911 or your local emergency number now.</p>
      </section>
    </main>
  )
}

function StatusPill({ tone = 'neutral', children }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}

function CitationList({ citations, compact = false }) {
  if (!citations?.length) return null
  return (
    <div className={`citations ${compact ? 'citations--compact' : ''}`}>
      {citations.map((citation) => (
        <a key={citation.url || citation.id} href={citation.url} target="_blank" rel="noreferrer" className="citation-chip">
          <Icon name="external" size={13} />
          {sourceLabel(citation)}
        </a>
      ))}
    </div>
  )
}

function InlineCitationLinks({ citations, label = 'Sources' }) {
  if (!citations?.length) return null
  return (
    <span className="inline-citations">
      <span className="inline-citations__label">{label}:</span>
      {citations.map((citation) => (
        <a key={citation.url || citation.id} href={citation.url} target="_blank" rel="noreferrer" className="inline-citation-link" title={`Open ${sourceLabel(citation)}`}>
          {sourceLabel(citation)} <Icon name="external" size={11} />
        </a>
      ))}
    </span>
  )
}

function CitedParagraph({ children, citations, className = '' }) {
  return <p className={className}>{children}<InlineCitationLinks citations={citations} /></p>
}

function CitationActions({ citations, label = 'Open source' }) {
  if (!citations?.length) return null
  return (
    <div className="citation-actions">
      {citations.map((citation, index) => (
        <a key={citation.url || citation.id} href={citation.url} target="_blank" rel="noreferrer" className="citation-action">
          {index === 0 ? label : 'More evidence'} <Icon name="external" size={12} />
        </a>
      ))}
    </div>
  )
}

function SectionHeader({ eyebrow, title, action }) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  )
}

function SourceCoverage({ coverage, compact = false }) {
  const lanes = Array.isArray(coverage) ? coverage : []
  if (!lanes.length) return null

  return (
    <section className={`source-coverage${compact ? ' source-coverage--compact' : ''}`} aria-label="Sources checked for this report">
      <div className="source-coverage__header">
        <div>
          <p className="eyebrow">Where we looked</p>
          <h2>Sources checked for this report</h2>
        </div>
        <StatusPill tone="neutral">Search details</StatusPill>
      </div>
      <div className="source-coverage__grid">
        {lanes.map((lane) => {
          const recordCount = Number(lane.records) || 0
          const status = lane.status === 'ready'
            ? (recordCount ? `${recordCount} exact record${recordCount === 1 ? '' : 's'}` : 'No exact match')
            : lane.status === 'not-configured'
              ? 'Not connected'
              : lane.status === 'manual'
                ? 'Open route'
              : 'Unavailable'
          const tone = lane.status === 'ready' && recordCount ? 'safe' : lane.status === 'unavailable' ? 'caution' : 'neutral'
          return (
            <article className="source-coverage-card" key={lane.id}>
              <div className="source-coverage-card__topline">
                <p>{lane.label}</p>
                <StatusPill tone={tone}>{status}</StatusPill>
              </div>
              <p className="source-coverage-card__detail">{lane.detail}</p>
              {lane.url ? <a href={lane.url} target="_blank" rel="noreferrer">Open source search <Icon name="external" size={13} /></a> : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function Pipeline({ items, loading }) {
  return (
    <div className="pipeline-list" aria-live="polite">
      {items.map((item, index) => (
        <article className={`pipeline-step pipeline-step--${loading && index > 0 ? 'waiting' : item.status}`} key={item.id}>
          <span className="pipeline-mark">
            {loading && index > 0 ? <Icon name="clock" size={15} /> : item.status === 'passed' ? <Icon name="check" size={16} /> : <span>{String(index + 1).padStart(2, '0')}</span>}
          </span>
          <div>
            <h4>{item.label}</h4>
            <p>{loading && index > 0 ? 'Working through the evidence boundary...' : item.detail}</p>
          </div>
        </article>
      ))}
    </div>
  )
}

function EvidenceCard({ item }) {
  return (
    <article className="evidence-card">
      <div className="card-topline">
        <div>
          <p className="card-kicker">{item.tier}</p>
          <h3>{item.name}</h3>
        </div>
        <StatusPill tone={item.badgeTone === 'verified' ? 'safe' : 'caution'}>{item.badge}</StatusPill>
      </div>
      <CitedParagraph className="card-summary" citations={item.citations}>{item.summary}</CitedParagraph>
      <dl className="evidence-facts">
        <div><dt>What to ask about</dt><dd>{item.useCase}<InlineCitationLinks citations={item.citations} /></dd></div>
        <div><dt>What the evidence says</dt><dd>{item.rationale}<InlineCitationLinks citations={item.citations} /></dd></div>
        <div><dt>Things to watch</dt><dd>{item.watchouts}<InlineCitationLinks citations={item.citations} /></dd></div>
      </dl>
    </article>
  )
}

function TrialCard({ trial }) {
  const citations = trial?.url ? [trial] : []
  return (
    <article className="trial-card">
      <div className="card-topline">
        <div>
          <p className="card-kicker">{trial.phase}</p>
          <h3>{trial.title}</h3>
        </div>
        <a className="nct-link" href={trial.url} target="_blank" rel="noreferrer">{trial.id}<Icon name="external" size={13} /></a>
      </div>
      <CitedParagraph citations={citations}>{trial.summary}</CitedParagraph>
      <div className="trial-meta">
        <span><strong>{trial.status}</strong></span>
        <span>{trial.location}</span>
        <span>{trial.interventions?.join(', ') || 'Intervention not listed'}</span>
      </div>
      {trial.caution ? <CitedParagraph className="trial-caution" citations={citations}><Icon name="alert" size={15} />{trial.caution}</CitedParagraph> : null}
      <CitedParagraph className="trial-sponsor" citations={citations}>Sponsor: {trial.sponsor}</CitedParagraph>
    </article>
  )
}

function EstablishedTreatments({ condition, result }) {
  const labels = officialLabelIdeasForReport(result, condition)
  const labelSearchUrl = 'https://open.fda.gov/drug/label/'
  return (
    <section id="approved-options" className="approved-treatments section-surface">
      <SectionHeader
        eyebrow="1. Approved and established options"
        title="What is already approved or clearly established"
        action={<StatusPill tone={labels.length ? 'safe' : 'neutral'}>{labels.length ? `${labels.length} official label${labels.length === 1 ? '' : 's'}` : 'Check labels'}</StatusPill>}
      />
      <p className="section-intro">Start here to separate treatments with an official U.S. label from early research. A label can apply to a specific subtype, symptom, or situation, so open the source before deciding whether it matters for this person.</p>
      {labels.length ? (
        <div className="approved-treatment-table-wrap">
          <table className="approved-treatment-table">
            <thead><tr><th>Treatment</th><th>What the official record says</th><th>Important limit</th><th>Source</th></tr></thead>
            <tbody>
              {labels.map((idea) => {
                const citations = claimCitations(result, idea, condition)
                return (
                  <tr key={idea.title}>
                    <td><p className="card-kicker">Official U.S. label</p><strong>{idea.title}</strong></td>
                    <td><CitedParagraph citations={citations}>{idea.summary}</CitedParagraph></td>
                    <td><div className="approved-treatment-table__boundary"><Icon name="shield" size={16} /><span>{idea.caution}</span></div></td>
                    <td><CitationActions citations={citations} label="Open official label" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <RequiredSectionEmptyState title="Check approved options by subtype or symptom." icon="database">The official-label search did not find a broad match for this condition. A treatment may still be labeled for a subtype, gene result, symptom, or related diagnosis. <a href={labelSearchUrl} target="_blank" rel="noreferrer">Open the FDA label search</a> and discuss the condition, subtype, and treatment choices with a clinician.</RequiredSectionEmptyState>
      )}
    </section>
  )
}

const isRecruitingTrial = (trial) => String(trial?.status || '').trim().toUpperCase() === 'RECRUITING'

function TrialTable({ trials }) {
  return (
    <div className="trial-table-wrap">
      <table className="trial-table">
        <thead>
          <tr><th>Study</th><th>Status</th><th>What is being studied</th><th>Location</th><th>Open</th></tr>
        </thead>
        <tbody>
          {trials.map((trial) => (
            <tr key={trial.id}>
              <td className="trial-table__study">
                <a href={trial.url} target="_blank" rel="noreferrer">{trial.title} <Icon name="external" size={12} /></a>
                <span>{trial.id} {trial.phase && trial.phase !== 'Phase not listed' ? `· ${trial.phase}` : ''}</span>
                <details className="trial-table__details">
                  <summary>Study details</summary>
                  <p>{trial.summary}</p>
                  <p><strong>Sponsor:</strong> {trial.sponsor}</p>
                  {trial.caution ? <p className="trial-table__caution">{trial.caution}</p> : null}
                </details>
              </td>
              <td><span className={trial.treatmentFocus ? 'trial-status trial-status--treatment' : 'trial-status'}>{trial.status}</span>{!trial.treatmentFocus ? <small>Research study</small> : null}</td>
              <td>{trial.interventions?.length ? trial.interventions.join(', ') : 'Imaging or other research'}</td>
              <td>{trial.location}</td>
              <td><a className="trial-table__open" href={trial.url} target="_blank" rel="noreferrer">Record <Icon name="external" size={12} /></a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TrialDirectory({ condition, result }) {
  const trials = Array.isArray(result?.trials) ? result.trials : []
  const recruitingTrials = trials.filter(isRecruitingTrial)
  const otherCurrentTrials = trials.filter((trial) => !isRecruitingTrial(trial))
  const clinicalTrialsSearchUrl = `https://clinicaltrials.gov/search?cond=${encodeURIComponent(condition || '')}`
  return (
    <section id="clinical-trials" className="trial-directory section-surface">
      <SectionHeader
        eyebrow="6. Current clinical trials"
        title={`${condition || 'Condition'} clinical trial directory`}
        action={<StatusPill tone={trials.length ? 'safe' : 'neutral'}>{trials.length ? `${trials.length} current studies` : 'Registry search'}</StatusPill>}
      />
      <p className="section-intro">This is the full current set returned by the live condition-specific registry search, with recruiting studies shown first. Every row links to ClinicalTrials.gov, where you can check the study purpose, locations, enrollment rules, and contact details.</p>
      {recruitingTrials.length ? (
        <section className="trial-directory__recruiting">
          <div className="trial-directory__other-heading">
            <div><p className="card-kicker">Recruiting now</p><h3>Studies that may be enrolling</h3></div>
            <StatusPill tone="safe">{recruitingTrials.length} recruiting</StatusPill>
          </div>
          <TrialTable trials={recruitingTrials} />
        </section>
      ) : trials.length ? (
        <RequiredSectionEmptyState title="Current studies were found; check their enrollment status." icon="search">The live registry did not list a recruiting match at this moment. Status can change, so use the linked records below and <a href={clinicalTrialsSearchUrl} target="_blank" rel="noreferrer">open the live registry search</a> before ruling anything out.</RequiredSectionEmptyState>
      ) : (
        <RequiredSectionEmptyState title="Open the live registry to continue the trial search." icon="search">Use the condition, subtype, and treatment directions in <a href={clinicalTrialsSearchUrl} target="_blank" rel="noreferrer">ClinicalTrials.gov</a>. A registry result is not proof of eligibility or benefit.</RequiredSectionEmptyState>
      )}
      {otherCurrentTrials.length ? (
        <section className="trial-directory__other">
          <div className="trial-directory__other-heading">
            <div><p className="card-kicker">Full current trial directory</p><h3>Other active, invitation-only, and not-yet-recruiting studies</h3></div>
            <StatusPill tone="neutral">{otherCurrentTrials.length} current</StatusPill>
          </div>
          <p>Together with the recruiting table above, these rows make up the full live report list. Open the exact record to check the latest status.</p>
          <TrialTable trials={otherCurrentTrials} />
        </section>
      ) : null}
    </section>
  )
}

const readableProfileValue = (values, fallback) => values.filter(Boolean).join(' · ') || fallback

function ResearchAccessPlan({ condition, form, result }) {
  const patient = result?.patient || form || {}
  const trials = Array.isArray(result?.trials) ? result.trials : []
  const recruitingTrials = trials.filter(isRecruitingTrial)
  const plan = [
    {
      label: 'Condition details to bring',
      value: readableProfileValue([displayConditionName(patient.condition || condition), patient.geneticVariant, patient.stage], 'Write down the diagnosis, subtype, gene result, and stage if known.'),
      detail: 'These details can change which source records and study questions are worth checking.',
    },
    {
      label: 'Current treatment list',
      value: readableProfileValue([patient.currentMeds, patient.priorTherapies], 'List current and past medicines or treatments before a visit.'),
      detail: 'A clinician or pharmacist needs the full list before judging a research idea.',
    },
    {
      label: 'Symptoms and key test notes',
      value: readableProfileValue([patient.symptoms, patient.scans], 'Bring the symptoms, scans, or test notes that matter most to the person.'),
      detail: 'This helps a specialist understand which questions are most important first.',
    },
    {
      label: 'Study-site conversation',
      value: recruitingTrials.length ? `${recruitingTrials.length} recruiting study record${recruitingTrials.length === 1 ? '' : 's'} linked below.` : 'Use the current study directory to check who is enrolling and where.',
      detail: 'A registry record does not decide eligibility. The study team can explain the current rules and contacts.',
      citations: recruitingTrials.slice(0, 3),
    },
  ]

  return (
    <section id="research-plan" className="research-access-plan section-surface">
      <SectionHeader eyebrow="7. Your research and access plan" title="Bring the right details to a visit or study call" action={<StatusPill tone="neutral">Discussion guide</StatusPill>} />
      <p className="section-intro">This is a simple organizer for the next conversation. It does not assess study eligibility, diagnose a condition, or recommend treatment.</p>
      <div className="research-access-plan__grid">
        {plan.map((item) => (
          <article className="research-access-plan__card" key={item.label}>
            <p className="card-kicker">{item.label}</p>
            <strong>{item.value}</strong>
            <p>{item.detail}</p>
            {item.citations ? <CitationActions citations={item.citations} label="Open recruiting study" /> : null}
          </article>
        ))}
      </div>
    </section>
  )
}

function CenterCard({ center, result }) {
  const citations = citationsFor(result, (center.trials || []).map((trial) => trial.id))
  return (
    <article className="center-card">
      <div className="center-number">{center.index}</div>
      <div>
        <h3>{center.name}</h3>
        <p className="center-location">{center.city}</p>
        {center.researchRegionPriority ? <span className="center-priority">U.S. / Europe site preference</span> : null}
        <CitedParagraph citations={citations}>{center.why}</CitedParagraph>
      </div>
    </article>
  )
}

function ResearcherCard({ researcher, result }) {
  const trialIds = (researcher.trials || []).map((trial) => trial.id).filter(Boolean)
  const citations = citationsFor(result, trialIds)
  return (
    <article className="researcher-card">
      <p className="card-kicker">{researcher.role || 'Research record'}</p>
      <h3>{researcher.name}</h3>
      {researcher.affiliation ? <p className="researcher-affiliation">{researcher.affiliation}</p> : null}
      <CitedParagraph citations={citations}>{researcher.why || (trialIds.length ? `Named in the ClinicalTrials.gov record${trialIds.length === 1 ? '' : 's'} for ${trialIds.join(', ')}.` : 'Named in the condition research sources.')}</CitedParagraph>
      {trialIds.length ? <span className="researcher-trials">{trialIds.join(' · ')}</span> : null}
    </article>
  )
}

function CareLocations({ condition, result, hasAiStartingMap }) {
  const centers = Array.isArray(result?.centers) ? result.centers : []
  const centerMode = result?.centerMode === 'active-research-sites'
  const clinicalTrialsSearchUrl = `https://clinicaltrials.gov/search?cond=${encodeURIComponent(condition || '')}`
  return (
    <section id="centers-experts" className="section-surface centers-surface care-locations">
      <SectionHeader
        eyebrow="2. Centers and experts"
        title={centerMode ? 'Specialty centers and study sites' : 'Institutions in this source pack'}
        action={<StatusPill tone={centers.length ? 'safe' : 'neutral'}>{centers.length ? `${centers.length} place${centers.length === 1 ? '' : 's'}` : 'Study sites'}</StatusPill>}
      />
      <p className="section-intro">Start with source-linked specialty centers and study sites. These are places to investigate, not a quality ranking or a promise that a person can join a study.</p>
      {centers.length ? (
        <div className="center-list">{centers.map((center, index) => <CenterCard key={`${center.name}-${center.city}`} center={{ ...center, index: String(index + 1).padStart(2, '0') }} result={result} />)}</div>
      ) : (
        <RequiredSectionEmptyState title={hasAiStartingMap ? 'Use the research map to find a specialty team.' : 'Start with the recruiting study locations below.'} icon="search">{hasAiStartingMap ? <>Use the research questions and search directions in this map to find academic disease-specific centers, then confirm expertise with a clinician or disease foundation.</> : <>Each recruiting study below links to its current registry record and location. You can also <a href={clinicalTrialsSearchUrl} target="_blank" rel="noreferrer">open the live study-site search</a> or ask a clinician or disease foundation for a specialist directory.</>}</RequiredSectionEmptyState>
      )}
      {result.researchers?.length ? (
        <div className="researcher-section">
          <h3>Researchers named in the source records</h3>
          <p>These people are named in a curated condition source or a current trial record. This is not a quality ranking or a referral list.</p>
          <div className="researcher-grid">{result.researchers.map((researcher) => <ResearcherCard key={`${researcher.name}-${researcher.affiliation}`} researcher={researcher} result={result} />)}</div>
        </div>
      ) : null}
      <div className="investigator-note"><Icon name="shield" size={16} /><p>{centerMode ? <><strong>Location preference:</strong> when registry sites are otherwise comparable, U.S. and European locations are shown first to make research navigation easier.</> : <>The institution list comes from the condition’s curated source pack.</>}</p></div>
    </section>
  )
}

function RequiredSectionEmptyState({ icon = 'search', title, children }) {
  return (
    <div className="empty-state required-section-empty">
      <Icon name={icon} size={21} />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  )
}

const conditionOverviewCardsForReport = (result, condition) => {
  const review = result?.review
  const sources = Array.isArray(result?.sources) ? result.sources : []
  const overviewSource = sources.find((source) => source?.conditionOverview && source?.url)
  const overview = overviewSource?.conditionOverview || {}
  const briefing = review?.briefing?.text || result?.exploration?.briefing || ''
  const citations = overviewSource
    ? [overviewSource]
    : citationsForClaim({
      result,
      sourceIds: review?.briefing?.sourceIds,
      condition,
      searchTerms: searchTermsFor(result),
      verifyWhenEmpty: Boolean(briefing),
    })

  return [
    {
      icon: 'brain',
      label: 'What it is',
      text: overview.whatItIs || briefing || `This report explains ${condition || 'this condition'} in plain language and links each major research section to its source.`,
      citations,
    },
    {
      icon: 'search',
      label: 'What people may notice',
      text: overview.whatToWatch || 'Symptoms and daily-life changes can help a clinician make the research and trial search more specific.',
      citations,
    },
    {
      icon: 'arrows',
      label: 'What changes the research path',
      text: overview.researchPath || 'The subtype, gene result, disease stage, test findings, and current treatment can change which options and studies are worth checking.',
      citations,
    },
  ]
}

const reportRoute = [
  { href: '#approved-options', label: 'Approved options' },
  { href: '#centers-experts', label: 'Centers & experts' },
  { href: '#lifestyle-support', label: 'Lifestyle support' },
  { href: '#research-ideas', label: 'Treatment ideas' },
  { href: '#research-programs', label: 'Research programs' },
  { href: '#clinical-trials', label: 'Clinical trials' },
  { href: '#research-plan', label: 'Research plan' },
  { href: '#safety', label: 'Safety' },
]

function ReportOverview({ condition, result }) {
  const exploration = result?.exploration
  return (
    <section id="condition-overview" className="report-overview section-surface">
      <SectionHeader
        eyebrow="Condition overview"
        title={`Understanding ${condition || 'this condition'}`}
        action={exploration && !result?.review?.briefing?.text ? <StatusPill tone="caution">Research ideas to verify</StatusPill> : <StatusPill tone="safe">Source-linked</StatusPill>}
      />
      <p className="section-intro">Start here before looking at treatments. This section explains the condition itself, then the rest of the report moves through established options, support, research ideas, and live trials.</p>
      <div className="condition-overview-grid" aria-label="Condition overview">
        {conditionOverviewCardsForReport(result, condition).map((card) => (
          <article className="condition-overview-card" key={card.label}>
            <div className="condition-overview-card__topline"><span><Icon name={card.icon} size={16} /></span><p>{card.label}</p></div>
            <CitedParagraph citations={card.citations}>{card.text}</CitedParagraph>
            <CitationActions citations={card.citations} label="Open source" />
          </article>
        ))}
      </div>
      <nav className="report-route" aria-label="Report guide">
        <span>Read this report in the order that helps you decide what to discuss next:</span>
        <div>{reportRoute.map((item) => <a href={item.href} key={item.href}>{item.label}</a>)}</div>
      </nav>
    </section>
  )
}

const doctorQuestionsForReport = (result) => {
  const reviewQuestions = Array.isArray(result?.review?.questions) ? result.review.questions : []
  if (reviewQuestions.length) return reviewQuestions
  return (Array.isArray(result?.exploration?.connections) ? result.exploration.connections : [])
    .map((item) => ({ text: item.question, sourceIds: [], kind: 'exploration' }))
    .filter((item) => item.text)
}

function DoctorQuestions({ condition, result }) {
  const questions = doctorQuestionsForReport(result)
  if (!questions.length) return null

  return (
    <section id="doctor-questions" className="doctor-questions section-surface">
      <SectionHeader eyebrow="Questions for your doctor" title="Simple questions to bring to a visit" action={<StatusPill tone="neutral">Source-linked</StatusPill>} />
      <p className="section-intro">These questions use the exact studies and research leads in this report. They are conversation starters, not a treatment plan.</p>
      <div className="doctor-questions__list">
        {questions.slice(0, 4).map((question, index) => (
          <CitedParagraph
            key={`${question.text}-${index}`}
            citations={claimCitations(result, question, condition, { verifyWhenEmpty: question.kind === 'exploration' })}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>{question.text}
          </CitedParagraph>
        ))}
      </div>
    </section>
  )
}

const sourceTextForIdea = (result, idea) => (idea?.sourceIds || [])
  .map((sourceId) => (result?.sources || []).find((source) => source.id === sourceId))
  .filter(Boolean)
  .map((source) => `${source.title || ''} ${source.summary || ''}`)
  .join(' ')

const evidencePointsAway = (result, idea) => idea?.accessClass === 'evidence-points-away'
  || /\b(?:worse|no (?:benefit|evidence)|did not (?:support|improve|show)|does not support|negative outcome|harmful)\b/i.test(`${idea?.summary || ''} ${idea?.caution || ''} ${sourceTextForIdea(result, idea)}`)

const patientAccessForIdea = (result, idea) => {
  if (evidencePointsAway(result, idea)) {
    return {
      tone: 'caution',
      label: 'Evidence points away',
      detail: 'This was studied, but the linked source reports a negative or worse result. Ask why it is not a routine option.',
    }
  }
  if (idea?.accessClass === 'prescription-or-label-check') {
    return {
      tone: 'neutral',
      label: 'Prescription or label check',
      detail: 'A clinician or pharmacist can check the exact label, prescription status, and safety context.',
    }
  }
  if (isSupplementIdea(idea)) {
    return {
      tone: 'safe',
      label: 'Consumer product to discuss',
      detail: 'This is a food or supplement item named in condition-specific research. A study does not establish a dose, safety, quality, or personal fit.',
    }
  }
  return {
    tone: 'safe',
    label: 'Discuss with a clinician',
    detail: idea?.accessExplanation || 'This is a source-backed lead to review with a clinician, not a personal treatment plan.',
  }
}

const PatientLeadCards = ({ condition, result, ideas }) => (
  <div className="research-ideas-grid">
    {ideas.slice(0, 10).map((idea, index) => {
      const citations = claimCitations(result, idea, condition)
      const access = patientAccessForIdea(result, idea)
      return (
        <article className={`research-idea-card ${access.tone === 'caution' ? 'research-idea-card--caution' : ''}`} key={idea.title}>
          <span className="research-idea-card__number">{String(index + 1).padStart(2, '0')}</span>
          <div className="card-topline"><p className="card-kicker">{idea.category || 'Source-linked treatment lead'}</p><StatusPill tone={access.tone}>{access.label}</StatusPill></div>
          <h3>{idea.title}</h3>
          <CitedParagraph citations={citations}>{idea.summary || idea.rationale || 'This item appears in condition-specific research.'}</CitedParagraph>
          <dl className="research-idea-facts">
            <div><dt>Access today</dt><dd>{access.detail}</dd></div>
            <div><dt>Ask your healthcare provider</dt><dd>{idea.providerQuestion || 'Is this worth discussing?'}</dd></div>
          </dl>
          {idea.whyItMayMatter ? <CitedParagraph className="research-idea-table__summary" citations={citations}><strong>Why it may matter:</strong> {idea.whyItMayMatter}</CitedParagraph> : null}
          <div className="research-idea-boundary"><Icon name="shield" size={16} /><span>{idea.caution || idea.boundary}</span></div>
          <CitationActions citations={citations} label="Open source" />
        </article>
      )
    })}
  </div>
)

const TheoryIdeaCards = ({ condition, result, ideas }) => (
  <div className="research-ideas-grid">
    {ideas.slice(0, 10).map((idea, index) => {
      const backgroundCitations = claimCitations(result, idea, condition)
      const verificationCitations = theoryVerificationLinks(condition, idea)
      return (
        <article className="research-idea-card research-idea-card--exploratory" key={idea.title}>
          <span className="research-idea-card__number">{String(index + 1).padStart(2, '0')}</span>
          <div className="card-topline"><p className="card-kicker">{idea.category || 'Theory to verify'}</p><StatusPill tone="experimental">Not established</StatusPill></div>
          <h3>{idea.title}</h3>
          <CitedParagraph citations={verificationCitations}>{idea.whyItCouldConnect}</CitedParagraph>
          <dl className="research-idea-facts">
            <div><dt>Why it is only a theory</dt><dd>{idea.whyNotEstablished}</dd></div>
            <div><dt>Ask your healthcare provider</dt><dd>{idea.providerQuestion || 'What evidence supports this idea?'}</dd></div>
          </dl>
          <div className="research-idea-boundary"><Icon name="shield" size={16} /><span>{idea.caution}</span></div>
          <CitationActions citations={verificationCitations} label="Search PubMed" />
          <CitationActions citations={backgroundCitations} label="Condition background" />
        </article>
      )
    })}
  </div>
)

function ResearchIdeas({ condition, result }) {
  const patientIdeas = patientDiscussionIdeasForReport(result, condition)
  const theoryIdeas = theoryIdeasForReport(result, condition)

  return (
    <section id="research-ideas" className="research-ideas section-surface">
      <SectionHeader eyebrow="4. Treatment ideas" title="What you can discuss now, plus ideas to verify" />
      <p className="section-intro">The first lane is deliberately patient-facing: source-backed medicines, foods, supplements, or procedures that a care team can discuss. Trial-only gene, cell, and device programs appear below in their own access section. The second lane is a different list of careful theories to verify. Neither lane is a treatment plan.</p>

      <div className="research-idea-lanes">
        <section className="research-idea-lane">
          <div className="research-idea-lane__header">
            <div><p className="card-kicker">1. Researched leads to discuss now</p><p>Up to 10 condition-specific leads that are not simply a trial-only program. Each card says what the source found, how to think about access, and one plain question to bring to a clinician.</p></div>
            <StatusPill tone={patientIdeas.length ? 'safe' : 'neutral'}>{patientIdeas.length}/10 source-linked</StatusPill>
          </div>
          {patientIdeas.length ? <PatientLeadCards condition={condition} result={result} ideas={patientIdeas} /> : <div className="research-idea-empty"><Icon name="shield" size={18} /><p>This lane stays separate on purpose. The report did not move trial-only programs here; use the approved-options and research-program sections to prepare the next discussion.</p></div>}
        </section>

        <section className="research-idea-lane research-idea-lane--exploratory">
          <div className="research-idea-lane__header">
            <div><p className="card-kicker">2. Theory leads to verify</p><p>Ten possible targets, pathways, genes, or mechanisms to investigate. Each card explains the connection, why it is not established, and a simple question to ask. No card gives a dose or tells anyone to take a treatment.</p></div>
            <StatusPill tone={theoryIdeas.length ? 'experimental' : 'neutral'}>{theoryIdeas.length}/10 theories</StatusPill>
          </div>
          {theoryIdeas.length ? <TheoryIdeaCards condition={condition} result={result} ideas={theoryIdeas} /> : <div className="research-idea-empty research-idea-empty--exploratory"><Icon name="shield" size={18} /><p>Use the linked PubMed and trial searches to build a theory list with a specialist. This app will not turn a guess into a treatment claim.</p></div>}
        </section>
      </div>
    </section>
  )
}

const isAdvancedResearchProgram = (idea) => looksLikeAdvancedResearch(idea)

const isResearchProgramIdea = (idea) => isAdvancedResearchProgram(idea)
  || idea?.kind === 'trial'
  || Boolean(Array.isArray(idea?.trials) && idea.trials.length)

const patientDiscussionIdeasForReport = (result, condition) => {
  const sourceById = new Map((result?.sources || []).map((source) => [source.id, source]))
  return allTreatmentIdeasForReport(result, condition)
    .filter((idea) => !isResearchProgramIdea(idea))
    .filter((idea) => (idea?.sourceIds || []).some((sourceId) => sourceById.has(sourceId)))
    .slice(0, 10)
}

const researchProgramIdeasForReport = (result, condition) => allTreatmentIdeasForReport(result, condition)
  .filter(isResearchProgramIdea)
  .slice(0, 10)

const developmentProgramsForReport = (result, condition) => {
  const seen = new Set()
  return researchProgramIdeasForReport(result, condition)
    .filter((idea) => {
      const key = treatmentIdeaKey(idea?.title)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
}

const trialForProgram = (result, program) => program?.trials?.[0]
  || (result?.trials || []).find((trial) => (program?.sourceIds || []).includes(trial.id))

const accessForResearchProgram = (result, program) => {
  const trial = trialForProgram(result, program)
  const status = String(trial?.status || '').toUpperCase()
  if (status === 'RECRUITING') return {
    tone: 'safe',
    label: 'Study may be enrolling',
    detail: 'This record says Recruiting. Contact the study site; the team decides whether someone qualifies.',
  }
  if (status === 'ENROLLING_BY_INVITATION') return {
    tone: 'neutral',
    label: 'By invitation only',
    detail: 'This record says enrollment is by invitation. It is not a self-enrollment route.',
  }
  if (status === 'ACTIVE_NOT_RECRUITING') return {
    tone: 'neutral',
    label: 'Not enrolling in this record',
    detail: 'The study is active, but this record does not show current enrollment. Open it for updates.',
  }
  if (status === 'NOT_YET_RECRUITING') return {
    tone: 'neutral',
    label: 'Not open yet',
    detail: 'This study is listed but has not started recruiting. Open the record for future updates.',
  }
  return {
    tone: 'caution',
    label: 'Formal access route needed',
    detail: 'This is research, not routine care. The linked record does not show a patient access route today.',
  }
}

function DevelopmentProgramTable({ condition, result, programs }) {
  return (
    <div className="development-program-table-wrap">
      <table className="development-program-table">
        <thead><tr><th>Program or approach</th><th>What is being studied</th><th>Access right now</th><th>Source</th></tr></thead>
        <tbody>
          {programs.map((program) => {
            const citations = claimCitations(result, program, condition)
            const access = accessForResearchProgram(result, program)
            const sourceLabel = program.kind === 'trial' ? 'Open current study' : 'Open research source'
            return (
              <tr key={program.title}>
                <td><p className="card-kicker">{program.kind === 'trial' ? 'Current study' : 'Research source'}</p><strong>{program.title}</strong></td>
                <td>
                  <span className="development-program-table__lane">{program.category || 'Treatment research'}</span>
                  <CitedParagraph citations={citations}>{program.summary || program.rationale || `This approach appears in condition-specific research for ${condition}.`}</CitedParagraph>
                </td>
                <td>
                  <StatusPill tone={access.tone}>{access.label}</StatusPill>
                  <p className="development-program-table__boundary">{access.detail}</p>
                  <p className="development-program-table__boundary">Expanded access is not confirmed for this program. The FDA guide explains the process; it does not guarantee access.</p>
                </td>
                <td><CitationActions citations={citations} label={sourceLabel} /><CitationActions citations={[FDA_EXPANDED_ACCESS_SOURCE]} label="FDA access guide" /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TreatmentDevelopment({ condition, result }) {
  const programs = developmentProgramsForReport(result, condition)

  if (!programs.length) return null

  return (
    <section id="research-programs" className="treatment-development section-surface">
      <SectionHeader
        eyebrow="5. Research programs and access"
        title="Research programs that need a formal access route"
        action={<StatusPill tone="safe">{programs.length} source-linked programs</StatusPill>}
      />
      <p className="section-intro">This is where trial-only gene, cell, device, procedure, and other research programs belong. The table tells you whether the linked record is enrolling, not yet open, or simply does not show a patient access route. It never treats a program as a product someone can just obtain.</p>
      <DevelopmentProgramTable condition={condition} result={result} programs={programs} />
    </section>
  )
}

function LifestyleResearch({ result }) {
  const condition = result?.patient?.condition
  const lifestyle = lifestyleIdeasForReport(result, condition)
  const hasFallback = lifestyle.some((item) => item.sourceLinkedFallback)
  const hasStartingMap = lifestyle.some((item) => item.needsVerification)

  return (
    <section id="lifestyle-support" className="lifestyle-research section-surface">
      <SectionHeader
        eyebrow="3. Lifestyle & environment"
        title="Lifestyle changes worth discussing"
        action={<StatusPill tone={hasStartingMap ? 'caution' : 'safe'}>{hasStartingMap ? 'Topics to verify' : hasFallback ? 'Source-linked' : 'Research-backed'}</StatusPill>}
      />
      <p className="section-intro">{hasStartingMap ? 'These are practical daily-life questions for this condition. They do not say that a change will help. Open the linked searches and ask a clinician which topics truly apply.' : 'These are research findings about daily life that may matter for this condition. They are not personal medical instructions.'}</p>
      <div className="lifestyle-grid">
        {lifestyle.map((item) => {
          const citations = item.needsVerification
            ? lifestyleVerificationLinks(condition, item)
            : claimCitations(result, item, condition)
          return (
            <article className="lifestyle-card" key={item.id || item.title}>
              <p className="card-kicker">{item.needsVerification ? 'Topic to verify' : 'Source-linked discussion point'}</p>
              <h3>{item.title}</h3>
              <CitedParagraph citations={citations}>{item.summary}</CitedParagraph>
              {item.providerQuestion ? <div className="lifestyle-question"><strong>Ask your healthcare provider</strong><span>{item.providerQuestion}</span></div> : null}
              <div className="lifestyle-caution"><Icon name="shield" size={16} /><span>{item.caution}</span></div>
              <CitationActions citations={citations} label={item.needsVerification ? 'Search evidence' : 'Open source'} />
            </article>
          )
        })}
      </div>
    </section>
  )
}

function SafetyResearch({ result }) {
  const safety = safetyIdeasForReport(result)
  const hasFallback = safety.some((item) => item.sourceLinkedFallback)
  const hasStartingMap = safety.some((item) => item.needsVerification)
  const condition = result?.patient?.condition

  return (
    <section id="safety" className="safety-research section-surface">
      <SectionHeader
        eyebrow="Important safety points"
        title="Cautions found in this research"
        action={<StatusPill tone={safety.length ? 'caution' : 'neutral'}>{safety.length ? (hasStartingMap ? 'AI map - verify' : hasFallback ? 'Source-linked' : 'Review with care') : 'Safety checklist'}</StatusPill>}
      />
      <p className="section-intro">{hasStartingMap ? 'These are safety questions generated by AI. Check medicines, allergies, other conditions, and study quality with a clinician or pharmacist.' : 'These are warnings or cautions found in the sources. They do not replace a clinician or pharmacist.'}</p>
      {safety.length ? (
        <div className="safety-grid">
          {safety.map((item) => (
            <article className="safety-card" key={item.title}>
              <p className="card-kicker">{item.needsVerification ? 'AI starting map' : 'Safety consideration'}</p>
              <h3>{item.title}</h3>
              <CitedParagraph citations={claimCitations(result, item, condition, { verifyWhenEmpty: item.needsVerification })}>{item.summary}</CitedParagraph>
              <div className="safety-caution"><Icon name="alert" size={16} /><span>{item.caution}</span></div>
            </article>
          ))}
        </div>
      ) : (
        <RequiredSectionEmptyState title="Use this safety checklist while you continue the search." icon="alert">Check current medicines, allergies, pregnancy status, and other conditions with a clinician or pharmacist before acting on any research idea.</RequiredSectionEmptyState>
      )}
    </section>
  )
}

function UniversalReport({ condition, form, result }) {
  const displayCondition = displayConditionName(result?.patient?.condition || condition) || 'Condition'
  const trialCount = result?.trials?.length || 0
  const resultIsEmpty = result?.status === 'empty'
  const resultIsExploration = result?.status === 'exploration'
  const hasAiStartingMap = Boolean(result?.exploration)
  const summaryPills = [
    form.stage || 'Stage not supplied',
    form.location || 'Location not supplied',
    form.currentMeds || 'No active therapy entered',
  ]

  return (
    <section className="report-shell universal-report">
      <div className="report-masthead">
        <div>
          <p className="eyebrow">Any-condition research brief</p>
          <h2>{displayCondition} research workspace</h2>
          <p>
            {result
              ? resultIsEmpty
                ? `The live research search needs another try for ${displayCondition}.`
                : resultIsExploration
                  ? `This AI research map makes condition-specific connections for ${displayCondition}. Every idea is clearly marked for source verification.`
                : `Start with approved options, places to go, and lifestyle support. Then review research leads and recruiting studies for ${displayCondition}.`
              : 'Enter any diagnosis or subtype, then run the search to build a plain-language report from current research and clinical-trial sources.'}
          </p>
        </div>
        <div className="report-actions">
          <div className="evidence-score">
            <span>Report status</span>
            <strong>{!result ? 'Waiting to search' : resultIsEmpty ? 'Search needs attention' : resultIsExploration ? 'AI starting map' : 'Ready to read'}</strong>
            <small>{!result ? 'Choose a condition to begin' : resultIsEmpty ? 'Try the live search again' : resultIsExploration ? 'Every idea needs a source check' : `${trialCount} current studies found`}</small>
          </div>
        </div>
      </div>

      <div className="summary-bar">
        {summaryPills.map((pill) => <span key={pill}>{pill}</span>)}
        <span><Icon name="shield" size={14} /> Keep this report for discussion with a clinician</span>
      </div>

      {!result ? (
        <section className="universal-empty section-surface">
          <div className="empty-review-icon"><Icon name="search" size={22} /></div>
          <div>
            <p className="eyebrow">Ready for any condition</p>
            <h2>Start with the condition you want to understand.</h2>
            <p>Enter a diagnosis, subtype, or gene. Each completed report keeps treatment research, lifestyle, current trials, and institutions or study sites in the same clear sections when usable condition-specific data is available.</p>
            <div className="calibration-list">
              <span><Icon name="database" size={16} /> Current research sources</span>
              <span><Icon name="shield" size={16} /> Regulatory labels when relevant</span>
              <span><Icon name="search" size={16} /> Active clinical studies</span>
              <span><Icon name="arrows" size={16} /> Clear sections for facts and ideas</span>
            </div>
          </div>
        </section>
      ) : resultIsEmpty ? (
        <section className="universal-empty universal-empty--attention section-surface">
          <div className="empty-review-icon"><Icon name="alert" size={22} /></div>
          <div>
            <p className="eyebrow">Live search needs another try</p>
            <h2>Keep the condition and try the source search again.</h2>
            <p>The local research service did not finish its live retrieval. Your profile is still here, and a new search can use the same condition, subtype, symptoms, and goals.</p>
            <div className="calibration-list">
              <span><Icon name="arrows" size={16} /> Try the report again in a minute</span>
              <span><Icon name="search" size={16} /> Add a subtype or gene if you know it</span>
              <span><Icon name="database" size={16} /> Check Sources &amp; exports for service status</span>
            </div>
          </div>
        </section>
      ) : (
        <>
          <ReportOverview condition={displayCondition} result={result} />
          <EstablishedTreatments condition={displayCondition} result={result} />
          <CareLocations condition={displayCondition} result={result} hasAiStartingMap={hasAiStartingMap} />
          <LifestyleResearch result={result} />
          <ResearchIdeas condition={displayCondition} result={result} />
          <TreatmentDevelopment condition={displayCondition} result={result} />
          <TrialDirectory condition={displayCondition} result={result} />
          <ResearchAccessPlan condition={displayCondition} form={form} result={result} />
          <DoctorQuestions condition={displayCondition} result={result} />
          <SafetyResearch result={result} />

          {result.leads?.length ? (
            <section className="source-leads section-surface">
              <SectionHeader eyebrow="Freshness scout" title="New leads waiting for human verification" action={<StatusPill tone="caution">Not verified evidence</StatusPill>} />
              <div className="lead-grid">
                {result.leads.map((lead) => <a className="lead-card" href={lead.url} target="_blank" rel="noreferrer" key={lead.url}><span>{lead.source}</span><h3>{lead.title}</h3><p>{lead.whyReview}</p><small>{lead.status} <Icon name="external" size={12} /></small></a>)}
              </div>
            </section>
          ) : null}
        </>
      )}

      <footer className="report-footer">
        <div><Icon name="shield" size={18} /><p><strong>Research only, not medical advice or a medical recommendation.</strong> A licensed clinician should make diagnosis and treatment decisions.</p></div>
        <div><Icon name="lock" size={18} /><p><strong>Privacy note.</strong> This demo is not HIPAA-ready. Do not enter real patient details. The details you enter are sent to the research services and AI providers used to make this report.</p></div>
      </footer>
    </section>
  )
}

function WorkspaceHeader({ condition, activeTab, onTabChange, onLock }) {
  const tabs = [
    { id: 'profile', label: 'Profile', icon: 'profile' },
    { id: 'research', label: 'Research report', icon: 'brain' },
    { id: 'sources', label: 'Sources & exports', icon: 'database' },
  ]

  return (
    <>
      <header className="mrc-header">
        <div className="mrc-header__inner">
          <a className="mrc-brand" href="#top" aria-label="Researching My Condition home">
            <span className="mrc-brand__mark"><Icon name="spark" size={19} /></span>
            <span>
              <strong>researchingmycondition.com</strong>
              <small>AI-assisted condition research, trials, and treatment discovery</small>
            </span>
            <b>BETA</b>
          </a>
          <div className="mrc-header__controls">
            <span className="mrc-style-select"><span>Report style</span><strong>Simple language</strong></span>
            <span className="mrc-run-pill"><span /> Unlimited runs</span>
            <button className="mrc-lock-site" type="button" onClick={onLock}><Icon name="lock" size={14} /> Lock & clear</button>
          </div>
        </div>
        <div className="mrc-pulse" />
        <div className="mrc-context"><span>Researching:</span> <strong>{displayConditionName(condition) || 'Choose a condition'}</strong></div>
      </header>
      <nav className="mrc-tabs" aria-label="Research workspace">
        <div className="mrc-tabs__inner">
          {tabs.map((tab) => (
            <button key={tab.id} className={activeTab === tab.id ? 'mrc-tab mrc-tab--active' : 'mrc-tab'} type="button" onClick={() => onTabChange(tab.id)}>
              <Icon name={tab.icon} size={16} /> {tab.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  )
}

function ProfileWorkspace({
  form,
  onFieldChange,
  narrative,
  onNarrativeChange,
  intakeAssist,
  onFillFromNarrative,
  onLoadDemo,
  onReset,
  onSubmit,
  onGoToResearch,
  running,
  serviceHealth,
  privacyAcknowledged,
  onPrivacyAcknowledged,
}) {
  const isIpf = /ipf|idiopathic pulmonary fibrosis/i.test(form.condition)
  const fields = [
    { key: 'condition', label: 'Main condition you want to research', type: 'condition', wide: true, placeholder: 'e.g. Retinitis Pigmentosa, Crohn\'s Disease, or a subtype' },
    { key: 'stage', label: 'Stage of the disease (if you know it)', placeholder: 'Mild, moderate, advanced...' },
    { key: 'age', label: 'Age', placeholder: 'e.g. 65' },
    { key: 'gender', label: 'Sex / gender', type: 'select', options: ['', 'Female', 'Male', 'Intersex', 'Prefer not to say'] },
    { key: 'weight', label: 'Weight', placeholder: 'e.g. 170 lb / 77 kg' },
    { key: 'location', label: 'Location', placeholder: 'Cleveland, OH' },
    { key: 'smoking', label: 'Smoking history', placeholder: 'e.g. Former, 20 pack-years, quit 2015' },
    { key: 'activity', label: 'Exercise / activity', placeholder: 'e.g. Walks 30 minutes daily' },
    { key: 'diagnoses', label: 'All current health conditions', multiline: true, placeholder: 'List conditions that could change safety or trial discussions.' },
    { key: 'currentMeds', label: 'Medicines you take now', multiline: true, placeholder: 'Prescription medicines, over-the-counter medicines, and supplements.' },
    { key: 'allergies', label: 'Medicine and other allergies', multiline: true, placeholder: 'List medicine, ingredient, and other relevant allergies.' },
    { key: 'priorTherapies', label: 'Treatments tried before', multiline: true, placeholder: 'Prior medicines or treatments and why they stopped, if known.' },
    { key: 'symptoms', label: 'Symptoms you have now', multiline: true, placeholder: isIpf ? formOptions.symptoms.join(', ') : 'Symptoms, functional changes, flares, or "not entered"' },
    { key: 'scans', label: 'Relevant tests, scans, pathology, or notes', multiline: true, placeholder: 'Labs, imaging, pathology, genetics, or relevant clinical notes.' },
    { key: 'geneticVariant', label: 'Gene test result (if you have one)', multiline: true, placeholder: 'Gene, variant, subtype, or "not entered"' },
    { key: 'goals', label: 'What should this research answer?', multiline: true, placeholder: 'Map source-linked evidence, active research sites, and research questions.' },
  ]

  return (
    <form className="mrc-profile" onSubmit={onSubmit}>
      <section className="mrc-panel mrc-profile__header">
        <div>
          <p className="mrc-kicker"><Icon name="file" size={15} /> Patient profile</p>
          <h1>Build a research profile.</h1>
          <p>You only need a main condition. Or describe the situation in plain English and we will fill the structured fields with facts explicitly stated.</p>
        </div>
        <div className="mrc-explain-select"><span>Report style</span><strong>Simple language</strong></div>
      </section>

      <section className="mrc-describe-card" aria-labelledby="describe-title">
        <p className="mrc-kicker">Describe it in your own words (optional)</p>
        <h2 id="describe-title">Tell us the situation like you would tell a doctor.</h2>
        <p>Example: <em>"A fictional person has LADA and uses insulin."</em> The helper copies only stated facts and never makes a diagnosis.</p>
        <textarea value={narrative} onChange={(event) => onNarrativeChange(event.target.value)} placeholder="A fictional person has LADA and uses insulin twice per day..." rows={3} />
        <div className="mrc-describe-card__actions">
          <button className="mrc-button mrc-button--primary" type="button" onClick={onFillFromNarrative} disabled={intakeAssist.status === 'running' || !privacyAcknowledged}>
            {intakeAssist.status === 'running' ? <><span className="mrc-spinner" /> Filling profile</> : <><Icon name="spark" size={15} /> Fill profile from this</>}
          </button>
          {['A fictional person has LADA and uses insulin.', 'A fictional person has IPF and takes pirfenidone.', 'A fictional person has retinitis pigmentosa.'].map((example) => (
            <button className="mrc-example" type="button" key={example} onClick={() => onNarrativeChange(example)}>{example}</button>
          ))}
        </div>
        {intakeAssist.message ? <p className={`mrc-profile-note mrc-profile-note--${intakeAssist.status}`} aria-live="polite">{intakeAssist.message}</p> : null}
      </section>

      <section className="mrc-privacy-card">
        <div><Icon name="lock" size={18} /></div>
        <div>
          <strong>Privacy comes first</strong>
          <p>This demo does not save your form after the run. To make a report, it sends the details you enter to the research services and AI providers used by this app. This demo is not HIPAA-ready. Do not enter real patient details.</p>
          <p>We try to block obvious contact and ID details, but that check cannot catch everything. Please leave out all identifying information.</p>
        </div>
      </section>

      <section className="mrc-safety-consent">
        <div><Icon name="shield" size={18} /></div>
        <div>
          <strong>Before you run a report</strong>
          <p>This tool is for learning and research. It does not diagnose, prescribe, or recommend treatment. It is not for emergencies.</p>
          <label className="mrc-consent-check">
            <input type="checkbox" checked={privacyAcknowledged} onChange={(event) => onPrivacyAcknowledged(event.target.checked)} />
            <span>I understand this is not medical advice or a medical recommendation. I will not enter real patient details, and I will discuss any decision with a licensed clinician.</span>
          </label>
          <details>
            <summary>What should I leave out?</summary>
            <p>Do not enter names, full birthdays, addresses, phone numbers, emails, medical record numbers, insurance details, or photos. Use a made-up example or broad details only.</p>
          </details>
        </div>
      </section>

      <section className="mrc-demo-strip">
        <div><strong>Demo profiles (fictional)</strong><span>Made-up examples only. Do not enter real personal health details.</span></div>
        <div className="mrc-demo-strip__choices">
          {demoProfiles.map((demo) => (
            <button key={demo.id} type="button" onClick={() => onLoadDemo(demo.profile)}><b>{demo.tag}</b>{demo.label}</button>
          ))}
          <button type="button" className="mrc-demo-strip__clear" onClick={onReset}>Clear form</button>
        </div>
      </section>

      <section className="mrc-panel mrc-form-panel">
        <div className="mrc-fields">
          {fields.map((field) => (
            <label className={field.wide ? 'mrc-field mrc-field--wide' : 'mrc-field'} key={field.key}>
              <span>{field.label}</span>
              {field.type === 'condition' ? (
                <>
                  <input list="condition-suggestions" value={form.condition} onChange={(event) => onFieldChange(field.key, event.target.value)} placeholder={field.placeholder} />
                  <datalist id="condition-suggestions">{conditions.map((condition) => <option value={condition.value} key={condition.value} />)}</datalist>
                </>
              ) : field.type === 'select' ? (
                <select value={form[field.key] || ''} onChange={(event) => onFieldChange(field.key, event.target.value)}>
                  {field.options.map((option) => <option key={option || 'blank'} value={option}>{option || 'Select...'}</option>)}
                </select>
              ) : field.multiline ? (
                <textarea value={form[field.key] || ''} onChange={(event) => onFieldChange(field.key, event.target.value)} placeholder={field.placeholder} rows={3} />
              ) : (
                <input value={form[field.key] || ''} onChange={(event) => onFieldChange(field.key, event.target.value)} placeholder={field.placeholder} />
              )}
            </label>
          ))}
        </div>
        <p className="mrc-condition-status"><span className={isIpf ? 'mrc-condition-dot mrc-condition-dot--curated' : 'mrc-condition-dot'} />{isIpf ? 'IPF includes a carefully maintained reference set alongside current research and clinical trials.' : `${form.condition || 'This condition'} will be searched across current research and clinical-trial sources.`}</p>
      </section>

      <section className="mrc-ready-panel">
        <div>
          <h2>Ready when you are</h2>
          <p>We will find current clinical trials and source-linked research for <strong>{form.condition || 'your condition'}</strong>.</p>
          <p className={`mrc-service-note mrc-service-note--${serviceHealth.status}`} aria-live="polite">
            <Icon name={serviceHealth.status === 'offline' ? 'alert' : serviceHealth.status === 'ready' ? 'check' : 'clock'} size={15} />
            {serviceHealth.status === 'checking'
              ? 'Checking the local research service...'
              : serviceHealth.status === 'offline'
                ? 'The local research service is not connected yet. Start the app before running a report.'
                : serviceHealth.aiConfigured
                  ? 'Live research service connected. AI writing and a second source-check pass are enabled.'
                  : 'Live research service connected. Source and trial search will work; AI writing is not configured.'}
          </p>
        </div>
        <div className="mrc-ready-panel__actions">
          <button className="mrc-button mrc-button--ghost" type="button" onClick={onGoToResearch}><Icon name="brain" size={15} /> Go to research</button>
          <button className="mrc-button mrc-button--primary" type="submit" disabled={running || !form.condition?.trim() || !privacyAcknowledged}>
            {running ? <><span className="mrc-spinner" /> Researching</> : <><Icon name="search" size={16} /> Save & run full research</>}
          </button>
        </div>
      </section>
    </form>
  )
}

function IpfResearchWorkspace({ report, result, copied, onCopy }) {
  const trials = result?.trials || []
  return (
    <section className="mrc-research-report">
      <section className="mrc-panel mrc-research-report__summary">
        <div>
          <p className="mrc-kicker">IPF research report</p>
          <h1>{report.title}</h1>
          <p>{report.core.summary}</p>
        </div>
        <div className="mrc-trust-badge"><span>Research updated</span><strong>Source-linked</strong><small>{report.metadata.lastUpdated} reference set</small></div>
      </section>
      <section className="mrc-panel">
        <SectionHeader eyebrow="What is well established" title="What is already well-supported" action={<StatusPill tone="safe">Source-linked</StatusPill>} />
        <div className="core-grid">{report.core.keyPoints.map((item, index) => <article className="core-item" key={item.title}><span className="core-index">0{index + 1}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}</div>
        <CitationList citations={report.core.citations} />
      </section>
      <section className="mrc-panel">
        <SectionHeader eyebrow="Current treatment options" title="Treatment and support options" action={<button className="mrc-button mrc-button--ghost mrc-button--small" type="button" onClick={onCopy}><Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy brief'}</button>} />
        <div className="evidence-grid">{report.verifiedOptions.map((item) => <EvidenceCard item={item} key={item.name} />)}</div>
      </section>
      {result ? <ReportOverview condition={report.metadata.condition} result={result} /> : null}
      {result ? <ResearchIdeas condition={report.metadata.condition} result={result} /> : null}
      {result ? <LifestyleResearch result={result} /> : null}
      <section className="two-column-section">
        <section className="mrc-panel trials-surface">
          <SectionHeader eyebrow="Live registry" title="Recruiting IPF trials" action={<StatusPill tone={trials.length ? 'safe' : 'neutral'}>{trials.length ? `${trials.length} live results` : 'Run to refresh'}</StatusPill>} />
          {trials.length ? <div className="trial-list">{trials.map((trial) => <TrialCard key={trial.id} trial={trial} />)}</div> : <div className="empty-state"><Icon name="search" size={21} /><p>Run full research to retrieve current registry records.</p></div>}
        </section>
        <section className="mrc-panel centers-surface">
          <SectionHeader eyebrow="Specialist targets" title="Centers worth a real conversation" action={<StatusPill tone="neutral">Curated</StatusPill>} />
          <div className="center-list">{report.specialists.map((center, index) => <CenterCard key={center.name} center={{ ...center, index: String(index + 1).padStart(2, '0') }} />)}</div>
        </section>
      </section>
    </section>
  )
}

const reportExportText = ({ form, report, result }) => {
  const isIpf = /ipf|idiopathic pulmonary fibrosis/i.test(form.condition)
  const condition = displayConditionName(result?.patient?.condition || form.condition) || 'this condition'
  const citedLine = (text, citations) => [text, citationText(citations)].filter(Boolean).join(' ')
  const sources = result?.sources?.length ? result.sources : (isIpf ? report.core.citations : [])
  const sourceLines = sources.map((source) => `- ${source.origin || source.type || 'Source'}: ${sourceLabel(source)} (${source.url})`).join('\n')
  const coverageLines = (result?.sourceCoverage || []).map((lane) => `- ${lane.label}: ${lane.status}; ${lane.records || 0} records. ${lane.detail}`).join('\n')
  const trials = Array.isArray(result?.trials) ? result.trials : []
  const recruitingTrialLines = trials.filter(isRecruitingTrial).map((trial) => citedLine(`- ${trial.id}: ${trial.title}`, trial?.url ? [trial] : [])).join('\n')
  const otherCurrentTrialLines = trials.filter((trial) => !isRecruitingTrial(trial)).map((trial) => citedLine(`- ${trial.id}: ${trial.title}`, trial?.url ? [trial] : [])).join('\n')
  const patientLeadLines = patientDiscussionIdeasForReport(result, condition)
    .map((idea) => {
      const access = patientAccessForIdea(result, idea)
      return citedLine(
        `- ${idea.title}: ${idea.summary || idea.rationale || 'Named in current condition-specific research.'} Access today: ${access.label}. ${access.detail} Ask your healthcare provider: ${idea.providerQuestion || 'Is this worth discussing?'}`,
        claimCitations(result, idea, condition, { verifyWhenEmpty: idea.kind === 'exploration' }),
      )
  })
    .join('\n')
  const developmentPrograms = developmentProgramsForReport(result, condition)
  const researchProgramLines = developmentPrograms
    .map((program) => {
      const access = accessForResearchProgram(result, program)
      return citedLine(
        `- ${program.title}${program.category ? ` (${program.category})` : ''}: ${program.summary || program.rationale || `Named in research for ${condition}.`} Access: ${access.label}. ${access.detail} Expanded access is not confirmed for this program.`,
        [...claimCitations(result, program, condition), FDA_EXPANDED_ACCESS_SOURCE],
      )
    })
    .join('\n')
  const officialLabelLines = officialLabelIdeasForReport(result, condition)
    .map((idea) => citedLine(`- ${idea.title}: ${idea.summary} Boundary: ${idea.caution}`, claimCitations(result, idea, condition)))
    .join('\n')
  const theoryIdeas = theoryIdeasForReport(result, condition)
  const theoryLines = theoryIdeas
    .map((idea) => citedLine(
      `- ${idea.title}: ${idea.whyItCouldConnect} Not established: ${idea.whyNotEstablished} Ask your healthcare provider: ${idea.providerQuestion || 'What evidence supports this idea?'} Boundary: ${idea.caution}`,
      [...claimCitations(result, idea, condition), ...theoryVerificationLinks(condition, idea)],
    ))
    .join('\n')
  const lifestyleLines = lifestyleIdeasForReport(result, condition)
    .map((item) => citedLine(
      `- ${item.title}: ${item.summary}${item.providerQuestion ? ` Ask your healthcare provider: ${item.providerQuestion}` : ''} Boundary: ${item.caution}`,
      item.needsVerification ? lifestyleVerificationLinks(condition, item) : claimCitations(result, item, condition),
    ))
    .join('\n')
  const safetyLines = safetyIdeasForReport(result)
    .map((item) => citedLine(`- ${item.title}: ${item.summary} Context: ${item.caution}`, claimCitations(result, item, condition, { verifyWhenEmpty: item.needsVerification })))
    .join('\n')
  const centerLines = (result?.centers?.length ? result.centers : (isIpf ? report.specialists : []))
    .map((center) => citedLine(
      `- ${center.name}${center.city ? ` (${center.city})` : ''}: ${center.why || 'Condition-specific institution or study site.'}`,
      citationsFor(result, (center.trials || []).map((trial) => trial.id)),
    ))
    .join('\n')
  const researcherLines = (result?.researchers || [])
    .map((researcher) => citedLine(
      `- ${researcher.name}${researcher.affiliation ? ` (${researcher.affiliation})` : ''}: ${researcher.why || `${researcher.role || 'Study official'}${researcher.trials?.length ? `; ${researcher.trials.map((trial) => trial.id).filter(Boolean).join(', ')}` : ''}`}`,
      citationsFor(result, (researcher.trials || []).map((trial) => trial.id)),
    ))
    .join('\n')
  const reviewText = result?.review?.briefing?.text || result?.exploration?.briefing || 'This report is ready for a new source search.'
  const briefingCitations = citationsForClaim({
    result,
    sourceIds: result?.review?.briefing?.sourceIds,
    condition,
    searchTerms: searchTermsFor(result),
    verifyWhenEmpty: Boolean(result?.exploration && !result?.review?.briefing?.text),
  })
  const questions = Array.isArray(result?.review?.questions) && result.review.questions.length
    ? result.review.questions
    : (result?.exploration?.connections || []).map((item) => ({ text: item.question, kind: 'exploration', sourceIds: [] }))
  const questionLines = questions
    .filter((question) => question?.text)
    .map((question) => citedLine(`- ${question.text}`, claimCitations(result, question, condition, { verifyWhenEmpty: question.kind === 'exploration' })))
    .join('\n')
  const profileConditionDetails = [condition, form.geneticVariant, form.stage].filter(Boolean).join(' · ') || 'Not supplied'
  const profileTreatmentDetails = [form.currentMeds, form.priorTherapies].filter(Boolean).join(' · ') || 'Not supplied'
  const profileSymptomDetails = [form.symptoms, form.scans].filter(Boolean).join(' · ') || 'Not supplied'
  const accessPlanLines = [
    `- Condition details to bring: ${profileConditionDetails}`,
    `- Current and past treatments: ${profileTreatmentDetails}`,
    `- Symptoms and key test notes: ${profileSymptomDetails}`,
    recruitingTrialLines ? citedLine('- Study-site conversation: Open the recruiting records to check current contacts and enrollment rules.', trials.filter(isRecruitingTrial).slice(0, 3)) : `- Study-site conversation: Use ClinicalTrials.gov to check current studies for ${condition}.`,
  ].join('\n')
  const mapNote = result?.exploration
    ? 'AI starting map: These connections are not verified facts or personal treatment advice. Check trusted sources and a clinician before acting on any idea.'
    : 'Source-linked report: Use the cited records to check every treatment and research question.'
  return [
    `Researching My Condition - ${condition}`,
    '',
    'Important safety note',
    'This report is for learning and research only. It is not medical advice, a diagnosis, a prescription, or a medical recommendation. Do not start, stop, or change treatment based on this report. Talk with a licensed clinician before making a health decision.',
    '',
    'Privacy note',
    'This demo is not HIPAA-ready. Do not include real patient names, full birthdays, addresses, phone numbers, emails, medical record numbers, insurance details, or photos.',
    '',
    'Research context',
    `Location: ${form.location || 'Not supplied'}`,
    `Stage: ${form.stage || 'Not supplied'}`,
    `Current treatments: ${form.currentMeds || 'Not supplied'}`,
    '',
    '1. Condition overview',
    citedLine(reviewText, briefingCitations),
    '',
    '2. Approved and established options',
    officialLabelLines || 'Check the condition subtype, gene result, symptom, and related diagnoses in official labels before ruling out established options.',
    '',
    '3. Centers and experts',
    centerLines || 'Use the linked recruiting study records and a clinician or disease foundation directory to find an appropriate specialty team.',
    '',
    '4. Lifestyle changes worth discussing',
    lifestyleLines || 'Use the condition-specific lifestyle evidence searches to prepare questions for a clinician.',
    '',
    '5. Researched leads to discuss now',
    patientLeadLines || 'This lane stays separate from trial-only research. Use the approved-options and research-program sections to prepare the next discussion.',
    '',
    '6. Theory leads to verify',
    theoryLines || 'Use the condition-specific PubMed and trial searches to build a responsible theory list.',
    '',
    '7. Research programs that need a formal access route',
    researchProgramLines || 'Use the live trial directory to check programs that may need formal study enrollment or another verified access route.',
    '',
    '8. Current clinical trials',
    recruitingTrialLines || `Use ClinicalTrials.gov to check the latest recruiting studies for ${condition}.`,
    ...(otherCurrentTrialLines ? ['', 'Other current clinical studies', otherCurrentTrialLines] : []),
    '',
    '9. Your research and access plan',
    accessPlanLines,
    '',
    '10. Simple questions to ask your doctor',
    questionLines || 'Use the source-linked treatment and trial tables to prepare questions for a clinician.',
    '',
    'Report boundary',
    mapNote,
    '',
    '11. Important safety points',
    safetyLines || 'Use a clinician or pharmacist to review medicines, allergies, other conditions, and pregnancy status before acting on an idea.',
    '',
    'Researchers named in source records',
    researcherLines || 'Use the linked studies and specialty-center directories to find named research contacts.',
    '',
    'Sources',
    sourceLines || 'Live source links were not available in this run. Use the AI research map and a new live search to continue.',
    '',
    'Database coverage',
    coverageLines || 'No database coverage ledger has been retrieved yet.',
    '',
    'Research support, not medical advice. Verify sources with a licensed clinician.',
  ].join('\n')
}

function ExportActions({ onExportText, onExportWord, onExportPdf, disabled = false }) {
  return (
    <div className="mrc-export-actions">
      <button className="mrc-button mrc-button--ghost" type="button" onClick={onExportWord} disabled={disabled} title={disabled ? 'Run a report before exporting.' : 'Downloads a real .docx Word document.'}><Icon name="file" size={15} /> Full report Word (.docx)</button>
      <button className="mrc-button mrc-button--ghost" type="button" onClick={onExportPdf} disabled={disabled} title={disabled ? 'Run a report before exporting.' : 'Downloads a self-contained PDF report.'}><Icon name="download" size={15} /> Full report PDF</button>
      <button className="mrc-button mrc-button--ghost" type="button" onClick={onExportText} disabled={disabled} title={disabled ? 'Run a report before exporting.' : undefined}><Icon name="copy" size={15} /> Full report text</button>
    </div>
  )
}

function SourcesWorkspace({ result, onExportText, onExportWord, onExportPdf, canExport }) {
  const sources = result?.sources || []
  const trials = result?.trials || []
  const coverage = result?.sourceCoverage || []

  return (
    <section className="mrc-sources">
      <section className="mrc-panel mrc-sources__header">
        <div>
          <p className="mrc-kicker"><Icon name="database" size={15} /> Sources & exports</p>
          <h1>Sources and exports</h1>
          <p>Open the studies and current trial records used for this report. Your export includes the report, source links, and trial records.</p>
        </div>
        <ExportActions onExportText={onExportText} onExportWord={onExportWord} onExportPdf={onExportPdf} disabled={!canExport} />
      </section>
      {coverage.length ? <section className="mrc-panel source-coverage-surface"><SourceCoverage coverage={coverage} compact /></section> : null}
      <section className="mrc-panel">
        <SectionHeader eyebrow="Sources used in this report" title={`${sources.length} source links`} action={<StatusPill tone="safe">Openable</StatusPill>} />
        {sources.length ? <div className="mrc-source-list">{sources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" className="mrc-source-row" key={source.url || source.id}><span>{source.origin || source.type || 'Source'}</span><strong>{sourceLabel(source)}</strong><small>{source.summary || source.url}</small><Icon name="external" size={14} /></a>)}</div> : <div className="empty-state"><Icon name="database" size={21} /><p>Run full research from the Profile tab before treating any source list as evidence for this condition.</p></div>}
      </section>
      <section className="mrc-panel">
        <SectionHeader eyebrow="ClinicalTrials.gov" title="Live trial records" action={<StatusPill tone={trials.length ? 'safe' : 'neutral'}>{trials.length ? `${trials.length} results` : 'Run research'}</StatusPill>} />
        {trials.length ? <div className="trial-list">{trials.map((trial) => <TrialCard key={trial.id} trial={trial} />)}</div> : <div className="empty-state"><Icon name="search" size={21} /><p>Run full research from the Profile tab to add current ClinicalTrials.gov records.</p></div>}
      </section>
    </section>
  )
}

function LegacyApp() {
  const [form, setForm] = useState({ ...defaultIntake, condition: 'Idiopathic Pulmonary Fibrosis' })
  const [report, setReport] = useState(() => buildVerifiedReport(defaultIntake))
  const [runState, setRunState] = useState({ status: 'idle', result: null, error: '' })
  const [health, setHealth] = useState({ status: 'checking', aiConfigured: false })
  const [copied, setCopied] = useState(false)
  const [narrative, setNarrative] = useState('')
  const [intakeAssist, setIntakeAssist] = useState({ status: 'idle', message: '' })

  const isIpf = /ipf|idiopathic pulmonary fibrosis/i.test(form.condition)
  const pipeline = runState.result?.pipeline || baselinePipeline
  const liveTrials = runState.result?.trials || []
  const sourceLeads = runState.result?.leads || []
  const currentMedsPlaceholder = isIpf
    ? formOptions.currentMeds.join(', ')
    : 'Current medicines, supplements, procedures, or "none entered"'
  const historyPlaceholder = isIpf
    ? 'Pulmonary rehab, oxygen, hospitalizations, transplant evaluation...'
    : 'Prior medicines, procedures, flares, surgeries, or relevant history...'
  const recordsPlaceholder = isIpf
    ? 'HRCT, FVC trend, DLCO, oxygen needs, genotype...'
    : 'Labs, imaging, pathology, genetics, or relevant clinical notes...'

  const summaryPills = useMemo(() => [
    report.patient.stage || 'Stage not supplied',
    report.patient.location || 'Location not supplied',
    report.patient.currentMeds || 'No active therapy entered',
  ], [report])

  useEffect(() => {
    let active = true
    getResearchHealth()
      .then((data) => active && setHealth({ status: 'ready', ...data }))
      .catch(() => active && setHealth({ status: 'offline', aiConfigured: false }))
    return () => { active = false }
  }, [])

  const updateField = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const resetDemo = () => {
    const next = { ...defaultIntake, condition: 'Idiopathic Pulmonary Fibrosis' }
    setForm(next)
    startTransition(() => setReport(buildVerifiedReport(next)))
    setRunState({ status: 'idle', result: null, error: '' })
    setCopied(false)
    setNarrative('')
    setIntakeAssist({ status: 'idle', message: '' })
  }

  const fillProfileFromNarrative = async () => {
    if (!narrative.trim()) {
      setIntakeAssist({ status: 'held', message: 'Write a short description first, or complete the structured fields directly.' })
      return
    }

    setIntakeAssist({ status: 'running', message: 'Extracting only details that are explicitly stated...' })
    try {
      const result = await extractResearchIntake(narrative)
      const extracted = Object.fromEntries(Object.entries(result.intake || {}).filter(([, value]) => String(value || '').trim()))
      if (Object.keys(extracted).length) {
        setForm((current) => ({ ...current, ...extracted }))
        setRunState({ status: 'idle', result: null, error: '' })
      }
      setIntakeAssist({ status: result.status || 'held', message: result.message || 'Review the profile fields before running research.' })
    } catch (error) {
      setIntakeAssist({ status: 'error', message: error instanceof Error ? error.message : 'The profile assistant is unavailable. Complete the fields directly instead.' })
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    const patient = { ...form }
    if (isIpf) startTransition(() => setReport(buildVerifiedReport(patient)))
    setRunState({ status: 'running', result: null, error: '' })

    try {
      const result = await runResearchReview(patient)
      setRunState({ status: result.status === 'ready' ? 'ready' : 'held', result, error: '' })
    } catch (error) {
      setRunState({ status: 'error', result: null, error: error instanceof Error ? error.message : 'Could not reach the local research service.' })
    }
  }

  const copyBrief = async () => {
    const options = report.verifiedOptions.map((item) => `- ${item.name}: ${item.summary}`).join('\n')
    const text = `${report.title}\n\nVerified core\n${report.core.summary}\n\nEvidence-backed options\n${options}\n\nThis is educational decision-support, not medical advice.`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Evidence Atlas home">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>Evidence Atlas</span>
        </a>
        <div className="topbar-meta">
          <span className="version-label">Monday prototype</span>
          <StatusPill tone="safe"><Icon name="lock" size={13} /> Local-only session</StatusPill>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow hero-eyebrow"><span /> Clinical research, made legible</p>
            <h1>Separate what we <em>know</em> from what we are still testing.</h1>
            <p className="hero-text">A research briefing studio for complex conditions: reviewed evidence, live trial discovery, source-linked specialist or research-site discovery, and an explicit hypothesis lane that never masquerades as medical advice.</p>
            <div className="hero-signals">
              <span><Icon name="database" size={16} /> Curated + live sources</span>
              <span><Icon name="arrows" size={16} /> Two AI passes</span>
              <span><Icon name="shield" size={16} /> Claims can be withheld</span>
            </div>
          </div>

          <aside className="hero-method">
            <p className="eyebrow">The trust loop</p>
            <div className="method-steps">
              <div><span>01</span><p><strong>Retrieve</strong> Curated sources and live trial records arrive separately.</p></div>
              <div><span>02</span><p><strong>Draft</strong> A research agent can only cite the packet it receives.</p></div>
              <div><span>03</span><p><strong>Challenge</strong> A skeptical reviewer blocks unsupported language.</p></div>
              <div><span>04</span><p><strong>Discuss</strong> The person and their clinician decide what matters.</p></div>
            </div>
          </aside>
        </section>

        <section className="workspace-grid">
          <form className="intake-card" onSubmit={handleSubmit}>
            <div className="intake-heading">
              <div><p className="eyebrow">Research intake</p><h2>Build a briefing</h2></div>
              <button type="button" className="text-button" onClick={resetDemo}>Reset demo</button>
            </div>

            <section className="plain-language-intake" aria-labelledby="plain-language-title">
              <div>
                <p className="eyebrow">Optional plain-language intake</p>
                <h3 id="plain-language-title">Describe the situation as you would to a clinician.</h3>
                <p>The assistant copies only facts you write into the profile. It leaves missing facts blank and does not make a diagnosis.</p>
              </div>
              <textarea
                value={narrative}
                onChange={(event) => setNarrative(event.target.value)}
                placeholder={'Example: "A fictional person has IPF, takes pirfenidone, and has worsening dry cough. We want current trials."'}
                rows={3}
              />
              <div className="narrative-actions">
                <button className="secondary-button" type="button" onClick={fillProfileFromNarrative} disabled={intakeAssist.status === 'running'}>
                  {intakeAssist.status === 'running' ? <><span className="button-spinner button-spinner--accent" /> Filling profile</> : <><Icon name="spark" size={16} /> Fill profile from this</>}
                </button>
                {intakeAssist.message ? <p className={`narrative-status narrative-status--${intakeAssist.status}`} aria-live="polite">{intakeAssist.message}</p> : null}
              </div>
            </section>

            <label className="field field--wide">
              <span>Condition, subtype, gene, or phenotype</span>
              <input
                list="condition-suggestions"
                value={form.condition}
                onChange={(event) => {
                  updateField('condition', event.target.value)
                  setRunState({ status: 'idle', result: null, error: '' })
                }}
                placeholder="Type any condition, e.g. Crohn's Disease"
              />
              <datalist id="condition-suggestions">
                {conditions.map((condition) => <option value={condition.value} key={condition.value} />)}
              </datalist>
            </label>

            <div className="condition-status">
              <span className={isIpf ? 'condition-dot condition-dot--live' : 'condition-dot'} />
              <p>{isIpf ? 'IPF adds a curator-reviewed reference pack. Every other condition uses the same live retrieval, trial, writer, and reviewer workflow.' : `${form.condition || 'This condition'} will run through live PubMed retrieval, ClinicalTrials.gov, and the same source-gated review.`}</p>
            </div>
            <div className="condition-chips" aria-label="Suggested conditions">
              {conditions.map((condition) => (
                <button className={form.condition === condition.value ? 'condition-chip condition-chip--active' : 'condition-chip'} type="button" key={condition.value} onClick={() => {
                  updateField('condition', condition.value)
                  setRunState({ status: 'idle', result: null, error: '' })
                }}>{condition.label}</button>
              ))}
            </div>

            <div className="intake-fields">
              <label className="field"><span>Location</span><input value={form.location} onChange={(event) => updateField('location', event.target.value)} placeholder="Cleveland, OH" /></label>
              <label className="field"><span>Stage or severity</span><input value={form.stage} onChange={(event) => updateField('stage', event.target.value)} placeholder="Mild, moderate, advanced..." /></label>
              <label className="field field--wide"><span>Symptoms</span><textarea value={form.symptoms} onChange={(event) => updateField('symptoms', event.target.value)} placeholder={isIpf ? formOptions.symptoms.join(', ') : 'Symptoms, functional changes, flares, or "not entered"'} rows={3} /></label>
              <label className="field field--wide"><span>Current treatments</span><textarea value={form.currentMeds} onChange={(event) => updateField('currentMeds', event.target.value)} placeholder={currentMedsPlaceholder} rows={2} /></label>
              <label className="field field--wide"><span>Prior therapies or history</span><textarea value={form.priorTherapies} onChange={(event) => updateField('priorTherapies', event.target.value)} placeholder={historyPlaceholder} rows={2} /></label>
              <label className="field field--wide"><span>Labs, imaging, pathology, genetics, or notes</span><textarea value={form.scans} onChange={(event) => updateField('scans', event.target.value)} placeholder={recordsPlaceholder} rows={2} /></label>
              <label className="field field--wide"><span>What should this research answer?</span><textarea value={form.goals} onChange={(event) => updateField('goals', event.target.value)} placeholder="Map source-linked evidence, active research sites, and worthwhile research questions..." rows={2} /></label>
            </div>

            <button className="primary-button" type="submit" disabled={runState.status === 'running'}>
              {runState.status === 'running' ? <><span className="button-spinner" /> Running source-gated review</> : <><Icon name="spark" size={18} /> Run evidence review</>}
            </button>
            <p className="form-footnote"><Icon name="lock" size={13} /> Do not enter identifying information. The profile helper and a research run send supplied context to configured research APIs; this prototype does not persist it.</p>
          </form>

          <aside className="run-card">
            <div className="run-card-heading">
              <div><p className="eyebrow">Run monitor</p><h2>Trust before prose</h2></div>
              <span className={`run-state run-state--${runState.status}`}>{runState.status === 'running' ? 'Running' : runState.status === 'ready' ? 'Complete' : runState.status === 'error' ? 'Needs attention' : 'Ready'}</span>
            </div>
            <Pipeline items={pipeline} loading={runState.status === 'running'} />
            <div className="provider-strip">
              <span><Icon name="brain" size={15} /> Writer {health.status === 'checking' ? 'checking' : health.aiConfigured ? 'connected' : 'optional'}</span>
              <span><Icon name="search" size={15} /> Scout {health.status === 'checking' ? 'checking' : health.scoutConfigured ? 'connected' : 'optional'}</span>
            </div>
            {runState.error ? <div className="run-error"><Icon name="alert" size={17} /><p>{runState.error}</p></div> : null}
            {runState.status === 'held' ? <div className="run-held"><Icon name="shield" size={17} /><p>{runState.result?.message || 'This run is held by the source-pack rule.'}</p></div> : null}
          </aside>
        </section>

        {!isIpf ? <UniversalReport condition={form.condition} form={form} result={runState.result} /> : (
          <section className="report-shell">
            <div className="report-masthead">
              <div>
                <p className="eyebrow">Verified IPF brief</p>
                <h2>{report.title}</h2>
                <p>{report.core.summary}</p>
              </div>
              <div className="report-actions">
                <div className="evidence-score"><span>Trust floor</span><strong>Source-linked</strong><small>{report.metadata.lastUpdated} review set</small></div>
                <button className="secondary-button" type="button" onClick={copyBrief}><Icon name="copy" size={16} /> {copied ? 'Copied' : 'Copy core brief'}</button>
              </div>
            </div>

            <div className="summary-bar">
              {summaryPills.map((pill) => <span key={pill}>{pill}</span>)}
              <span><Icon name="shield" size={14} /> Missing data is flagged, not inferred</span>
            </div>

            <section className="verified-core section-surface">
              <SectionHeader eyebrow="Evidence floor" title="What is already well-supported" action={<StatusPill tone="safe"><Icon name="shield" size={13} /> Verified lane</StatusPill>} />
              <div className="core-grid">
                {report.core.keyPoints.map((item) => <article className="core-item" key={item.title}><span className="core-index">0{report.core.keyPoints.indexOf(item) + 1}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}
              </div>
              <CitationList citations={report.core.citations} />
            </section>

            <section className="section-surface">
              <SectionHeader eyebrow="Evidence-backed options" title="The trusted treatment and support lane" action={<p className="section-note">Cards include context and cautions, not prescribing.</p>} />
              <div className="evidence-grid">
                {report.verifiedOptions.map((item) => <EvidenceCard item={item} key={item.name} />)}
              </div>
            </section>

            <section className="exploratory-section section-surface">
              <SectionHeader eyebrow="Research workbench" title="Good questions are not the same as good treatments" action={<StatusPill tone="experimental"><Icon name="spark" size={13} /> Explicitly exploratory</StatusPill>} />
              <p className="section-intro">The workbench is where a care team can explore mechanisms, trial-fit questions, and things to monitor. Nothing here gets promoted into the trusted lane without direct evidence.</p>
              <div className="idea-grid">
                {report.brainstorm.map((idea) => (
                  <article className="idea-card" key={idea.title}>
                    <p className="card-kicker">{idea.label}</p>
                    <h3>{idea.title}</h3>
                    <p>{idea.thesis}</p>
                    <div className="idea-detail"><strong>Why it is on the radar</strong><span>{idea.why}</span></div>
                    <div className="idea-detail"><strong>Question for a center</strong><span>{idea.nextQuestion}</span></div>
                    <div className="idea-caution"><Icon name="shield" size={15} /><span>{idea.caution}</span></div>
                    <CitationList citations={idea.citations} compact />
                  </article>
                ))}
              </div>
            </section>

            <ReportOverview condition={form.condition} result={runState.result} />

            <section className="two-column-section">
              <section className="section-surface trials-surface">
                <SectionHeader eyebrow="Live registry" title="Recruiting IPF trials" action={<StatusPill tone={liveTrials.length ? 'safe' : 'neutral'}>{liveTrials.length ? `${liveTrials.length} live results` : 'Run to refresh'}</StatusPill>} />
                {liveTrials.length ? <div className="trial-list">{liveTrials.map((trial) => <TrialCard key={trial.id} trial={trial} />)}</div> : <div className="empty-state"><Icon name="search" size={21} /><p>ClinicalTrials.gov is queried only when you run the report, so this panel never pretends that a static list is current.</p></div>}
              </section>

              <section className="section-surface centers-surface">
                <SectionHeader eyebrow="Specialist targets" title="Centers worth a real conversation" action={<StatusPill tone="neutral">Location-aware</StatusPill>} />
                <div className="center-list">{report.specialists.map((center, index) => <CenterCard key={center.name} center={{ ...center, index: String(index + 1).padStart(2, '0') }} />)}</div>
                <div className="investigator-note"><Icon name="spark" size={16} /><p>Investigators in this source set: <strong>{report.investigators.join(', ')}</strong>.</p></div>
              </section>
            </section>

            {sourceLeads.length ? (
              <section className="source-leads section-surface">
                <SectionHeader eyebrow="Freshness scout" title="New leads waiting for human verification" action={<StatusPill tone="caution">Not verified evidence</StatusPill>} />
                <div className="lead-grid">
                  {sourceLeads.map((lead) => <a className="lead-card" href={lead.url} target="_blank" rel="noreferrer" key={lead.url}><span>{lead.source}</span><h3>{lead.title}</h3><p>{lead.whyReview}</p><small>{lead.status} <Icon name="external" size={12} /></small></a>)}
                </div>
              </section>
            ) : null}

            <section className="audit-section section-surface">
              <SectionHeader eyebrow="Evidence audit" title="The source ledger Dorothy can inspect" action={<span className="audit-count">{runState.result?.sources?.length || 13} pinned references</span>} />
              <div className="audit-grid">
                {(runState.result?.sources || []).length ? runState.result.sources.map((source) => <a className="audit-source" href={source.url} target="_blank" rel="noreferrer" key={source.id}><span>{source.type}</span><h3>{source.title}</h3><p>{source.summary}</p><small>{source.id} · {source.year || 'Date not listed'} <Icon name="external" size={12} /></small></a>) : report.core.citations.map((citation) => <a className="audit-source" href={citation.url} target="_blank" rel="noreferrer" key={citation.url}><span>pinned reference</span><h3>{citation.label}</h3><p>Source linked to the verified IPF evidence floor.</p><small><Icon name="external" size={12} /> Open source</small></a>)}
              </div>
            </section>

            {report.review.requiredInputs.length ? (
              <section className="missing-data section-surface">
                <div className="missing-icon"><Icon name="alert" size={21} /></div>
                <div><p className="eyebrow">Reviewer hold points</p><h2>What this brief refuses to guess</h2><div className="missing-list">{report.review.requiredInputs.map((item) => <p key={item}>{item}</p>)}</div></div>
              </section>
            ) : null}

            <footer className="report-footer">
              <div><Icon name="shield" size={18} /><p><strong>Research support, not medical advice.</strong> A licensed clinician and an experienced specialty center should make diagnosis and treatment decisions.</p></div>
              <div><Icon name="lock" size={18} /><p><strong>Prototype privacy note.</strong> This local demo does not persist intake, but the profile helper and a research run send supplied context to configured research APIs. It is not HIPAA-ready.</p></div>
            </footer>
          </section>
        )}
      </main>
    </div>
  )
}

void LegacyApp
void IpfResearchWorkspace

function App() {
  const [form, setForm] = useState(() => createInitialProfile())
  const [runState, setRunState] = useState({ status: 'idle', result: null, error: '' })
  const [narrative, setNarrative] = useState('')
  const [intakeAssist, setIntakeAssist] = useState({ status: 'idle', message: '' })
  const [activeTab, setActiveTab] = useState('profile')
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [siteAccess, setSiteAccess] = useState({ status: 'checking', message: '' })
  const [exportFeedback, setExportFeedback] = useState('')
  const [health, setHealth] = useState({ status: 'checking', aiConfigured: false })
  const activeRunController = useRef(null)
  const activeRunSequence = useRef(0)
  const reportStyle = 'plain'

  const report = buildVerifiedReport(form)
  const runStatusLabel = runState.status === 'running'
    ? 'Running full report'
    : runState.status === 'ready'
      ? 'Report complete'
    : runState.status === 'empty'
      ? 'Search needs attention'
      : runState.status === 'exploration'
      ? 'Report ready'
      : runState.status === 'held'
        ? 'Source report complete'
        : runState.status === 'error'
          ? 'Needs attention'
          : 'Ready to research'
  const reportFinished = runState.status === 'ready' || runState.status === 'held' || runState.status === 'exploration'
  const reportProgress = runState.status === 'running' ? 58 : reportFinished ? 100 : 0
  const canExport = Boolean(runState.result && reportFinished && runState.result.status !== 'empty')
  const reportServiceMessage = runState.result?.exploration
    ? runState.status === 'exploration'
      ? 'The report includes condition-specific ideas to explore. Check each idea with a trusted source and clinician.'
      : 'Source-linked research is ready. Extra ideas are clearly marked so you can check them before acting on them.'
    : runState.result
      ? runState.result.writer?.status === 'completed'
        ? 'AI organized the current research into plain language. Source links are included below.'
        : 'This report uses the current sources and trial records that were available for this run.'
    : health.status === 'checking'
      ? 'Checking the local research service...'
      : health.status === 'offline'
        ? 'The local research service is not connected.'
        : health.aiConfigured
          ? 'Live research service connected. AI writing and source checking are enabled.'
          : 'Live research service connected. Source and trial search will still work without AI writing.'

  useEffect(() => {
    let active = true
    getSiteAccessStatus()
      .then((data) => active && setSiteAccess({ status: data.access || 'locked', ...data }))
      .catch(() => active && setSiteAccess({ status: 'offline', message: 'The local access service is not available.' }))
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    if (siteAccess.status !== 'granted') {
      setHealth({ status: 'checking', aiConfigured: false })
      return () => { active = false }
    }
    getResearchHealth()
      .then((data) => active && setHealth({ status: 'ready', ...data }))
      .catch((error) => {
        if (!active) return
        if (error?.code === 'access_required') {
          setSiteAccess({ status: 'locked', message: 'Your access session ended. Enter the passcode again.' })
          return
        }
        setHealth({ status: 'offline', aiConfigured: false })
      })
    return () => { active = false }
  }, [siteAccess.status])

  useEffect(() => {
    return () => {
      activeRunController.current?.abort()
    }
  }, [])

  const abandonActiveRun = () => {
    if (!activeRunController.current) return
    activeRunSequence.current += 1
    activeRunController.current.abort()
    activeRunController.current = null
  }

  const lockSite = async () => {
    abandonActiveRun()
    try {
      await logoutSiteAccess()
    } catch {
      // Clear this browser's view even if the local server has already stopped.
    } finally {
      setSiteAccess({ status: 'locked', message: '' })
      setHealth({ status: 'checking', aiConfigured: false })
      setRunState({ status: 'idle', result: null, error: '' })
      setForm(createInitialProfile())
      setNarrative('')
      setIntakeAssist({ status: 'idle', message: '' })
      setPrivacyAcknowledged(false)
      setActiveTab('profile')
    }
  }

  const updateField = (key, value) => {
    abandonActiveRun()
    setForm((current) => ({ ...current, [key]: value }))
    setRunState({ status: 'idle', result: null, error: '' })
  }

  const resetProfile = () => {
    abandonActiveRun()
    setForm(createInitialProfile())
    setNarrative('')
    setIntakeAssist({ status: 'idle', message: '' })
    setRunState({ status: 'idle', result: null, error: '' })
  }

  const loadDemoProfile = (profile) => {
    abandonActiveRun()
    setForm(createInitialProfile(profile))
    setNarrative('')
    setIntakeAssist({ status: 'idle', message: 'Fictional demo profile loaded. Review every field before running research.' })
    setRunState({ status: 'idle', result: null, error: '' })
  }

  const loadSavedDemo = () => {
    const demo = demoProfiles.find((item) => item.id === 'rp-ush2a') || demoProfiles[0]
    if (!demo) return
    loadDemoProfile(demo.profile)
    setActiveTab('profile')
  }

  const fillProfileFromNarrative = async () => {
    if (!privacyAcknowledged) {
      setIntakeAssist({ status: 'held', message: 'Read and check the privacy and safety notice before using the profile helper.' })
      return
    }
    if (!narrative.trim()) {
      setIntakeAssist({ status: 'held', message: 'Write a short description first, or complete the profile directly.' })
      return
    }

    const directIdentifier = findDirectIdentifier(narrative)
    if (directIdentifier) {
      setIntakeAssist({ status: 'error', message: `Remove ${directIdentifier} before continuing. Do not send real patient details to this demo.` })
      return
    }

    setIntakeAssist({ status: 'running', message: 'Extracting only details explicitly stated...' })
    try {
      const result = await extractResearchIntake(narrative, { privacyAcknowledged })
      const extracted = Object.fromEntries(Object.entries(result.intake || {}).filter(([, value]) => String(value || '').trim()))
      if (Object.keys(extracted).length) {
        setForm((current) => ({ ...current, ...extracted }))
        setRunState({ status: 'idle', result: null, error: '' })
      }
      setIntakeAssist({ status: result.status || 'held', message: result.message || 'Review the profile fields before running research.' })
    } catch (error) {
      if (error?.code === 'access_required') setSiteAccess({ status: 'locked', message: 'Your access session ended. Enter the passcode again.' })
      setIntakeAssist({ status: 'error', message: error instanceof Error ? error.message : 'The profile helper is unavailable. Complete the fields directly instead.' })
    }
  }

  const startResearch = async () => {
    if (!form.condition?.trim()) {
      setActiveTab('profile')
      setRunState({ status: 'error', result: null, error: 'Enter a condition before starting research.' })
      return
    }
    if (!privacyAcknowledged) {
      setActiveTab('profile')
      setRunState({ status: 'error', result: null, error: 'Read and check the privacy and safety notice before running a report.' })
      return
    }
    const privacyIssue = findProfilePrivacyIssue(form)
    if (privacyIssue) {
      setActiveTab('profile')
      setRunState({ status: 'error', result: null, error: privacyIssueMessage(privacyIssue) })
      return
    }

    abandonActiveRun()
    const controller = new AbortController()
    const runSequence = activeRunSequence.current + 1
    activeRunSequence.current = runSequence
    activeRunController.current = controller
    setActiveTab('research')
    setRunState({ status: 'running', result: null, error: '' })
    try {
      const result = await runResearchReview({ ...form, reportStyle }, { signal: controller.signal, privacyAcknowledged })
      if (runSequence !== activeRunSequence.current) return
      const status = result.status === 'ready'
        ? 'ready'
        : result.status === 'empty'
          ? 'empty'
          : result.status === 'exploration'
            ? 'exploration'
          : 'held'
      setRunState({ status, result, error: '' })
    } catch (error) {
      if (runSequence !== activeRunSequence.current) return
      if (error?.code === 'access_required') {
        setSiteAccess({ status: 'locked', message: 'Your access session ended. Enter the passcode again.' })
        return
      }
      const message = error?.name === 'AbortError'
        ? 'Research was canceled. You can change the profile and run it again.'
        : error instanceof Error
          ? error.message
          : 'Could not reach the local research service.'
      setRunState({ status: 'error', result: null, error: message })
    } finally {
      if (runSequence === activeRunSequence.current) activeRunController.current = null
    }
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    void startResearch()
  }

  const cancelResearch = () => {
    if (!activeRunController.current) return
    abandonActiveRun()
    setRunState({ status: 'error', result: null, error: 'Research was canceled. You can change the profile and run it again.' })
  }

  const showExportFeedback = (message) => {
    setExportFeedback(message)
    window.setTimeout(() => setExportFeedback(''), 3_600)
  }

  const exportText = () => {
    if (!canExport) {
      showExportFeedback('Run and complete a report before exporting.')
      return
    }
    try {
      const filename = reportFilename(form.condition, 'txt')
      downloadExport(filename, reportExportText({ form, report, result: runState.result }), 'text/plain;charset=utf-8')
      showExportFeedback('Text report download started.')
    } catch {
      showExportFeedback('The text report could not be created. Please try again.')
    }
  }

  const exportWord = () => {
    if (!canExport) {
      showExportFeedback('Run and complete a report before exporting.')
      return
    }
    try {
      const text = reportExportText({ form, report, result: runState.result })
      const document = createWordDocument(`Researching My Condition - ${form.condition || 'Research report'}`, text)
      downloadExport(reportFilename(form.condition, 'docx'), document, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      showExportFeedback('Word (.docx) report download started.')
    } catch {
      showExportFeedback('The Word report could not be created. Please try again.')
    }
  }

  const exportPdf = () => {
    if (!canExport) {
      showExportFeedback('Run and complete a report before exporting.')
      return
    }
    try {
      const text = reportExportText({ form, report, result: runState.result })
      const pdf = createPdfDocument(`Researching My Condition - ${form.condition || 'Research report'}`, text)
      downloadExport(reportFilename(form.condition, 'pdf'), pdf, 'application/pdf')
      showExportFeedback('PDF report download started.')
    } catch {
      showExportFeedback('The PDF report could not be created. Please try again.')
    }
  }

  if (siteAccess.status !== 'granted') {
    return <SiteAccessGate access={siteAccess} onGranted={(result) => setSiteAccess({ status: 'granted', ...result })} />
  }

  return (
    <div className="mrc-app-shell">
      <WorkspaceHeader condition={form.condition} activeTab={activeTab} onTabChange={setActiveTab} onLock={() => void lockSite()} />
      <main id="top" className="mrc-main">
        {activeTab === 'profile' ? (
          <ProfileWorkspace
            form={form}
            onFieldChange={updateField}
            narrative={narrative}
            onNarrativeChange={setNarrative}
            intakeAssist={intakeAssist}
            onFillFromNarrative={fillProfileFromNarrative}
            onLoadDemo={loadDemoProfile}
            onReset={resetProfile}
            onSubmit={handleSubmit}
            onGoToResearch={() => setActiveTab('research')}
            running={runState.status === 'running'}
            serviceHealth={health}
            privacyAcknowledged={privacyAcknowledged}
            onPrivacyAcknowledged={setPrivacyAcknowledged}
          />
        ) : null}

        {activeTab === 'research' ? (
          <section className="mrc-reference-report">
            <div className="mrc-report-toolbar">
              <ExportActions onExportText={exportText} onExportWord={exportWord} onExportPdf={exportPdf} disabled={!canExport} />
              <button className="mrc-demo-load" type="button" onClick={loadSavedDemo}><Icon name="file" size={16} /> Load saved demo (not live)</button>
            </div>

            <section className="mrc-detail-hero">
              <div>
                <p className="mrc-kicker"><Icon name="brain" size={17} /> Detailed condition report</p>
                <h1>Detailed Condition Report</h1>
                <p className="mrc-detail-hero__subtitle">Research, current studies, treatment ideas, daily-life support, and specialist teams for <strong>{form.condition || 'your condition'}</strong>.</p>
                <p className="mrc-detail-hero__detail">Use this report to prepare questions for a clinician. It is not medical advice or a treatment plan.</p>
              </div>
              <span className={`mrc-hero-state mrc-hero-state--${runState.status}`}>{runStatusLabel}</span>
            </section>

            <section className="mrc-run-monitor mrc-run-monitor--reference">
              <div className="mrc-run-monitor__header">
                <div><p className="mrc-kicker">Research status</p><h2>{runStatusLabel}</h2><p>{runState.status === 'empty' ? 'The report needs a refresh. Keep the condition and try again.' : runState.status === 'exploration' ? 'Start with the treatment and research ideas below, then check each one with a trusted source and clinician.' : runState.result ? 'Start with the treatment ideas below, then use the source links when you want more detail.' : 'Run the report to search current research and active clinical studies.'}</p></div>
                <div className="mrc-run-monitor__actions">
                  <span className={`mrc-run-status mrc-run-status--${runState.status}`}>{runState.status === 'running' ? 'Searching' : runState.status === 'ready' ? 'Complete' : runState.status === 'exploration' ? 'Ideas ready' : runState.status === 'held' ? 'Source report' : runState.status === 'empty' || runState.status === 'error' ? 'Attention' : 'Ready'}</span>
                  {runState.status === 'running' ? <button className="mrc-run-action" type="button" onClick={cancelResearch}>Cancel report</button> : null}
                  {runState.status === 'empty' || runState.status === 'error' ? <button className="mrc-run-action" type="button" onClick={() => void startResearch()}><Icon name="arrows" size={14} /> Try again</button> : null}
                </div>
              </div>
              <div className={runState.status === 'running' ? 'mrc-run-progress mrc-run-progress--running' : 'mrc-run-progress'} aria-label={runState.status === 'running' ? 'Research is in progress' : 'Research progress'}>
                <span style={{ width: `${reportProgress}%` }} />
              </div>
              <div className="mrc-run-steps">
                <div className={runState.status === 'running' || reportFinished ? 'mrc-run-step mrc-run-step--done' : 'mrc-run-step'}>
                  <span>{runState.status === 'running' || reportFinished ? <Icon name="check" size={15} /> : <Icon name="search" size={15} />}</span>
                  <div><strong>Gather research</strong><p>Searches journals, source databases, and current ClinicalTrials.gov records.</p></div>
                </div>
                <div className={runState.status === 'running' ? 'mrc-run-step mrc-run-step--working' : reportFinished ? 'mrc-run-step mrc-run-step--done' : 'mrc-run-step'}>
                  <span>{runState.status === 'running' ? <Icon name="clock" size={15} /> : reportFinished ? <Icon name="check" size={15} /> : <Icon name="file" size={15} />}</span>
                  <div><strong>Write your report</strong><p>Builds a plain-language, source-linked report for clinician discussion.</p></div>
                </div>
              </div>
              <p className={`mrc-service-status mrc-service-status--${health.status}`}><Icon name={health.status === 'offline' ? 'alert' : health.status === 'checking' ? 'clock' : 'shield'} size={15} /> {reportServiceMessage}</p>
              {runState.error ? <div className="mrc-run-error"><Icon name="alert" size={16} /> {runState.error}</div> : null}
            </section>
            <div className="mrc-report-stage">
              <UniversalReport condition={form.condition} form={form} result={runState.result} />
            </div>
          </section>
        ) : null}

        {activeTab === 'sources' ? <SourcesWorkspace result={runState.result} onExportText={exportText} onExportWord={exportWord} onExportPdf={exportPdf} canExport={canExport} /> : null}
      </main>
      <footer className="mrc-footer">
        <p><strong>For learning and research only.</strong> This tool is not medical advice, a diagnosis, a prescription, or a medical recommendation. Talk with a licensed clinician before making a health decision. If this may be an emergency, call 911 or your local emergency number.</p>
        <p><strong>Privacy:</strong> This demo is not HIPAA-ready. Do not enter real patient details. The app does not save the form after a run, but the research details you enter are sent to the source services and AI providers used to prepare the report.</p>
      </footer>
      {exportFeedback ? <div className="mrc-export-toast" role="status">{exportFeedback}</div> : null}
      <div className="mrc-fixed-disclaimer"><strong>NOT MEDICAL ADVICE OR MEDICAL RECOMMENDATION.</strong> For research only. Do not enter real patient details. Talk with a licensed clinician before making a health decision.</div>
    </div>
  )
}

export default App
