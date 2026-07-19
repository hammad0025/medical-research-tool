#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'mrt.kb-clinical-review.v1';
export const DEFAULT_MANIFEST_PATH = '.verify-runs/kb-clinical-review.json';
export const HIGH_RISK_FIELDS = Object.freeze([
  {
    field: 'approval status',
    paths: ['pipelineDrugs[].approvalStatus', 'pipelineDrugs[].status', 'canonicalFacts[].claim']
  },
  {
    field: 'dosing',
    paths: ['items[].summary', 'items[].keyPassages', 'canonicalFacts[].claim', 'lifestyleRecommendations[].recommendation']
  },
  {
    field: 'efficacy numbers',
    paths: ['items[].summary', 'items[].keyPassages', 'canonicalFacts[].claim', 'excludedAgents[].reason']
  },
  {
    field: 'safety',
    paths: ['items[].summary', 'items[].keyPassages', 'redFlags[]', 'canonicalFacts[].claim']
  },
  {
    field: 'contraindications',
    paths: ['items[].summary', 'items[].keyPassages', 'redFlags[]']
  },
  {
    field: 'failed trials',
    paths: ['excludedAgents[]', 'items[category=negative-trial]']
  },
  {
    field: 'genetics',
    paths: ['items[].summary', 'items[].keyPassages', 'canonicalFacts[].claim', 'redFlags[]']
  },
  {
    field: 'citations',
    paths: ['items[].doi', 'items[].pmid', 'items[].url', 'canonicalFacts[].evidenceRefs', 'pipelineDrugs[].evidenceRef', 'excludedAgents[].evidenceRef']
  }
]);

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(modulePath), '..');

const normalizePath = (value) => value.split(sep).join('/');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blankReview = () => ({ reviewer: '', date: '', decision: '', correction: '' });
const highRiskFields = () => HIGH_RISK_FIELDS.map(({ field, paths }) => ({ field, paths: [...paths] }));
const isGeneratedKb = (kb) =>
  Boolean(kb.generatedBy) || /auto|dynamic/i.test(String(kb.curatedBy || ''));

const loadGeneratedKbs = async (root) => {
  const kbDir = join(root, 'data', 'kb');
  const names = (await readdir(kbDir))
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .sort();
  const entries = [];
  for (const name of names) {
    const absolutePath = join(kbDir, name);
    const bytes = await readFile(absolutePath);
    let kb;
    try {
      kb = JSON.parse(bytes);
    } catch (error) {
      throw new Error(`${normalizePath(relative(root, absolutePath))} is invalid JSON: ${error.message}`);
    }
    if (!isGeneratedKb(kb)) continue;
    entries.push({
      file: normalizePath(relative(root, absolutePath)),
      sha256: digest(bytes),
      condition: String(kb.condition || ''),
      highRiskFields: highRiskFields(),
      review: blankReview()
    });
  }
  if (!entries.length) throw new Error('No generated medical KB files found');
  return entries;
};

export const buildManifest = async ({ root = defaultRoot } = {}) => {
  const assurancePath = join(root, '.verify-runs', 'assurance-final.json');
  let assuranceSha256 = null;
  try {
    assuranceSha256 = digest(await readFile(assurancePath));
  } catch {
    // The review queue remains derivable from the KBs when the assurance artifact is absent.
  }
  return {
    schema: SCHEMA,
    generatedAt: '1970-01-01T00:00:00.000Z',
    purpose: 'Human clinical review queue; this record does not itself grant medical approval.',
    sourceAssurance: {
      file: '.verify-runs/assurance-final.json',
      sha256: assuranceSha256
    },
    requiredDecision: 'approved',
    entries: await loadGeneratedKbs(root)
  };
};

const hasReviewData = (manifest) =>
  Array.isArray(manifest?.entries) &&
  manifest.entries.some((entry) =>
    ['reviewer', 'date', 'decision', 'correction'].some(
      (field) => String(entry?.review?.[field] || '').trim() !== ''
    )
  );

export const generateManifest = async ({
  root = defaultRoot,
  manifestPath = DEFAULT_MANIFEST_PATH,
  force = false
} = {}) => {
  const absoluteManifest = resolve(root, manifestPath);
  if (!force) {
    try {
      const existing = JSON.parse(await readFile(absoluteManifest, 'utf8'));
      if (hasReviewData(existing)) {
        throw new Error(
          `Refusing to overwrite populated review records at ${normalizePath(relative(root, absoluteManifest))}; archive them or explicitly use --force`
        );
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const manifest = await buildManifest({ root });
  await mkdir(dirname(absoluteManifest), { recursive: true });
  await writeFile(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const validateManifest = async ({
  root = defaultRoot,
  manifestPath = DEFAULT_MANIFEST_PATH
} = {}) => {
  const failures = [];
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(absoluteManifest, 'utf8'));
  } catch (error) {
    return { ok: false, failures: [`Review manifest is missing or invalid JSON: ${error.message}`] };
  }

  if (manifest?.schema !== SCHEMA) failures.push(`schema must be ${SCHEMA}`);
  if (!Array.isArray(manifest?.entries)) {
    return { ok: false, failures: [...failures, 'entries must be an array'] };
  }

  let expectedEntries;
  try {
    expectedEntries = await loadGeneratedKbs(root);
  } catch (error) {
    return { ok: false, failures: [...failures, error.message] };
  }
  const expectedByFile = new Map(expectedEntries.map((entry) => [entry.file, entry]));
  const seen = new Set();

  for (const entry of manifest.entries) {
    const file = String(entry?.file || '');
    if (!file || seen.has(file)) {
      failures.push(file ? `${file}: duplicate queue entry` : 'queue entry has no file');
      continue;
    }
    seen.add(file);
    const expected = expectedByFile.get(file);
    if (!expected) {
      failures.push(`${file}: unexpected or no longer generated KB`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      failures.push(`${file}: malformed SHA-256 digest`);
    } else if (entry.sha256 !== expected.sha256) {
      failures.push(`${file}: stale sign-off; KB content changed after recorded digest`);
    }
    if (entry.condition !== expected.condition || !entry.condition) {
      failures.push(`${file}: condition does not match current KB`);
    }
    if (!sameJson(entry.highRiskFields, expected.highRiskFields)) {
      failures.push(`${file}: high-risk inspection fields are malformed`);
    }

    const review = entry.review;
    if (!review || typeof review !== 'object' || Array.isArray(review)) {
      failures.push(`${file}: review record is malformed`);
      continue;
    }
    const keys = Object.keys(review).sort();
    if (!sameJson(keys, ['correction', 'date', 'decision', 'reviewer'])) {
      failures.push(`${file}: review record must contain only reviewer, date, decision, and correction`);
      continue;
    }
    if (Object.values(review).some((value) => typeof value !== 'string')) {
      failures.push(`${file}: review fields must be strings`);
      continue;
    }
    if (!review.reviewer.trim()) failures.push(`${file}: unsigned; reviewer is blank`);
    if (!validDate(review.date)) failures.push(`${file}: unsigned or malformed review date`);
    if (review.decision === 'rejected') {
      failures.push(`${file}: reviewer rejected this KB`);
    } else if (review.decision !== 'approved') {
      failures.push(`${file}: unsigned or malformed decision; expected approved or rejected`);
    }
    if (review.correction.trim()) {
      failures.push(`${file}: unresolved correction is recorded; update the KB and obtain a new sign-off`);
    }
  }

  for (const file of expectedByFile.keys()) {
    if (!seen.has(file)) failures.push(`${file}: missing from reviewer queue`);
  }
  if (manifest.entries.length !== expectedEntries.length) {
    failures.push(
      `queue has ${manifest.entries.length} entries; current generated KB set has ${expectedEntries.length}`
    );
  }

  return { ok: failures.length === 0, failures };
};

const parseCli = (argv) => {
  const [command, ...flags] = argv;
  const options = { command, root: defaultRoot, manifestPath: DEFAULT_MANIFEST_PATH, force: false };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--force') options.force = true;
    else if (flag === '--root') {
      const value = flags[++index];
      if (!value) throw new Error('--root requires a path');
      options.root = resolve(value);
    } else if (flag === '--manifest') {
      const value = flags[++index];
      if (!value) throw new Error('--manifest requires a path');
      options.manifestPath = value;
    }
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
};

const main = async () => {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'generate') {
    const manifest = await generateManifest(options);
    console.log(`Wrote ${options.manifestPath} with ${manifest.entries.length} unsigned review records.`);
    return;
  }
  if (options.command === 'verify') {
    const result = await validateManifest(options);
    if (!result.ok) {
      console.error('Clinical KB review verification failed:');
      for (const failure of result.failures) console.error(`- ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log('Clinical KB review verification passed.');
    return;
  }
  throw new Error('Usage: node scripts/kb-clinical-review.mjs <generate|verify> [--manifest path] [--root path] [--force]');
};

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
