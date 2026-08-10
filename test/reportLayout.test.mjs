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
  assert.match(appSource, /function ResearchQuestionTable/)
  assert.match(appSource, /function TreatmentDevelopment/)
  assert.match(appSource, /function ResearchAccessPlan/)
  assert.match(appSource, /id="condition-snapshot"/)
  assert.match(appSource, /id="clinical-trials"/)
  assert.match(appSource, /10 researched leads \+ 10 questions to investigate/)
  assert.match(appSource, /Full current trial directory/)
})
