#!/usr/bin/env node
// Check infrastructure. Live: MRT_ACCESS_PASSCODE=xxx node scripts/verify-infra.mjs --live

import { getInfraStatus, pingUpstash } from '../lib/infra-status.js';

const LIVE = process.argv.includes('--live');
const BASE = process.env.MRT_PUBLIC_URL || 'https://medical-research-tool.vercel.app';
const PASSCODE = process.env.MRT_ACCESS_PASSCODE || '';

const pass = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);

console.log('\n=== Infrastructure ===\n');
const status = getInfraStatus();
for (const id of status.ok) pass(id);
for (const w of status.warnings) warn(`${w.id} — ${w.why}`);
for (const m of status.missing) fail(`YOU MUST ADD: ${m.id}`);

console.log(`\nBrain store: ${status.brainStore}`);

if (status.brainPersistent) {
  const ping = await pingUpstash();
  if (ping.ok) pass('Upstash connected');
  else fail(`Upstash ping failed: ${ping.error}`);
}

if (LIVE && PASSCODE) {
  const r = await fetch(`${BASE}/api/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-passcode': PASSCODE },
    body: JSON.stringify({ mode: 'runtime-config' })
  });
  const cfg = await r.json();
  if (cfg.dynamicKb?.store === 'upstash-redis') pass('Live production: persistent brain');
  else fail('Live production: still in-memory — add Upstash to Vercel and redeploy');
}

console.log(process.exitCode ? '\nSee docs/INFRA.md' : '\nAll good.\n');
