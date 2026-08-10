import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createResearchApiPlugin } from '../server/researchApi.mjs'
import { createVercelApiHandler } from '../server/vercelApi.mjs'

const env = {
  ANTHROPIC_RESEARCH_DISABLED: 'true',
  OPENAI_API_KEY: 'test-key',
  // Keep unit tests isolated from any real Vercel access settings used at build time.
  VERCEL: '',
  AWS_LAMBDA_FUNCTION_NAME: '',
  SITE_ACCESS_PASSCODE: '',
  SITE_ACCESS_SESSION_SECRET: '',
  SITE_ACCESS_SECURE_COOKIE: '',
}

const pubMedXml = `
<PubmedArticle>
  <MedlineCitation>
    <PMID>1001</PMID>
    <Article>
      <Journal><Title>Test Retina Journal</Title></Journal>
      <ArticleTitle>AAV-RP therapy and vision rehabilitation</ArticleTitle>
      <Abstract>
        <AbstractText>AAV-RP therapy is being researched for retinitis pigmentosa. Vision rehabilitation is also described for people living with retinitis pigmentosa.</AbstractText>
      </Abstract>
      <PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
      <JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue>
    </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/test-rp</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>`

const trial = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT00000001',
      briefTitle: 'AAV-RP Therapy for Retinitis Pigmentosa',
    },
    statusModule: { overallStatus: 'RECRUITING' },
    designModule: { studyType: 'INTERVENTIONAL', phases: ['PHASE2'] },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Retina Institute' } },
    conditionsModule: { conditions: ['Retinitis Pigmentosa'] },
    descriptionModule: { briefSummary: 'A study of AAV-RP therapy for retinitis pigmentosa.' },
    armsInterventionsModule: { interventions: [{ name: 'Genetic: AAV-RP therapy', type: 'GENETIC' }] },
    contactsLocationsModule: {
      locations: [{ facility: 'Test Retina Institute', city: 'Cleveland', state: 'Ohio', country: 'United States' }],
      overallOfficials: [{ name: 'Taylor Researcher', affiliation: 'Test Retina Institute', role: 'Principal Investigator' }],
    },
  },
}

// This mirrors the live false-positive we found in the previous app: a
// recruiting stem-cell study for NAION must never appear in an RP report.
const unrelatedStemCellTrial = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT05147701',
      briefTitle: 'Safety of Cultured Allogeneic Adult Umbilical Cord Derived Mesenchymal Stem Cells for NAION',
    },
    statusModule: { overallStatus: 'RECRUITING' },
    designModule: { studyType: 'INTERVENTIONAL', phases: ['PHASE1'] },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Unrelated Eye Research Center' } },
    conditionsModule: {
      conditions: ['Nonarteritic Anterior Ischemic Optic Neuropathy'],
      keywords: ['Retinitis Pigmentosa', 'stem cells'],
    },
    descriptionModule: { briefSummary: 'A stem-cell safety study for NAION.' },
    armsInterventionsModule: { interventions: [{ name: 'Allogeneic umbilical cord mesenchymal stem cells', type: 'BIOLOGICAL' }] },
    contactsLocationsModule: {
      locations: [{ facility: 'Unrelated Eye Research Center', city: 'Miami', state: 'Florida', country: 'United States' }],
    },
  },
}

const writerDraft = {
  briefing: 'Retinitis pigmentosa is a group of inherited eye diseases that slowly damage the retina. A gene result and the amount of working retina can change which research paths are worth checking.',
  researchQuestions: [{
    text: 'Could a retina specialist explain whether this study is relevant to the person’s condition?',
    sourceIds: ['NCT00000001'],
  }],
  treatmentIdeas: [{
    title: 'AAV-RP therapy',
    category: 'Gene treatment',
    summary: 'A current study is testing AAV-RP therapy for retinitis pigmentosa.',
    whyItMayMatter: 'It is a named gene treatment being studied in a current trial.',
    caution: 'It is experimental and is not a personal treatment recommendation.',
    sourceIds: ['NCT00000001'],
  }],
  lifestyle: [{
    title: 'Vision rehabilitation',
    summary: 'A source describes vision rehabilitation for people with retinitis pigmentosa.',
    caution: 'This group research finding is not a personal plan.',
    sourceIds: ['pmid-1001', 'epmc-med-1001'],
  }],
  safety: [{
    title: 'Investigational treatment needs review',
    summary: 'AAV-RP therapy is still being studied, so its safety and benefit are not established.',
    caution: 'A trial listing does not show that a treatment works or is right for one person.',
    sourceIds: ['NCT00000001'],
  }],
  hypotheses: [{
    title: 'AAV-RP therapy research question',
    candidate: 'AAV-RP therapy',
    mechanism: 'Researchers are studying a gene treatment approach.',
    whyItIsAQuestion: 'The current study is evaluating this named intervention for retinitis pigmentosa.',
    caution: 'This is a research question, not a recommendation to use the treatment.',
    sourceIds: ['NCT00000001'],
  }],
  theoryIdeas: [{
    title: 'Vitamin D signaling and retinal cell stress',
    category: 'Supplement mechanism to verify',
    whyItCouldConnect: 'Vitamin D signaling is a biological topic that could be checked for a link to retinal cell stress.',
    whyNotEstablished: 'This report did not find a source-backed RP treatment lead for this idea.',
    caution: 'This is a theory to verify, not a personal treatment recommendation.',
    verificationQuery: 'retinitis pigmentosa vitamin D retinal cell stress',
    sourceIds: ['rp-nei-condition-overview'],
  }],
  claimsForReview: [{
    claim: 'A current study is testing AAV-RP therapy for retinitis pigmentosa.',
    sourceIds: ['NCT00000001'],
  }],
}

const reviewerDraft = {
  overallVerdict: 'approved',
  briefing: {
    decision: 'approve',
    text: writerDraft.briefing,
    reason: 'It is linked to the source packet.',
    sourceIds: ['pmid-1001'],
  },
  questions: [{ index: 0, decision: 'approve', text: writerDraft.researchQuestions[0].text, reason: 'Safe question.', sourceIds: ['NCT00000001'] }],
  treatmentIdeas: [{ index: 0, decision: 'approve', item: writerDraft.treatmentIdeas[0], reason: 'Named trial intervention.' }],
  lifestyle: [{ index: 0, decision: 'approve', item: writerDraft.lifestyle[0], reason: 'Source-linked daily-life topic.' }],
  safety: [{ index: 0, decision: 'approve', item: writerDraft.safety[0], reason: 'Source-linked caution.' }],
  hypotheses: [{ index: 0, decision: 'approve', item: writerDraft.hypotheses[0], reason: 'Clearly exploratory.' }],
  theoryIdeas: [{ index: 0, decision: 'approve', item: writerDraft.theoryIdeas[0], reason: 'Clearly marked as unverified.' }],
  flags: [],
}

const explorationDraft = {
  briefing: 'This is an AI starting map for retinitis pigmentosa. It gives possible research connections to verify with trusted sources and a specialist.',
  treatmentPaths: [{
    title: 'Gene and cell pathway research',
    summary: 'Researchers may study gene, cell, or retina-protection approaches for retinitis pigmentosa.',
    whyItMayMatter: 'Different disease causes could point to different research paths.',
    caution: 'This is a research direction to verify, not a personal treatment plan.',
  }],
  connections: [{
    title: 'Gene result could shape the search',
    researchAngle: 'Gene-specific retina research',
    whyItCouldConnect: 'A genetic subtype may change which studies are worth checking.',
    question: 'Could a gene result make the treatment and trial search more specific?',
    caution: 'This is a research question to verify with a specialist.',
  }],
  lifestyle: [{
    title: 'Daily function and vision support',
    summary: 'Explore which condition-specific support or rehabilitation questions may matter in daily life.',
    caution: 'Check this topic with trusted sources and a clinician before acting on it.',
  }],
  safety: [{
    title: 'Check treatment claims carefully',
    summary: 'Any possible treatment path may need a review of medicines, allergies, and study quality.',
    caution: 'Verify safety questions with a clinician or pharmacist before acting on an idea.',
  }],
  searchTerms: ['retinitis pigmentosa treatment review', 'retinitis pigmentosa gene clinical trials'],
}

const sparseReviewerDraft = {
  ...reviewerDraft,
  treatmentIdeas: [],
  lifestyle: [],
  safety: [],
  hypotheses: [],
  theoryIdeas: [],
}

const candidateScoutDraft = {
  candidates: [
    { name: 'AAV-RP therapy', category: 'gene or cell program' },
    { name: 'Unrelated treatment', category: 'medicine' },
  ],
}

const packetCandidateDraft = {
  candidates: [
    { name: 'Vision rehabilitation', category: 'procedure or rehabilitation', sourceIds: ['pmid-1001', 'epmc-med-1001'] },
    { name: 'AAV-RP therapy', category: 'gene or cell program', sourceIds: ['NCT00000001'] },
    { name: 'Made-up treatment', category: 'medicine', sourceIds: ['pmid-1001'] },
  ],
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
})

const createMockFetch = ({ failTrials = false, failEvidence = false, failPubMed = false, sparseReview = false, malformedReview = false } = {}) => {
  const pubMedTerms = []

  return {
    pubMedTerms,
    fetch: async (input, options = {}) => {
      const url = String(input)

      if (url.includes('/esearch.fcgi')) {
        if (failEvidence || failPubMed) throw new Error('PubMed is unavailable')
        pubMedTerms.push(new URL(url).searchParams.get('term') || '')
        return jsonResponse({ esearchresult: { idlist: ['1001'] } })
      }
      if (url.includes('/efetch.fcgi')) {
        if (failEvidence || failPubMed) throw new Error('PubMed is unavailable')
        return textResponse(pubMedXml)
      }
      if (url.includes('europepmc.org') || url.includes('/europepmc/')) {
        if (failEvidence) throw new Error('Europe PMC is unavailable')
        const query = new URL(url).searchParams.get('query') || ''
        if (/AAV-RP therapy/i.test(query)) {
          return jsonResponse({
            resultList: {
              result: [{
                source: 'MED',
                id: '2002',
                pmid: '2002',
                title: 'AAV-RP therapy for retinitis pigmentosa',
                abstractText: 'AAV-RP therapy is being studied for retinitis pigmentosa.',
                pubYear: '2025',
                journalTitle: 'Europe PMC Retina Journal',
                pubType: 'Clinical Trial',
              }],
            },
          })
        }
        return jsonResponse({
          resultList: {
            result: [{
              source: 'MED',
              id: '1001',
              pmid: '1001',
              title: 'Vision rehabilitation in retinitis pigmentosa',
              abstractText: 'Vision rehabilitation is discussed for people with retinitis pigmentosa.',
              pubYear: '2025',
              journalTitle: 'Test Retina Journal',
              pubType: 'Systematic Review',
            }],
          },
        })
      }
      if (url.includes('clinicaltrials.gov/api/v2/studies')) {
        if (failTrials) throw new Error('ClinicalTrials.gov is unavailable')
        return jsonResponse({ studies: [trial, unrelatedStemCellTrial] })
      }
      if (url.includes('open.fda.gov/drug/label.json')) return jsonResponse({ error: { message: 'No matches found' } }, 404)
      if (url.includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body)
        if (malformedReview && !request.instructions.includes('Researcher Agent') && !request.instructions.includes('Research Connections Agent')) {
          return jsonResponse({ status: 'completed', output_text: 'This response is not valid JSON.' })
        }
        const output = request.instructions.includes('Packet Candidate Extractor')
          ? packetCandidateDraft
          : request.instructions.includes('Candidate Scout')
            ? candidateScoutDraft
          : request.instructions.includes('Research Connections Agent') || request.instructions.includes('second safety pass')
          ? explorationDraft
          : request.instructions.includes('Researcher Agent')
            ? writerDraft
            : sparseReview
              ? sparseReviewerDraft
              : reviewerDraft
        return jsonResponse({ status: 'completed', output_text: JSON.stringify(output) })
      }

      throw new Error(`Unexpected request in test: ${url}`)
    },
  }
}

const apiRoutes = (runtimeEnv = env) => {
  const handlers = new Map()
  createResearchApiPlugin(runtimeEnv).configureServer({
    middlewares: { use: (path, handler) => handlers.set(path, handler) },
  })
  return handlers
}

const callRoute = async (handler, method, payload, { headers = {}, url = '', parsedBody } = {}) => new Promise((resolve, reject) => {
  const request = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : [])
  request.method = method
  request.headers = headers
  request.url = url
  if (parsedBody !== undefined) request.body = parsedBody
  const responseHeaders = {}
  const response = {
    statusCode: 200,
    setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = value },
    end(body) {
      try {
        resolve({ status: this.statusCode, headers: responseHeaders, body: JSON.parse(String(body || '{}')) })
      } catch (error) {
        reject(error)
      }
    },
  }
  Promise.resolve(handler(request, response)).catch(reject)
})

const withMockedFetch = async (mockFetch, run) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('RP expands to retinitis pigmentosa and returns a source-gated report', { concurrency: false }, async () => {
  const mock = createMockFetch()
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'RP', geneticVariant: 'USH2A', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.equal(response.body.patient.condition, 'Retinitis Pigmentosa')
  assert.ok(mock.pubMedTerms.some((term) => term.includes('Retinitis Pigmentosa')))
  assert.ok(response.body.sources.length >= 3)
  assert.ok(response.body.sources.some((source) => source.id === 'rp-nei-condition-overview'))
  assert.ok(response.body.sources.some((source) => source.id === 'rp-fda-luxturna-rpe65'))
  const candidateSource = response.body.sources.find((source) => source.candidateLeads?.some((candidate) => candidate.name === 'AAV-RP therapy'))
  assert.ok(candidateSource)
  assert.ok(candidateSource.candidateLeads.some((candidate) => candidate.name === 'AAV-RP therapy'))
  assert.ok(response.body.sources.some((source) => source.candidateLeads?.some((candidate) => candidate.name === 'Vision rehabilitation')))
  assert.ok(!candidateSource.candidateLeads.some((candidate) => /unrelated/i.test(candidate.name)))
  assert.ok(!candidateSource.candidateLeads.some((candidate) => /made-up/i.test(candidate.name)))
  assert.ok(mock.pubMedTerms.some((term) => term.includes('AAV-RP therapy')))
  const candidateGate = response.body.sourceCoverage.find((lane) => lane.id === 'candidate-verification')
  assert.equal(candidateGate.status, 'ready')
  assert.match(candidateGate.detail, /exact source text/i)
  assert.equal(response.body.trials.length, 1)
  assert.deepEqual(response.body.trials.map((item) => item.id), ['NCT00000001'])
  assert.ok(!response.body.trials.some((item) => /NAION|umbilical cord/i.test(item.title)))
  assert.equal(response.body.centers.length, 1)
  assert.equal(response.body.review.treatmentIdeas.length, 1)
  assert.equal(response.body.review.lifestyle.length, 1)
  assert.equal(response.body.review.safety.length, 1)
  assert.equal(response.body.review.hypotheses.length, 1)
  assert.equal(response.body.review.theoryIdeas.length, 10)
  assert.ok(response.body.review.theoryIdeas.some((idea) => idea.title === 'Vitamin D signaling and retinal cell stress'))
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.providerQuestion))
  assert.ok(response.body.review.theoryIdeas.every((idea) => !/\bhigh[-\s]?dose\b/i.test(`${idea.title} ${idea.whyItCouldConnect} ${idea.caution}`)))
  assert.deepEqual(response.body.review.questions[0].sourceIds, ['NCT00000001'])
  assert.equal(response.body.review.questions[0].text, 'Could this study fit me?')
  assert.ok((response.body.review.questions[0].text.match(/[A-Za-z0-9']+/g) || []).length <= 12)
  assert.equal(response.body.exploration, null)
  assert.equal(response.body.review.mode, 'dual-agent')
  assert.equal(response.body.review.independent, false)
})

test('a registry outage is labeled unavailable instead of as an empty trial search', { concurrency: false }, async () => {
  const mock = createMockFetch({ failTrials: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  const registry = response.body.sourceCoverage.find((lane) => lane.id === 'clinicaltrials-gov')
  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.ok(response.body.sources.length >= 3)
  assert.equal(response.body.trials.length, 0)
  assert.equal(registry.status, 'unavailable')
  assert.match(registry.detail, /could not be reached/i)
})

test('Europe PMC keeps candidate evidence available when PubMed is unavailable', { concurrency: false }, async () => {
  const mock = createMockFetch({ failPubMed: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.equal(response.body.sourceCoverage.find((lane) => lane.id === 'pubmed').status, 'unavailable')
  const candidatePubMed = response.body.sourceCoverage.find((lane) => lane.id === 'candidate-pubmed')
  const candidateEuropePmc = response.body.sourceCoverage.find((lane) => lane.id === 'candidate-europe-pmc')
  assert.ok(candidatePubMed, JSON.stringify(response.body.sourceCoverage))
  assert.ok(candidateEuropePmc, JSON.stringify(response.body.sourceCoverage))
  assert.equal(candidatePubMed.status, 'unavailable')
  assert.equal(candidateEuropePmc.status, 'ready')
  assert.equal(response.body.sourceCoverage.find((lane) => lane.id === 'candidate-verification').status, 'ready')
  const candidateSource = response.body.sources.find((source) => source.id === 'epmc-med-2002')
  assert.ok(candidateSource)
  assert.ok(candidateSource.candidateLeads.some((candidate) => candidate.name === 'AAV-RP therapy'))
})

test('a source-backed run keeps a source-linked overview when a report lane is empty', { concurrency: false }, async () => {
  const mock = createMockFetch({ sparseReview: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.ok(response.body.sources.length >= 3)
  assert.equal(response.body.trials.length, 1)
  assert.equal(response.body.review.treatmentIdeas.length, 0)
  assert.equal(response.body.exploration, null)
  assert.match(response.body.review.briefing.text, /inherited eye diseases/i)
  assert.doesNotMatch(response.body.review.briefing.text, /record(?:s)?/i)
  assert.ok(response.body.review.briefing.sourceIds.length)
  assert.ok(response.body.review.questions.length)
  assert.ok(response.body.review.questions.every((question) => question.sourceIds.length))
  assert.equal(response.body.review.theoryIdeas.length, 10)
})

test('a source-gated writer overview survives a malformed second AI pass', { concurrency: false }, async () => {
  const mock = createMockFetch({ malformedReview: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.equal(response.body.review.mode, 'source-gate')
  assert.match(response.body.review.briefing.text, /inherited eye diseases/i)
  assert.ok(response.body.review.briefing.sourceIds.length)
})

test('an authoritative condition foundation prevents a blank RP report when live services are unavailable', { concurrency: false }, async () => {
  const mock = createMockFetch({ failTrials: true, failEvidence: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.equal(response.body.sources.length, 2)
  assert.equal(response.body.trials.length, 0)
  assert.equal(response.body.exploration, null)
  assert.match(response.body.review.briefing.text, /rare inherited eye diseases/i)
  assert.ok(response.body.review.briefing.sourceIds.includes('rp-nei-condition-overview'))
  assert.equal(response.body.review.theoryIdeas.length, 10)
})

test('a report request without a condition is rejected before any research starts', { concurrency: false }, async () => {
  const response = await callRoute(apiRoutes().get('/api/research-run'), 'POST', { privacyAcknowledged: true, patient: { condition: ' ' } })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'Enter a condition before starting research.')
})

test('the passcode gate protects the API with a server-only session cookie', async () => {
  const passcode = 'test-only-demo-passcode'
  const routes = apiRoutes({ ...env, SITE_ACCESS_PASSCODE: passcode })

  const locked = await callRoute(routes.get('/api/health'), 'GET')
  assert.equal(locked.status, 401)
  assert.equal(locked.body.code, 'access_required')

  const wrongLogin = await callRoute(routes.get('/api/access/login'), 'POST', { passcode: 'wrong' })
  assert.equal(wrongLogin.status, 401)

  // A real demo user can mistype a shared passcode several times. The correct
  // passcode must recover access instead of inheriting that temporary limit.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const retry = await callRoute(routes.get('/api/access/login'), 'POST', { passcode: `wrong-${attempt}` })
    assert.equal(retry.status, 401)
  }

  const login = await callRoute(routes.get('/api/access/login'), 'POST', { passcode })
  assert.equal(login.status, 200)
  assert.equal(login.body.access, 'granted')
  assert.match(login.headers['set-cookie'], /HttpOnly/)
  assert.match(login.headers['set-cookie'], /SameSite=Strict/)
  assert.doesNotMatch(login.headers['set-cookie'], new RegExp(passcode))

  const cookie = login.headers['set-cookie'].split(';')[0]
  const open = await callRoute(routes.get('/api/health'), 'GET', undefined, { headers: { cookie } })
  assert.equal(open.status, 200)
  assert.equal(open.body.ok, true)

  const logout = await callRoute(routes.get('/api/access/logout'), 'POST', undefined, { headers: { cookie } })
  assert.equal(logout.status, 200)
  assert.match(logout.headers['set-cookie'], /Max-Age=0/)

  const relocked = await callRoute(routes.get('/api/health'), 'GET', undefined, { headers: { cookie } })
  assert.equal(relocked.status, 401)
})

test('the Vercel API adapter validates a signed session across separate function instances', async () => {
  const passcode = 'test-only-demo-passcode'
  const runtimeEnv = {
    ...env,
    VERCEL: '1',
    SITE_ACCESS_PASSCODE: passcode,
    SITE_ACCESS_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    SITE_ACCESS_SECURE_COOKIE: 'true',
  }
  const firstInstance = createVercelApiHandler(runtimeEnv)

  const locked = await callRoute(firstInstance, 'GET', undefined, { url: '/api/health' })
  assert.equal(locked.status, 401)

  const login = await callRoute(
    firstInstance,
    'POST',
    undefined,
    { url: '/api/access/login', parsedBody: { passcode } },
  )
  assert.equal(login.status, 200)
  assert.match(login.headers['set-cookie'], /HttpOnly/)
  assert.match(login.headers['set-cookie'], /SameSite=Strict/)
  assert.match(login.headers['set-cookie'], /Secure/)

  const cookie = login.headers['set-cookie'].split(';')[0]
  const secondInstance = createVercelApiHandler(runtimeEnv)
  const open = await callRoute(secondInstance, 'GET', undefined, { url: '/api/health', headers: { cookie } })
  assert.equal(open.status, 200)
  assert.equal(open.body.ok, true)

  const status = await callRoute(secondInstance, 'GET', undefined, { url: '/access/status', headers: { cookie } })
  assert.equal(status.status, 200)
  assert.equal(status.body.access, 'granted')

  const missing = await callRoute(secondInstance, 'GET', undefined, { url: '/api/not-a-real-route' })
  assert.equal(missing.status, 404)
})

test('a serverless deployment without session security configuration keeps the API locked', async () => {
  const missingSecret = createVercelApiHandler({
    ...env,
    VERCEL: '1',
    SITE_ACCESS_PASSCODE: 'test-only-demo-passcode',
  })

  const status = await callRoute(missingSecret, 'GET', undefined, { url: '/api/access/status' })
  assert.equal(status.status, 200)
  assert.equal(status.body.access, 'setup-required')

  const health = await callRoute(missingSecret, 'GET', undefined, { url: '/api/health' })
  assert.equal(health.status, 401)

  const insecureCookie = createVercelApiHandler({
    ...env,
    VERCEL: '1',
    SITE_ACCESS_PASSCODE: 'test-only-demo-passcode',
    SITE_ACCESS_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
  })
  const insecureStatus = await callRoute(insecureCookie, 'GET', undefined, { url: '/api/access/status' })
  assert.equal(insecureStatus.body.access, 'setup-required')
})

test('the research endpoint requires consent and rejects obvious direct identifiers', async () => {
  const routes = apiRoutes()
  const noConsent = await callRoute(routes.get('/api/research-run'), 'POST', { patient: { condition: 'Retinitis Pigmentosa' } })
  assert.equal(noConsent.status, 400)
  assert.match(noConsent.body.error, /privacy and safety notice/i)

  const directIdentifier = await callRoute(routes.get('/api/research-run'), 'POST', {
    privacyAcknowledged: true,
    patient: { condition: 'Retinitis Pigmentosa', currentMeds: 'Send the report to patient@example.com' },
  })
  assert.equal(directIdentifier.status, 400)
  assert.match(directIdentifier.body.error, /email address/i)
})

test('the offline starting map stays condition-specific for common and arbitrary demo conditions', { concurrency: false }, async () => {
  const routes = apiRoutes({
    ...env,
    ANTHROPIC_RESEARCH_DISABLED: 'true',
    OPENAI_API_KEY: '',
  })
  const unavailableFetch = async () => { throw new Error('Network unavailable for fallback test') }
  const runFallback = (condition, geneticVariant = '') => withMockedFetch(unavailableFetch, () => callRoute(
    routes.get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition, geneticVariant } },
  ))

  const cases = [
    ['Idiopathic Pulmonary Fibrosis', '', /anti-scarring/i],
    ['Retinitis Pigmentosa', 'USH2A', /gene-specific/i],
    ['Huntington Disease', '', /HTT-lowering/i],
    ['Fabry Disease', '', /enzyme-replacement/i],
    ['Koolen-de Vries syndrome', '', /current and repurposed medicine research/i],
  ]

  for (const [condition, geneticVariant, expectedTitle] of cases) {
    const response = await runFallback(condition, geneticVariant)
    assert.equal(response.status, 200)
    const hasAuthoritativeFoundation = /ipf|idiopathic pulmonary fibrosis|retinitis pigmentosa/i.test(condition)
    assert.equal(response.body.status, hasAuthoritativeFoundation ? 'ready' : 'exploration')
    if (hasAuthoritativeFoundation) {
      assert.equal(response.body.exploration, null)
      assert.ok(response.body.review.briefing.text)
      assert.ok(response.body.review.briefing.sourceIds.length)
      assert.equal(response.body.review.theoryIdeas.length, 10)
      if (/retinitis pigmentosa/i.test(condition)) {
        assert.ok(response.body.review.briefing.sourceIds.includes('rp-nei-condition-overview'))
      }
      continue
    }
    assert.equal(response.body.exploration.mode, 'structured-starting-map')
    assert.equal(response.body.exploration.treatmentPaths.length, 10)
    assert.equal(response.body.exploration.connections.length, 10)
    assert.equal(response.body.exploration.lifestyle.length, 2)
    assert.equal(response.body.exploration.safety.length, 2)
    assert.match(response.body.exploration.treatmentPaths[0].title, expectedTitle)
    assert.ok(response.body.exploration.treatmentPaths.every((item) => item.needsVerification))
    assert.ok(response.body.exploration.connections.every((item) => item.needsVerification))
    assert.ok(!response.body.exploration.treatmentPaths.some((item) => /\b(?:supplement|nutrition|goji berry)\b/i.test(`${item.title} ${item.summary}`)))
    assert.match(response.body.exploration.briefing, new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }
})
