const baseUrl = 'https://clinicaltrials.gov/api/v2/studies'

const formatTrial = (study, locationHint) => {
  const protocol = study.protocolSection || {}
  const identification = protocol.identificationModule || {}
  const status = protocol.statusModule || {}
  const design = protocol.designModule || {}
  const sponsor = protocol.sponsorCollaboratorsModule?.leadSponsor?.name || 'Sponsor not listed'
  const interventions = protocol.armsInterventionsModule?.interventions || []
  const locations = protocol.contactsLocationsModule?.locations || []

  const location = locations.find((entry) => {
    const haystack = `${entry.city || ''} ${entry.state || ''} ${entry.country || ''}`
    return locationHint && haystack.toLowerCase().includes(locationHint.toLowerCase())
  }) || locations[0]

  return {
    id: identification.nctId,
    title: identification.briefTitle || 'Untitled study',
    phase: (design.phases || ['Phase not listed']).join(', '),
    status: status.overallStatus || 'Status not listed',
    sponsor,
    interventions: interventions.slice(0, 3).map((item) => item.name).join(', ') || 'Intervention not listed',
    location: location
      ? [location.city, location.state, location.country].filter(Boolean).join(', ')
      : 'Location not listed',
    summary: protocol.descriptionModule?.briefSummary || 'No brief summary available.',
    url: `https://clinicaltrials.gov/study/${identification.nctId}`,
  }
}

export const fetchIpfTrials = async (locationHint) => {
  const url = new URL(baseUrl)
  url.searchParams.set('query.cond', 'Idiopathic Pulmonary Fibrosis')
  url.searchParams.set('filter.overallStatus', 'RECRUITING')
  url.searchParams.set('pageSize', '6')
  url.searchParams.set('format', 'json')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('ClinicalTrials.gov did not return a usable response.')
  }

  const payload = await response.json()
  const studies = Array.isArray(payload.studies) ? payload.studies : []

  const trials = studies
    .filter((study) => study.protocolSection?.designModule?.studyType === 'INTERVENTIONAL')
    .slice(0, 4)
    .map((study) => formatTrial(study, locationHint))

  return {
    fetchedAt: new Date().toLocaleString(),
    trials,
  }
}
