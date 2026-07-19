import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  auditDangerousTrackedPaths,
  auditExternalAssets,
  auditLockfile,
  auditWorkflowPins,
  runSupplyChainAudit,
  scanTextForSecrets
} from '../scripts/assurance-supply-chain.mjs';

test('GitHub actions require immutable commit SHA pins', () => {
  assert.deepEqual(
    auditWorkflowPins('steps:\n  - uses: actions/checkout@0123456789012345678901234567890123456789\n'),
    []
  );
  const findings = auditWorkflowPins('steps:\n  - uses: actions/checkout@v4\n');
  assert.deepEqual(findings.map((item) => item.id), ['ACTION_NOT_SHA_PINNED']);
});

test('external executable assets require SRI while self-hosted assets do not', () => {
  assert.deepEqual(auditExternalAssets('<script defer src="/app.js"></script>'), []);
  assert.deepEqual(
    auditExternalAssets('<script src="https://cdn.example/app.js" integrity="sha384-abc"></script>'),
    []
  );
  assert.deepEqual(
    auditExternalAssets('<script src="https://cdn.example/app.js"></script>').map((item) => item.id),
    ['EXTERNAL_ASSET_WITHOUT_SRI']
  );
});

test('secret scanning suppresses values and ignores documented placeholders', () => {
  assert.deepEqual(scanTextForSecrets('ANTHROPIC_API_KEY=sk-ant-...', '.env.example'), []);
  const fakeKey = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-');
  const findings = scanTextForSecrets(
    `token=${fakeKey}`,
    'fixture.txt'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'SECRET_ANTHROPIC_KEY');
  assert.equal(JSON.stringify(findings).includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('dangerous tracked artifact rules reject credentials and private audit payloads', () => {
  const findings = auditDangerousTrackedPaths([
    '.env.example',
    '.env.production',
    'certs/signing.key',
    '.verify-runs/run-1/patient.json'
  ]);
  assert.deepEqual(
    findings.map((item) => item.id).sort(),
    ['TRACKED_ENV', 'TRACKED_KEY_MATERIAL', 'TRACKED_PRIVATE_AUDIT'].sort()
  );
});

test('lockfile audit requires exact package entries and SHA-2 integrity', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const lockfile = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  assert.deepEqual(auditLockfile(packageJson, lockfile), []);

  const bad = structuredClone(lockfile);
  bad.packages['node_modules/marked'].integrity = 'sha1-unsafe';
  assert.equal(
    auditLockfile(packageJson, bad).some((item) => item.id === 'LOCKFILE_INTEGRITY'),
    true
  );
});

test('repository audit clears report blockers while preserving replay warnings', async () => {
  const result = await runSupplyChainAudit();
  const ids = new Set(result.findings.map((item) => item.id));
  assert.equal(ids.has('REPORT_SEAL_DEFAULT_KEY'), false);
  assert.equal(ids.has('REPORT_SEAL_UNVERIFIABLE'), false);
  assert.equal(ids.has('REPORT_REPLAY_WINDOW'), true);
  assert.equal(ids.has('GATHER_REPLAY_WINDOW'), true);
  assert.equal(ids.has('SESSION_REPLAY_WINDOW'), true);
  assert.equal(ids.has('KEY_REUSE_GATHER'), true);
  assert.equal(ids.has('KEY_REUSE_REPORT'), false);
  assert.equal(ids.has('ACTION_NOT_SHA_PINNED'), false);
  assert.equal(ids.has('EXTERNAL_ASSET_WITHOUT_SRI'), false);
  assert.equal(ids.has('LOCKFILE_INTEGRITY'), false);
});
