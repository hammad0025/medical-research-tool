import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('only an authenticated private-preview request receives the explicit unlimited flag', () => {
  const source = `
    process.env.MRT_ACCESS_PASSCODE = 'owner-code';
    process.env.MRT_PRIVATE_PREVIEW_UNLIMITED = '1';
    process.env.VERCEL_ENV = 'production';
    const { isPrivatePreviewUnlimited } = await import('./lib/access-gate.js');
    const valid = isPrivatePreviewUnlimited({ headers: { 'x-access-passcode': 'owner-code' } });
    const invalid = isPrivatePreviewUnlimited({ headers: { 'x-access-passcode': 'wrong-code' } });
    process.stdout.write(JSON.stringify({ valid, invalid }));
  `;
  const result = JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { cwd: root, encoding: 'utf8' }
  ));

  assert.deepEqual(result, { valid: true, invalid: false });
});

test('authenticated preview bypasses quota but retains normal request accounting path', async () => {
  const usageSource = await readFile(new URL('../lib/usage-store.js', import.meta.url), 'utf8');
  const researchSource = await readFile(new URL('../api/research.js', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');

  assert.match(usageSource, /consumeResearchCredit = async \(ip, \{ authenticatedPreview = false \}/);
  assert.match(researchSource, /consumeResearchCredit\(ip, \{ authenticatedPreview \}\)/);
  assert.match(researchSource, /reserveProviderBudget\(/);
  assert.match(researchSource, /beginBillableRequest\(/);
  assert.match(researchSource, /privatePreviewUnlimited,/);
  assert.match(appSource, /\{!privatePreviewUnlimited && <div/);
});
