#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const forbiddenTracked = tracked.filter((path) =>
  /(^|\/)(?:\.verify-runs|\.verify-screenshots|tmp)(?:\/|$)/.test(path) ||
  /(^|\/)\.cursor\/debug-[^/]+\.log$/.test(path) ||
  (/((^|\/)\.env(?:\.|$)|credentials?\.json$|secrets?\.json$)/i.test(path) &&
    !/(^|\/)\.env\.example$/i.test(path))
);
if (forbiddenTracked.length) {
  fail(`private/generated artifacts are tracked: ${forbiddenTracked.join(', ')}`);
}

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const privateRoute = vercel.routes?.[0];
if (!privateRoute || privateRoute.dest !== '/api/private-static') {
  fail('vercel.json must deny private paths before every other route');
}

const homeRoute = vercel.routes?.find((route) => route.dest === '/index.html');
const homeCsp = String(homeRoute?.headers?.['Content-Security-Policy'] || '');
const scriptPolicy = homeCsp.match(/(?:^|;\s*)script-src\s+([^;]+)/)?.[1] || '';
if (!scriptPolicy || /'unsafe-inline'|'unsafe-eval'|https?:/i.test(scriptPolicy)) {
  fail('homepage script-src must allow only repository-owned scripts without unsafe-inline/unsafe-eval');
}
if (!vercel.routes?.some((route) => route.dest === '/terms.html' && /terms/.test(route.src || ''))) {
  fail('vercel.json must expose the production Terms page at /terms');
}

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const vercelIgnore = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8');
if (/^scripts\s*$/m.test(vercelIgnore) || /^src\s*$/m.test(vercelIgnore)) {
  fail('.vercelignore must include frontend build inputs (scripts/ and src/)');
}
if (/type=["']text\/babel|https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)/i.test(index)) {
  fail('homepage must not execute runtime Babel or CDN JavaScript');
}
if (!/<script defer src="\/app\.js"><\/script>/.test(index)) {
  fail('homepage must load the repository-built /app.js bundle');
}
const bundleBefore = readFileSync(new URL('../app.js', import.meta.url));
execFileSync(process.execPath, ['scripts/build-frontend.mjs'], { stdio: 'ignore' });
const bundleAfter = readFileSync(new URL('../app.js', import.meta.url));
if (!bundleBefore.equals(bundleAfter)) {
  fail('app.js is stale; run npm run build and include the generated bundle');
}
for (const name of ['index.html', 'terms.html', 'app.js']) {
  const source = readFileSync(new URL(`../${name}`, import.meta.url));
  const staged = readFileSync(new URL(`../public/${name}`, import.meta.url));
  if (!source.equals(staged)) {
    fail(`public/${name} does not match the deployable root artifact`);
  }
}

for (const apiPath of [
  '../api/access-session.js',
  '../api/alerts-cron.js',
  '../api/alerts-subscribe.js',
  '../api/brain-cron.js',
  '../api/demo-readiness.js',
  '../api/health.js',
  '../api/research.js',
  '../api/terms-consent.js',
  '../api/trials.js'
]) {
  const source = readFileSync(new URL(apiPath, import.meta.url), 'utf8');
  if (/Access-Control-Allow-Origin['"]?\s*,\s*['"]\*/.test(source)) {
    fail(`${apiPath.replace('../', '')} permits wildcard browser origins`);
  }
}

const kbDir = new URL('../data/kb/', import.meta.url);
const unreviewedKbs = readdirSync(kbDir)
  .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
  .filter((name) => JSON.parse(readFileSync(new URL(name, kbDir), 'utf8')).reviewed === false);
if (unreviewedKbs.length) {
  warn(`${unreviewedKbs.length} medical KBs have not received independent clinician review (non-blocking)`);
}
const unsignedGeneratedKbs = readdirSync(kbDir)
  .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
  .filter((name) => {
    const kb = JSON.parse(readFileSync(new URL(name, kbDir), 'utf8'));
    const generated = kb.generatedBy || /auto|dynamic/i.test(String(kb.curatedBy || ''));
    return generated && kb.reviewed === true &&
      (!String(kb.reviewedBy || '').trim() || !/^\d{4}-\d{2}-\d{2}/.test(String(kb.reviewedAt || '')));
  });
if (unsignedGeneratedKbs.length) {
  fail(`generated KB sign-off requires reviewedBy and reviewedAt: ${unsignedGeneratedKbs.join(', ')}`);
}
for (const privatePrefix of ['lib', 'data', 'scripts', 'docs', '\\.verify-runs', 'tmp']) {
  if (!String(privateRoute?.src || '').includes(privatePrefix)) {
    fail(`vercel.json does not explicitly deny static access to ${privatePrefix}`);
  }
}

const gate = readFileSync(new URL('../lib/access-gate.js', import.meta.url), 'utf8');
if (/if\s*\(\s*!expected\s*\)\s*return\s+true/.test(gate)) {
  fail('access control contains a missing-secret fail-open path');
}

for (const cronPath of ['../api/alerts-cron.js', '../api/brain-cron.js']) {
  const source = readFileSync(new URL(cronPath, import.meta.url), 'utf8');
  if (/if\s*\(\s*!expected\s*\)\s*return\s+true/.test(source)) {
    fail(`${cronPath.replace('../', '')} fails open when CRON_SECRET is absent`);
  }
}

if (failures.length) {
  console.error('Pre-push audit failed:');
  failures.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

if (warnings.length) {
  console.warn('Pre-push audit warnings:');
  warnings.forEach((message) => console.warn(`- ${message}`));
}

console.log('Pre-push repository policy checks passed.');
