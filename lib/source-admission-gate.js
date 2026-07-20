import {
  canonicalizeCitationUrl,
  isBannedClaimCitation
} from './citation-gate.js';
import { sourceMentionsCondition } from './grounding-gate.js';
import { assessGuidanceFreshness } from './guidance-freshness-gate.js';

const DOI_RE = /^10\.\d{4,9}\/\S+$/i;
const PMID_RE = /^\d{5,9}$/;
const NCT_RE = /^NCT\d{8}$/i;
const MIN_SOURCE_CHARS = 80;
const MIN_SOURCE_WORDS = 8;

const cleanDoi = (value) => String(value || '')
  .trim()
  .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  .replace(/^doi:\s*/i, '')
  .replace(/[).,;]+$/, '')
  .toLowerCase();

const cleanPmid = (value) => String(value || '')
  .trim()
  .replace(/^pmid:\s*/i, '');

const supportText = (item) => [
  item?.summary,
  item?.finding,
  item?.abstract,
  item?.text,
  item?.fullText,
  item?.content,
  item?.indicationsAndUsage,
  item?.dosageAndAdministration,
  item?.warnings,
  item?.adverseReactions,
  ...(Array.isArray(item?.keyPassages)
    ? item.keyPassages.map((passage) =>
        typeof passage === 'string' ? passage : passage?.quote)
    : [])
].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

const sourceText = (item) =>
  [item?.title, supportText(item)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

const provenance = (item) => {
  const providers = [
    ...(Array.isArray(item?.sources) ? item.sources : []),
    item?.source
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return {
    providers: [...new Set(providers)],
    providerId: item?.provenanceId || item?.id || null,
    condition: item?.kbCondition || item?.condition || item?.conditionSlug || null,
    curated: item?.isCuratedKB === true
  };
};

const reject = (reason, item, details = {}) => ({
  ok: false,
  reason,
  provenance: provenance(item),
  ...details
});

const urlIdentifiers = (url) => {
  const value = canonicalizeCitationUrl(url);
  if (!value) return {};
  const pmid = value.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})(?:\/|$)/i)?.[1] || '';
  const doi = value.match(/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^?#]+)/i)?.[1] || '';
  const nct = value.match(/clinicaltrials\.gov\/study\/(NCT\d{8})(?:\/|$)/i)?.[1] || '';
  const pmcid = value.match(/(?:ncbi\.nlm\.nih\.gov\/pmc\/articles|europepmc\.org\/article\/PMC)\/?(PMC\d+)/i)?.[1] || '';
  let decodedDoi = '';
  if (doi) {
    try {
      decodedDoi = cleanDoi(decodeURIComponent(doi));
    } catch {
      return { invalidDoiEncoding: true };
    }
  }
  return {
    ...(pmid ? { pmid } : {}),
    ...(decodedDoi ? { doi: decodedDoi } : {}),
    ...(nct ? { nct: nct.toUpperCase() } : {}),
    ...(pmcid ? { pmcid: pmcid.toUpperCase() } : {})
  };
};

const candidateUrls = (item) => [
  item?.url,
  item?.pubmedUrl,
  item?.pmcUrl,
  item?.doiUrl,
  item?.oaUrl,
  item?.europePmcUrl,
  item?.landingUrl
].map(canonicalizeCitationUrl).filter(Boolean);

const isStableDocumentUrl = (url) => {
  if (!url || isBannedClaimCitation(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (/^(?:www\.)?(?:google|bing|duckduckgo)\./i.test(parsed.hostname)) return false;
  if (/\/(?:search|query)(?:\/|$)/i.test(parsed.pathname)) return false;
  if (parsed.pathname === '/' && !parsed.search) return false;
  return true;
};

const resolveIdentity = (item, urls) => {
  const pmid = cleanPmid(item?.pmid);
  const doi = cleanDoi(item?.doi);
  const id = String(item?.id || '').trim();
  const idPmid = id.match(/^pmid:\s*(\d{5,9})$/i)?.[1] || '';
  const idDoi = id.match(/^doi:\s*(10\.\d{4,9}\/\S+)$/i)?.[1] || '';
  const nct = String(item?.nctId || item?.nct || '').trim().toUpperCase();

  if (pmid && !PMID_RE.test(pmid)) return { error: 'INVALID_PMID' };
  if (doi && !DOI_RE.test(doi)) return { error: 'INVALID_DOI' };
  if (nct && !NCT_RE.test(nct)) return { error: 'INVALID_NCT_ID' };
  if (idPmid && pmid && idPmid !== pmid) return { error: 'IDENTIFIER_MISMATCH' };
  if (idDoi && doi && cleanDoi(idDoi) !== doi) return { error: 'IDENTIFIER_MISMATCH' };

  for (const url of urls) {
    const embedded = urlIdentifiers(url);
    if (embedded.invalidDoiEncoding) return { error: 'INVALID_DOI' };
    if (embedded.pmid && pmid && embedded.pmid !== pmid) {
      return { error: 'PMID_URL_MISMATCH', details: { pmid, urlPmid: embedded.pmid } };
    }
    if (embedded.doi && doi && embedded.doi !== doi) {
      return { error: 'DOI_URL_MISMATCH', details: { doi, urlDoi: embedded.doi } };
    }
    if (embedded.nct && nct && embedded.nct !== nct) {
      return { error: 'NCT_URL_MISMATCH', details: { nct, urlNct: embedded.nct } };
    }
  }

  const stableUrl = urls.find(isStableDocumentUrl) || '';
  if (pmid) {
    return {
      type: 'pmid',
      value: pmid,
      url: stableUrl || `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      ...(doi ? { doi } : {})
    };
  }
  if (doi) {
    return { type: 'doi', value: doi, url: stableUrl || `https://doi.org/${doi}` };
  }
  if (nct) {
    return { type: 'nct', value: nct, url: stableUrl || `https://clinicaltrials.gov/study/${nct}` };
  }
  if (stableUrl) {
    const embedded = urlIdentifiers(stableUrl);
    const value = embedded.pmid || embedded.doi || embedded.nct || embedded.pmcid || stableUrl;
    return { type: Object.keys(embedded)[0] || 'url', value, url: stableUrl };
  }
  return { error: 'UNRESOLVABLE_IDENTITY' };
};

const conditionMatch = (item, text, conditionNames) => {
  const names = conditionNames.map((name) => String(name || '').trim()).filter(Boolean);
  if (!names.length) return { ok: false, matchedOn: null };
  const kbCondition = String(item?.kbCondition || '').trim();
  if (item?.isCuratedKB && kbCondition) {
    const matched = names.find((name) =>
      sourceMentionsCondition(kbCondition, name) === true
      || sourceMentionsCondition(name, kbCondition) === true);
    if (matched) return { ok: true, matchedOn: `kb:${matched}` };
  }
  const matched = names.find((name) => sourceMentionsCondition(text, name) === true);
  return { ok: !!matched, matchedOn: matched ? `text:${matched}` : null };
};

export const admitSourceRow = (item, {
  condition = '',
  aliases = [],
  now = new Date()
} = {}) => {
  if (!item || typeof item !== 'object') return reject('INVALID_ROW', item);
  if (item.quarantined === true) return reject('PREQUARANTINED', item);
  if (String(item.accessLevel || '').toLowerCase() === 'dossier') {
    return reject('DOSSIER_ACCESS', item);
  }

  const rawUrls = [
    item.url, item.pubmedUrl, item.pmcUrl, item.doiUrl,
    item.oaUrl, item.europePmcUrl, item.landingUrl
  ].filter(Boolean);
  if (rawUrls.some((url) => {
    const canonical = canonicalizeCitationUrl(url);
    return !canonical || isBannedClaimCitation(canonical);
  })) {
    return reject('PLACEHOLDER_OR_INVALID_URL', item);
  }

  const urls = candidateUrls(item);
  const identity = resolveIdentity(item, urls);
  if (identity.error) return reject(identity.error, item, identity.details);

  const guidanceFreshness = assessGuidanceFreshness(item, { now });
  if (!guidanceFreshness.ok) {
    return reject(guidanceFreshness.reason, item, {
      guidanceFreshness
    });
  }

  const support = supportText(item);
  const text = sourceText(item);
  const words = support.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  if (support.length < MIN_SOURCE_CHARS || words.length < MIN_SOURCE_WORDS) {
    return reject('INSUFFICIENT_SOURCE_TEXT', item, {
      sourceChars: support.length,
      sourceWords: words.length
    });
  }

  const relevance = conditionMatch(item, text, [condition, ...aliases]);
  if (!relevance.ok) return reject('CONDITION_MISMATCH', item);

  const admission = {
    version: 1,
    status: 'accepted',
    reason: 'ADMITTED',
    identity,
    provenance: provenance(item),
    conditionMatch: relevance.matchedOn,
    excerpt: text.slice(0, 700)
  };
  return {
    ok: true,
    reason: admission.reason,
    row: {
      ...item,
      url: identity.url,
      guidanceFreshness,
      sourceAdmission: admission,
      admissionReason: admission.reason,
      admissionProvenance: admission.provenance,
      admissionExcerpt: admission.excerpt
    }
  };
};

export const admitSourceRows = (rows, options = {}) => {
  const accepted = [];
  const rejected = [];
  const reasons = {};
  for (const item of Array.isArray(rows) ? rows : []) {
    const result = admitSourceRow(item, options);
    if (result.ok) {
      accepted.push(result.row);
      continue;
    }
    reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    rejected.push({
      id: item?.id || item?.pmid || item?.doi || null,
      title: item?.title || null,
      reason: result.reason,
      provenance: result.provenance,
      ...(result.guidanceFreshness ? { guidanceFreshness: result.guidanceFreshness } : {})
    });
  }
  return {
    accepted,
    audit: {
      version: 1,
      evaluated: accepted.length + rejected.length,
      accepted: accepted.length,
      rejected: rejected.length,
      reasons,
      rejectedRows: rejected.slice(0, 100)
    }
  };
};

export const admitEvidencePools = (evidence, options = {}) => {
  if (!evidence || typeof evidence !== 'object') return evidence;
  const grounded = admitSourceRows(evidence.groundedForPrompt, options);
  const topRanked = admitSourceRows(evidence.topRanked, options);
  const retrievalAudit = evidence.sourceAdmissionAudit?.retrieval
    || evidence.sourceAdmissionAudit
    || null;
  return {
    ...evidence,
    groundedForPrompt: grounded.accepted,
    topRanked: topRanked.accepted,
    sourceAdmissionAudit: {
      version: 1,
      groundedForPrompt: grounded.audit,
      topRanked: topRanked.audit,
      ...(retrievalAudit ? { retrieval: retrievalAudit } : {})
    }
  };
};
