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
    '<TreatmentDevelopment',
    '<ResearchIdeas',
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
  assert.match(appSource, /function ResearchedLeadTable/)
  assert.match(appSource, /function TheoryIdeaTable/)
  assert.match(appSource, /function TreatmentDevelopment/)
  assert.match(appSource, /function ResearchAccessPlan/)
  assert.match(appSource, /id="condition-overview"/)
  assert.match(appSource, /id="clinical-trials"/)
  assert.match(appSource, /10 researched leads \+ 10 theory leads/)
  assert.match(appSource, /Theory leads to verify/)
  assert.match(appSource, /Full current trial directory/)
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
    '5. Treatments in development',
    '6. Gene, cell, device, and procedure research',
    '7. Researched treatment leads',
    '8. Theory leads to verify',
    '9. Current clinical trials',
    '10. Your research and access plan',
    '11. Simple questions to ask your doctor',
    '12. Important safety points',
  ]

  let lastPosition = -1
  for (const heading of headingsInOrder) {
    const position = exportReport.indexOf(heading)
    assert.ok(position > lastPosition, `${heading} should follow the prior export section`)
    lastPosition = position
  }
})
