#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = path.join(ROOT, 'data', 'kb');
const NCBI_SUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const NCBI_SEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or',
  'the', 'to', 'with', 'official', 'study', 'trial', 'trials', 'results'
]);

export const normalizeDoi = (value) =>
  String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();

export const normalizePmid = (value) => String(value || '').replace(/\D/g, '');

// NCBI and Crossref rate-limit by IP. A 429 threw straight out of the audit,
// so a busy minute at E-utilities killed the nightly release job with a stack
// trace that looked like a data defect. Transient statuses get a bounded
// backoff (honouring Retry-After); a genuine 4xx still fails loudly and fast.
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchWithRetry = async (fetchImpl, url, options, label, {
  attempts = 4,
  baseDelayMs = 1000,
  // Statuses the caller interprets itself (Crossref 404 = "no such DOI"),
  // returned as-is rather than retried or thrown.
  allowStatuses = []
} = {}) => {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url, options);
    if (response.ok || allowStatuses.includes(response.status)) return response;
    lastStatus = response.status;
    if (!TRANSIENT_STATUS.has(response.status) || attempt === attempts) break;
    const retryAfter = Number(response.headers?.get?.('retry-after')) || 0;
    const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
    console.log(`  ${label} HTTP ${response.status} — retrying in ${Math.round(delay / 1000)}s (${attempt}/${attempts - 1})`);
    await sleep(delay);
  }
  throw new Error(`${label} failed: HTTP ${lastStatus}`);
};

const titleWords = (value) => new Set(
  String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !TITLE_STOP_WORDS.has(word))
);

export const titleCoverage = (storedTitle, authoritativeTitle) => {
  const stored = titleWords(storedTitle);
  const actual = titleWords(authoritativeTitle);
  if (!stored.size || !actual.size) return 0;
  let overlap = 0;
  for (const word of stored) if (actual.has(word)) overlap += 1;
  return overlap / Math.min(stored.size, actual.size);
};

const pubmedIdFromUrl = (value) =>
  String(value || '').match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})(?:\/|$)/i)?.[1] || '';

const doiFromUrl = (value) =>
  String(value || '').match(/https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i)?.[1] || '';

export const collectKbMetadataRecords = (kb, file = '') => {
  const records = [];
  const add = (record, location, { compareTitle = true } = {}) => {
    if (!record || typeof record !== 'object' || record.quarantined === true) return;
    const pmid = normalizePmid(record.pmid);
    const doi = normalizeDoi(record.doi);
    const url = String(record.url || record.pubmedUrl || record.doiUrl || '').trim();
    if (!pmid && !doi && !pubmedIdFromUrl(url) && !doiFromUrl(url)) return;
    records.push({
      file,
      location,
      id: String(record.id || record.name || location),
      title: compareTitle ? String(record.title || '').trim() : '',
      pmid,
      doi,
      url
    });
  };
  for (const [index, item] of (kb.items || []).entries()) {
    add(item, `items[${index}]`);
  }
  for (const [index, drug] of (kb.pipelineDrugs || []).entries()) {
    add(drug, `pipelineDrugs[${index}]`, { compareTitle: false });
  }
  return records;
};

export const validateStaticMetadataRecord = (record) => {
  const issues = [];
  const urlPmid = pubmedIdFromUrl(record.url);
  if (record.pmid && urlPmid && record.pmid !== urlPmid) {
    issues.push(`stored PMID ${record.pmid} disagrees with PubMed URL PMID ${urlPmid}`);
  }
  const urlDoi = normalizeDoi(doiFromUrl(record.url));
  if (record.doi && urlDoi && record.doi !== urlDoi) {
    issues.push(`stored DOI ${record.doi} disagrees with DOI URL ${urlDoi}`);
  }
  if (record.pmid && !/^\d{5,9}$/.test(record.pmid)) {
    issues.push(`invalid PMID format ${record.pmid}`);
  }
  if (record.doi && !/^10\.\d{4,9}\/\S+$/i.test(record.doi)) {
    issues.push(`invalid DOI format ${record.doi}`);
  }
  return issues;
};

export const validateAuthoritativeMetadata = (record, authoritative) => {
  const issues = [];
  if (!authoritative) return [`PMID ${record.pmid} was not returned by PubMed`];
  const actualDoi = normalizeDoi(authoritative.doi);
  if (record.doi && actualDoi && record.doi !== actualDoi) {
    issues.push(`DOI mismatch: stored ${record.doi}, PubMed ${actualDoi}`);
  }
  if (record.doi && !actualDoi) {
    issues.push(`stored DOI ${record.doi} is absent from PubMed metadata`);
  }
  if (record.title) {
    const coverage = titleCoverage(record.title, authoritative.title);
    if (coverage < 0.55) {
      issues.push(
        `title mismatch (${coverage.toFixed(2)}): stored "${record.title}", PubMed "${authoritative.title || ''}"`
      );
    }
  }
  return issues;
};

export const validateCrossrefMetadata = (record, authoritative) => {
  if (!authoritative) return [`DOI ${record.doi} was not returned by Crossref`];
  const issues = [];
  if (normalizeDoi(authoritative.doi) !== record.doi) {
    issues.push(`DOI mismatch: stored ${record.doi}, Crossref ${normalizeDoi(authoritative.doi)}`);
  }
  if (record.title) {
    const coverage = titleCoverage(record.title, authoritative.title);
    if (coverage < 0.55) {
      issues.push(
        `title mismatch (${coverage.toFixed(2)}): stored "${record.title}", Crossref "${authoritative.title || ''}"`
      );
    }
  }
  return issues;
};

export const parsePubMedSummary = (payload) => {
  const map = new Map();
  for (const uid of payload?.result?.uids || []) {
    const row = payload.result?.[uid];
    if (!row) continue;
    const doi = (row.articleids || []).find((id) => id?.idtype === 'doi')?.value || '';
    map.set(String(uid), { title: row.title || '', doi });
  }
  return map;
};

export const fetchPubMedMetadata = async (pmids, { fetchImpl = fetch } = {}) => {
  const unique = [...new Set(pmids.map(normalizePmid).filter(Boolean))];
  const metadata = new Map();
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50);
    const query = new URLSearchParams({
      db: 'pubmed',
      id: batch.join(','),
      retmode: 'json',
      tool: 'medical-research-tool-metadata-audit'
    });
    const response = await fetchWithRetry(
      fetchImpl,
      `${NCBI_SUMMARY_URL}?${query}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
      'PubMed metadata request'
    );
    const parsed = parsePubMedSummary(await response.json());
    for (const [pmid, value] of parsed) metadata.set(pmid, value);
  }
  return metadata;
};

export const resolveDoisToPmids = async (dois, { fetchImpl = fetch, delayMs = 350 } = {}) => {
  const unique = [...new Set(dois.map(normalizeDoi).filter(Boolean))];
  const resolved = new Map();
  for (let index = 0; index < unique.length; index += 1) {
    const doi = unique[index];
    const query = new URLSearchParams({
      db: 'pubmed',
      term: `"${doi}"[AID]`,
      retmode: 'json',
      retmax: '5',
      tool: 'medical-research-tool-metadata-audit'
    });
    const response = await fetchWithRetry(
      fetchImpl,
      `${NCBI_SEARCH_URL}?${query}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
      'PubMed DOI lookup'
    );
    const ids = (await response.json())?.esearchresult?.idlist || [];
    resolved.set(doi, ids.map(normalizePmid).filter(Boolean));
    if (delayMs > 0 && index < unique.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return resolved;
};

export const fetchCrossrefMetadata = async (dois, { fetchImpl = fetch, delayMs = 100 } = {}) => {
  const unique = [...new Set(dois.map(normalizeDoi).filter(Boolean))];
  const metadata = new Map();
  for (let index = 0; index < unique.length; index += 1) {
    const doi = unique[index];
    const response = await fetchWithRetry(
      fetchImpl,
      `${CROSSREF_WORKS_URL}/${encodeURIComponent(doi)}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'medical-research-tool-metadata-audit/1.0 (mailto:shaque025@gmail.com)'
        },
        signal: AbortSignal.timeout(15_000)
      },
      'Crossref metadata request',
      { allowStatuses: [404] }
    );
    if (response.status === 404) {
      metadata.set(doi, null);
    } else {
      const message = (await response.json())?.message || {};
      metadata.set(doi, {
        doi: message.DOI || doi,
        title: Array.isArray(message.title) ? message.title[0] || '' : message.title || '',
        url: message.URL || ''
      });
    }
    if (delayMs > 0 && index < unique.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return metadata;
};

const loadRecords = async () => {
  const files = (await readdir(KB_DIR))
    .filter((file) => file.endsWith('.json') && !file.startsWith('_'))
    .sort();
  const records = [];
  for (const file of files) {
    const kb = JSON.parse(await readFile(path.join(KB_DIR, file), 'utf8'));
    records.push(...collectKbMetadataRecords(kb, file));
  }
  return { files, records };
};

const main = async () => {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : '';
  const { files, records } = await loadRecords();
  const failures = [];
  for (const record of records) {
    for (const issue of validateStaticMetadataRecord(record)) {
      failures.push({ ...record, issue, source: 'static' });
    }
  }

  const withPmid = records.filter((record) => record.pmid);
  const metadata = await fetchPubMedMetadata(withPmid.map((record) => record.pmid));
  const authoritativeFailures = [];
  for (const record of withPmid) {
    for (const issue of validateAuthoritativeMetadata(record, metadata.get(record.pmid))) {
      const failure = { ...record, issue, source: 'pubmed' };
      failures.push(failure);
      authoritativeFailures.push(failure);
    }
  }
  const mismatchedDois = authoritativeFailures
    .filter((failure) => failure.doi)
    .map((failure) => failure.doi);
  const doiResolutions = mismatchedDois.length
    ? await resolveDoisToPmids(mismatchedDois)
    : new Map();
  for (const failure of failures) {
    const candidates = doiResolutions.get(failure.doi) || [];
    if (candidates.length) failure.doiResolvesToPmids = candidates;
  }
  const doiOnly = records.filter((record) => !record.pmid && record.doi);
  const crossref = doiOnly.length
    ? await fetchCrossrefMetadata(doiOnly.map((record) => record.doi))
    : new Map();
  for (const record of doiOnly) {
    for (const issue of validateCrossrefMetadata(record, crossref.get(record.doi))) {
      failures.push({ ...record, issue, source: 'crossref' });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    kbFiles: files.length,
    recordsChecked: records.length,
    pmidsChecked: new Set(withPmid.map((record) => record.pmid)).size,
    doiOnlyChecked: new Set(doiOnly.map((record) => record.doi)).size,
    failures
  };
  if (jsonPath) await writeFile(path.resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);

  if (failures.length) {
    console.error(`KB metadata audit failed: ${failures.length} mismatch(es)`);
    for (const failure of failures) {
      console.error(`- ${failure.file} ${failure.location} ${failure.id}: ${failure.issue}`);
      if (failure.doiResolvesToPmids?.length) {
        console.error(`  DOI resolves to PMID: ${failure.doiResolvesToPmids.join(', ')}`);
      }
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `KB metadata audit passed: ${report.recordsChecked} records across ${report.kbFiles} KBs; ` +
    `${report.pmidsChecked} unique PubMed records and ${report.doiOnlyChecked} DOI-only records verified.`
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
