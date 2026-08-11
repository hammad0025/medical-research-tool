const directIdentifierPatterns = [
  { label: 'an email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: 'a phone number', pattern: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/ },
  { label: 'a Social Security number', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: 'a full date of birth', pattern: /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}[/-](?:0[1-9]|1[0-2])[/-](?:0[1-9]|[12]\d|3[01])\b/ },
  { label: 'a date of birth', pattern: /\b(?:date\s+of\s+birth|dob|born)\b[^.\n]{0,48}\b(?:19|20)\d{2}\b/i },
  { label: 'an insurance policy or member number', pattern: /\b(?:insurance|policy|subscriber|member)\s*(?:id|number|no\.?)\s*(?:#|:)?\s*[a-z0-9-]{4,}\b/i },
  { label: 'a medical record or patient ID', pattern: /\b(?:medical\s*record|mrn|patient\s*(?:id|number)|member\s*(?:id|number))\s*(?:#|:)?\s*[a-z0-9-]{4,}\b/i },
  { label: 'a street address', pattern: /\b\d{1,5}\s+(?:[A-Za-z]+\s+){0,3}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way)\b/i },
]

export const findDirectIdentifier = (value) => {
  const text = String(value || '')
  return directIdentifierPatterns.find((entry) => entry.pattern.test(text))?.label || ''
}

const profileFieldLabels = {
  condition: 'condition',
  location: 'location',
  stage: 'stage',
  age: 'age',
  gender: 'sex or gender',
  weight: 'weight',
  smoking: 'smoking history',
  activity: 'activity',
  diagnoses: 'health conditions',
  symptoms: 'symptoms',
  currentMeds: 'medicines',
  allergies: 'allergies',
  priorTherapies: 'past treatments',
  scans: 'test or scan notes',
  geneticVariant: 'gene result',
  goals: 'research question',
}

export const findProfilePrivacyIssue = (profile) => {
  for (const [field, label] of Object.entries(profileFieldLabels)) {
    const identifier = findDirectIdentifier(profile?.[field])
    if (identifier) return { field, label, identifier }
  }
  return null
}

export const privacyIssueMessage = (issue) => issue
  ? `Remove ${issue.identifier} from the ${issue.label} field. This demo is not HIPAA-ready, so do not send real patient details.`
  : ''
