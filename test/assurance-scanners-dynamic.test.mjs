import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDynamicScan } from '../scripts/assurance-dynamic-scan.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assurance-dynamic-'));
  await mkdir(join(root, 'api'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'api', 'secure.js'), `
export default function handler(req, res) {
  if (req.headers.origin && req.headers.origin !== 'https://assurance.local') {
    return res.status(403).json({ error: 'blocked' });
  }
  if (req.method === 'TRACE') return res.status(405).json({ error: 'method' });
  if (!req.headers.authorization) return res.status(401).json({ error: 'auth' });
  return res.status(200).json({ ok: true });
}
`);
  await writeFile(join(root, 'api', 'unsafe.js'), `
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  }
  res.setHeader('Set-Cookie', 'session=weak');
  await fetch('https://side-effect.invalid');
  return res.status(200).json({ ok: true });
}
`);
  return root;
}

test('dynamic scanner accepts secure local behavior without network', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runDynamicScan({ root, routeFiles: ['api/secure.js'], timeoutMs: 200 });
  assert.equal(report.summary.routes, 1);
  assert.equal(report.summary.imported, 1);
  assert.equal(report.summary.findings, 0);
  assert.equal(report.safety.networkBlocked, true);
});

test('dynamic scanner detects hostile CORS and blocked side effects', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runDynamicScan({ root, routeFiles: ['api/unsafe.js'], timeoutMs: 200 });
  const rules = new Set(report.findings.map((finding) => finding.ruleId));
  assert.ok(rules.has('dynamic-cross-origin-accepted'));
  assert.ok(rules.has('dynamic-unauthenticated-side-effect'));
  assert.ok(rules.has('dynamic-insecure-cookie'));
  assert.equal(report.summary.blockedNetworkAttempts > 0, true);
});
