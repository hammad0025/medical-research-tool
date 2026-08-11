import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createResearchApiPlugin } from '../server/researchApi.mjs'
import { createVercelApiHandler } from '../server/vercelApi.mjs'
import { recentResearchSignalsFor } from '../server/recentResearchSignals.mjs'

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
        <AbstractText>AAV-RP therapy is being researched for retinitis pigmentosa. Vision rehabilitation is also described for people living with retinitis pigmentosa. Blood dopamine was measured, an Orai-1 inhibitor class was discussed, and adjuvant therapy was mentioned without a named intervention. A person with a separate aHUS diagnosis was given cyclophosphamide.</AbstractText>
      </Abstract>
      <PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
      <JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue>
    </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/test-rp</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>`

const relatedPreclinicalPubMedXml = `
<PubmedArticle>
  <MedlineCitation>
    <PMID>42321469</PMID>
    <Article>
      <Journal><Title>Nature Neuroscience</Title></Journal>
      <ArticleTitle>A fatty acid amide activates myeloid cells and improves neurovascular outcomes in retinal degeneration</ArticleTitle>
      <Abstract>
        <AbstractText>Erucamide was dysregulated during photoreceptor degeneration in mice. In vivo delivery of erucamide limited vascular and neuronal degeneration in a retinal disease model. The authors propose erucamide and analogs as candidate therapeutics.</AbstractText>
      </Abstract>
      <PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>
      <JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue>
    </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1038/s41593-026-02341-w</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>`

const medlinePlusParkinsonXml = `
<nlmSearchResult>
  <list>
    <document url="https://medlineplus.gov/parkinsonsdisease.html" rank="0">
      <content name="title">&lt;span class="qt0"&gt;Parkinson's Disease&lt;/span&gt;</content>
      <content name="organizationName">National Library of Medicine</content>
      <content name="FullSummary">&lt;p&gt;Parkinson's disease is a movement disorder that affects the nervous system.&lt;/p&gt;&lt;p&gt;Symptoms often begin gradually and can include tremor, stiffness, slow movement, and balance problems. Diagnosis uses a person's history, symptoms, and a neurological exam.&lt;/p&gt;</content>
    </document>
  </list>
</nlmSearchResult>`

const titleFallbackPubMedXml = `
<PubmedArticle>
  <MedlineCitation>
    <PMID>1001</PMID>
    <Article>
      <Journal><Title>Test Retina Journal</Title></Journal>
      <ArticleTitle>Migalastat compared with enzyme replacement therapy in retinitis pigmentosa</ArticleTitle>
      <Abstract><AbstractText>This fixture tests source-title treatment fallback behavior.</AbstractText></Abstract>
      <PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
      <JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue>
    </Article>
  </MedlineCitation>
</PubmedArticle>
<PubmedArticle>
  <MedlineCitation>
    <PMID>1002</PMID>
    <Article>
      <Journal><Title>Test Retina Journal</Title></Journal>
      <ArticleTitle>Use of nonsteroidal mineralocorticoid receptor antagonist in chronic kidney disease: a case report of a patient with retinitis pigmentosa</ArticleTitle>
      <Abstract><AbstractText>The medicine was used for chronic kidney disease in a person who also had retinitis pigmentosa.</AbstractText></Abstract>
      <PublicationTypeList><PublicationType>Case Reports</PublicationType></PublicationTypeList>
      <JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue>
    </Article>
  </MedlineCitation>
</PubmedArticle>`

const nonConditionComparisonPubMedXml = `
<PubmedArticle>
  <MedlineCitation>
    <PMID>1003</PMID>
    <Article>
      <Journal><Title>Test Rare Disease Journal</Title></Journal>
      <ArticleTitle>Pharmacokinetic evaluation of single-dose migalastat in non-Fabry disease subjects with ESRD receiving dialysis treatment, and use of modeling to select dose regimens in Fabry disease subjects with ESRD receiving dialysis treatment.</ArticleTitle>
      <Abstract><AbstractText>This record compares a non-Fabry dialysis population with a modeling question for Fabry disease.</AbstractText></Abstract>
      <PublicationTypeList><PublicationType>Clinical Trial</PublicationType></PublicationTypeList>
      <JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue>
    </Article>
  </MedlineCitation>
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
      locations: [
        { facility: 'Clinical Trial Site', city: 'New York', state: 'New York', country: 'United States' },
        { facility: 'Novartis Investigative Site', city: 'Boston', state: 'Massachusetts', country: 'United States' },
        { facility: 'PPD Development, LP', city: 'Austin', state: 'Texas', country: 'United States' },
        { facility: 'Test Retina Institute', city: 'Cleveland', state: 'Ohio', country: 'United States' },
      ],
      overallOfficials: [{ name: 'Taylor Researcher', affiliation: 'Test Retina Institute', role: 'Principal Investigator' }],
    },
  },
}

const ush2aTrial = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT06627179',
      briefTitle: 'Study to Evaluate Ultevursen in Subjects With Retinitis Pigmentosa Due to Mutations in Exon 13 of the USH2A Gene',
    },
    statusModule: { overallStatus: 'RECRUITING' },
    designModule: { studyType: 'INTERVENTIONAL', phases: ['PHASE2'] },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Laboratoires Thea' } },
    conditionsModule: { conditions: ['Usher Syndrome Type 2A'], keywords: ['USH2A', 'Exon 13', 'LUNA'] },
    descriptionModule: { briefSummary: 'A study of ultevursen for retinitis pigmentosa due to mutations in exon 13 of the USH2A gene.' },
    armsInterventionsModule: { interventions: [{ name: 'Ultevursen', type: 'DRUG' }] },
    contactsLocationsModule: {
      locations: [{ facility: 'Test Retina Institute', city: 'Cleveland', state: 'Ohio', country: 'United States' }],
    },
  },
}

const oldUsh2aTrial = {
  protocolSection: {
    ...ush2aTrial.protocolSection,
    identificationModule: { nctId: 'NCT05158296', briefTitle: 'Earlier Ultevursen Study for RP Due to USH2A Exon 13 Mutations' },
    statusModule: { overallStatus: 'COMPLETED' },
  },
}

const directCellTrial = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT00000002',
      briefTitle: 'CAR-T Cell Study for Retinitis Pigmentosa',
    },
    statusModule: { overallStatus: 'RECRUITING' },
    designModule: { studyType: 'INTERVENTIONAL', phases: ['PHASE1'] },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Cellular Therapy Institute' } },
    conditionsModule: { conditions: ['Retinitis Pigmentosa'] },
    descriptionModule: { briefSummary: 'A direct-condition study of CAR-T cells for retinitis pigmentosa.' },
    armsInterventionsModule: { interventions: [{ name: 'CAR-T cells', type: 'BIOLOGICAL' }] },
    contactsLocationsModule: {
      locations: [{ facility: 'Test Cellular Therapy Institute', city: 'Boston', state: 'Massachusetts', country: 'United States' }],
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
  }, {
    title: 'blood dopamine',
    category: 'Biomarker mistaken for a treatment',
    summary: 'A source measured blood dopamine during research.',
    caution: 'A measurement is not a treatment.',
    sourceIds: ['pmid-1001'],
  }, {
    title: 'adjuvant therapy',
    category: 'Unnamed therapy class',
    summary: 'A source used a broad therapy label without naming an intervention.',
    caution: 'A broad label is not a treatment option.',
    sourceIds: ['pmid-1001'],
  }, {
    title: 'Orai-1 inhibitor',
    category: 'Unnamed drug class',
    summary: 'A source discussed a target class without naming a drug.',
    caution: 'A target class is not a named treatment.',
    sourceIds: ['pmid-1001'],
  }, {
    title: 'Virtual Reality Rehabilitation',
    category: 'Rehabilitation paper title',
    summary: 'A source compared rehabilitation programs.',
    caution: 'Rehabilitation belongs in the lifestyle and support section.',
    sourceIds: ['pmid-1001'],
  }, {
    title: 'Versus Conventional Physical therapy',
    category: 'Comparator fragment',
    summary: 'A title parser returned a comparator phrase.',
    caution: 'A comparator fragment is not a treatment name.',
    sourceIds: ['pmid-1001'],
  }, {
    title: 'initial MAO-B inhibitor therapy',
    category: 'Unnamed treatment class',
    summary: 'A source discussed a broad inhibitor class.',
    caution: 'A broad class is not a concrete named treatment.',
    sourceIds: ['pmid-1001'],
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
  treatmentIdeas: writerDraft.treatmentIdeas.map((item, index) => ({ index, decision: 'approve', item, reason: 'Test reviewer response.' })),
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
    { name: 'Cyclophosphamide', category: 'medicine', sourceIds: ['pmid-1001'] },
    { name: 'Made-up treatment', category: 'medicine', sourceIds: ['pmid-1001'] },
    { name: 'blood dopamine', category: 'medicine', sourceIds: ['pmid-1001'] },
    { name: 'adjuvant therapy', category: 'medicine', sourceIds: ['pmid-1001'] },
    { name: 'Orai-1 inhibitor', category: 'medicine', sourceIds: ['pmid-1001'] },
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

const createMockFetch = ({ failTrials = false, failEvidence = false, failPubMed = false, sparseReview = false, malformedReview = false, titleFallback = false, relationReviewUnavailable = false, relatedPreclinical = false, directCellStudy = false, delayedVariantTrial = false, failExactVariantTrial = false } = {}) => {
  const pubMedTerms = []
  const clinicalTrialQueries = []
  const clinicalTrialRecordIds = []
  let variantQueryCount = 0

  return {
    pubMedTerms,
    clinicalTrialQueries,
    clinicalTrialRecordIds,
    fetch: async (input, options = {}) => {
      const url = String(input)

      if (url.includes('/esearch.fcgi')) {
        if (failEvidence || failPubMed) throw new Error('PubMed is unavailable')
        const term = new URL(url).searchParams.get('term') || ''
        pubMedTerms.push(term)
        if (relatedPreclinical && /retinal degeneration/i.test(term)) {
          return jsonResponse({ esearchresult: { idlist: ['42321469'] } })
        }
        return jsonResponse({ esearchresult: { idlist: ['1001'] } })
      }
      if (url.includes('/efetch.fcgi')) {
        if (failEvidence || failPubMed) throw new Error('PubMed is unavailable')
        const ids = new URL(url).searchParams.get('id') || ''
        const primaryXml = titleFallback ? `${titleFallbackPubMedXml}${nonConditionComparisonPubMedXml}` : pubMedXml
        return textResponse(relatedPreclinical && ids.includes('42321469') ? `${primaryXml}${relatedPreclinicalPubMedXml}` : primaryXml)
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
              title: titleFallback ? 'Migalastat compared with enzyme replacement therapy in retinitis pigmentosa' : 'Vision rehabilitation in retinitis pigmentosa',
              abstractText: titleFallback ? 'This fixture tests source-title treatment fallback behavior.' : 'Vision rehabilitation is discussed for people with retinitis pigmentosa.',
              pubYear: '2025',
              journalTitle: 'Test Retina Journal',
              pubType: 'Systematic Review',
            }],
          },
        })
      }
      if (url.includes('clinicaltrials.gov/api/v2/studies')) {
        if (failTrials) throw new Error('ClinicalTrials.gov is unavailable')
        const trialUrl = new URL(url)
        const directRecordId = trialUrl.pathname.match(/\/studies\/(NCT\d{8})$/)?.[1]
        if (directRecordId) {
          clinicalTrialRecordIds.push(directRecordId)
          if (failExactVariantTrial) throw new Error('Exact trial lookup is unavailable')
          return jsonResponse(ush2aTrial)
        }
        clinicalTrialQueries.push(trialUrl)
        const queryText = `${trialUrl.searchParams.get('query.cond') || ''} ${trialUrl.searchParams.get('query.term') || ''}`
        if (/USH2A/i.test(queryText)) {
          variantQueryCount += 1
          return jsonResponse({ studies: delayedVariantTrial && variantQueryCount <= 2 ? [oldUsh2aTrial] : [ush2aTrial] })
        }
        return jsonResponse({ studies: [trial, unrelatedStemCellTrial, ...(directCellStudy ? [directCellTrial] : [])] })
      }
      if (url.includes('api.crossref.org/works')) {
        if (failEvidence) throw new Error('Crossref is unavailable')
        return jsonResponse({
          message: {
            items: [{
              DOI: '10.1000/crossref-rp',
              title: ['Retinitis pigmentosa treatment research'],
              'container-title': ['Crossref Retina Journal'],
              published: { 'date-parts': [[2025, 1, 1]] },
              URL: 'https://doi.org/10.1000/crossref-rp',
            }],
          },
        })
      }
      if (url.includes('api.semanticscholar.org/graph/v1/paper/search')) {
        if (failEvidence) throw new Error('Semantic Scholar is unavailable')
        return jsonResponse({
          data: [{
            paperId: 'semantic-rp-1',
            title: 'Retinitis pigmentosa treatment research',
            abstract: 'This Semantic Scholar record describes treatment research for retinitis pigmentosa.',
            year: 2025,
            venue: 'Semantic Retina Journal',
            externalIds: { DOI: '10.1000/semantic-rp' },
            url: 'https://www.semanticscholar.org/paper/semantic-rp-1',
          }],
        })
      }
      if (url.includes('api.reporter.nih.gov/v2/projects/search')) {
        if (failEvidence) throw new Error('NIH RePORTER is unavailable')
        return jsonResponse({
          results: [{
            appl_id: 12345678,
            project_num: 'R01EY000001',
            project_title: 'Retinitis pigmentosa research project',
            abstract_text: 'An active NIH project studying retinitis pigmentosa.',
            fiscal_year: 2026,
            organization: 'Test Eye Institute',
            project_detail_url: 'https://reporter.nih.gov/project-details/12345678',
          }],
        })
      }
      if (url.includes('wsearch.nlm.nih.gov/ws/query')) return textResponse(medlinePlusParkinsonXml)
      if (url.includes('api.perplexity.ai/search')) {
        return jsonResponse({
          results: [{
            title: 'Retinitis pigmentosa research center',
            url: 'https://example.org/retinitis-pigmentosa-research',
            snippet: 'A research center page for retinitis pigmentosa studies and clinical research.',
            date: '2026-08-11',
          }],
        })
      }
      if (url.includes('open.fda.gov/drug/label.json')) return jsonResponse({ error: { message: 'No matches found' } }, 404)
      if (url.includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body)
        if (relationReviewUnavailable && request.instructions.includes('Candidate Relation Reviewer')) {
          return jsonResponse({ error: { message: 'Reviewer unavailable in this test.' } }, 503)
        }
        if (malformedReview && !request.instructions.includes('Researcher Agent') && !request.instructions.includes('Research Connections Agent')) {
          return jsonResponse({ status: 'completed', output_text: 'This response is not valid JSON.' })
        }
        if (request.instructions.includes('Candidate Relation Reviewer')) {
          const input = String(request.input || '')
          const packet = JSON.parse(input.slice(input.indexOf('{'), input.lastIndexOf('}') + 1))
          const decisions = (packet.records || []).map((record) => {
            const unrelatedComorbidityMedicine = /cyclophosphamide|fresh frozen plasma|mycophenolate|methylprednisolone|bronchodilator/i.test(record.candidate)
            const sourceText = `${record.title || ''}. ${record.summary || ''}`
            const evidence = sourceText
              .split(/(?<=[.!?])\s+/)
              .find((sentence) => sentence.toLowerCase().includes(String(record.candidate || '').toLowerCase()))
              || sourceText
            return {
              recordId: record.recordId,
              candidate: record.candidate,
              decision: unrelatedComorbidityMedicine ? 'reject' : 'approve',
              relationship: /rehabilitation/i.test(record.candidate) ? 'condition-support' : 'direct-condition-treatment',
              evidence: evidence.slice(0, 170),
            }
          })
          return jsonResponse({ status: 'completed', output_text: JSON.stringify({ decisions }) })
        }
        const packetCandidateOutput = String(request.input || '').includes('erucamide')
          ? {
            candidates: [
              ...packetCandidateDraft.candidates,
              { name: 'erucamide', category: 'early animal or lab research', sourceIds: ['pmid-42321469'] },
            ],
          }
          : packetCandidateDraft
        const output = request.instructions.includes('Packet Candidate Extractor')
          ? packetCandidateOutput
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
  const mock = createMockFetch({ delayedVariantTrial: true, failExactVariantTrial: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes({ ...env, PERPLEXITY_API_KEY: '' }).get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'RP', geneticVariant: 'USH2A', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  assert.equal(response.body.patient.condition, 'Retinitis Pigmentosa')
  assert.ok(mock.pubMedTerms.some((term) => term.includes('Retinitis Pigmentosa')))
  assert.ok(mock.clinicalTrialQueries.some((url) => {
    const term = url.searchParams.get('query.term') || ''
    return /AREA\[ConditionSearch\]/.test(term) && /USH2A/i.test(term)
  }))
  assert.ok(mock.clinicalTrialQueries.some((url) => url.searchParams.get('query.cond') === 'USH2A'))
  assert.deepEqual(mock.clinicalTrialRecordIds, ['NCT06627179'])
  for (const laneId of ['crossref', 'semantic-scholar', 'nih-reporter']) {
    assert.equal(response.body.sourceCoverage.find((lane) => lane.id === laneId)?.status, 'ready')
  }
  assert.equal(response.body.sourceCoverage.find((lane) => lane.id === 'perplexity-web')?.status, 'not-configured')
  assert.ok(response.body.sources.length >= 3)
  assert.ok(response.body.sources.some((source) => source.id === 'rp-nei-condition-overview'))
  assert.ok(response.body.sources.some((source) => source.id === 'rp-nei-vision-rehabilitation'))
  assert.ok(response.body.sources.some((source) => source.id === 'rp-fda-luxturna-rpe65'))
  assert.ok(response.body.sources.some((source) => source.id === 'rp-lycium-barbarum-rct-2019'))
  assert.deepEqual(
    response.body.curatedDiscussionLeads.map((idea) => idea.title).sort(),
    ['Lycium barbarum (goji berry)', 'N-acetylcysteine (NAC)'].sort(),
  )
  assert.deepEqual(
    response.body.curatedLifestyleIdeas.map((idea) => idea.title),
    ['Vision rehabilitation and low-vision aids', 'Regular eye exams and treatable eye problems'],
  )
  assert.ok(response.body.curatedLifestyleIdeas.every((idea) => idea.sourceIds.every((id) => response.body.sources.some((source) => source.id === id))))
  assert.equal(response.body.curatedLifestyleIdeas[0].providerQuestion, 'Could vision rehabilitation help with daily tasks?')
  const candidateSource = response.body.sources.find((source) => source.candidateLeads?.some((candidate) => candidate.name === 'AAV-RP therapy'))
  assert.ok(candidateSource)
  assert.ok(candidateSource.candidateLeads.some((candidate) => candidate.name === 'AAV-RP therapy'))
  assert.ok(response.body.sources.some((source) => source.candidateLeads?.some((candidate) => candidate.name === 'Vision rehabilitation')))
  assert.ok(response.body.sources.every((source) => (source.candidateLeads || []).every((candidate) => candidate.roleVerified === true)))
  assert.ok(!response.body.sources.some((source) => source.candidateLeads?.some((candidate) => /cyclophosphamide/i.test(candidate.name))))
  assert.ok(!candidateSource.candidateLeads.some((candidate) => /unrelated/i.test(candidate.name)))
  assert.ok(!candidateSource.candidateLeads.some((candidate) => /made-up/i.test(candidate.name)))
  assert.ok(mock.pubMedTerms.some((term) => term.includes('AAV-RP therapy')))
  const candidateGate = response.body.sourceCoverage.find((lane) => lane.id === 'candidate-verification')
  assert.equal(candidateGate.status, 'ready')
  assert.match(candidateGate.detail, /exact source text/i)
  assert.equal(response.body.trials.length, 2)
  assert.deepEqual(response.body.trials.map((item) => item.id), ['NCT06627179', 'NCT00000001'])
  assert.equal(response.body.trials[0].variantMatch, true)
  assert.match(response.body.trials[0].caution, /confirm current status/i)
  assert.ok(!response.body.trials.some((item) => /NAION|umbilical cord/i.test(item.title)))
  assert.equal(response.body.centers.length, 5)
  assert.equal(response.body.centers[0].name, 'University of California, San Francisco')
  assert.equal(response.body.centers[0].variantMatch, true)
  assert.equal(response.body.centers[0].siteKind, 'academic-or-clinical-center')
  assert.equal(response.body.trials[0].siteName, 'University of California, San Francisco')
  assert.equal(response.body.review.treatmentIdeas.length, 1)
  assert.ok(!response.body.review.treatmentIdeas.some((idea) => /blood dopamine|adjuvant therapy|Orai-1 inhibitor|rehabilitation|physical therapy|initial MAO-B inhibitor/i.test(idea.title)))
  assert.equal(response.body.review.lifestyle.length, 1)
  assert.equal(response.body.review.safety.length, 1)
  assert.equal(response.body.review.hypotheses.length, 1)
  assert.equal(response.body.review.theoryIdeas.length, 10)
  assert.ok(response.body.review.theoryIdeas.some((idea) => idea.title === 'Vitamin D signaling and retinal cell stress'))
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.potentialInterventions?.length))
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.providerQuestion))
  assert.ok(response.body.review.theoryIdeas.every((idea) => !/\bhigh[-\s]?dose\b/i.test(`${idea.title} ${idea.whyItCouldConnect} ${idea.caution}`)))
  assert.deepEqual(response.body.review.questions[0].sourceIds, ['NCT00000001'])
  assert.equal(response.body.review.questions[0].text, 'Could this study fit me?')
  assert.ok((response.body.review.questions[0].text.match(/[A-Za-z0-9']+/g) || []).length <= 12)
  assert.equal(response.body.exploration, null)
  assert.equal(response.body.review.mode, 'dual-agent')
  assert.equal(response.body.review.independent, false)
})

test('an any-condition report uses MedlinePlus for the disease overview', { concurrency: false }, async () => {
  const mock = createMockFetch()
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes({ ...env, PERPLEXITY_API_KEY: '' }).get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: "Parkinson's disease", reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  const overview = response.body.sources.find((source) => source.origin === 'MedlinePlus')
  assert.ok(overview)
  assert.equal(overview.title, "Parkinson's Disease")
  assert.doesNotMatch(`${overview.title} ${overview.summary}`, /<[^>]+>/)
  assert.match(overview.conditionOverview.whatItIs, /movement disorder/i)
  assert.match(overview.conditionOverview.whatToWatch, /tremor|stiffness/i)
  assert.ok(response.body.sourceCoverage.some((lane) => lane.id === 'medlineplus' && lane.status === 'ready'))
  assert.equal(response.body.review.theoryIdeas.length, 10)
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.potentialInterventions?.length))
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.verificationQuery))
})

test('a direct condition-matched CAR-T or cell study stays in the live trial list', { concurrency: false }, async () => {
  const mock = createMockFetch({ directCellStudy: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  const cellStudy = response.body.trials.find((item) => item.id === 'NCT00000002')
  assert.ok(cellStudy, JSON.stringify(response.body.trials))
  assert.equal(cellStudy.conditionMatch, 'direct')
  assert.deepEqual(cellStudy.interventionDetails, [{ name: 'CAR-T cells', type: 'BIOLOGICAL' }])
})

test('a related retinal model finding stays in a clearly marked early-research lane', { concurrency: false }, async () => {
  const mock = createMockFetch({ relatedPreclinical: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.ok(mock.pubMedTerms.some((term) => /retinal degeneration/i.test(term)))
  const source = response.body.sources.find((item) => item.id === 'pmid-42321469')
  assert.ok(source, JSON.stringify(response.body.sources))
  assert.equal(source.conditionScope, 'related-preclinical')
  assert.match(source.relatedConditionContext, /not a study in people/i)
  const erucamide = source.candidateLeads?.find((candidate) => candidate.name === 'erucamide')
  assert.ok(erucamide, JSON.stringify(source))
  assert.equal(erucamide.relationship, 'condition-family-preclinical')
  assert.equal(erucamide.roleVerified, true)
  assert.equal(erucamide.sourceEarlyResearchDerived, true)
  assert.ok(!response.body.review.treatmentIdeas.some((idea) => /erucamide/i.test(idea.title)))
})

test('the audited recent-research intake keeps the erucamide paper separate from human RP care', () => {
  const signals = recentResearchSignalsFor('Retinitis Pigmentosa - USH2A')
  const study = signals.find((source) => source.id === 'rp-erucamide-retinal-protection-study-2026')
  const nei = signals.find((source) => source.id === 'rp-nei-erucamide-retinal-protection-2026')

  assert.ok(study)
  assert.ok(nei)
  assert.equal(study.url, 'https://pubmed.ncbi.nlm.nih.gov/42321469/')
  assert.match(nei.url, /^https:\/\/www\.nei\.nih\.gov\//)
  assert.equal(study.conditionScope, 'related-preclinical')
  assert.deepEqual(study.supportingSourceIds, [nei.id])
  assert.deepEqual(study.candidateLeads.map((candidate) => candidate.name), ['Erucamide'])
  assert.equal(study.candidateLeads[0].relationship, 'condition-family-preclinical')
  assert.equal(study.aiEligible, false)
})

test('broad web discovery stays link-only until another source verifies a claim', { concurrency: false }, async () => {
  const mock = createMockFetch({ failEvidence: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes({ ...env, PERPLEXITY_API_KEY: 'test-web-key' }).get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  const webLane = response.body.sourceCoverage.find((lane) => lane.id === 'perplexity-web')
  assert.equal(webLane.status, 'ready')
  assert.equal(webLane.records, 1)
  const webSource = response.body.sources.find((source) => source.origin === 'Broad web discovery')
  assert.ok(webSource)
  assert.equal(webSource.aiEligible, false)
  assert.equal(webSource.discoveryOnly, true)
  assert.ok(!response.body.review.treatmentIdeas.some((idea) => /research center/i.test(idea.title)))
})

test('the curated IPF source pack exposes its overview and FDA-labeled medicines', { concurrency: false }, async () => {
  const mock = createMockFetch()
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Idiopathic Pulmonary Fibrosis', reportStyle: 'plain' } },
  ))

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ready')
  const overviewSource = response.body.sources.find((source) => source.id === 'ipf-fda-condition-overview')
  assert.ok(overviewSource)
  assert.match(overviewSource.conditionOverview.whatItIs, /scarring in the lungs/i)
  assert.match(response.body.review.briefing.text, /serious lung disease/i)

  const labels = response.body.sources.filter((source) => source.type === 'FDA drug label')
  assert.deepEqual(
    labels.map((source) => source.treatmentName).sort(),
    ['Nerandomilast (Jascayd)', 'Nintedanib (Ofev)', 'Pirfenidone (Esbriet)'].sort(),
  )
  assert.equal(labels.every((source) => source.origin === 'U.S. Food and Drug Administration'), true)
  assert.ok(!response.body.sources.some((source) => source.candidateLeads?.some((candidate) => /monotherapy|dose reduction|study protocol/i.test(candidate.name))))

  assert.equal(response.body.centers.length, 6)
  assert.ok(response.body.centers.every((center) => center.url?.startsWith('https://')))
  assert.ok(response.body.centers.every((center) => center.sourceTitle?.length))
  const clevelandCenter = response.body.centers.find((center) => /Cleveland Clinic/i.test(center.name))
  assert.ok(clevelandCenter)
  assert.match(clevelandCenter.url, /clevelandclinic\.org/)
  assert.match(clevelandCenter.sourceTitle, /Interstitial Lung Disease Program/)

  assert.deepEqual(
    response.body.curatedLifestyleIdeas.map((idea) => idea.title),
    ['Pulmonary rehabilitation', 'Oxygen during activity', 'Smoking and pirfenidone'],
  )
  assert.ok(response.body.curatedLifestyleIdeas.every((idea) => idea.providerQuestion.endsWith('?')))
  assert.ok(response.body.curatedLifestyleIdeas.every((idea) => idea.sourceIds.every((id) => response.body.sources.some((source) => source.id === id))))
  assert.equal(response.body.curatedDiscussionLeads.length, 10)
  const nac = response.body.curatedDiscussionLeads.find((idea) => idea.title === 'N-acetylcysteine (NAC)')
  assert.ok(nac)
  assert.equal(nac.accessClass, 'evidence-points-away')
  assert.match(nac.takeaway, /did not show broad benefit/i)
  assert.match(nac.providerQuestion, /\?$/)
  assert.ok(nac.sourceIds.every((id) => response.body.sources.some((source) => source.id === id)))

  const blockedMetformin = response.body.excludedTreatments.find((item) => /metformin/i.test(item.title))
  assert.ok(blockedMetformin)
  assert.ok(blockedMetformin.aliases.some((alias) => /^metformin$/i.test(alias)))
  assert.deepEqual(blockedMetformin.sourceIds, ['ipf-metformin-spagnolo-2018'])
  assert.ok(blockedMetformin.sourceIds.every((id) => response.body.sources.some((source) => source.id === id)))

  const blockedNac = response.body.excludedTreatments.find((item) => /N-acetylcysteine monotherapy/i.test(item.title))
  assert.ok(blockedNac)
  assert.ok(blockedNac.aliases.some((alias) => /^NAC$/i.test(alias)))

  assert.equal(response.body.curatedTheoryIdeas.length, 10)
  assert.equal(response.body.review.theoryIdeas.length, 10)
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.potentialInterventions.length > 0))
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.sourceIds.every((id) => response.body.sources.some((source) => source.id === id))))
  const vagueTheoryItem = /\b(?:research|study|studies|platform|pathway|target|treatment|therapy|drug class|cell program|gene program|rna program|formal|academic|question|screen|search|trial)\b/i
  assert.ok(response.body.review.theoryIdeas.every((idea) => idea.potentialInterventions.some((item) => !vagueTheoryItem.test(item))))
  for (const name of ['Bosentan', 'Sildenafil', 'Interferon gamma-1b']) {
    const excluded = response.body.excludedTreatments.find((item) => item.aliases.some((alias) => alias.toLowerCase() === name.toLowerCase()))
    assert.ok(excluded, `${name} should stay in the negative-results lane`)
    assert.ok(excluded.sourceIds.every((id) => response.body.sources.some((source) => source.id === id)))
  }
  const cellResearch = response.body.curatedTheoryIdeas.find((idea) => idea.title === 'Academic cell and exosome research')
  assert.ok(cellResearch)
  assert.ok(cellResearch.potentialInterventions.some((item) => /exosome/i.test(item)))
  assert.match(cellResearch.accessRoute, /academic/i)
  assert.ok(cellResearch.sourceIds.every((id) => response.body.sources.some((source) => source.id === id)))
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

test('a condition-titled treatment source survives an unavailable AI relation check', { concurrency: false }, async () => {
  const mock = createMockFetch({ titleFallback: true, relationReviewUnavailable: true })
  const response = await withMockedFetch(mock.fetch, async () => callRoute(
    apiRoutes().get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' } },
  ))

  const titleFallbackSource = response.body.sources.find((source) => source.candidateLeads?.some((candidate) => candidate.name === 'Migalastat'))
  assert.ok(titleFallbackSource, JSON.stringify(response.body.sources))
  assert.ok(titleFallbackSource.candidateLeads.some((candidate) => candidate.name === 'Migalastat'))
  assert.ok(titleFallbackSource.candidateLeads.some((candidate) => candidate.name === 'enzyme replacement therapy'))
  assert.ok(titleFallbackSource.candidateLeads.every((candidate) => candidate.roleVerified && candidate.sourceTitleDerived))
  assert.ok(!response.body.sources.some((source) => source.candidateLeads?.some((candidate) => /mineralocorticoid/i.test(candidate.name))))
  assert.ok(!response.body.sources.some((source) => source.candidateLeads?.some((candidate) => /single-dose migalastat/i.test(candidate.name))))
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
  // The curated source IDs below are required. Additional safely retrieved
  // records must not make this fallback test fail in a richer environment.
  assert.ok(response.body.sources.length >= 8)
  assert.ok(response.body.sources.some((source) => source.id === 'rp-nac-phase-1-2020'))
  assert.ok(response.body.sources.some((source) => source.id === 'rp-lycium-barbarum-rct-2019'))
  assert.ok(response.body.sources.some((source) => source.id === 'rp-valproic-acid-phase-2-negative-2018'))
  assert.deepEqual(
    response.body.curatedDiscussionLeads.map((idea) => idea.title).sort(),
    ['Lycium barbarum (goji berry)', 'N-acetylcysteine (NAC)'].sort(),
  )
  const valproicAcid = response.body.excludedTreatments.find((item) => /valproic acid/i.test(item.title))
  assert.ok(valproicAcid)
  assert.deepEqual(valproicAcid.sourceIds, ['rp-valproic-acid-phase-2-negative-2018'])
  assert.ok(!response.body.review.treatmentIdeas.some((idea) => /valproic acid/i.test(idea.title)))
  const earlyResearchSource = response.body.sources.find((source) => source.id === 'rp-erucamide-retinal-protection-study-2026')
  assert.ok(earlyResearchSource)
  assert.equal(earlyResearchSource.conditionScope, 'related-preclinical')
  assert.equal(earlyResearchSource.candidateLeads[0].name, 'Erucamide')
  assert.ok(response.body.sourceCoverage.some((lane) => lane.id === 'verified-recent-research'))
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

test('the research endpoint limits repeat runs before paid providers are called', { concurrency: false }, async () => {
  const mock = createMockFetch()
  const routes = apiRoutes({ ...env, RESEARCH_RUN_MAX_PER_WINDOW: '2' })
  const run = () => callRoute(routes.get('/api/research-run'), 'POST', {
    privacyAcknowledged: true,
    patient: { condition: 'Retinitis Pigmentosa', reportStyle: 'plain' },
  })

  const responses = await withMockedFetch(mock.fetch, async () => [await run(), await run(), await run()])
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 429])
  assert.match(responses[2].body.error, /too many reports/i)
  assert.ok(Number(responses[2].headers['retry-after']) > 0)
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
    const hasAuthoritativeFoundation = /ipf|idiopathic pulmonary fibrosis|retinitis pigmentosa|huntington/i.test(condition)
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

test('common-condition foundations keep established care and lifestyle sections usable during source outages', { concurrency: false }, async () => {
  const routes = apiRoutes({
    ...env,
    ANTHROPIC_RESEARCH_DISABLED: 'true',
    OPENAI_API_KEY: '',
  })
  const unavailableFetch = async () => { throw new Error('Network unavailable for foundation test') }
  const run = (condition) => withMockedFetch(unavailableFetch, () => callRoute(
    routes.get('/api/research-run'),
    'POST',
    { privacyAcknowledged: true, patient: { condition } },
  ))

  const huntington = await run('Huntington Disease')
  assert.equal(huntington.status, 200)
  assert.equal(huntington.body.status, 'ready')
  assert.ok(huntington.body.sources.some((source) => source.treatmentName === 'Deutetrabenazine (Austedo and Austedo XR)'))
  assert.ok(huntington.body.sources.some((source) => source.treatmentName === 'Valbenazine (Ingrezza)'))
  assert.equal(huntington.body.curatedLifestyleIdeas.length, 3)
  assert.ok(huntington.body.review.briefing.sourceIds.includes('hd-ninds-condition-overview'))

  const crohn = await run("Crohn's Disease")
  assert.equal(crohn.status, 200)
  assert.equal(crohn.body.status, 'ready')
  const crohnLabels = crohn.body.sources.map((source) => source.treatmentName).filter(Boolean)
  assert.ok(crohnLabels.includes('Ustekinumab (Stelara and biosimilars)'))
  assert.ok(crohnLabels.includes('Upadacitinib (Rinvoq)'))
  assert.ok(crohnLabels.length >= 6)
  assert.equal(crohn.body.curatedDiscussionLeads.length, 3)
  assert.deepEqual(
    crohn.body.curatedDiscussionLeads.map((idea) => idea.title),
    [
      'Low-dose naltrexone',
      'Tacrolimus for Crohn fistulas',
      'Hyperbaric oxygen for treatment-resistant perianal fistulas',
    ],
  )
  assert.ok(crohn.body.sources.some((source) => source.id === 'crohn-ldn-rct-2011'
    && source.url === 'https://pubmed.ncbi.nlm.nih.gov/21380937/'))
  assert.ok(crohn.body.sources.some((source) => source.id === 'crohn-tacrolimus-fistula-rct-2003'
    && source.candidateLeads?.[0]?.roleVerified === true))
  assert.ok(crohn.body.sources.some((source) => source.id === 'crohn-hbot-fistula-pilot-2022'
    && source.candidateLeads?.[0]?.roleVerified === true))
  assert.equal(crohn.body.curatedLifestyleIdeas.length, 3)
  assert.ok(crohn.body.review.briefing.sourceIds.includes('crohn-niddk-overview'))
  assert.equal(crohn.body.review.theoryIdeas.length, 10)
  assert.ok(crohn.body.review.theoryIdeas.some((idea) => /NOD2-RIPK2/i.test(idea.title)))
  assert.ok(crohn.body.review.theoryIdeas.every((idea) => idea.potentialInterventions.length > 0))
  assert.ok(crohn.body.review.theoryIdeas.every((idea) => idea.potentialInterventions.every((item) =>
    !/\b(?:research|study|platform|pathway|target|treatment|therapy|drug class|question|trial)\b/i.test(item))))

  const parkinson = await run("Parkinson's Disease")
  assert.equal(parkinson.status, 200)
  assert.equal(parkinson.body.status, 'ready')
  const parkinsonLabels = parkinson.body.sources.map((source) => source.treatmentName).filter(Boolean)
  assert.ok(parkinsonLabels.includes('Carbidopa and levodopa (Sinemet and other products)'))
  assert.ok(parkinsonLabels.includes('Rotigotine patch (Neupro)'))
  assert.ok(parkinsonLabels.includes('Rasagiline'))
  assert.ok(parkinsonLabels.length >= 8)
  assert.equal(parkinson.body.curatedLifestyleIdeas.length, 3)
  assert.ok(parkinson.body.review.briefing.sourceIds.includes('parkinson-ninds-overview-support'))

  const lada = await run('LADA')
  assert.equal(lada.status, 200)
  assert.equal(lada.body.status, 'ready')
  assert.ok(lada.body.sources.some((source) => source.establishedCare === true && source.treatmentName === 'Insulin therapy'))
  assert.equal(lada.body.curatedDiscussionLeads.length, 6)
  assert.ok(lada.body.curatedDiscussionLeads.some((idea) => idea.title === 'GAD-alum immune therapy'))
  assert.ok(lada.body.sources.some((source) => source.id === 'lada-dulaglutide-posthoc-2018'
    && source.url === 'https://pubmed.ncbi.nlm.nih.gov/29377522/'))
  assert.ok(lada.body.excludedTreatments.some((item) => item.title === 'Sulfonylureas for LADA'))
  assert.equal(lada.body.curatedLifestyleIdeas.length, 3)
  assert.ok(lada.body.review.briefing.sourceIds.includes('lada-expert-consensus-overview'))
  assert.equal(lada.body.review.theoryIdeas.length, 10)
  assert.ok(lada.body.review.theoryIdeas.some((idea) => /Anti-CD3/i.test(idea.title)))
  assert.ok(lada.body.review.theoryIdeas.every((idea) => idea.potentialInterventions.every((item) =>
    !/\b(?:research|study|platform|pathway|target|treatment|therapy|drug class|question|trial)\b/i.test(item))))

  const wilson = await run('Wilson disease')
  assert.equal(wilson.status, 200)
  assert.equal(wilson.body.status, 'ready')
  const wilsonOptions = wilson.body.sources.map((source) => source.treatmentName).filter(Boolean)
  assert.ok(wilsonOptions.includes('Penicillamine'))
  assert.ok(wilsonOptions.includes('Trientine tetrahydrochloride (Cuvrior)'))
  assert.ok(wilsonOptions.includes('Trientine hydrochloride (Syprine)'))
  assert.ok(wilsonOptions.includes('Zinc acetate (Galzin)'))
  assert.equal(wilson.body.curatedLifestyleIdeas.length, 4)
  assert.ok(wilson.body.review.briefing.sourceIds.includes('wilson-medlineplus-overview'))
  assert.equal(wilson.body.review.theoryIdeas.length, 10)
  assert.ok(wilson.body.review.theoryIdeas.some((idea) => /ATP7B/i.test(idea.title)))
  assert.ok(wilson.body.review.theoryIdeas.every((idea) => idea.potentialInterventions.length > 0))
})
