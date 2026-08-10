import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../src/App.jsx', import.meta.url))
const appSource = readFileSync(appPath, 'utf8')

test('the patient-first report order keeps practical decisions ahead of recruiting trials', () => {
  const universalReport = appSource.slice(
    appSource.indexOf('function UniversalReport'),
    appSource.indexOf('function WorkspaceHeader'),
  )
  const sectionsInOrder = [
    '<EstablishedTreatments',
    '<CareLocations',
    '<LifestyleResearch',
    '<ResearchIdeas',
    '<TrialDirectory',
    '<DoctorQuestions',
  ]

  let lastPosition = -1
  for (const section of sectionsInOrder) {
    const position = universalReport.indexOf(section)
    assert.ok(position > lastPosition, `${section} should follow the prior patient-first section`)
    lastPosition = position
  }
  assert.match(appSource, /function ResearchedLeadTable/)
  assert.match(appSource, /function ResearchQuestionTable/)
  assert.match(appSource, /eyebrow="Recruiting clinical trials"/)
})
