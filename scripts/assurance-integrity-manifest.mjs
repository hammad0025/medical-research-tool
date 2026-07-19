#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_VERSION = 1;
export const DEFAULT_MANIFEST_PATH = '.verify-runs/integrity-manifest.sha256.json';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['api', 'lib', 'src', 'scripts'];
const ROOT_FILES = [
  '.env.example',
  '.gitignore',
  '.vercelignore',
  'index.html',
  'terms.html',
  'app.js',
  'package.json',
  'package-lock.json',
  'vercel.json'
];
const AUDIT_EXTENSIONS = new Set(['.json', '.md', '.txt']);

const normalizeRelative = (value) => value.split(path.sep).join('/');

const isWithin = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const assertSafeRelativePath = (relativePath) => {
  const normalized = normalizeRelative(String(relativePath || ''));
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`Unsafe manifest path: ${JSON.stringify(normalized)}`);
  }
  const resolved = path.resolve(ROOT, normalized);
  if (!isWithin(ROOT, resolved)) throw new Error(`Manifest path escapes repository: ${normalized}`);
  return normalized;
};

const walkFiles = async (relativeDirectory, predicate = () => true) => {
  const absoluteDirectory = path.resolve(ROOT, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = normalizeRelative(path.join(relativeDirectory, entry.name));
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to hash symlink in release scope: ${relative}`);
    }
    if (entry.isDirectory()) files.push(...await walkFiles(relative, predicate));
    else if (entry.isFile() && predicate(relative)) files.push(relative);
  }
  return files;
};

const existsAsFile = async (relativePath) => {
  try {
    return (await stat(path.resolve(ROOT, relativePath))).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

export const collectReleaseCriticalFiles = async ({
  manifestPath = DEFAULT_MANIFEST_PATH,
  includeAuditOutputs = true
} = {}) => {
  const excludedManifest = normalizeRelative(manifestPath);
  const files = [];
  for (const directory of SOURCE_DIRS) {
    files.push(...await walkFiles(directory, (relative) =>
      /\.(?:js|jsx|mjs|json|md|txt)$/i.test(relative)
    ));
  }
  files.push(...await walkFiles('data/kb', (relative) => /\.(?:json|md)$/i.test(relative)));
  files.push(...await walkFiles('.github/workflows', (relative) => /\.ya?ml$/i.test(relative)));
  for (const relative of ROOT_FILES) {
    if (await existsAsFile(relative)) files.push(relative);
  }
  if (includeAuditOutputs) {
    files.push(...await walkFiles('.verify-runs', (relative) =>
      relative !== excludedManifest &&
      !relative.endsWith('.tmp') &&
      AUDIT_EXTENSIONS.has(path.extname(relative).toLowerCase())
    ));
  }
  return [...new Set(files.map(assertSafeRelativePath))].sort();
};

export const sha256File = async (relativePath) => {
  const safePath = assertSafeRelativePath(relativePath);
  const contents = await readFile(path.resolve(ROOT, safePath));
  return {
    path: safePath,
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex')
  };
};

export const createIntegrityManifest = async (options = {}) => {
  const files = await collectReleaseCriticalFiles(options);
  const entries = [];
  for (const file of files) entries.push(await sha256File(file));
  return {
    schema: 'mrt.release-integrity-manifest',
    version: MANIFEST_VERSION,
    algorithm: 'SHA-256',
    generatedAt: new Date(0).toISOString(),
    entries
  };
};

const canonicalManifest = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

export const writeIntegrityManifest = async ({
  manifestPath = DEFAULT_MANIFEST_PATH,
  includeAuditOutputs = true
} = {}) => {
  const safePath = assertSafeRelativePath(manifestPath);
  const absolutePath = path.resolve(ROOT, safePath);
  const manifest = await createIntegrityManifest({ manifestPath: safePath, includeAuditOutputs });
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, canonicalManifest(manifest), { mode: 0o600 });
  await rename(temporaryPath, absolutePath);
  return manifest;
};

const validateManifestShape = (manifest) => {
  if (
    manifest?.schema !== 'mrt.release-integrity-manifest' ||
    manifest?.version !== MANIFEST_VERSION ||
    manifest?.algorithm !== 'SHA-256' ||
    !Array.isArray(manifest?.entries)
  ) {
    throw new Error('Unsupported or malformed integrity manifest');
  }
  const paths = new Set();
  for (const entry of manifest.entries) {
    const relative = assertSafeRelativePath(entry?.path);
    if (paths.has(relative)) throw new Error(`Duplicate manifest path: ${relative}`);
    if (!/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ''))) {
      throw new Error(`Invalid SHA-256 digest for ${relative}`);
    }
    if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0) {
      throw new Error(`Invalid byte count for ${relative}`);
    }
    paths.add(relative);
  }
};

export const verifyIntegrityManifest = async ({
  manifestPath = DEFAULT_MANIFEST_PATH,
  includeAuditOutputs = true
} = {}) => {
  const safePath = assertSafeRelativePath(manifestPath);
  const raw = await readFile(path.resolve(ROOT, safePath), 'utf8');
  const manifest = JSON.parse(raw);
  validateManifestShape(manifest);

  const expectedScope = await collectReleaseCriticalFiles({
    manifestPath: safePath,
    includeAuditOutputs
  });
  const actualPaths = manifest.entries.map((entry) => entry.path);
  const expectedSet = new Set(expectedScope);
  const actualSet = new Set(actualPaths);
  const missingFromManifest = expectedScope.filter((file) => !actualSet.has(file));
  const missingFromDisk = actualPaths.filter((file) => !expectedSet.has(file));
  const mismatches = [];

  for (const entry of manifest.entries) {
    if (missingFromDisk.includes(entry.path)) continue;
    const actual = await sha256File(entry.path);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      mismatches.push({
        path: entry.path,
        expectedBytes: entry.bytes,
        actualBytes: actual.bytes,
        digestMatches: actual.sha256 === entry.sha256
      });
    }
  }
  return {
    ok: missingFromManifest.length === 0 && missingFromDisk.length === 0 && mismatches.length === 0,
    checked: manifest.entries.length,
    missingFromManifest,
    missingFromDisk,
    mismatches
  };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2] || 'verify';
  const requestedPath = process.argv.find((arg) => arg.startsWith('--manifest='))
    ?.slice('--manifest='.length) || DEFAULT_MANIFEST_PATH;
  const includeAuditOutputs = !process.argv.includes('--no-audit-outputs');
  try {
    if (command === 'generate') {
      const manifest = await writeIntegrityManifest({
        manifestPath: requestedPath,
        includeAuditOutputs
      });
      console.log(`Wrote SHA-256 manifest with ${manifest.entries.length} files to ${requestedPath}`);
    } else if (command === 'verify') {
      const result = await verifyIntegrityManifest({
        manifestPath: requestedPath,
        includeAuditOutputs
      });
      if (!result.ok) {
        console.error(JSON.stringify(result, null, 2));
        process.exitCode = 1;
      } else {
        console.log(`Verified ${result.checked} release-critical files with SHA-256`);
      }
    } else {
      throw new Error('Usage: assurance-integrity-manifest.mjs <generate|verify> [--manifest=PATH] [--no-audit-outputs]');
    }
  } catch (error) {
    console.error(`Integrity manifest failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
