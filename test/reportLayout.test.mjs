import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../src/App.jsx', import.meta.url))
const appSource = readFileSync(appPath, 'utf8')

test('the patient-first dossier flow keeps practical decisions ahead of the full trial directory', () => {
  const universalReport = appSource.slice(
    appSource.indexOf('function UniversalReport'),
    appSource.indexOf('function WorkspaceHeader'),
  )
  const sectionsInOrder = [
    '<ReportOverview',
    '<EstablishedTreatments',
    '<CareLocations',
    '<LifestyleResearch',
    '<ResearchIdeas',
    '<TreatmentDevelopment',
    '<TrialDirectory',
    '<ResearchAccessPlan',
    '<DoctorQuestions',
    '<SafetyResearch',
  ]

  let lastPosition = -1
  for (const section of sectionsInOrder) {
    const position = universalReport.indexOf(section)
    assert.ok(position > lastPosition, `${section} should follow the prior patient-first section`)
    lastPosition = position
  }
  assert.match(appSource, /const PatientLeadCards/)
  assert.match(appSource, /const TheoryIdeaCards/)
  assert.match(appSource, /function TreatmentDevelopment/)
  assert.match(appSource, /function ResearchAccessPlan/)
  assert.match(appSource, /id="condition-overview"/)
  assert.match(appSource, /id="clinical-trials"/)
  assert.match(appSource, /What you can discuss now, plus ideas to verify/)
  assert.match(appSource, /Researched leads to discuss now/)
  assert.match(appSource, /Theory leads to verify/)
  assert.match(appSource, /Research programs that need a formal access route/)
  assert.match(appSource, /FDA_EXPANDED_ACCESS_SOURCE/)
  assert.match(appSource, /Full current trial directory/)
  assert.match(appSource, /buildLifestyleFallbackTopics/)
  assert.match(appSource, /lifestyleVerificationLinks/)
  assert.match(appSource, /Topic to verify/)
  assert.doesNotMatch(appSource, /Build a more specific lifestyle search next\./)
})

test('Word and PDF exports keep the same practical dossier sections', () => {
  const exportReport = appSource.slice(
    appSource.indexOf('const reportExportText'),
    appSource.indexOf('function ExportActions'),
  )
  const headingsInOrder = [
    '1. Condition overview',
    '2. Approved and established options',
    '3. Centers and experts',
    '4. Lifestyle changes worth discussing',
    '5. Researched leads to discuss now',
    '6. Theory leads to verify',
    '7. Research programs that need a formal access route',
    '8. Current clinical trials',
    '9. Your research and access plan',
    '10. Simple questions to ask your doctor',
    '11. Important safety points',
  ]

  let lastPosition = -1
  for (const heading of headingsInOrder) {
    const position = exportReport.indexOf(heading)
    assert.ok(position > lastPosition, `${heading} should follow the prior export section`)
    lastPosition = position
  }
})
