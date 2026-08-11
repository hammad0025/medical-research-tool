// This is a small, audited intake for important recent findings that may not
// appear in a short ranked database search. Entries must be linked to a
// public primary paper and, when available, an authoritative research source.
const RECENT_RESEARCH_SIGNALS = [
  {
    id: 'rp-erucamide-retinal-protection-study-2026',
    conditionAliases: ['retinitis pigmentosa', 'rp'],
    title: 'A fatty acid amide activates myeloid cells and improves neurovascular outcomes in retinal degeneration',
    url: 'https://pubmed.ncbi.nlm.nih.gov/42321469/',
    type: 'Preclinical research study',
    origin: 'Nature Neuroscience',
    journal: 'Nature Neuroscience',
    year: '2026',
    pmid: '42321469',
    doi: '10.1038/s41593-026-02341-w',
    summary: 'This paper studied erucamide in mouse models of retinal degeneration, including a model related to retinitis pigmentosa. It was not a study in people with retinitis pigmentosa.',
    conditionScope: 'related-preclinical',
    conditionScopeLabel: 'related retinal-degeneration models',
    relatedConditionContext: 'Retinitis pigmentosa is an inherited retinal disease. This source is from a related retinal-degeneration model, not a study in people with retinitis pigmentosa.',
    supportingSourceIds: ['rp-nei-erucamide-retinal-protection-2026'],
    candidateLeads: [
      {
        name: 'Erucamide',
        category: 'Early animal or lab research',
        roleVerified: true,
        sourceEarlyResearchDerived: true,
        relationship: 'condition-family-preclinical',
        relationEvidence: 'In vivo delivery of erucamide limited vascular and neuronal degeneration in retinal disease models.',
      },
    ],
    // The card is built deterministically from the audited source. It is not
    // sent to the prose-writing model, which prevents a model from turning it
    // into a patient-accessible treatment claim.
    aiEligible: false,
  },
  {
    id: 'rp-nei-erucamide-retinal-protection-2026',
    conditionAliases: ['retinitis pigmentosa', 'rp'],
    title: 'NEI-funded research identifies molecule that strengthens the eye\'s response to damage in retinal disease',
    url: 'https://www.nei.nih.gov/research-and-training/research-news/nei-funded-research-identifies-molecule-strengthens-eyes-response-damage-retinal-disease',
    type: 'NIH research news',
    origin: 'National Eye Institute',
    year: '2026',
    summary: 'The National Eye Institute describes this as preclinical retinal-degeneration research. It is not a human treatment study for retinitis pigmentosa.',
    conditionScope: 'related-preclinical',
    conditionScopeLabel: 'related retinal-degeneration models',
    relatedConditionContext: 'Retinitis pigmentosa is an inherited retinal disease. This source is from a related retinal-degeneration model, not a study in people with retinitis pigmentosa.',
    aiEligible: false,
  },
]

const normalizedCondition = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

const matchesCondition = (signal, condition) => {
  const received = normalizedCondition(condition)
  return (signal.conditionAliases || []).some((alias) => {
    const expected = normalizedCondition(alias)
    return received === expected || received.startsWith(`${expected} `)
  })
}

// Return copies because downstream source enrichment may add metadata.
export const recentResearchSignalsFor = (condition) => RECENT_RESEARCH_SIGNALS
  .filter((signal) => matchesCondition(signal, condition))
  .map((signal) => ({
    ...signal,
    supportingSourceIds: [...(signal.supportingSourceIds || [])],
    candidateLeads: (signal.candidateLeads || []).map((candidate) => ({ ...candidate })),
  }))
