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

const sourceLabel = (source) => source?.label || source?.title || 'Source'

const citationsFor = (result, sourceIds) => {
  if (!sourceIds?.length) return []
  const byId = new Map(
    [...(result?.sources || []), ...(result?.trials || [])]
      .filter((item) => item?.id && item?.url)
      .map((item) => [item.id, item]),
  )
  return sourceIds.map((id) => byId.get(id)).filter(Boolean)
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

const treatmentInterventionsForTrial = (trial) => {
  if (trial?.conditionMatch === 'broad' || trial?.treatmentFocus === false) return []
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
  if (['DRUG', 'BIOLOGICAL', 'COMBINATION_PRODUCT', 'DIETARY_SUPPLEMENT', 'GENETIC'].includes(type)) return 3
  if (['DEVICE', 'PROCEDURE', 'RADIATION'].includes(type)) return 1
  return 2
}

const trialInterventionIdeas = (trials, condition) => {
  const byIntervention = new Map()
  const conditionLabel = String(condition || 'this condition').trim() || 'this condition'
  let appearanceOrder = 0

  for (const trial of trials || []) {
    const interventions = treatmentInterventionsForTrial(trial)

    for (const intervention of interventions) {
      const title = String(intervention?.title || '').replace(/\s+/g, ' ').trim()
      if (title.length < 2 || !isDisplayableTrialIntervention(title)) continue

      const key = treatmentIdeaKey(title) || title.toLocaleLowerCase()
      const priority = treatmentTypePriority(intervention?.type) * 10 + trialStatusPriority(trial?.status)
      const idea = byIntervention.get(key) || { title, trials: [], priority, appearanceOrder: appearanceOrder++ }
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
        rationale: `This treatment is in ${studyCount} current ${studyLabel} for ${conditionLabel}.`,
        boundary: caution || 'A study listing only shows that researchers are testing it. It does not show that it works, is safe, or is right for this person.',
        requiresExtraReview: Boolean(caution),
      }
    })
}

const treatmentIdeaKey = (title) => String(title || '')
  .toLowerCase()
  .replace(/^(?:drug|biological|combination product|dietary supplement|genetic|device|procedure|radiation):\s*/g, '')
  .replace(/\b(?:low|high|intermediate|selected)\s+dose\b/g, '')
  .replace(/\b(?:standard|modified)\s+corticosteroid regimen\b/g, '')
  .replace(/\bgene therapy\b/g, '')
  .replace(/\b(?:hydrochloride|dihydrochloride|tartrate|mesylate|sodium|tablets?|capsules?|extended[- ]release)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

const sourceTreatmentMatchers = [
  { category: 'Gene therapy research', pattern: /\b(?:gene therapy|aav\d*|optogenetic|antisense oligonucleotide|gene editing)\b/i },
  { category: 'Cell or exosome research', pattern: /\b(?:stem cell|cell therapy|exosome|extracellular vesicle|cell-derived)\b/i },
  { category: 'Drug or supplement research', pattern: /\b(?:drug|medicine|oral|vitamin|supplement|fish oil|antioxidant|peptide|capsule|tablet)\b/i },
  { category: 'Procedure or device research', pattern: /\b(?:surgery|transplant|vitrectomy|implant|laser|device|prosthe)\b/i },
]

const sourceTreatmentIdeas = (sources, condition) => {
  const ideas = []
  for (const source of sources || []) {
    const title = String(source?.title || '').replace(/[.\s]+$/, '').trim()
    const sourceText = `${title} ${source?.summary || ''}`
    const match = sourceTreatmentMatchers.find((entry) => entry.pattern.test(sourceText))
    if (!title || !source?.id || !match || !isDisplayableTrialIntervention(title)) continue
    ideas.push({
      title: title.length > 150 ? `${title.slice(0, 147).trimEnd()}...` : title,
      category: match.category,
      summary: String(source.summary || 'This article describes a treatment topic being researched for this condition.').slice(0, 440),
      whyItMayMatter: `This source names a treatment topic being studied for ${condition || 'this condition'}.`,
      caution: 'A research article is not proof that a treatment works or is right for one person. Review the full source with a clinician.',
      sourceIds: [source.id],
      kind: 'source',
    })
    if (ideas.length === 6) break
  }
  return ideas
}

const explorationTreatmentIdeas = (result) => (Array.isArray(result?.exploration?.treatmentPaths) ? result.exploration.treatmentPaths : [])
  .map((idea) => ({
    ...idea,
    category: 'AI research path',
    kind: 'exploration',
    requiresExtraReview: true,
  }))
  .filter((idea) => idea.title && idea.summary && idea.caution)

const treatmentIdeasForReport = (result, condition) => {
  const sourcedIdeas = Array.isArray(result?.review?.treatmentIdeas) ? result.review.treatmentIdeas : []
  const labelIdeas = (result?.sources || [])
    .filter((source) => source?.origin === 'openFDA' || /FDA drug label/i.test(source?.type || ''))
    .map((source) => {
      const title = sourceLabel(source).replace(/^FDA label:\s*/i, '').trim()
      return {
        title,
        category: 'FDA label',
        summary: source.summary,
        whyItMayMatter: `This medicine has a U.S. prescribing label that mentions ${condition || 'this condition'}.`,
        caution: 'A label applies to a specific diagnosis and situation. A clinician must decide whether it applies here.',
        sourceIds: [source.id],
        kind: 'source',
      }
    })
    .filter((idea) => idea.title && !/^drug product$/i.test(idea.title) && isDisplayableTrialIntervention(idea.title))
  const treatmentIdeas = []
  const treatmentKeys = new Set()

  for (const idea of [...sourcedIdeas, ...labelIdeas]) {
    const key = treatmentIdeaKey(idea?.title)
    if (!key || treatmentKeys.has(key)) continue
    treatmentKeys.add(key)
    treatmentIdeas.push({ ...idea, kind: 'source' })
  }
  for (const idea of trialInterventionIdeas(result?.trials, condition).slice(0, 6)) {
    const key = treatmentIdeaKey(idea?.title)
    if (!key || treatmentKeys.has(key)) continue
    treatmentKeys.add(key)
    treatmentIdeas.push({ ...idea, kind: 'trial' })
  }
  for (const idea of sourceTreatmentIdeas(result?.sources, condition)) {
    const key = treatmentIdeaKey(idea?.title)
    if (!key || treatmentKeys.has(key)) continue
    treatmentKeys.add(key)
    treatmentIdeas.push(idea)
  }

  if (!treatmentIdeas.length) {
    treatmentIdeas.push(...explorationTreatmentIdeas(result))
  }

  return treatmentIdeas.slice(0, 10)
}

const sourceConnectionIdeas = (sources, condition) => (sources || [])
  .filter((source) => source?.id && source?.title)
  .slice(0, 4)
  .map((source) => ({
    title: `What could this research direction mean for ${condition || 'this condition'}?`,
    candidate: source.title,
    mechanism: source.summary || source.title,
    whyItIsAQuestion: 'This source is a useful starting point for connecting the condition to a treatment or pathway question.',
    caution: 'This is a research question based on a source title or abstract, not a personal treatment suggestion.',
    sourceIds: [source.id],
    kind: 'source',
  }))

const explorationConnectionIdeas = (result) => (Array.isArray(result?.exploration?.connections) ? result.exploration.connections : [])
  .map((idea) => ({
    title: idea.title,
    candidate: idea.researchAngle,
    mechanism: idea.whyItCouldConnect,
    whyItIsAQuestion: idea.question,
    caution: idea.caution,
    sourceIds: [],
    kind: 'exploration',
  }))
  .filter((idea) => idea.title && idea.whyItIsAQuestion && idea.caution)

const lifestyleSourceMatchers = [
  { title: 'Rehabilitation and activity', pattern: /pulmonary rehabilitation|physical therapy|exercise training|exercise program|vision rehabilitation/i },
  { title: 'Tobacco and smoke exposure', pattern: /smoking cessation|tobacco|secondhand smoke|smoke exposure/i },
  { title: 'Food and nutrition', pattern: /\b(?:diet|nutrition|nutritional|dietary)\b/i },
  { title: 'Sleep and daily routine', pattern: /\b(?:sleep|insomnia|circadian)\b/i },
  { title: 'Environmental exposures', pattern: /\b(?:environmental|occupational|air pollution|sun exposure|ultraviolet)\b/i },
  { title: 'Daily-life coping and vision support', pattern: /\b(?:coping|quality of life|low vision|daily living)\b/i },
]

const plainLifestyleFallbackSummary = (title) => ({
  'Rehabilitation and activity': 'This source looks at rehabilitation or activity programs for people with this condition.',
  'Tobacco and smoke exposure': 'This source discusses tobacco or smoke exposure in people with this condition.',
  'Food and nutrition': 'This source discusses food or nutrition in people with this condition.',
  'Sleep and daily routine': 'This source discusses sleep or daily routine in people with this condition.',
  'Environmental exposures': 'This source discusses environmental exposures that may matter for this condition.',
  'Daily-life coping and vision support': 'This source looks at day-to-day coping or vision support for people living with this condition.',
}[title] || 'This source discusses a daily-life topic that may matter for this condition.')

const lifestyleIdeasForReport = (result) => {
  const reviewedIdeas = Array.isArray(result?.review?.lifestyle) ? result.review.lifestyle : []
  if (reviewedIdeas.length) return reviewedIdeas

  const fallbackIdeas = []
  const usedTopics = new Set()
  for (const source of result?.sources || []) {
    const sourceText = `${source?.title || ''} ${source?.summary || ''}`
    const match = lifestyleSourceMatchers.find((entry) => entry.pattern.test(sourceText))
    if (!match || usedTopics.has(match.title) || !source?.id) continue
    usedTopics.add(match.title)
    fallbackIdeas.push({
      title: match.title,
      summary: plainLifestyleFallbackSummary(match.title),
      caution: 'This is a research finding in groups, not a personal plan. Discuss whether it fits the person’s condition and safety needs with a clinician.',
      sourceIds: [source.id],
      sourceLinkedFallback: true,
    })
    if (fallbackIdeas.length === 3) break
  }

  if (fallbackIdeas.length) return fallbackIdeas

  return (Array.isArray(result?.exploration?.lifestyle) ? result.exploration.lifestyle : [])
    .map((item) => ({ ...item, sourceIds: [], needsVerification: true }))
    .filter((item) => item.title && item.summary && item.caution)
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
      <p className="card-summary">{item.summary}</p>
      <dl className="evidence-facts">
        <div><dt>What to ask about</dt><dd>{item.useCase}</dd></div>
        <div><dt>What the evidence says</dt><dd>{item.rationale}</dd></div>
        <div><dt>Things to watch</dt><dd>{item.watchouts}</dd></div>
      </dl>
      <CitationList citations={item.citations} compact />
    </article>
  )
}

function TrialCard({ trial }) {
  return (
    <article className="trial-card">
      <div className="card-topline">
        <div>
          <p className="card-kicker">{trial.phase}</p>
          <h3>{trial.title}</h3>
        </div>
        <a className="nct-link" href={trial.url} target="_blank" rel="noreferrer">{trial.id}<Icon name="external" size={13} /></a>
      </div>
      <p>{trial.summary}</p>
      <div className="trial-meta">
        <span><strong>{trial.status}</strong></span>
        <span>{trial.location}</span>
        <span>{trial.interventions?.join(', ') || 'Intervention not listed'}</span>
      </div>
      {trial.caution ? <p className="trial-caution"><Icon name="alert" size={15} />{trial.caution}</p> : null}
      <p className="trial-sponsor">Sponsor: {trial.sponsor}</p>
    </article>
  )
}

function CenterCard({ center }) {
  return (
    <article className="center-card">
      <div className="center-number">{center.index}</div>
      <div>
        <h3>{center.name}</h3>
        <p className="center-location">{center.city}</p>
        {center.researchRegionPriority ? <span className="center-priority">U.S. / Europe site preference</span> : null}
        <p>{center.why}</p>
      </div>
    </article>
  )
}

function ResearcherCard({ researcher }) {
  const trialIds = (researcher.trials || []).map((trial) => trial.id).filter(Boolean)
  return (
    <article className="researcher-card">
      <p className="card-kicker">{researcher.role || 'Research record'}</p>
      <h3>{researcher.name}</h3>
      {researcher.affiliation ? <p className="researcher-affiliation">{researcher.affiliation}</p> : null}
      <p>{researcher.why || (trialIds.length ? `Named in the ClinicalTrials.gov record${trialIds.length === 1 ? '' : 's'} for ${trialIds.join(', ')}.` : 'Named in the condition research sources.')}</p>
      {trialIds.length ? <span className="researcher-trials">{trialIds.join(' · ')}</span> : null}
    </article>
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

function ReportOverview({ condition, result }) {
  const review = result?.review
  const exploration = result?.exploration
  const briefing = review?.briefing?.text || exploration?.briefing
  const briefingCitations = citationsFor(result, review?.briefing?.sourceIds)
  const questions = Array.isArray(review?.questions) && review.questions.length
    ? review.questions
    : (Array.isArray(exploration?.connections) ? exploration.connections : [])
      .map((item) => ({ text: item.question }))
      .filter((item) => item.text)

  return (
    <section className="report-overview section-surface">
      <SectionHeader
        eyebrow="Your overview"
        title={`What we found about ${condition || 'this condition'}`}
        action={exploration && !review?.briefing?.text ? <StatusPill tone="caution">Research ideas to verify</StatusPill> : null}
      />
      {briefing ? <p className="report-overview__briefing">{briefing}</p> : <p className="report-overview__briefing">This report brings together treatment research, daily-life questions, current studies, and source links for discussion with a clinician.</p>}
      {briefingCitations.length ? <CitationList citations={briefingCitations} compact /> : null}
      {questions.length ? (
        <div className="report-overview__questions">
          <h3>Questions to bring to a visit</h3>
          {questions.slice(0, 4).map((question, index) => <p key={`${question.text}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span>{question.text}</p>)}
        </div>
      ) : null}
    </section>
  )
}

function ResearchIdeas({ condition, result }) {
  const treatmentIdeas = treatmentIdeasForReport(result, condition)
  const reviewerIdeas = Array.isArray(result?.review?.hypotheses) ? result.review.hypotheses : []
  const explorationIdeas = explorationConnectionIdeas(result)
  const sourceIdeas = sourceConnectionIdeas(result?.sources, condition)
  const treatmentMapOnly = treatmentIdeas.length > 0 && treatmentIdeas.every((idea) => idea.kind === 'exploration')
  const brainstormingIdeas = reviewerIdeas.length
    ? reviewerIdeas.map((idea) => ({ ...idea, kind: 'source' }))
    : explorationIdeas.length
      ? explorationIdeas
      : sourceIdeas.length
        ? sourceIdeas
        : treatmentIdeas.slice(0, 10).map((idea) => ({
      title: `Could ${idea.title} be worth asking about?`,
      candidate: idea.title,
      mechanism: idea.kind === 'source' && idea.category !== 'FDA label' ? idea.whyItMayMatter || '' : '',
      whyItIsAQuestion: idea.whyItMayMatter || idea.rationale || 'This named treatment appears in current condition-specific research.',
      caution: idea.caution || idea.boundary || 'This is a research question, not a personal treatment suggestion.',
      sourceIds: idea.sourceIds || [],
      trials: idea.trials || [],
      kind: idea.kind,
    }))
  const connectionMapOnly = brainstormingIdeas.length > 0 && brainstormingIdeas.every((idea) => idea.kind === 'exploration')

  return (
    <section className="research-ideas section-surface">
      <SectionHeader
        eyebrow="Treatment research"
        title="Drug and treatment ideas to discuss"
      />
      <p className="section-intro">The first list shows source-linked treatments when available. The second makes careful connections worth checking. Neither list is a personal treatment plan.</p>

      <div className="research-idea-lanes">
        <section className="research-idea-lane">
          <div className="research-idea-lane__header">
            <div><p className="card-kicker">Treatment ideas from research</p><p>{treatmentMapOnly ? 'Possible treatment paths generated by AI. Check each one against trusted sources.' : 'Drugs, supplements, devices, procedures, and cell or gene treatments named in sources or current studies.'}</p></div>
            <StatusPill tone={treatmentIdeas.length ? (treatmentMapOnly ? 'caution' : 'safe') : 'neutral'}>{treatmentIdeas.length ? (treatmentMapOnly ? 'Ideas to verify' : 'Source-linked') : 'Search guide'}</StatusPill>
          </div>
          {treatmentIdeas.length ? (
            <div className="research-ideas-grid">
              {treatmentIdeas.slice(0, 10).map((idea) => (
                <article className={idea.requiresExtraReview || idea.kind === 'exploration' ? 'idea-card research-idea-card research-idea-card--caution' : 'idea-card research-idea-card'} key={idea.title}>
                  <div className="card-topline">
                    <div><p className="card-kicker">{idea.kind === 'exploration' ? 'AI research path' : idea.kind === 'trial' ? 'Active study' : idea.category || 'Treatment lead'}</p><h3>{idea.title}</h3></div>
                    <StatusPill tone={idea.requiresExtraReview || idea.kind === 'exploration' ? 'caution' : 'safe'}>{idea.kind === 'exploration' ? 'Verify first' : idea.requiresExtraReview ? 'Extra review' : idea.category === 'FDA label' ? 'FDA label' : idea.kind === 'trial' ? 'Active study' : 'Research lead'}</StatusPill>
                  </div>
                  <p>{idea.summary || idea.rationale}</p>
                  {idea.whyItMayMatter ? <p className="research-idea-why"><strong>Why it may matter:</strong> {idea.whyItMayMatter}</p> : null}
                  <div className="research-idea-boundary"><Icon name="shield" size={16} /><span>{idea.caution || idea.boundary}</span></div>
                  <CitationList citations={idea.kind === 'trial' ? idea.trials : citationsFor(result, idea.sourceIds)} compact />
                </article>
              ))}
            </div>
          ) : (
            <div className="research-idea-empty"><Icon name="search" size={18} /><p>Use a subtype, gene result, symptom pattern, or treatment goal to build more focused treatment search directions.</p></div>
          )}
        </section>

        <section className="research-idea-lane research-idea-lane--exploratory">
          <div className="research-idea-lane__header">
            <div><p className="card-kicker">AI connections to explore</p><p>{connectionMapOnly ? 'These are careful AI-generated connections. Verify them before treating them as facts.' : 'These are early questions based on the current research. They are not treatment recommendations.'}</p></div>
            <StatusPill tone={brainstormingIdeas.length ? (connectionMapOnly ? 'caution' : 'experimental') : 'neutral'}>{brainstormingIdeas.length ? (connectionMapOnly ? 'Verify each idea' : 'Explore carefully') : 'Search guide'}</StatusPill>
          </div>
          {brainstormingIdeas.length ? (
            <div className="research-ideas-grid">
              {brainstormingIdeas.slice(0, 10).map((idea) => (
                <article className="idea-card research-idea-card research-idea-card--exploratory" key={idea.title}>
                  <div className="card-topline">
                    <div><p className="card-kicker">{idea.kind === 'exploration' ? 'AI connection' : 'Idea to explore'}</p><h3>{idea.title}</h3></div>
                    <StatusPill tone={idea.kind === 'exploration' ? 'caution' : 'experimental'}>{idea.kind === 'exploration' ? 'Verify first' : 'Exploratory'}</StatusPill>
                  </div>
                  {idea.candidate ? <p className="research-idea-candidate"><strong>Research topic:</strong> {idea.candidate}</p> : null}
                  <p><strong>Why explore:</strong> {idea.whyItIsAQuestion}</p>
                  {idea.mechanism ? <p className="research-idea-why"><strong>What researchers are looking at:</strong> {idea.mechanism}</p> : null}
                  <div className="research-idea-boundary"><Icon name="alert" size={16} /><span>{idea.caution}</span></div>
                  <CitationList citations={idea.kind === 'trial' ? idea.trials : citationsFor(result, idea.sourceIds)} compact />
                </article>
              ))}
            </div>
          ) : (
            <div className="research-idea-empty research-idea-empty--exploratory"><Icon name="shield" size={18} /><p>Add a subtype, gene result, symptoms, or a treatment question to make this connection map more specific.</p></div>
          )}
        </section>
      </div>
    </section>
  )
}

function LifestyleResearch({ result }) {
  const lifestyle = lifestyleIdeasForReport(result)
  const hasFallback = lifestyle.some((item) => item.sourceLinkedFallback)
  const hasStartingMap = lifestyle.some((item) => item.needsVerification)

  return (
    <section className="lifestyle-research section-surface">
      <SectionHeader
        eyebrow="Lifestyle & environment"
        title="Lifestyle changes worth discussing"
        action={<StatusPill tone={lifestyle.length ? (hasStartingMap ? 'caution' : 'safe') : 'neutral'}>{lifestyle.length ? (hasStartingMap ? 'Ideas to verify' : hasFallback ? 'Source-linked' : 'Research-backed') : 'Search guide'}</StatusPill>}
      />
      <p className="section-intro">{hasStartingMap ? 'These are condition-relevant daily-life questions generated by AI. Check them with trusted sources and a clinician before acting on them.' : 'These are research findings about daily life that may matter for this condition. They are not personal medical instructions.'}</p>
      {lifestyle.length ? (
        <div className="lifestyle-grid">
          {lifestyle.map((item) => (
            <article className="lifestyle-card" key={item.title}>
              <p className="card-kicker">{item.needsVerification ? 'AI starting map' : 'Discussion point'}</p>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <div className="lifestyle-caution"><Icon name="shield" size={16} /><span>{item.caution}</span></div>
              <CitationList citations={citationsFor(result, item.sourceIds)} compact />
            </article>
          ))}
        </div>
      ) : (
        <RequiredSectionEmptyState title="Build a more specific lifestyle search next." icon="shield">Add symptoms, activity limits, a subtype, or an environmental concern to focus this section on the person’s actual questions.</RequiredSectionEmptyState>
      )}
    </section>
  )
}

function SafetyResearch({ result }) {
  const safety = safetyIdeasForReport(result)
  const hasFallback = safety.some((item) => item.sourceLinkedFallback)
  const hasStartingMap = safety.some((item) => item.needsVerification)

  return (
    <section className="safety-research section-surface">
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
              <p>{item.summary}</p>
              <div className="safety-caution"><Icon name="alert" size={16} /><span>{item.caution}</span></div>
              <CitationList citations={citationsFor(result, item.sourceIds)} compact />
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
  const trialCount = result?.trials?.length || 0
  const resultIsEmpty = result?.status === 'empty'
  const resultIsExploration = result?.status === 'exploration'
  const hasAiStartingMap = Boolean(result?.exploration)
  const centerMode = result?.centerMode === 'active-research-sites'
  const clinicalTrialsSearchUrl = `https://clinicaltrials.gov/search?cond=${encodeURIComponent(condition || '')}`
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
          <h2>{condition || 'Condition'} research workspace</h2>
          <p>
            {result
              ? resultIsEmpty
                ? `The live research search needs another try for ${condition}.`
                : resultIsExploration
                  ? `This AI research map makes condition-specific connections for ${condition}. Every idea is clearly marked for source verification.`
                : `This report brings together treatment research, current trials, daily-life research, and specialist or study-site information for ${condition}.`
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
          <ReportOverview condition={condition} result={result} />
          <SafetyResearch result={result} />
          <ResearchIdeas condition={condition} result={result} />
          <LifestyleResearch result={result} />

          <section className="two-column-section">
            <section className="section-surface centers-surface">
              <SectionHeader eyebrow="Institutions & specialists" title={centerMode ? 'Research institutions and study sites' : 'Institutions in this source pack'} action={<StatusPill tone="neutral">Location-aware</StatusPill>} />
              {result.centers?.length ? <div className="center-list">{result.centers.map((center, index) => <CenterCard key={`${center.name}-${center.city}`} center={{ ...center, index: String(index + 1).padStart(2, '0') }} />)}</div> : <RequiredSectionEmptyState title={hasAiStartingMap ? 'Find a specialty team next.' : 'Use the live trial search to find study sites.'} icon="search">{hasAiStartingMap ? <>Use the research questions and search directions in this map to find academic disease-specific centers, then confirm expertise with a clinician or disease foundation.</> : <>You can also ask a clinician or disease foundation for a specialist directory. The app will not invent a “best doctor” list.</>}</RequiredSectionEmptyState>}
              {result.researchers?.length ? (
                <div className="researcher-section">
                  <h3>Researchers named in the source records</h3>
                  <p>These people are named in a curated condition source or a current trial record. This is not a quality ranking or a referral list.</p>
                  <div className="researcher-grid">{result.researchers.map((researcher) => <ResearcherCard key={`${researcher.name}-${researcher.affiliation}`} researcher={researcher} />)}</div>
                </div>
              ) : null}
              <div className="investigator-note"><Icon name="shield" size={16} /><p>{centerMode ? <><strong>Important:</strong> these are active research sites, not a quality ranking or a guarantee of eligibility. When registry sites are otherwise comparable, U.S. and European locations are shown first as a research-navigation preference.</> : <>The institution list comes from the condition’s curated source pack.</>}</p></div>
            </section>

            <section className="section-surface trials-surface">
              <SectionHeader eyebrow="Current clinical trials" title={`Current ${condition} trials`} action={<StatusPill tone={trialCount ? 'safe' : 'neutral'}>{trialCount ? `${trialCount} live results` : hasAiStartingMap ? 'Search next' : 'Registry search'}</StatusPill>} />
              {trialCount ? <div className="trial-list">{result.trials.map((trial) => <TrialCard key={trial.id} trial={trial} />)}</div> : <RequiredSectionEmptyState title={hasAiStartingMap ? 'Search current studies next.' : 'Use the live registry to continue this search.'} icon="search">Use the condition, subtype, and treatment directions above in <a href={clinicalTrialsSearchUrl} target="_blank" rel="noreferrer">the live ClinicalTrials.gov search</a>. A registry search is the right next step when this report has no matched study card.</RequiredSectionEmptyState>}
            </section>
          </section>

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
        <div className="mrc-context"><span>Researching:</span> <strong>{condition || 'Choose a condition'}</strong></div>
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
  const sources = result?.sources?.length ? result.sources : (isIpf ? report.core.citations : [])
  const sourceLines = sources.map((source) => `- ${source.origin || source.type || 'Source'}: ${sourceLabel(source)} (${source.url})`).join('\n')
  const coverageLines = (result?.sourceCoverage || []).map((lane) => `- ${lane.label}: ${lane.status}; ${lane.records || 0} records. ${lane.detail}`).join('\n')
  const trialLines = (result?.trials || []).map((trial) => `- ${trial.id}: ${trial.title} (${trial.url})`).join('\n')
  const interventionLines = treatmentIdeasForReport(result, form.condition)
    .map((idea) => `- ${idea.title}: ${idea.summary || idea.rationale || 'Named in current condition-specific research.'} ${idea.whyItMayMatter ? `Why it may matter: ${idea.whyItMayMatter}` : ''} ${idea.kind === 'trial' ? idea.trials.map((trial) => `${trial.id} (${trial.url})`).join(', ') : ''}`.trim())
    .join('\n')
  const hypotheses = Array.isArray(result?.review?.hypotheses) && result.review.hypotheses.length
    ? result.review.hypotheses
    : explorationConnectionIdeas(result)
  const hypothesisLines = hypotheses
    .map((idea) => `- ${idea.title}: ${idea.whyItIsAQuestion} Boundary: ${idea.caution}`)
    .join('\n')
  const lifestyleLines = lifestyleIdeasForReport(result)
    .map((item) => `- ${item.title}: ${item.summary} Boundary: ${item.caution}`)
    .join('\n')
  const safetyLines = safetyIdeasForReport(result)
    .map((item) => `- ${item.title}: ${item.summary} Context: ${item.caution}`)
    .join('\n')
  const centerLines = (result?.centers?.length ? result.centers : (isIpf ? report.specialists : []))
    .map((center) => `- ${center.name}${center.city ? ` (${center.city})` : ''}: ${center.why || 'Condition-specific institution or study site.'}`)
    .join('\n')
  const researcherLines = (result?.researchers || [])
    .map((researcher) => `- ${researcher.name}${researcher.affiliation ? ` (${researcher.affiliation})` : ''}: ${researcher.why || `${researcher.role || 'Study official'}${researcher.trials?.length ? `; ${researcher.trials.map((trial) => trial.id).filter(Boolean).join(', ')}` : ''}`}`)
    .join('\n')
  const reviewText = result?.review?.briefing?.text || result?.exploration?.briefing || 'This report is ready for a new source search.'
  const mapNote = result?.exploration
    ? 'AI starting map: These connections are not verified facts or personal treatment advice. Check trusted sources and a clinician before acting on any idea.'
    : 'Source-linked report: Use the cited records to check every treatment and research question.'
  return [
    `Researching My Condition - ${form.condition || 'Condition research'}`,
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
    'Reviewed briefing',
    reviewText,
    '',
    'Report boundary',
    mapNote,
    '',
    'Sources',
    sourceLines || 'Live source links were not available in this run. Use the AI research map and a new live search to continue.',
    '',
    'Database coverage',
    coverageLines || 'No database coverage ledger has been retrieved yet.',
    '',
    'Recruiting trials',
    trialLines || `Use ClinicalTrials.gov to continue the live search for ${form.condition || 'this condition'}.`,
    '',
    'Important safety points',
    safetyLines || 'Use a clinician or pharmacist to review medicines, allergies, other conditions, and pregnancy status before acting on an idea.',
    '',
    'Treatment ideas to discuss',
    interventionLines || 'Use the condition subtype, gene result, symptoms, and treatment goals to build more focused treatment directions.',
    '',
    'Lifestyle changes worth discussing',
    lifestyleLines || 'Add daily-life symptoms, activity limits, or environmental concerns to make this section more specific.',
    '',
    'Research institutions and study sites',
    centerLines || 'Use the live ClinicalTrials.gov search and a clinician or disease foundation directory to find an appropriate specialty team.',
    '',
    'Researchers named in source records',
    researcherLines || 'Use the linked studies and specialty-center directories to find named research contacts.',
    '',
    'AI research connections',
    hypothesisLines || 'Use the treatment and lifestyle directions above as starting questions for a clinician or trusted-source search.',
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
