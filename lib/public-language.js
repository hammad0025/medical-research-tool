// Deterministic boundary for text that can be shown to a reader.
// Keep this module browser-safe: it is used by API handlers and the frontend.

const ZERO_WIDTH = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const DASHES = /[\u058a\u05be\u1400\u1806\u2010-\u2015\u2e17\u2e1a\u2e3a-\u2e3b\u2e40\u301c\u3030\u30a0\ufe31-\ufe32\ufe58\ufe63\uff0d]/g;
const SPACES = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
const CONFUSABLE_ASCII = Object.freeze({
  а: 'a', с: 'c', е: 'e', і: 'i', ј: 'j',
  о: 'o', р: 'p', ѕ: 's', х: 'x', у: 'y'
});
const PROHIBITED_SKELETONS = [
  'evidencepack', 'diligencepacket', 'demorehearsal', 'challengesuite',
  'groundedevidencepack', 'groundedevidence', 'dossiersourced', 'diseasedossier',
  'faers', 'promptpack', 'secondai', 'modelfallbackchain', 'internalpipeline',
  'citationaudit', 'validationstatus', 'schemavalidation', 'saveddemoprovenance',
  'sourcesha', 'serverseal', 'reportseal', 'profilekey', 'reviewedgitsha',
  'coveragemessages', 'repurposesection', 'evidencestrength',
  'patientspecificrisks', 'internalerror', 'upstreamstacktrace'
];

const canonicalizePublicUnicode = (value) =>
  String(value ?? '').normalize('NFKC').replace(ZERO_WIDTH, '');

export const normalizePublicLanguageForDetection = (value) =>
  canonicalizePublicUnicode(value)
    .replace(DASHES, '-')
    .replace(SPACES, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

const publicLanguageSkeleton = (value) => [...normalizePublicLanguageForDetection(value).toLowerCase()]
  .map((char) => CONFUSABLE_ASCII[char] || char)
  .join('')
  .replace(/[^\p{L}\p{N}]+/gu, '');

// Exported so downstream text passes can recognise a field label in EITHER
// spelling. Anything that matches on the raw key alone breaks the moment
// polishReportForDisplay renames it — which is exactly how every candidate's
// "Research category" / "Strength of research" line came to be deleted as an
// unsourced claim, collapsing the drug-idea buckets to all-unclear.
export const RAW_LABELS = Object.freeze({
  PROVIDER: 'Treatment type',
  TREATMENT: 'Treatment',
  FDA_STATUS: 'FDA status',
  LENGTH_FREQUENCY: 'Dose and schedule',
  EFFICACY: 'What studies found',
  SAFETY: 'Safety concern',
  RISKS: 'Risks',
  INTERACTIONS: 'Medication interactions',
  COST: 'Cost and access',
  REFERENCES: 'Sources',
  CANDIDATE: 'Drug or supplement idea',
  ITEM_KIND: 'Type',
  CLASS: 'Class',
  APPROVED_FOR: 'Usually used for',
  WHAT_IT_DOES: 'What it does',
  WHY_FOR_THIS_CONDITION: 'Why this option was searched',
  MECHANISM_TARGET: 'How it might work',
  REPURPOSE_RATIONALE: 'Reason for considering it',
  REPURPOSE_SECTION: 'Research category',
  EVIDENCE_STRENGTH: 'Strength of research',
  SUPPORTING_EVIDENCE: 'What the research says',
  EFFICACY_HYPOTHESIS: 'Theoretical benefit',
  CONFIDENCE: 'Confidence',
  PATIENT_SPECIFIC_RISKS: 'Risks for this patient',
  HOW_TO_DISCUSS_WITH_DOCTOR: 'Questions for your doctor',
  COMBO: 'Combination studied',
  RATIONALE: 'Why it was studied',
  EVIDENCE_TIER: 'Study evidence level',
  INTERACTION_RISK: 'Interaction concern',
  THEORETICAL_BENEFIT: 'Theoretical benefit',
  FIT_FOR_PATIENT: 'Fit for the patient details provided',
  HARM_RISK: 'Safety concern',
  LOCATION_CONTACT: 'Location and contact',
  SUMMARY: 'Summary'
});

/** Every reader-facing field label, longest first so prefix matching is greedy. */
export const READER_FIELD_LABELS = Object.freeze(
  [...new Set(Object.values(RAW_LABELS))].sort((a, b) => b.length - a.length)
);

/**
 * Every spelling a field label can appear in for the given raw keys: the raw
 * machine key plus its reader-facing rename. Callers that pattern-match field
 * labels must use this rather than hardcoding one spelling.
 */
export const fieldLabelSpellings = (keys) => {
  const out = new Set();
  for (const key of keys || []) {
    if (!key) continue;
    out.add(key);
    if (RAW_LABELS[key]) out.add(RAW_LABELS[key]);
  }
  return [...out];
};

const REWRITES = [
  [/\bthe evidence[\s-]*pack does not (?:provide|include|contain|list)\s+FAERS\b[^.|]*/gi,
    'FDA post-market report counts were not available in the sources we reviewed'],
  // Catch-all for every OTHER phrasing the model uses when it correctly
  // follows the prompt's instruction to discuss FDA post-market adverse-event
  // report counts (a legitimate, safety-critical topic) but writes the raw
  // internal acronym instead of reader-facing language. Without this, any
  // sentence mentioning FAERS that isn't the one exact phrasing above fell
  // through to the hard PROHIBITED_SKELETONS assertion and failed the whole
  // report/response instead of being rewritten.
  [/\bFAERS\b/gi, 'FDA post-market safety reports'],
  // The remaining catch-alls below close the same gap for every other
  // PROHIBITED_SKELETONS entry that previously had no (or only a narrow,
  // single-phrasing) rewrite. Each of these is plausible in genuine,
  // non-adversarial output — either the model paraphrasing its own system
  // prompt's internal vocabulary (as it did with FAERS), or a hardcoded
  // status string reaching sanitizePublicPayload — and a miss here is not a
  // cosmetic leak, it fails the entire request the same way FAERS did.
  [/\b(?:the |a )?second AI\b/gi, 'the independent reviewer'],
  [/\bprompt[\s-]*packs?\b/gi, 'prompt templates'],
  [/\bmodel[\s-]*fallback[\s-]*chains?\b/gi, 'backup response system'],
  [/\binternal[\s-]*pipelines?\b/gi, 'internal review process'],
  [/\bvalidation[\s-]*status\b/gi, 'review status'],
  [/\bschema[\s-]*validation\b/gi, 'response verification'],
  [/\bsaved[\s-]*demo[\s-]*provenance\b/gi, 'saved example record'],
  [/\bprofile[\s-]*key\b/gi, 'profile record'],
  [/\breviewed[\s-]*git[\s-]*sha\b/gi, 'reviewed version'],
  [/\bcoverage[\s-]*messages\b/gi, 'coverage notes'],
  [/\brepurpose[\s-]*section\b/gi, 'research category'],
  [/\bevidence[\s-]*strength\b/gi, 'strength of research'],
  [/\bpatient[\s-]*specific[\s-]*risks\b/gi, 'risks for this patient'],
  [/\binternal[\s-]*error\b/gi, 'unexpected problem'],
  [/\bthe evidence[\s-]*pack does not (?:provide|include|contain|list)\b/gi, 'we did not find'],
  [/\b(?:in|from|among|within)\s+(?:this|the)\s+evidence[\s-]*pack\b/gi, 'in the sources we reviewed'],
  [/\bno evidence[\s-]*pack items?\b/gi, 'No published source found here'],
  [/\bevidence[\s-]*pack items?\b/gi, 'published sources'],
  [/\b(?:the|this|an?)\s+evidence[\s-]*pack\b/gi, 'the sources we reviewed'],
  [/\bevidence[\s-]*packs?\b/gi, 'source collections'],
  [/\bno grounded evidence\b/gi, 'No published source found'],
  [/\bgrounded evidence\b/gi, 'published research'],
  [/\bdisease[\s-]*dossier\b/gi, 'condition overview'],
  [/\bdossier[\s-]*sourced\b|\bdossier source\b/gi, 'source reviewed'],
  [/(^|[^\p{L}\p{N}])K[^\p{L}\p{N}]{0,6}8s?(?=$|[^\p{L}\p{N}])/giu, '$1quality review'],
  [/\bdiligence[\s-]*packets?\b/gi, 'review materials'],
  [/\bdemo[\s-]*rehearsals?\b/gi, 'presentation checks'],
  [/\bchallenge[\s-]*suites?\b/gi, 'safety checks'],
  [/\bcitation[\s-]*audit\b/gi, 'source check'],
  [/\bvalidation[\s-]*audit\b/gi, 'independent review'],
  [/\baudit status\b/gi, 'review status'],
  [/\binternal server error\b/gi, 'The service encountered an unexpected problem'],
  [/\b(?:model|schema) validation failed\b/gi, 'The response could not be verified'],
  [/\b(?:model output|raw model response)\b/gi, 'generated response'],
  [/\bdegraded coverage\b/gi, 'partial source coverage'],
  [/\breport sealing\b/gi, 'report verification'],
  [/\breport seal\b/gi, 'verification record'],
  [/\bserver seal\b/gi, 'verification record'],
  [/\bsource[\s_-]*SHA\b/gi, 'reviewed version'],
  [/\bsourceSHA\b/gi, 'reviewed version'],
  [/\bACTIVE[\s_-]*NOT[\s_-]*RECRUITING\b/gi, 'Active, not recruiting'],
  [/\bNOT[\s_-]*YET[\s_-]*RECRUITING\b/gi, 'Not yet recruiting'],
  [/\bENROLLING[\s_-]*BY[\s_-]*INVITATION\b/gi, 'Enrolling by invitation'],
  [/\bNO[\s_-]*LONGER[\s_-]*AVAILABLE\b/gi, 'No longer available'],
  [/\bPHASE[\s_-]*([1-4])\b/gi, 'Phase $1']
];

const PROHIBITED = [
  /\bevidence[\s-]*packs?\b/i,
  /\bgrounded evidence\b/i,
  /\bdisease[\s-]*dossier\b|\bdossier[\s-]*(?:source|sourced)\b/i,
  /(^|[^\p{L}\p{N}])K[^\p{L}\p{N}]{0,6}8s?(?=$|[^\p{L}\p{N}])/iu,
  /\bdiligence[\s-]*packets?\b/i,
  /\bdemo[\s-]*rehearsals?\b/i,
  /\bchallenge[\s-]*suites?\b/i,
  /\b(?:citation|validation|security)[\s-]*audit\b|\baudit status\b/i,
  /\b(?:system prompt|developer message|hidden instructions?|chain[\s-]*of[\s-]*thought|private orchestration|internal[\s-]*only instruction)\b/i,
  /\b(?:schemaVersion|schema validation|model output|raw model response|modelRequested|promptPackBreakdown|generatedBy|cacheHit)\b/i,
  /\b(?:API[\s_-]*KEY|authorization\s*:\s*bearer|access token|secret token|stack trace|SSRF|cross[\s-]*site scripting|XSS)\b/i,
  /\binternal server error\b/i,
  /^(?:PROVIDER|FDA_STATUS|REPURPOSE_SECTION|EVIDENCE_STRENGTH|MECHANISM_TARGET|SUPPORTING_EVIDENCE|FIT_FOR_PATIENT|HARM_RISK|LOCATION_CONTACT)\s*:/im,
  /\b(?:ACTIVE_NOT_RECRUITING|NOT_YET_RECRUITING|ENROLLING_BY_INVITATION|NO_LONGER_AVAILABLE|PHASE[1-4])\b/i
];

const CONFIDENTIAL_LINE = /\b(?:system prompt|developer message|hidden instructions?|chain[\s-]*of[\s-]*thought|private orchestration|internal[\s-]*only instruction|API[\s_-]*KEY|authorization\s*:\s*bearer|access token|secret token|stack trace)\b/i;

export class PublicLanguageBoundaryError extends Error {
  constructor(matches) {
    super('Public text did not pass the reader-language boundary.');
    this.name = 'PublicLanguageBoundaryError';
    this.code = 'PUBLIC_LANGUAGE_REJECTED';
    this.matches = matches;
  }
}

export const findProhibitedPublicLanguage = (value, { sourceTitle = false } = {}) => {
  if (sourceTitle) return [];
  const normalized = normalizePublicLanguageForDetection(value);
  const skeleton = publicLanguageSkeleton(normalized);
  const compactMatches = PROHIBITED_SKELETONS.filter((term) =>
    skeleton.includes(term) || skeleton.includes(`${term}s`)
  );
  return [...compactMatches, ...PROHIBITED
    .map((pattern) => normalized.match(pattern)?.[0] || '')
    .filter(Boolean)];
};

const rewritePublicLanguage = (value, { sourceTitle = false } = {}) => {
  let text = canonicalizePublicUnicode(value);
  if (sourceTitle) return text;
  // Normalize dash variants only inside words that participate in boundary
  // phrases. Typography elsewhere remains untouched.
  text = text.replace(
    /\b(evidence|disease|dossier|grounded|diligence|demo|challenge|citation|validation|audit|model|schema|internal|system|developer|hidden|chain|private|access|secret|cross|K)\p{Pd}+(?=[\p{L}\p{N}])/gu,
    '$1-'
  );
  text = text
    .split('\n')
    .filter((line) => !CONFIDENTIAL_LINE.test(normalizePublicLanguageForDetection(line)))
    .join('\n');
  for (const [pattern, replacement] of REWRITES) text = text.replace(pattern, replacement);
  text = text.replace(/^([ \t>*#-]*)([A-Z][A-Z0-9_]*):/gm, (match, prefix, label) => {
    const approved = RAW_LABELS[label];
    return approved ? `${prefix}${approved}:` : match;
  });
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
};

const assertPublicLanguage = (value, options) => {
  const matches = findProhibitedPublicLanguage(value, options);
  if (matches.length) throw new PublicLanguageBoundaryError(matches);
  return value;
};

export const sanitizePublicText = (value, options) => {
  const rewritten = rewritePublicLanguage(value, options);
  return assertPublicLanguage(rewritten, options);
};

export const sanitizePublicHtml = (value) => {
  const protectedTitles = [];
  const tokenized = canonicalizePublicUnicode(value).replace(
    /(<([a-z][a-z0-9-]*)\b[^>]*\bdata-mrt-source-title(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>)([\s\S]*?)(<\/\2>)/gi,
    (match) => {
      const token = `MRTSOURCETITLE${protectedTitles.length}TOKEN`;
      protectedTitles.push(match);
      return token;
    }
  );
  let clean = sanitizePublicText(tokenized);
  protectedTitles.forEach((title, index) => {
    clean = clean.replace(`MRTSOURCETITLE${index}TOKEN`, title);
  });
  return clean;
};

const VISIBLE_TEXT_KEYS = /^(?:text|content|error|message|summary|description|reason|label|notice|html|subject|researchText|repurposeText|coverageMessages|missingMessages)$/i;
const SOURCE_TITLE_KEYS = /^(?:title|briefTitle|officialTitle|sourceTitle|journal)$/i;

export const sanitizePublicPayload = (value, key = '', seen = new WeakSet()) => {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (SOURCE_TITLE_KEYS.test(key)) return sanitizePublicText(value, { sourceTitle: true });
    return VISIBLE_TEXT_KEYS.test(key) ? sanitizePublicText(value) : canonicalizePublicUnicode(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizePublicPayload(entry, key, seen));
  if (typeof value !== 'object') return value;
  if (seen.has(value)) throw new PublicLanguageBoundaryError(['cyclic public payload']);
  seen.add(value);
  const clean = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    clean[entryKey] = sanitizePublicPayload(entry, entryKey, seen);
  }
  seen.delete(value);
  return clean;
};

export const installPublicJsonBoundary = (res) => {
  if (!res || typeof res.json !== 'function' || res.__publicLanguageBoundary) return res;
  const json = res.json.bind(res);
  Object.defineProperty(res, '__publicLanguageBoundary', { value: true });
  res.json = (body) => json(sanitizePublicPayload(body));
  return res;
};

