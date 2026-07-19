import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectInventory, scanStatic } from '../scripts/assurance-static-scan.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assurance-static-'));
  await Promise.all(['api', 'lib', 'src', 'data/kb', 'test'].map((directory) =>
    mkdir(join(root, directory), { recursive: true })));
  await writeFile(join(root, 'vercel.json'), JSON.stringify({
    routes: [{ src: '^/api/(.*)$', dest: '/api/$1' }]
  }));
  await writeFile(join(root, 'api', 'unsafe.js'), `
export default async function handler(req, res) {
  // TODO security bypass before release
  console.log(req.body, req.headers.authorization);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Set-Cookie', 'session=weak');
  if (false) return res.status(204).end();
  const response = await fetch(req.body.url);
  return res.status(200).json({ response });
}
`);
  await writeFile(join(root, 'lib', 'unsafe.js'), `
import { exec } from 'node:child_process';
export const run = (text) => eval(text);
export const weak = () => createHash('sha1');
export const command = exec;
`);
  await writeFile(join(root, 'lib', 'cache-store.js'), 'export const cache = new Map();\n');
  await writeFile(join(root, 'src', 'app.jsx'), `
export const View = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;
`);
  await writeFile(join(root, 'data', 'kb', 'fixture.json'), '{"condition":"Fixture"}\n');
  await writeFile(join(root, 'test', 'unsafe.test.mjs'), `
import test from 'node:test';
import { run } from '../lib/unsafe.js';
test('fixture', () => run);
`);
  return root;
}

test('inventory covers modules, routes, data, LOC, and transitive test mappings', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = await collectInventory({ root });
  assert.equal(inventory.totals.routes, 1);
  assert.equal(inventory.totals.dataFiles, 1);
  assert.ok(inventory.totals.physicalLoc > 0);
  assert.deepEqual(
    inventory.modules.find((module) => module.file === 'lib/unsafe.js').tests,
    ['test/unsafe.test.mjs']
  );
  assert.equal(inventory.routes[0].configured, true);
  assert.equal(inventory.data[0].file, 'data/kb/fixture.json');
});

test('static scanner reports security boundaries and unsafe primitives', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await scanStatic({ root });
  const rules = new Set(report.findings.map((finding) => finding.ruleId));
  for (const expected of [
    'route-missing-cors',
    'route-missing-auth',
    'route-missing-terms',
    'route-missing-body-limit',
    'route-missing-schema-validation',
    'fetch-missing-timeout',
    'sensitive-logging',
    'dynamic-code-execution',
    'child-process-runtime',
    'weak-cryptography',
    'unsafe-html-sink',
    'wildcard-cors',
    'insecure-cookie',
    'security-bypass-marker',
    'unreachable-constant-branch',
    'production-memory-fallback'
  ]) {
    assert.ok(rules.has(expected), `expected ${expected}`);
  }
  assert.equal(report.summary.bySeverity.critical > 0, true);
});

test('static scanner recognizes bounded wrappers, sanitizers, and fixed hosts', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'src', 'safe.jsx'), `
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const controller = new AbortController();
  return nativeFetch(input, { ...init, signal: controller.signal });
};
const sanitizeRenderedHtml = (html) => sanitizeReportHtml(html);
export const Safe = ({ raw }) => {
  const html = sanitizeRenderedHtml(raw);
  fetch('/api/safe');
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
};
`);
  await writeFile(join(root, 'lib', 'fixed-host.js'), `
const API = (id) => \`https://provider.test/item/\${encodeURIComponent(id)}\`;
export const load = (req) => fetchWithTimeout(API(req.body.id));
`);
  const report = await scanStatic({ root });
  assert.deepEqual(
    report.findings.filter((finding) =>
      ['src/safe.jsx', 'lib/fixed-host.js'].includes(finding.file) &&
      finding.category !== 'coverage-map'),
    []
  );
});
