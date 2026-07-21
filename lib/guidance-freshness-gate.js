import {
  canonicalizeCitationUrl,
  isBannedClaimCitation,
  rewriteMarkdownLinks
} from './citation-gate.js';

const GUIDANCE_FRESHNESS_VERSION = 1;

const AUTHORITY_HOSTS = [
  { host: 'fda.gov', type: 'regulatory', authority: 'US FDA', maxAgeYears: 5 },
  { host: 'dailymed.nlm.nih.gov', type: 'regulatory', authority: 'DailyMed', maxAgeYears: 5 },
  { host: 'cdc.gov', type: 'public-health', authority: 'CDC', maxAgeYears: 4 },
  { host: 'nih.gov', type: 'public-health', authority: 'NIH', maxAgeYears: 5 },
  { host: 'who.int', type: 'public-health', authority: 'WHO', maxAgeYears: 5 },
  { host: 'nice.org.uk', type: 'guideline', authority: 'NICE', maxAgeYears: 4 }
];

const SOCIETY_RE = /\b(?:guideline|guidance|practice parameter|consensus|recommendations?|position statement)\b/i;
const AUTHORITY_RE = /\b(?:american|european|international|royal|national|canadian|british|australasian|academy|association|college|society|task force|working group|consortium|network|foundation|ATS|ERS|JRS|ALAT|AHA|ACC|ADA|ACR|ACOG|AAP|ASCO|NCCN|EASL|AASLD|KDIGO|GOLD|GINA)\b/i;
const GUIDANCE_CATEGORY_RE = /\b(?:clinical-)?(?:guideline|guidance|recommendation|consensus|position-statement|fda-label|drug-label)\b/i;
const SUPERSEDED_RE = /\b(?:superseded|withdrawn|rescinded|retracted|retired|replaced by|no longer current|archived guidance)\b/i;
const REDIRECT_PATH_RE = /\/(?:search|results?|redirect|out|go|placeholder)(?:\/|$)/i;
const REDIRECT_PARAM_RE = /^(?:url|uri|target|redirect|redirect_uri|destination|dest|next|continue)$/i;

const normalizeDate = (value) => {
  if (value == null || value === '') return '';
  const raw = String(value).trim();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  const normalized = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : raw;
  const date = /^\d{4}$/.test(normalized)
    ? new Date(`${normalized}-12-31T00:00:00.000Z`)
    : new Date(normalized);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const itemUrl = (item) => canonicalizeCitationUrl(
  item?.canonicalUrl || item?.url || item?.dailyMedUrl || item?.sourceUrl || ''
);

const hostname = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const hostMatches = (host, allowed) => host === allowed || host.endsWith(`.${allowed}`);

const canonicalIdentity = (value) => {
  const canonical = canonicalizeCitationUrl(value);
  if (!canonical) return '';
  const parsed = new URL(canonical);
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.replace(/^www\./, '');
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_|gclid|fbclid)/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.href.replace(/\/$/, '');
};

const unsafeDocumentUrlReason = (url) => {
  if (!url || isBannedClaimCitation(url)) return 'GUIDANCE_PLACEHOLDER_URL';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'GUIDANCE_INVALID_URL';
  }
  if (REDIRECT_PATH_RE.test(parsed.pathname)) return 'GUIDANCE_REDIRECT_URL';
  if (
    /(?:^|[?&])event=BasicSearch\.process(?:&|$)/i.test(parsed.search) ||
    parsed.searchParams.has('BaseSearchterm')
  ) return 'GUIDANCE_PLACEHOLDER_URL';
  if ([...parsed.searchParams.keys()].some((key) => REDIRECT_PARAM_RE.test(key))) {
    return 'GUIDANCE_REDIRECT_URL';
  }
  if (parsed.pathname === '/' && !parsed.search) return 'GUIDANCE_NON_DOCUMENT_URL';
  return '';
};

export const classifyGuidanceSource = (item = {}) => {
  const url = itemUrl(item);
  const host = hostname(url);
  const hostPolicy = AUTHORITY_HOSTS.find((entry) =>
    hostMatches(host, entry.host) &&
    !(entry.authority === 'NIH' &&
      /(?:^|\.)ncbi\.nlm\.nih\.gov$/.test(host))
  );
  const descriptor = [
    item.title, item.journal,
    item.publisher, item.authority, item.guidanceAuthority
  ].filter(Boolean).join(' ');
  const categoryGuidance = GUIDANCE_CATEGORY_RE.test(String(item.category || ''));
  const languageGuidance = SOCIETY_RE.test(descriptor);
  const isGuidance = !!hostPolicy || categoryGuidance || languageGuidance;
  if (!isGuidance) return { isGuidance: false, sourceType: 'stable-source' };

  if (hostPolicy) return { isGuidance: true, ...hostPolicy };
  const explicitlyAllowed = item.authorityAllowed === true &&
    String(item.guidanceAuthority || item.authority || '').trim();
  if (explicitlyAllowed) {
    return {
      isGuidance: true,
      type: 'explicit-authority',
      sourceType: 'explicit-authority',
      authority: String(item.guidanceAuthority || item.authority).trim(),
      maxAgeYears: Number(item.maxGuidanceAgeYears) || 5
    };
  }
  if (
    (item.isCuratedKB === true && categoryGuidance) ||
    (languageGuidance && AUTHORITY_RE.test(descriptor))
  ) {
    return {
      isGuidance: true,
      type: 'specialty-society',
      sourceType: 'specialty-society',
      authority: String(item.guidanceAuthority || item.publisher || item.journal || 'Specialty society').trim(),
      maxAgeYears: 8
    };
  }
  return {
    isGuidance: true,
    type: 'unknown-guidance-authority',
    sourceType: 'unknown-guidance-authority',
    authority: '',
    maxAgeYears: 0
  };
};

const collectDates = (item) => {
  const fields = [
    ['updated', item.updatedAt || item.updateDate || item.lastUpdated || item.lastModified],
    ['effective', item.effectiveDate || item.effectiveTime],
    ['reviewed', item.reviewDate || item.reviewedAt || item.nextReviewDate],
    ['published', item.publicationDate || item.publishedAt || item.date || item.year]
  ];
  return fields
    .map(([kind, value]) => ({ kind, raw: value, value: normalizeDate(value) }))
    .filter((entry) => entry.value);
};

const versionIdentifier = (item, url, dates) => {
  const explicit = item.guidanceVersion || item.versionIdentifier || item.revision ||
    item.edition || item.version || item.splVersion || item.splId || item.splSetId ||
    item.pmid || item.doi || '';
  if (String(explicit).trim()) return String(explicit).trim();
  const parsed = (() => {
    try { return new URL(url); } catch { return null; }
  })();
  const pathId = parsed?.pathname.match(/\b(?:NICE|NG|CG|QS|TA|IDSA|WHO)[-_]?\d+\b/i)?.[0] ||
    parsed?.pathname.match(/\/(\d{5,}[a-z0-9]*s\d{3}lbl)\.pdf$/i)?.[1] ||
    parsed?.searchParams.get('setid') || '';
  if (pathId) return pathId;
  const effective = dates.find((entry) => entry.kind === 'effective');
  return effective ? `effective:${effective.value}` : '';
};

const reject = (reason, classification, details = {}) => ({
  ok: false,
  status: 'rejected',
  reason,
  version: GUIDANCE_FRESHNESS_VERSION,
  classification,
  ...details
});

export const assessGuidanceFreshness = (item = {}, {
  now = new Date(),
  finalUrl = item.finalUrl || item.resolvedUrl || ''
} = {}) => {
  const classification = classifyGuidanceSource(item);
  if (!classification.isGuidance) {
    return {
      ok: true,
      status: 'not-applicable',
      reason: 'STABLE_NON_GUIDANCE_SOURCE',
      version: GUIDANCE_FRESHNESS_VERSION,
      classification
    };
  }
  const url = itemUrl(item);
  const unsafeReason = unsafeDocumentUrlReason(url);
  if (unsafeReason) return reject(unsafeReason, classification, { url });
  if (!classification.authority) return reject('GUIDANCE_AUTHORITY_NOT_ALLOWED', classification, { url });

  const expected = item.canonicalUrl ? canonicalIdentity(item.canonicalUrl) : '';
  const supplied = canonicalIdentity(item.url || item.dailyMedUrl || item.sourceUrl || url);
  if (expected && supplied && expected !== supplied) {
    return reject('GUIDANCE_CANONICAL_IDENTITY_MISMATCH', classification, {
      url: supplied,
      canonicalUrl: expected
    });
  }
  if (finalUrl && canonicalIdentity(finalUrl) !== canonicalIdentity(url)) {
    return reject('GUIDANCE_REDIRECT_IDENTITY_MISMATCH', classification, {
      url: canonicalIdentity(url),
      finalUrl: canonicalIdentity(finalUrl)
    });
  }

  const statusText = [
    item.status, item.guidanceStatus, item.withdrawalStatus,
    item.supersededBy, item.replacedBy
  ].filter(Boolean).join(' ');
  if (
    item.withdrawn === true || item.superseded === true || item.isCurrent === false ||
    SUPERSEDED_RE.test(statusText)
  ) {
    return reject('GUIDANCE_SUPERSEDED_OR_WITHDRAWN', classification, { url });
  }

  const dates = collectDates(item);
  if (!dates.length) return reject('GUIDANCE_DATE_MISSING', classification, { url });
  const versionIdentifierValue = versionIdentifier(item, url, dates);
  if (!versionIdentifierValue) {
    return reject('GUIDANCE_VERSION_MISSING', classification, {
      url,
      dates
    });
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const newest = dates.reduce((best, entry) =>
    entry.value > best.value ? entry : best, dates[0]);
  const newestMs = new Date(`${newest.value}T23:59:59.999Z`).getTime();
  if (
    Number.isNaN(nowDate.getTime()) ||
    (!/^\d{4}$/.test(String(newest.raw || '').trim()) &&
      newestMs > nowDate.getTime() + 31 * 86400000)
  ) {
    return reject('GUIDANCE_DATE_INVALID_OR_FUTURE', classification, { url, dates });
  }
  const expires = new Date(newestMs);
  expires.setUTCFullYear(expires.getUTCFullYear() + classification.maxAgeYears);
  if (nowDate.getTime() > expires.getTime()) {
    return reject('GUIDANCE_STALE', classification, {
      url,
      dates,
      governingDate: newest.value,
      maxAgeYears: classification.maxAgeYears,
      versionIdentifier: versionIdentifierValue
    });
  }
  return {
    ok: true,
    status: 'accepted',
    reason: 'GUIDANCE_CURRENT',
    version: GUIDANCE_FRESHNESS_VERSION,
    classification,
    url,
    dates,
    governingDate: newest.value,
    versionIdentifier: versionIdentifierValue,
    maxAgeYears: classification.maxAgeYears
  };
};

const isChangingMedicalClaim = (text) => {
  const value = String(text || '');
  return (
    /\b(?:dose|dosage|titration|administer|take|taken)\b.{0,50}\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|mL|units?)\b/i.test(value) ||
    /\b(?:FDA[- ]approved|approved (?:for|to)|authorization|indicat(?:ed|ion) for)\b/i.test(value) ||
    /\b(?:recommend(?:s|ed|ation)?|first[- ]line|standard of care|should (?:receive|use|start|avoid|undergo))\b/i.test(value) ||
    /\b(?:boxed warning|black box warning|contraindicat(?:ed|ion)|safety warning|drug safety communication)\b/i.test(value) ||
    /\b(?:screen(?:ing)?|surveillance)\b.{0,80}\b(?:every|annual|age|years?|months?|eligible)\b/i.test(value) ||
    /\b(?:eligible|eligibility|inclusion criteria|exclusion criteria)\b/i.test(value)
  );
};

const evidenceRows = (evidence = {}) => [
  ...(evidence.groundedForPrompt || []),
  ...(evidence.topRanked || []),
  ...(evidence.evidencePack || []),
  ...(evidence.references || []),
  ...((evidence.fdaLabels || []).flatMap((entry) => [entry?.label, entry]).filter(Boolean))
];

const guidanceUrlIndex = (evidence, now) => {
  const map = new Map();
  for (const row of evidenceRows(evidence)) {
    const assessment = row?.guidanceFreshness || assessGuidanceFreshness(row, { now });
    const urls = [
      row?.url, row?.canonicalUrl, row?.dailyMedUrl, row?.sourceUrl,
      row?.pubmedUrl, row?.doiUrl
    ].map(canonicalizeCitationUrl).filter(Boolean);
    for (const url of urls) map.set(url, assessment);
  }
  return map;
};

export const enforceGuidanceFreshnessNarrative = (text, evidence = {}, {
  now = new Date()
} = {}) => {
  const index = guidanceUrlIndex(evidence, now);
  const removed = [];
  const reasons = {};
  const output = String(text || '').split('\n').filter((line) => {
    if (!isChangingMedicalClaim(line) || /^\s*#{1,6}\s/.test(line)) return true;
    const citations = [];
    rewriteMarkdownLinks(line, (match, _label, url) => {
      citations.push(canonicalizeCitationUrl(url));
      return match;
    });
    const assessments = citations.map((url) => index.get(url)).filter(Boolean);
    if (assessments.some((assessment) => assessment.ok && assessment.status === 'accepted')) return true;
    const reason = assessments.find((assessment) => !assessment.ok)?.reason ||
      'CHANGING_CLAIM_WITHOUT_CURRENT_GUIDANCE';
    reasons[reason] = (reasons[reason] || 0) + 1;
    removed.push({ line: line.slice(0, 500), reason, citations });
    return false;
  }).join('\n');
  return {
    text: output,
    audit: {
      version: GUIDANCE_FRESHNESS_VERSION,
      evaluatedChangingClaims: removed.length +
        String(text || '').split('\n').filter(isChangingMedicalClaim).length - removed.length,
      removed: removed.length,
      reasons,
      removedClaims: removed.slice(0, 100)
    }
  };
};
