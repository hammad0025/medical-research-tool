#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_DIR = path.join(ROOT, '.verify-runs');
const requestedCategory = process.argv.find((arg) => arg.startsWith('--category='))
  ?.slice('--category='.length);

const offlineEnv = {
  ...process.env,
  ALLOW_PAID_CALLS: '0',
  MRT_DEMO_ALLOW_PAID: '0',
  MRT_DEMO_PRODUCTION: '0',
  REGRESSION_LIVE: '0',
  MRT_LINKCHECK_ENABLED: '0',
  ANTHROPIC_API_KEY: 'offline-fixture-key',
  PERPLEXITY_API_KEY: '',
  OPENAI_API_KEY: '',
  XAI_API_KEY: '',
  RESEND_API_KEY: '',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  MRT_DISABLE_USAGE_LIMIT: '1',
  MRT_GATHER_SIGNING_SECRET: 'offline-gather-secret',
  MRT_REPORT_SEAL_SECRET: 'offline-report-secret',
  MRT_TERMS_SIGNING_SECRET: 'offline-terms-secret'
};

const releaseEnv = {
  ...offlineEnv,
  MRT_BASE_URL: 'https://offline.example.test',
  MRT_EXPECTED_SHA: 'a'.repeat(40),
  MRT_ACCESS_PASSCODE: 'offline-access-passcode',
  MRT_REVIEWER_TOKEN: 'offline-reviewer-token',
  RESEND_API_KEY: 'offline-resend-key',
  ALERTS_EMAIL_FROM: 'alerts@offline.example.test',
  ALERTS_PUBLIC_URL: 'https://offline.example.test',
  ALERTS_MONITOR_WEBHOOK_URL: 'https://monitor.offline.example.test/hook',
  CRON_SECRET: 'offline-cron-secret',
  UPSTASH_REDIS_REST_URL: 'https://offline-redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'offline-redis-token',
  MRT_DISABLE_USAGE_LIMIT: '0'
};

const test = (...files) => ({
  command: process.execPath,
  args: ['--test', '--test-concurrency=1', ...files]
});
const node = (script, ...args) => ({ command: process.execPath, args: [script, ...args] });

const categories = {
  integration: {
    tests: [],
    standalone: [node('scripts/assurance-integration.mjs')]
  },
  static: {
    tests: [test(
      'test/assurance-scanners-static.test.mjs',
      'test/assurance-unmapped-coverage.test.mjs'
    )],
    standalone: [{ ...node('scripts/assurance-static-scan.mjs'), json: 'assurance-static.json' }]
  },
  dynamic: {
    tests: [test('test/assurance-scanners-dynamic.test.mjs')],
    standalone: [{ ...node('scripts/assurance-dynamic-scan.mjs'), json: 'assurance-dynamic.json' }]
  },
  security: {
    tests: [test(
      'test/security-pentest-auth-boundaries.test.mjs',
      'test/security-pentest-input-network.test.mjs',
      'test/security-pentest-static-assurance.test.mjs',
      'test/access-security.test.mjs',
      'test/security-enforcement.test.mjs'
    )],
    standalone: [{ ...node('scripts/assurance-security-scan.mjs', '--json', '--strict'), json: 'assurance-security.json' }]
  },
  privacy: {
    tests: [test(
      'test/privacy-ai-governance-data-lifecycle.test.mjs',
      'test/privacy-ai-governance-ai-controls.test.mjs'
    )],
    standalone: [{ ...node('scripts/assurance-data-flow.mjs'), json: 'assurance-data-flow.json' }]
  },
  supply: {
    tests: [test(
      'test/crypto-supply-chain-audit.test.mjs',
      'test/crypto-supply-chain-manifest.test.mjs',
      'test/crypto-supply-chain-seals.test.mjs'
    )],
    standalone: [
      { ...node('scripts/assurance-supply-chain.mjs'), json: 'assurance-supply-chain.json' },
      node('scripts/assurance-supply-chain.mjs', '--sbom'),
      node('scripts/assurance-integrity-manifest.mjs', 'generate', '--no-audit-outputs'),
      node('scripts/assurance-integrity-manifest.mjs', 'verify', '--no-audit-outputs')
    ]
  },
  clinician: {
    tests: [],
    standalone: [node('scripts/clinician-investor-audit.mjs')]
  },
  demo: {
    tests: [test('test/demo-readiness.test.mjs', 'test/physician-demo.test.mjs')],
    standalone: [node('scripts/demo-smoke.mjs')]
  },
  release: {
    tests: [test('test/release-controls.test.mjs')],
    standalone: [{ ...node('scripts/validate-release-config.mjs'), env: releaseEnv }]
  },
  prepush: {
    tests: [test('test/post-fix-medium-low.test.mjs')],
    standalone: [node('scripts/prepush-audit.mjs')]
  },
  infrastructure: {
    tests: [test('test/integration-chaos-infrastructure.test.mjs')],
    standalone: [{ ...node('scripts/verify-infra.mjs', '--offline'), env: releaseEnv }]
  }
};

const commandText = (step) => [step.command === process.execPath ? 'node' : step.command, ...step.args].join(' ');
const parseTap = (output) => {
  const value = (name) => [...output.matchAll(new RegExp(`(?:#|ℹ) ${name} (\\d+)`, 'g'))]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  return { tests: value('tests'), pass: value('pass'), fail: value('fail'), skipped: value('skipped') };
};

const readJsonOutput = async (name, fallback) => {
  try {
    return JSON.parse(await readFile(path.join(VERIFY_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
};

const runStep = async (category, step) => {
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    env: step.env || offlineEnv,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const command = commandText(step);
  if (step.json && stdout.trim().startsWith('{')) {
    await writeFile(path.join(VERIFY_DIR, step.json), `${stdout.trim()}\n`, { mode: 0o600 });
  } else if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) process.stderr.write(stderr);
  const tap = parseTap(`${stdout}\n${stderr}`);
  const record = {
    category,
    command,
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status ?? 1,
    ...tap
  };
  if (step.json) record.output = `.verify-runs/${step.json}`;
  if (result.status !== 0) {
    record.diagnostic = `${stderr || stdout}`.trim().slice(-4000);
  }
  console.log(`${record.status === 'pass' ? 'PASS' : 'FAIL'} ${category}: ${command}`);
  return record;
};

const main = async () => {
  await mkdir(VERIFY_DIR, { recursive: true });
  if (requestedCategory && !categories[requestedCategory] && requestedCategory !== 'ci') {
    throw new Error(`Unknown assurance category: ${requestedCategory}`);
  }

  const records = [];
  if (!requestedCategory || requestedCategory === 'ci') {
    records.push(await runStep('ci-overlap', {
      command: 'npm',
      args: ['run', 'test:ci'],
      env: offlineEnv
    }));
  }

  if (requestedCategory !== 'ci') {
    const selected = requestedCategory
      ? [[requestedCategory, categories[requestedCategory]]]
      : Object.entries(categories);
    for (const [category, definition] of selected) {
      const steps = requestedCategory
        ? [...definition.tests, ...definition.standalone]
        : definition.standalone;
      for (const step of steps) records.push(await runStep(category, step));
    }
  }

  const failures = records.filter((record) => record.status === 'fail');
  const [staticScan, dynamicScan, securityScan, dataFlow, supplyChain] = await Promise.all([
    readJsonOutput('assurance-static.json', { findings: [] }),
    readJsonOutput('assurance-dynamic.json', { findings: [] }),
    readJsonOutput('assurance-security.json', { findings: [], limitations: [] }),
    readJsonOutput('assurance-data-flow.json', { summary: {} }),
    readJsonOutput('assurance-supply-chain.json', { findings: [] })
  ]);
  const codeFindings = failures
    .filter((record) => !/medical KBs still require human review\/sign-off/.test(record.diagnostic || ''))
    .map((record) => ({
      category: record.category,
      command: record.command,
      disposition: 'code-owned-failure',
      diagnostic: record.diagnostic
    }));
  const manualFindings = failures
    .filter((record) => /medical KBs still require human review\/sign-off/.test(record.diagnostic || ''))
    .map((record) => ({
      category: record.category,
      command: record.command,
      disposition: 'manual-review-blocker',
      diagnostic: record.diagnostic
    }));
  const report = {
    schema: 'mrt.assurance-final',
    generatedAt: new Date().toISOString(),
    mode: 'offline/mock/no-paid',
    scope: 'Repository assurance only; not certification, legal compliance, or production validation.',
    requestedCategory: requestedCategory || 'all',
    summary: {
      commands: records.length,
      passedCommands: records.length - failures.length,
      failedCommands: failures.length,
      tests: records.reduce((sum, record) => sum + record.tests, 0),
      passedTests: records.reduce((sum, record) => sum + record.pass, 0),
      failedTests: records.reduce((sum, record) => sum + record.fail, 0)
    },
    overlapReconciliation: 'Full assurance runs npm test:ci once, then executes only standalone category runners; category commands run their focused suites plus standalone runner.',
    commands: records,
    findings: {
      codeOwnedFailures: codeFindings,
      manualBlockers: manualFindings,
      static: staticScan.findings,
      dynamic: dynamicScan.findings,
      security: securityScan.findings,
      supplyChain: supplyChain.findings,
      privacyControlSummary: dataFlow.summary,
      securityLimitations: securityScan.limitations
    },
    fixes: [
      'Added durable scripts for each assurance category and one aggregate offline command.',
      'Made the deterministic aggregate the CI and pre-push release gate without repeating category test suites.',
      'Separated structural offline release/infrastructure checks from live post-deploy operations.',
      'Updated deterministic demo smoke assertions to match the current patient-visible saved-demo and export-blocking language.',
      'Added a behavioral regression that executes the local no-spend demo smoke.',
      'Mapped the demo-readiness API route into hostile-origin assurance coverage.',
      'Repaired the privacy data-flow detector and regression for capability-token cross-user access controls.'
    ],
    unresolvedExternalBlockers: [
      'No deployed-edge request-smuggling or cache-key behavior was exercised offline.',
      'No production credentials, persistent Redis, email delivery, monitoring webhook, live citations, deployed SHA, or production routes were validated.',
      'SSO/SAML/OIDC is not implemented and was not claimed or tested.',
      'Clinician/physician fixture checks do not replace independent human medical review.'
    ]
  };

  if (!requestedCategory) {
    await writeFile(
      path.join(VERIFY_DIR, 'assurance-final.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  if (failures.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`Assurance orchestration failed: ${error?.message || error}`);
  process.exitCode = 1;
});
