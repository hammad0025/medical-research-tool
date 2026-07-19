import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
const trials = await readFile(new URL('../api/trials.js', import.meta.url), 'utf8');
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = await readFile(new URL('../scripts/build-frontend.mjs', import.meta.url), 'utf8');

test('browser JavaScript is repository-built without runtime Babel or CDN execution', () => {
  assert.match(index, /<script defer src="\/app\.js"><\/script>/);
  assert.doesNotMatch(index, /text\/babel|unpkg\.com|cdn\.jsdelivr\.net/);
  assert.match(app, /import React from "react"/);
  for (const artifact of ['index.html', 'terms.html', 'app.js']) {
    assert.match(buildScript, new RegExp(`copyFile\\('${artifact}', 'public/${artifact}'\\)`));
  }
});

test('homepage CSP blocks eval, inline scripts, and remote scripts', () => {
  const home = vercel.routes.find((route) => route.dest === '/index.html');
  const csp = home?.headers?.['Content-Security-Policy'] || '';
  const scriptPolicy = csp.match(/(?:^|;\s*)script-src\s+([^;]+)/)?.[1] || '';
  assert.equal(scriptPolicy, "'self'");
  assert.doesNotMatch(scriptPolicy, /unsafe|https?:/);
});

test('trials API uses same-origin CORS and production Terms are routable', () => {
  assert.match(trials, /setSameOriginCors/);
  assert.doesNotMatch(trials, /Access-Control-Allow-Origin['"]?\s*,\s*['"]\*/);
  assert.ok(vercel.routes.some((route) => route.dest === '/terms.html' && /terms/.test(route.src)));
});

test('release smoke is fail-closed on config and deployed SHA', () => {
  assert.match(workflow, /npm run audit:release-config/);
  assert.match(workflow, /MRT_EXPECTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /MRT_SMOKE_ACCESS_PASSCODE/);
});

test('CI uses one deterministic assurance aggregate and keeps live operations separate', () => {
  assert.match(workflow, /run: npm run assurance:all/);
  assert.match(workflow, /Scheduled live citation audit/);
  assert.match(workflow, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /run: npm run smoke:postdeploy/);
  assert.equal(packageJson.scripts['audit:prepush'], 'npm run assurance:all');
  for (const category of [
    'integration', 'static', 'dynamic', 'security', 'privacy', 'supply-chain',
    'clinician', 'demo', 'release', 'prepush', 'infrastructure', 'all'
  ]) {
    assert.ok(packageJson.scripts[`assurance:${category}`], category);
  }
});
