import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';

import {
  createIntegrityManifest,
  verifyIntegrityManifest,
  writeIntegrityManifest
} from '../scripts/assurance-integrity-manifest.mjs';

const manifestPath = `.verify-runs/test-integrity-manifest-${process.pid}.json`;

test.after(async () => {
  await rm(new URL(`../${manifestPath}`, import.meta.url), { force: true });
});

test('release manifest covers source, frontend bundle, KBs, lockfile, and workflows', async () => {
  const manifest = await createIntegrityManifest({
    manifestPath,
    includeAuditOutputs: false
  });
  const paths = new Set(manifest.entries.map((entry) => entry.path));
  for (const expected of [
    'api/research.js',
    'lib/gather-seal.js',
    'src/app.jsx',
    'app.js',
    'data/kb/ipf.json',
    'package-lock.json',
    '.github/workflows/ci.yml'
  ]) {
    assert.equal(paths.has(expected), true, `${expected} must be covered`);
  }
  assert.equal(manifest.algorithm, 'SHA-256');
  assert.equal(manifest.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(
    manifest.entries.map((entry) => entry.path),
    [...manifest.entries.map((entry) => entry.path)].sort()
  );
});

test('manifest digests are full SHA-256 values and verify exactly', async () => {
  const manifest = await writeIntegrityManifest({
    manifestPath,
    includeAuditOutputs: false
  });
  const appEntry = manifest.entries.find((entry) => entry.path === 'app.js');
  const app = await readFile(new URL('../app.js', import.meta.url));
  assert.equal(appEntry.sha256, createHash('sha256').update(app).digest('hex'));
  assert.match(appEntry.sha256, /^[a-f0-9]{64}$/);

  const result = await verifyIntegrityManifest({
    manifestPath,
    includeAuditOutputs: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked, manifest.entries.length);
});

test('verification rejects a forged manifest digest without exposing file contents', async () => {
  const manifest = await writeIntegrityManifest({
    manifestPath,
    includeAuditOutputs: false
  });
  const target = manifest.entries.find((entry) => entry.path === 'package-lock.json');
  target.sha256 = '0'.repeat(64);
  await writeFile(
    new URL(`../${manifestPath}`, import.meta.url),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const result = await verifyIntegrityManifest({
    manifestPath,
    includeAuditOutputs: false
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map((entry) => entry.path), ['package-lock.json']);
  assert.equal(JSON.stringify(result).includes('"actualSha256"'), false);
});
