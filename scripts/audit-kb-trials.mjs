#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fetchTrialRegistryFacts,
  nctIdFromUrl,
  normalizeNctId,
  validateTrialRecord
} from '../lib/trial-registry-gate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = path.join(ROOT, 'data', 'kb');
const STATIC_ONLY = process.argv.includes('--static');

export const collectKbTrialRecords = (kb, file = '') => {
  const records = [];
  const expectedConditions = [kb.condition, ...(kb.aliases || [])].filter(Boolean);
  const add = (record, location) => {
    if (!record || typeof record !== 'object' || record.quarantined === true) return;
    const nctId = normalizeNctId(record.nct || record.nctId || record.url);
    if (!nctId) return;
    records.push({
      file,
      location,
      id: String(record.id || record.name || nctId),
      nctId,
      url: String(record.url || ''),
      statusText: [
        ...(Array.isArray(record.registryPhases) ? record.registryPhases : []),
        record.registryPhase,
        record.registryStatus
      ].filter(Boolean).join(' '),
      hasRegistryPhase: Boolean(
        (Array.isArray(record.registryPhases) && record.registryPhases.length) ||
        record.registryPhase
      ),
      hasRegistryStatus: Boolean(record.registryStatus),
      expectedConditions
    });
  };
  for (const [index, item] of (kb.items || []).entries()) add(item, `items[${index}]`);
  for (const [index, drug] of (kb.pipelineDrugs || []).entries()) add(drug, `pipelineDrugs[${index}]`);
  return records;
};

export const validateStaticTrialRecord = (record) => {
  const issues = [];
  if (!/^NCT\d{8}$/.test(record.nctId)) issues.push('NCT_INVALID_FORMAT');
  const urlNct = nctIdFromUrl(record.url);
  if (urlNct && urlNct !== record.nctId) issues.push('NCT_URL_ID_MISMATCH');
  if (!record.hasRegistryPhase) issues.push('NCT_REGISTRY_PHASE_MISSING');
  if (!record.hasRegistryStatus) issues.push('NCT_REGISTRY_STATUS_MISSING');
  return issues;
};

const main = async () => {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : '';
  const files = (await readdir(KB_DIR))
    .filter((file) => file.endsWith('.json') && !file.startsWith('_'))
    .sort();
  const records = [];
  for (const file of files) {
    const kb = JSON.parse(await readFile(path.join(KB_DIR, file), 'utf8'));
    records.push(...collectKbTrialRecords(kb, file));
  }
  const failures = [];
  for (const record of records) {
    for (const issue of validateStaticTrialRecord(record)) {
      failures.push({ ...record, issue, source: 'static' });
    }
  }
  let registryChecked = 0;
  const factsByNct = new Map();
  if (!STATIC_ONLY) {
    for (const nctId of [...new Set(records.map((record) => record.nctId))]) {
      factsByNct.set(nctId, await fetchTrialRegistryFacts(nctId));
      registryChecked += 1;
    }
    for (const record of records) {
      const registryFacts = factsByNct.get(record.nctId);
      for (const issue of validateTrialRecord(record, registryFacts)) {
        failures.push({ ...record, issue, registryFacts, source: 'clinicaltrials.gov' });
      }
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    kbFiles: files.length,
    recordsChecked: records.length,
    registryChecked,
    registryRecords: STATIC_ONLY
      ? []
      : records.map((record) => ({ ...record, registryFacts: factsByNct.get(record.nctId) || null })),
    staticOnly: STATIC_ONLY,
    failures
  };
  if (jsonPath) await writeFile(path.resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) {
    console.error(`KB trial registry audit failed: ${failures.length} issue(s)`);
    for (const failure of failures) {
      console.error(
        `- ${failure.file} ${failure.location} ${failure.id} ${failure.nctId}: ${failure.issue}`
      );
      if (failure.registryFacts) {
        console.error(
          `  Registry: status=${failure.registryFacts.status || 'unknown'} ` +
          `phases=${failure.registryFacts.phases.join(',') || 'none'} ` +
          `conditions=${failure.registryFacts.conditions.join(' | ') || 'none'}`
        );
        console.error(`  Stored context: ${failure.statusText || 'none'}`);
      }
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `KB trial registry audit passed: ${records.length} records across ${files.length} KBs` +
    (STATIC_ONLY ? ' (static).' : `; ${registryChecked} unique NCT records verified.`)
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
