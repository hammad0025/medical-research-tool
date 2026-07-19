#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const tests = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => /^integration-chaos-.*\.test\.mjs$/.test(name))
  .sort()
  .map((name) => `test/${name}`);

if (!tests.length) {
  console.error('No integration-chaos test files found.');
  process.exit(1);
}

const env = {
  ...process.env,
  ANTHROPIC_API_KEY: 'offline-anthropic-fixture',
  PERPLEXITY_API_KEY: '',
  OPENAI_API_KEY: '',
  XAI_API_KEY: '',
  RESEND_API_KEY: '',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  MRT_DISABLE_USAGE_LIMIT: '1',
  MRT_LINKCHECK_ENABLED: '0',
  MRT_GATHER_SIGNING_SECRET: 'offline-gather-secret',
  MRT_REPORT_SEAL_SECRET: 'offline-report-secret'
};

console.log(`Running ${tests.length} offline integration/chaos suites...`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
  cwd: root,
  env,
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
