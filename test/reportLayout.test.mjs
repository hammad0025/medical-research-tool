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
  assert.match(appSource, /Treatments to ask about and AI ideas to check/)
  assert.match(appSource, /Things studied for this illness/)
  assert.doesNotMatch(appSource, /Early lab or animal research/)
  assert.doesNotMatch(appSource, /Not in people yet/)
  assert.match(appSource, /supportingSourceIds/)
  assert.match(appSource, /Do not buy, compound, or use/)
  assert.match(appSource, /AI ideas to check/)
  assert.match(appSource, /What this means/)
  assert.match(appSource, /Possible idea to check/)
  assert.match(appSource, /Study may be open/)
  assert.match(appSource, /Nerandomilast \(Jascayd; BI 1015550\)/)
  assert.match(appSource, /Nalbuphine extended-release \(NAL ER\)/)
  assert.match(appSource, /Pirfenidone \(Esbriet\)/)
  assert.match(appSource, /Nitrate-rich beetroot juice/)
  assert.match(appSource, /return 'oxygen support'/)
  assert.match(appSource, /study-access-only/)
  assert.match(appSource, /isExplicitlyExcludedTreatment/)
  assert.match(appSource, /Why AI thinks this may connect/)
  assert.match(appSource, /Check PubMed/)
  assert.doesNotMatch(appSource, /Not established/)
  assert.doesNotMatch(appSource, /sourceMentionsRepurposingCandidate/)
  assert.doesNotMatch(appSource, /Treatments studied but not listed as options/)
  assert.match(appSource, /centerSourceCitation/)
  assert.match(appSource, /Open official center page/)
  assert.match(appSource, /\{label\}: \{sourceLabel\(citation\)\}/)
  assert.doesNotMatch(appSource, /source pack/i)
  assert.match(appSource, /Treatments in current clinical studies/)
  assert.match(appSource, /FDA_EXPANDED_ACCESS_SOURCE/)
  assert.match(appSource, /Full current trial directory/)
  assert.match(appSource, /No daily-life tip was added/)
  assert.match(appSource, /curatedLifestyleIdeas/)
  assert.match(appSource, /profileAwareLifestyleIdeas/)
  assert.match(appSource, /Night-time travel and driving safety/)
  assert.match(appSource, /Based on what you entered/)
  assert.match(appSource, /Do not use this report to decide whether to drive/)
  assert.match(appSource, /rp-nei-low-vision/)
  assert.match(appSource, /induction and maintenance/)
  assert.match(appSource, /comparative effectiveness/)
  assert.match(appSource, /KleanLyte\|Bi-PegLyte/)
  assert.match(appSource, /tai chi\|yoga\|dance therapy/)
  assert.match(appSource, /treatment with/)
  assert.match(appSource, /those\|these\|this\|that/)
  assert.match(appSource, /biomarker\|prognos/)
  assert.match(appSource, /l dopa\|levodopa\|carbidopa/)
  assert.match(appSource, /vitamin d3\|cholecalciferol\|vitamin d/)
  assert.match(appSource, /\(\?:and\|or\|plus\|with\)/)
  assert.match(appSource, /\[\.\.\.profileIdeas, \.\.\.curatedIdeas, \.\.\.reviewedIdeas, \.\.\.sourceFallbackIdeas\]/)
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
    '5. Things studied for this illness',
    'AI ideas to check',
    'Treatments in current studies',
    'Current clinical trials',
    'What to bring to your next visit',
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
