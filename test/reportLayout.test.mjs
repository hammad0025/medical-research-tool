import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../src/App.jsx', import.meta.url))
const appSource = readFileSync(appPath, 'utf8')

test('the patient-first report flow keeps practical decisions ahead of the full trial directory', () => {
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
    '<TreatmentResultsThatPointAway',
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
  assert.match(appSource, /const EarlyResearchCards/)
  assert.match(appSource, /const TheoryIdeaCards/)
  assert.match(appSource, /function TreatmentDevelopment/)
  assert.match(appSource, /function ResearchAccessPlan/)
  assert.match(appSource, /id="condition-overview"/)
  assert.match(appSource, /id="clinical-trials"/)
  assert.match(appSource, /What you can discuss now, plus research questions to check/)
  assert.match(appSource, /Researched medicines, supplements, procedures, and study programs/)
  assert.match(appSource, /Early research worth watching/)
  assert.match(appSource, /Not in people yet/)
  assert.match(appSource, /supportingSourceIds/)
  assert.match(appSource, /Do not buy, compound, or use/)
  assert.match(appSource, /New repurposing questions/)
  assert.match(appSource, /Plain takeaway/)
  assert.match(appSource, /Named item to investigate/)
  assert.match(appSource, /Study may be enrolling/)
  assert.match(appSource, /Nerandomilast \(Jascayd; BI 1015550\)/)
  assert.match(appSource, /Nalbuphine extended-release \(NAL ER\)/)
  assert.match(appSource, /Pirfenidone \(Esbriet\)/)
  assert.match(appSource, /Nitrate-rich beetroot juice/)
  assert.match(appSource, /return 'oxygen support'/)
  assert.match(appSource, /study-access-only/)
  assert.match(appSource, /isExplicitlyExcludedTreatment/)
  assert.match(appSource, /Source for disease biology/)
  assert.match(appSource, /Search to check next/)
  assert.doesNotMatch(appSource, /sourceMentionsRepurposingCandidate/)
  assert.match(appSource, /Treatments studied but not listed as options/)
  assert.match(appSource, /centerSourceCitation/)
  assert.match(appSource, /Open official center page/)
  assert.match(appSource, /\{label\}: \{sourceLabel\(citation\)\}/)
  assert.doesNotMatch(appSource, /source pack/i)
  assert.match(appSource, /Treatments in current clinical studies/)
  assert.match(appSource, /FDA_EXPANDED_ACCESS_SOURCE/)
  assert.match(appSource, /Full current trial directory/)
  assert.match(appSource, /No lifestyle claim was added without a direct source/)
  assert.match(appSource, /curatedLifestyleIdeas/)
  assert.match(appSource, /induction and maintenance/)
  assert.match(appSource, /comparative effectiveness/)
  assert.match(appSource, /\(\?:and\|or\|plus\|with\)/)
  assert.match(appSource, /\[\.\.\.curatedIdeas, \.\.\.reviewedIdeas, \.\.\.sourceFallbackIdeas\]/)
  assert.match(appSource, /broadResearchConditionName/)
  assert.match(appSource, /isMismatchedNamedGeneProgram/)
  assert.match(appSource, /Matches entered gene or subtype/)
  assert.match(appSource, /sourceNeedsSpecialistReview/)
  assert.doesNotMatch(appSource, /idea\?\.summary \|\| ''\} \$\{idea\?\.caution/)
  assert.doesNotMatch(appSource, /quality of life\|low vision/)
  assert.doesNotMatch(appSource, /lifestyleVerificationLinks/)
  assert.doesNotMatch(appSource, /theoryVerificationLinks/)
  assert.doesNotMatch(appSource, /More evidence/)
})

test('Word and PDF exports keep the same practical report sections', () => {
  const exportReport = appSource.slice(
    appSource.indexOf('const reportExportText'),
    appSource.indexOf('function ExportActions'),
  )
  const headingsInOrder = [
    '1. Condition overview',
    '2. Approved and established options',
    '3. Centers and study sites',
    '4. Lifestyle changes worth discussing',
    '5. Researched medicines, supplements, procedures, and study programs',
    'Early animal and lab research worth watching',
    'New repurposing questions',
    'Treatments studied but not listed as options',
    'Pipeline watch',
    'Current clinical trials',
    'Your research and access plan',
    'Simple questions to ask your doctor',
    'Important safety points',
  ]

  let lastPosition = -1
  for (const heading of headingsInOrder) {
    const position = exportReport.indexOf(heading)
    assert.ok(position > lastPosition, `${heading} should follow the prior export section`)
    lastPosition = position
  }

  assert.match(exportReport, /centerCitations\(result, center\)/)
})
