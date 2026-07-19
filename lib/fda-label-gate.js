import { createGatherSeal, verifyGatherSeal } from './gather-seal.js';
import { canonicalizeCitationUrl, rewriteMarkdownLinks } from './citation-gate.js';

const LABEL_FINGERPRINT = 'fda-dailymed-runtime-v1';
const SET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLICATION_RE = /^(?:ANDA|NDA|BLA)\d{6}$/i;
const SPL_ID_RE = SET_ID_RE;
const UNKNOWN_LABEL_TEXT = 'Unknown — insufficient verified FDA/DailyMed label evidence.';

const values = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .map((item) => String(item || '').trim())
  .filter(Boolean);

const normalizeName = (value) => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/\b(?:tablet|capsule|injection|solution|cream|ointment|oral|topical)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const normalizeSplSetId = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return SET_ID_RE.test(id) ? id : '';
};

export const dailyMedLabelUrl = (setId) => {
  const id = normalizeSplSetId(setId);
  return id ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${id}` : '';
};

export const setIdFromDailyMedUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    return '';
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'dailymed.nlm.nih.gov' ||
    parsed.pathname.toLowerCase() !== '/dailymed/druginfo.cfm' ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some((key) => key.toLowerCase() !== 'setid')
  ) return '';
  return normalizeSplSetId(parsed.searchParams.get('setid'));
};

const normalizeApplications = (value) =>
  [...new Set(values(value).map((item) => item.toUpperCase()))];

const rawSetId = (raw) =>
  values(raw?.openfda?.spl_set_id)[0] || raw?.set_id || raw?.spl_set_id || '';

export const labelRecordFromOpenFda = (raw, { requestedDrug = '' } = {}) => {
  const setId = normalizeSplSetId(rawSetId(raw));
  const url = dailyMedLabelUrl(setId);
  return {
    requestedDrug: String(requestedDrug || '').trim(),
    splSetId: setId,
    splIds: values(raw?.openfda?.spl_id || raw?.id).map((id) => id.toLowerCase()),
    effectiveDate: String(raw?.effective_time || '').trim(),
    applicationNumbers: normalizeApplications(raw?.openfda?.application_number),
    productNdc: values(raw?.openfda?.product_ndc),
    brandName: values(raw?.openfda?.brand_name),
    genericName: values(raw?.openfda?.generic_name),
    activeIngredient: values(raw?.openfda?.substance_name),
    manufacturer: values(raw?.openfda?.manufacturer_name),
    route: values(raw?.openfda?.route),
    dosageForm: values(raw?.openfda?.dosage_form),
    productType: values(raw?.openfda?.product_type),
    boxedWarning: values(raw?.boxed_warning).join('\n'),
    indications: values(raw?.indications_and_usage).join('\n'),
    warnings: [
      ...values(raw?.warnings),
      ...values(raw?.warnings_and_cautions)
    ].join('\n'),
    contraindications: values(raw?.contraindications).join('\n'),
    adverseReactions: values(raw?.adverse_reactions).join('\n').slice(0, 6000),
    drugInteractions: values(raw?.drug_interactions).join('\n').slice(0, 6000),
    dosage: values(raw?.dosage_and_administration).join('\n').slice(0, 4000),
    pregnancy: values(raw?.pregnancy).join('\n'),
    geriatric: values(raw?.geriatric_use).join('\n'),
    dailyMedUrl: url,
    url
  };
};

const labelNames = (label) => [
  ...values(label?.brandName),
  ...values(label?.genericName),
  ...values(label?.activeIngredient)
];

export const labelMatchesRequestedProduct = (label, requestedDrug = label?.requestedDrug) => {
  const requested = normalizeName(requestedDrug);
  if (!requested) return false;
  return labelNames(label).some((name) => normalizeName(name) === requested);
};

export const validateLabelIdentity = (label, { requestedDrug = label?.requestedDrug } = {}) => {
  const issues = [];
  const setId = normalizeSplSetId(label?.splSetId);
  if (!setId) issues.push('LABEL_SET_ID_INVALID');
  const urlSetId = setIdFromDailyMedUrl(label?.dailyMedUrl || label?.url);
  if (!urlSetId) issues.push('LABEL_URL_INVALID');
  else if (setId && urlSetId !== setId) issues.push('LABEL_URL_SET_ID_MISMATCH');
  if (!values(label?.genericName).length && !values(label?.brandName).length) {
    issues.push('LABEL_PRODUCT_NAME_MISSING');
  }
  if (!values(label?.activeIngredient).length) issues.push('LABEL_ACTIVE_INGREDIENT_MISSING');
  if (requestedDrug && !labelMatchesRequestedProduct(label, requestedDrug)) {
    issues.push('LABEL_PRODUCT_MISMATCH');
  }
  if (values(label?.splIds).some((id) => !SPL_ID_RE.test(id))) issues.push('LABEL_SPL_ID_INVALID');
  if (values(label?.applicationNumbers).some((id) => !APPLICATION_RE.test(id))) {
    issues.push('LABEL_APPLICATION_ID_INVALID');
  }
  return [...new Set(issues)];
};

const unsignedLabel = (label = {}) => ({
  requestedDrug: String(label.requestedDrug || ''),
  splSetId: String(label.splSetId || ''),
  splIds: values(label.splIds),
  applicationNumbers: values(label.applicationNumbers),
  productNdc: values(label.productNdc),
  brandName: values(label.brandName),
  genericName: values(label.genericName),
  activeIngredient: values(label.activeIngredient),
  manufacturer: values(label.manufacturer),
  route: values(label.route),
  dosageForm: values(label.dosageForm),
  productType: values(label.productType),
  boxedWarning: String(label.boxedWarning || ''),
  indications: String(label.indications || ''),
  warnings: String(label.warnings || ''),
  contraindications: String(label.contraindications || ''),
  adverseReactions: String(label.adverseReactions || ''),
  drugInteractions: String(label.drugInteractions || ''),
  dosage: String(label.dosage || ''),
  pregnancy: String(label.pregnancy || ''),
  geriatric: String(label.geriatric || ''),
  dailyMedUrl: String(label.dailyMedUrl || ''),
  url: String(label.url || '')
});

export const sealFdaLabel = (label, { secret, now } = {}) =>
  createGatherSeal({
    gatherFingerprint: LABEL_FINGERPRINT,
    dossier: null,
    evidence: unsignedLabel(label),
    trials: null,
    secret,
    now
  });

export const verifyFdaLabel = (label, { secret, now } = {}) => {
  const issues = validateLabelIdentity(label);
  if (issues.length) return { ok: false, code: issues[0], issues };
  return verifyGatherSeal({
    seal: label?.labelSeal,
    gatherFingerprint: LABEL_FINGERPRINT,
    dossier: null,
    evidence: unsignedLabel(label),
    trials: null,
    secret,
    now
  });
};

export const verifiedFdaLabelEntries = (entries, options = {}) => {
  const accepted = [];
  const rejected = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const label = entry?.label || entry;
    const result = verifyFdaLabel(label, options);
    if (result.ok) accepted.push(entry);
    else rejected.push({ drug: entry?.drug || label?.requestedDrug || '', reason: result.code });
  }
  return { accepted, rejected };
};

const claimClasses = (value) => {
  const text = String(value || '');
  const classes = new Set();
  if (/\b(?:FDA[- ]approved|approved by (?:the )?FDA|unapproved|not FDA[- ]approved|approval status|label status)\b/i.test(text)) {
    classes.add('approval');
  }
  if (/\b(?:indicat(?:ed|ion)|approved (?:for|to treat)|on[- ]label|off[- ]label)\b/i.test(text)) {
    classes.add('indication');
  }
  if (
    /\b(?:dose|dosage|dosing|once daily|twice daily|three times daily|every \d+ hours?|administered)\b/i.test(text) ||
    /\b\d+(?:\.\d+)?\s*(?:mcg|µg|mg|g|mL|units?)\b/i.test(text)
  ) classes.add('dosage');
  if (/\bcontraindicat/i.test(text)) classes.add('contraindication');
  if (/\bboxed warning\b|\bblack[- ]box warning\b/i.test(text)) classes.add('boxed-warning');
  if (/\b(?:adverse (?:event|reaction)|side effects?)\b/i.test(text)) classes.add('adverse-event');
  return classes;
};

const numericTokens = (value) =>
  new Set([...String(value || '').matchAll(
    /\b\d+(?:\.\d+)?\s*(?:mcg|µg|ug|mg|g|mL|ml|units?)(?:\s*\/\s*(?:day|week))?\b/gi
  )].map((match) => match[0].toLowerCase().replace(/\s+/g, '').replace('µg', 'mcg').replace('ug', 'mcg')));

const words = (value) => String(value || '')
  .toLowerCase()
  .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, ' ')
  .match(/[a-z][a-z0-9-]{3,}/g) || [];

const GENERIC = new Set([
  'adverse', 'approved', 'administration', 'boxed', 'contraindicated', 'contraindication',
  'daily', 'dosage', 'dose', 'drug', 'effects', 'event', 'label', 'reaction', 'side',
  'treatment', 'warning', 'warnings', 'with', 'this', 'that', 'patients', 'people'
]);

const sectionForClass = (label, type) => {
  if (type === 'indication') return label.indications;
  if (type === 'dosage') return label.dosage;
  if (type === 'contraindication') return label.contraindications;
  if (type === 'boxed-warning') return label.boxedWarning;
  if (type === 'adverse-event') return label.adverseReactions;
  return '';
};

const classSupported = (claim, label, type) => {
  if (type === 'approval') {
    if (/\b(?:unapproved|not FDA[- ]approved|withdrawn|revoked)\b/i.test(claim)) return false;
    if (!values(label.applicationNumbers).length) return false;
    if (!/\b(?:approved (?:for|to treat)|indicat)/i.test(claim)) return true;
  }
  if (type === 'boxed-warning' && /\b(?:no|without|does not have)\b[^.]{0,30}\bboxed warning\b/i.test(claim)) {
    return !String(label.boxedWarning || '').trim() &&
      !!String(label.warnings || label.contraindications || label.indications || '').trim();
  }
  const section = sectionForClass(label, type === 'approval' ? 'indication' : type);
  if (!String(section || '').trim()) return false;
  const claimNumbers = numericTokens(claim);
  const sectionNumbers = numericTokens(section);
  if ([...claimNumbers].some((token) => !sectionNumbers.has(token))) return false;
  const identityWords = new Set(labelNames(label).flatMap(words));
  const meaningful = [...new Set(words(claim))]
    .filter((word) => !GENERIC.has(word) && !identityWords.has(word));
  if (!meaningful.length) return true;
  const source = normalizeName(section);
  return meaningful.some((word) => source.includes(word));
};

const labelForDrug = (entries, drugName) => {
  const wanted = normalizeName(drugName);
  if (!wanted) return null;
  return entries.find((entry) => {
    const label = entry?.label || entry;
    return labelNames(label).some((name) => normalizeName(name) === wanted) ||
      normalizeName(entry?.drug) === wanted;
  }) || null;
};

const labelMentionedInText = (entry, text) => {
  const label = entry?.label || entry;
  const normalizedText = ` ${normalizeName(text)} `;
  return labelNames(label).some((name) => {
    const normalized = normalizeName(name);
    return normalized && normalizedText.includes(` ${normalized} `);
  });
};

const linkedSetIds = (text) => {
  const ids = [];
  rewriteMarkdownLinks(String(text || ''), (match, _label, href) => {
    const id = setIdFromDailyMedUrl(canonicalizeCitationUrl(href));
    if (id) ids.push(id);
    return match;
  });
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s)\]"']+/gi)) {
    const id = setIdFromDailyMedUrl(match[0]);
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
};

const unknownReplacement = (line) => {
  const match = String(line).match(/^(\s*(?:FDA_STATUS|APPROVAL_STATUS|LABEL_STATUS):)\s*/i);
  return match ? `${match[1]} ${UNKNOWN_LABEL_TEXT}` : '';
};

export const enforceFdaLabelNarrative = (text, entries, options = {}) => {
  if (!text) return { text, removed: [], issues: [], attached: 0 };
  const verified = verifiedFdaLabelEntries(entries, options);
  const labelsBySetId = new Map(verified.accepted.map((entry) => {
    const label = entry?.label || entry;
    return [normalizeSplSetId(label.splSetId), entry];
  }));
  const removed = [];
  const issues = verified.rejected.map((item) => item.reason);
  let attached = 0;
  let currentDrug = '';
  const output = [];

  for (const line of String(text).split('\n')) {
    const card = line.match(/^\s*(?:TREATMENT|CANDIDATE):\s*(.+)$/i);
    if (card) currentDrug = card[1].replace(/\[[^\]]+\]\([^)]+\)/g, '').replace(/\*/g, '').trim();
    const classes = claimClasses(line);
    if (!classes.size || new RegExp(UNKNOWN_LABEL_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(line)) {
      output.push(line);
      continue;
    }
    if (options.statusOnly && !unknownReplacement(line)) {
      output.push(line);
      continue;
    }

    const ids = linkedSetIds(line);
    let entry = ids.length === 1 ? labelsBySetId.get(ids[0]) : null;
    if (!entry && !ids.length) entry = labelForDrug(verified.accepted, currentDrug);
    if (!entry && !ids.length) {
      const mentioned = verified.accepted.filter((candidate) => labelMentionedInText(candidate, line));
      if (mentioned.length === 1) entry = mentioned[0];
    }
    const label = entry?.label || entry;
    const foreignProductMention = label && verified.accepted.some((candidate) =>
      candidate !== entry && labelMentionedInText(candidate, line));
    const productMatches = label && !foreignProductMention && (
      currentDrug
        ? labelMatchesRequestedProduct(label, currentDrug)
        : (
            (ids.length === 1 && normalizeSplSetId(label.splSetId) === ids[0]) ||
            labelMentionedInText(entry, line)
          )
    );
    const supported = productMatches &&
      [...classes].every((type) => classSupported(line, label, type));
    const wrongLinkedIdentity = ids.length !== 0 && (
      ids.length !== 1 || !entry || normalizeSplSetId(label?.splSetId) !== ids[0]
    );

    if (!supported || wrongLinkedIdentity) {
      const replacement = unknownReplacement(line);
      if (replacement) output.push(replacement);
      removed.push(line);
      issues.push(wrongLinkedIdentity ? 'LABEL_URL_IDENTITY_MISMATCH' : 'LABEL_CLAIM_UNSUPPORTED');
      continue;
    }

    if (!ids.length) {
      output.push(`${line} ([DailyMed label](${label.dailyMedUrl}))`);
      attached += 1;
    } else {
      output.push(line);
    }
  }
  return {
    text: output.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    removed,
    issues: [...new Set(issues)],
    attached,
    labelAudit: verified
  };
};

export const filterVerifiedFdaEvidence = (evidence, options = {}) => {
  if (!evidence || typeof evidence !== 'object') return evidence;
  const result = verifiedFdaLabelEntries(evidence.fdaLabels, options);
  return {
    ...evidence,
    fdaLabels: result.accepted,
    fdaLabelAudit: {
      evaluated: result.accepted.length + result.rejected.length,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      rejectedLabels: result.rejected
    }
  };
};
