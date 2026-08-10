const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim()

export const sourceLabel = (source) => cleanText(source?.label || source?.title || source?.id || 'Source')

const uniqueByUrl = (sources) => {
  const seen = new Set()
  return sources.filter((source) => {
    const url = cleanText(source?.url)
    if (!url || seen.has(url)) return false
    seen.add(url)
    return true
  })
}

export const citationsFor = (result, sourceIds) => {
  if (!Array.isArray(sourceIds) || !sourceIds.length) return []
  const byId = new Map(
    [...(result?.sources || []), ...(result?.trials || [])]
      .filter((item) => item?.id && item?.url)
      .map((item) => [item.id, item]),
  )
  return uniqueByUrl(sourceIds.map((id) => byId.get(id)).filter(Boolean))
}

export const verificationLinks = ({ condition, searchTerms = [] } = {}) => {
  const fallback = cleanText(condition) || 'medical research'
  const term = cleanText(searchTerms.find(Boolean)) || fallback
  const encodedTerm = encodeURIComponent(term)
  const encodedCondition = encodeURIComponent(cleanText(condition) || term)
  return [
    {
      id: `verify-pubmed-${term.toLowerCase()}`,
      label: 'Verify in PubMed',
      url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodedTerm}`,
    },
    {
      id: `verify-trials-${(cleanText(condition) || term).toLowerCase()}`,
      label: 'Search ClinicalTrials.gov',
      url: `https://clinicaltrials.gov/search?cond=${encodedCondition}`,
    },
  ]
}

export const citationsForClaim = ({ result, sourceIds, condition, searchTerms, verifyWhenEmpty = false } = {}) => {
  const citations = citationsFor(result, sourceIds)
  return citations.length || !verifyWhenEmpty ? citations : verificationLinks({ condition, searchTerms })
}

export const citationText = (citations, label = 'Sources') => {
  const entries = uniqueByUrl(Array.isArray(citations) ? citations : [])
  if (!entries.length) return ''
  return `${label}: ${entries.map((citation) => `${sourceLabel(citation)} (${citation.url})`).join('; ')}`
}
