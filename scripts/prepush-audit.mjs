#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const failures = [];
const fail = (message) => failures.push(message);

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

console.log('Pre-push repository policy checks passed.');
