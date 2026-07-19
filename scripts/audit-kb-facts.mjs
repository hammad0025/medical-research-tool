#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildGroundingIndex,
  isClaimGrounded,
  quantitativeGroundingDiagnostics
} from '../lib/grounding-gate.js';
import {
  kbClaimSegments,
  kbEvidenceRefs,
  kbItemsGroundingIndex
} from '../lib/kb-fact-gate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = path.join(ROOT, 'data', 'kb');

const evidenceRefs = kbEvidenceRefs;

export const itemGroundingIndex = (item) => buildGroundingIndex({
  evidencePack: [{
    title: item?.title || '',
    journal: item?.journal || '',
    year: item?.year || '',
    summary: item?.summary || '',
    keyPassages: (item?.keyPassages || []).map((passage) => passage?.quote || '').filter(Boolean)
  }]
});

export const itemsGroundingIndex = kbItemsGroundingIndex;

const claimSegments = kbClaimSegments;

export const validateFactRecord = (
  record,
  itemsById,
  { location = '', quarantinedIds = new Set() } = {}
) => {
  const claim = String(record?.claim || record?.recommendation || '').trim();
  const refs = evidenceRefs(record);
  const issues = [];
  if (!claim) return [{ location, issue: 'record has no claim or recommendation text' }];
  if (!refs.length) return [{ location, issue: 'record has no evidenceRefs' }];
  const activeItems = [];
  for (const ref of refs) {
    const item = itemsById.get(ref);
    if (!item) {
      issues.push({
        location,
        issue: quarantinedIds.has(ref)
          ? `quarantined evidenceRef ${ref}`
          : `unresolved evidenceRef ${ref}`
      });
      continue;
    }
    activeItems.push(item);
  }
  // Composite canonical records can contain several independently checkable
  // statements. Every statement must ground against the cited set; quantitative
  // statements still must match one individual source item inside that set.
  const index = itemsGroundingIndex(activeItems);
  const unsupported = activeItems.length
    ? claimSegments(claim).filter((segment) => !isClaimGrounded(segment, index))
    : [];
  if (unsupported.length) {
    issues.push({
      location,
      issue:
        `claim is not grounded in referenced source set (${refs.join(', ')}): ` +
        unsupported.map((segment) => JSON.stringify(segment.slice(0, 180))).join(' | '),
      diagnostics: unsupported.map((segment) => ({
        segment,
        sources: activeItems.map((item) => ({
          id: item.id,
          ...quantitativeGroundingDiagnostics(segment, itemGroundingIndex(item).items[0]?.text || '')
        }))
      }))
    });
  }
  return issues;
};

export const auditKbFacts = (kb, file = '') => {
  const activeItems = (kb.items || []).filter((item) => item?.quarantined !== true);
  const itemsById = new Map(activeItems.map((item) => [item.id, item]));
  const quarantinedIds = new Set(
    (kb.items || []).filter((item) => item?.quarantined === true).map((item) => item.id)
  );
  const failures = [];
  let checked = 0;
  let excluded = 0;
  for (const [collection, records] of [
    ['canonicalFacts', kb.canonicalFacts || []],
    ['lifestyleRecommendations', kb.lifestyleRecommendations || []]
  ]) {
    for (const [index, record] of records.entries()) {
      const refs = evidenceRefs(record);
      checked += 1;
      for (const failure of validateFactRecord(record, itemsById, {
        location: `${collection}[${index}]`,
        quarantinedIds
      })) {
        failures.push({ file, ...failure });
      }
    }
  }
  return { checked, excluded, failures };
};

const main = async () => {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : '';
  const files = (await readdir(KB_DIR))
    .filter((file) => file.endsWith('.json') && !file.startsWith('_'))
    .sort();
  const failures = [];
  let checked = 0;
  let excluded = 0;
  for (const file of files) {
    const kb = JSON.parse(await readFile(path.join(KB_DIR, file), 'utf8'));
    const result = auditKbFacts(kb, file);
    checked += result.checked;
    excluded += result.excluded;
    failures.push(...result.failures);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    kbFiles: files.length,
    recordsChecked: checked,
    quarantinedRecordsExcluded: excluded,
    failures
  };
  if (jsonPath) await writeFile(path.resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) {
    console.error(`KB fact grounding audit failed: ${failures.length} issue(s)`);
    for (const failure of failures) {
      console.error(`- ${failure.file} ${failure.location}: ${failure.issue}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `KB fact grounding audit passed: ${checked} canonical/lifestyle records across ${files.length} KBs; ` +
    `${excluded} quarantined records excluded.`
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
