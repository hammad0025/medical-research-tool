#!/usr/bin/env node

import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = `critical-safeguards-20260718-${process.pid}-${Date.now()}`;
const workspace = join(tmpdir(), `mrt-mutation-${runId}`);
const jsonPath = join(root, '.verify-runs', 'mutation-closure.json');
const reportPath = join(root, '.verify-runs', `mutation-closure-20260718-${process.pid}.md`);
const startedAt = new Date().toISOString();

const test = (file, pattern) => ({ file, pattern });

const mutants = [
  {
    id: 'citation-allowlist-exactness-prefix',
    control: 'citation allowlist exactness',
    file: 'lib/report-links.js',
    search: 'return normalizeReportUrlAllowlist(allowedUrls).has(canonical) ? canonical : null;',
    replace: 'return [...normalizeReportUrlAllowlist(allowedUrls)].some((allowed) => canonical.startsWith(allowed)) ? canonical : null;',
    operator: 'exact Set membership → unsafe prefix match',
    tests: [test('test/report-completion.test.mjs', 'all four report link surfaces reject unsafe and non-allowlisted URLs')]
  },
  {
    id: 'disease-contamination-disabled',
    control: 'disease contamination filter',
    file: 'lib/disease-contamination.js',
    search: 'return FOREIGN_DISEASE_MARKERS.filter((m) => !m.self.test(cond));',
    replace: 'return [];',
    operator: 'active foreign-disease marker set → empty',
    tests: [test('test/output-integrity.test.mjs', 'foreign-disease rows are removed')]
  },
  {
    id: 'numeric-grounding-intervention-bypass',
    control: 'numeric/entity grounding',
    file: 'lib/grounding-gate.js',
    search: "if (![...claimInterventions].some((word) => itemInterventions.has(word))) continue;",
    replace: "if (false && ![...claimInterventions].some((word) => itemInterventions.has(word))) continue;",
    operator: 'required intervention identity check → disabled',
    tests: [test('test/assurance-property-medical-gates.test.mjs', 'grounding rejects intervention swaps')]
  },
  {
    id: 'patient-fact-invention-bypass',
    control: 'patient-fact invention gate',
    file: 'lib/report-polish.js',
    search: 'if (patientFact && !patientStatementSupported(sentence, patient, patientFact.field)) {',
    replace: 'if (false && patientFact && !patientStatementSupported(sentence, patient, patientFact.field)) {',
    operator: 'unsupported patient-fact rejection → disabled',
    tests: [test('test/clinician-investor-challenge.test.mjs', 'finalized output rejects patient facts absent')]
  },
  {
    id: 'direct-treatment-instruction-bypass',
    control: 'direct-treatment instruction gate',
    file: 'lib/report-polish.js',
    search: 'if (DIRECT_TREATMENT_RE.test(sentence)) {',
    replace: 'if (false && DIRECT_TREATMENT_RE.test(sentence)) {',
    operator: 'direct command rewrite → disabled',
    tests: [test('test/clinician-investor-challenge.test.mjs', 'every direct treatment command is naturalized')]
  },
  {
    id: 'public-language-assertion-bypass',
    control: 'public-language gate',
    file: 'lib/public-language.js',
    search: 'return assertPublicLanguage(rewritten, options);',
    replace: 'return rewritten;',
    operator: 'post-rewrite prohibited-language assertion → bypassed',
    tests: [test('test/public-language-boundary.test.mjs', 'rewriting is followed by a fail-closed prohibited-language check')]
  },
  {
    id: 'report-completion-or-eligibility',
    control: 'report completion/export seal',
    file: 'lib/report-completion.js',
    search: 'const eligible = missing.length === 0 && failed.length === 0;',
    replace: 'const eligible = missing.length === 0 || failed.length === 0;',
    operator: 'completion conjunction → disjunction',
    tests: [test('test/report-completion.test.mjs', 'empty or incomplete reports cannot be classified as full')]
  },
  {
    id: 'report-seal-signature-bypass',
    control: 'report completion/export seal',
    file: 'lib/report-completion.js',
    search: 'const ok = expected.length === supplied.length && timingSafeEqual(expected, supplied);',
    replace: 'const ok = true;',
    operator: 'HMAC verification → unconditional success',
    tests: [test('test/crypto-supply-chain-seals.test.mjs', 'report seals verify across cold starts and reject tampering')]
  },
  {
    id: 'terms-signature-bypass',
    control: 'Terms/access authentication',
    file: 'lib/terms-consent.js',
    search: 'return a.length === b.length && timingSafeEqual(a, b);',
    replace: 'return true;',
    operator: 'Terms cookie constant-time comparison → unconditional success',
    tests: [test('test/security-pentest-auth-boundaries.test.mjs', 'terms consent rejects tampering')]
  },
  {
    id: 'access-session-signature-bypass',
    control: 'Terms/access authentication',
    file: 'lib/access-gate.js',
    search: 'return left.length === right.length && timingSafeEqual(left, right);',
    replace: 'return true;',
    operator: 'access-session signature comparison → unconditional success',
    tests: [test('test/security-pentest-auth-boundaries.test.mjs', 'forged, expired, and unsigned access sessions')]
  },
  {
    id: 'brute-force-off-by-one',
    control: 'brute-force limits',
    file: 'lib/access-rate-limit.js',
    search: 'allowed: entries.every(({ value, limit }) => value.count < limit),',
    replace: 'allowed: entries.every(({ value, limit }) => value.count <= limit),',
    operator: 'limit comparison < → <=',
    tests: [test('test/access-security.test.mjs', 'access failures are blocked after five attempts')]
  },
  {
    id: 'cors-host-mismatch-accepted',
    control: 'same-origin CORS',
    file: 'lib/cors.js',
    search: 'if (!host || parsed.host.toLowerCase() !== host) return false;',
    replace: 'if (!host || false) return false;',
    operator: 'origin/Host equality rejection → disabled',
    tests: [test('test/security-pentest-input-network.test.mjs', 'CORS rejects foreign origins')]
  },
  {
    id: 'ssrf-private-literal-accepted',
    control: 'SSRF private-address checks',
    file: 'lib/link-check.js',
    search: "if (isPrivateAddress(host)) throw new Error('private probe address');",
    replace: "if (false && isPrivateAddress(host)) throw new Error('private probe address');",
    operator: 'private literal rejection → disabled',
    tests: [test('test/security-pentest-input-network.test.mjs', 'SSRF guard blocks private IPv4')]
  },
  {
    id: 'url-scheme-check-disabled',
    control: 'HTML/URL sanitization',
    file: 'lib/report-links.js',
    search: "if (!['https:', 'http:'].includes(parsed.protocol)) return null;",
    replace: "if (false && !['https:', 'http:'].includes(parsed.protocol)) return null;",
    operator: 'active URL scheme rejection → disabled',
    tests: [test('test/security-pentest-input-network.test.mjs', 'report URL and HTML boundaries reject active-content')]
  },
  {
    id: 'trial-unknown-marked-eligible',
    control: 'trial unknown eligibility',
    file: 'api/trials.js',
    search: 'eligible: false,\n    checks,',
    replace: "eligible: true,\n    checks,",
    operator: 'detailed eligibility hard false → unconditional eligible',
    tests: [test('test/trial-patient-remediation.test.mjs', 'unresolved detailed criteria produce unknown eligibility')]
  },
  {
    id: 'safety-missing-context-accepted',
    control: 'safety fail-closed context',
    file: 'lib/safety-score.js',
    search: 'if (missingContexts.length) {',
    replace: 'if (false && missingContexts.length) {',
    operator: 'missing patient safety context → ignored',
    tests: [test('test/safety-fail-closed.test.mjs', 'Low safety concern requires explicit pregnancy')]
  },
  {
    id: 'usage-atomicity-yield-injected',
    control: 'usage atomic limits',
    file: 'lib/usage-store.js',
    search: "const latest = mem.usageByMonthIp.get(memKey) || { count: 0, plan: tier };\n  const latestCount",
    replace: "const latest = mem.usageByMonthIp.get(memKey) || { count: 0, plan: tier };\n  await Promise.resolve();\n  const latestCount",
    operator: 'atomic read/check/write region → async yield inserted',
    tests: [test('test/reliability-cost.test.mjs', 'usage credit consumption is atomic under concurrency')]
  },
  {
    id: 'provider-deadline-metadata-lost',
    control: 'provider deadlines/cancellation',
    file: 'lib/fetch-timeout.js',
    search: 'controller.abort(error);',
    replace: 'controller.abort();',
    operator: 'typed deadline abort reason → generic abort',
    tests: [test('test/network-timeouts.test.mjs', 'fetchWithTimeout aborts a hanging request')]
  },
  {
    id: 'provider-upstream-cancellation-detached',
    control: 'provider deadlines/cancellation',
    file: 'lib/fetch-timeout.js',
    search: "else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });",
    replace: "else if (false) upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });",
    operator: 'caller AbortSignal propagation → detached',
    tests: [test('test/network-timeouts.test.mjs', 'fetchWithTimeout preserves caller cancellation')]
  },
  {
    id: 'saved-demo-live-label',
    control: 'saved-demo labeling',
    file: 'lib/report-completion.js',
    search: "? 'Saved example report — not live'",
    replace: "? 'Complete report'",
    operator: 'saved-demo not-live label → live-looking label',
    tests: [test('test/demo-readiness.test.mjs', 'saved demo provenance is explicit')]
  },
  {
    id: 'geography-quality-adjustment',
    control: 'geography/nationality neutrality',
    file: 'lib/evidence.js',
    search: 'export const countryAdjustment = (_a) => 0;',
    replace: 'export const countryAdjustment = (a) => a?.firstAuthorCountry ? 1 : 0;',
    operator: 'country-neutral quality adjustment → country-dependent boost',
    tests: [test('test/generated-report-semantic-remediation.test.mjs', 'country, nationality, region, and hospital reputation')]
  }
];

const cleanEnvironment = () => {
  const env = { ...process.env, CI: '1', NODE_ENV: 'test', VERCEL_ENV: '' };
  for (const key of Object.keys(env)) {
    if (
      /(?:API_KEY|AUTH_TOKEN|SECRET|UPSTASH|REDIS_REST|RESEND|PERPLEXITY|ANTHROPIC)/i.test(key) &&
      !/^NODE_/.test(key)
    ) delete env[key];
  }
  env.MRT_DISABLE_USAGE_LIMIT = '0';
  return env;
};

const runTest = ({ file, pattern }, timeoutMs = 30_000) => new Promise((resolveRun) => {
  const args = [
    '--test',
    '--test-concurrency=1',
    '--test-name-pattern',
    pattern,
    file
  ];
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolveRun({
      file,
      pattern,
      exitCode: code,
      signal,
      timedOut,
      passed: code === 0 && !timedOut,
      output: `${stdout}\n${stderr}`.trim().slice(-4000)
    });
  });
});

const lineFor = (source, needle) =>
  source.slice(0, source.indexOf(needle)).split('\n').length;

const restoreFile = async (file) => {
  await mkdir(dirname(join(workspace, file)), { recursive: true });
  await cp(join(root, file), join(workspace, file), { force: true });
};

const applyMutant = async (mutant) => {
  await restoreFile(mutant.file);
  const path = join(workspace, mutant.file);
  const source = await readFile(path, 'utf8');
  const occurrences = source.split(mutant.search).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutant.id}: expected exactly one mutation target, found ${occurrences}`);
  }
  const line = lineFor(source, mutant.search);
  await writeFile(path, source.replace(mutant.search, mutant.replace));
  return line;
};

const copyWorkspace = async () => {
  await rm(workspace, { recursive: true, force: true });
  await cp(root, workspace, {
    recursive: true,
    filter: (source) => {
      const rel = relative(root, source);
      if (!rel) return true;
      const first = rel.split(/[\\/]/)[0];
      return !['.git', '.verify-runs', 'node_modules'].includes(first);
    }
  });
  const nodeModules = join(root, 'node_modules');
  try {
    if ((await lstat(nodeModules)).isDirectory()) {
      await symlink(nodeModules, join(workspace, 'node_modules'), 'dir');
    }
  } catch {
    // The selected tests use only built-in modules and repository code.
  }
};

const uniqueTests = new Map();
for (const mutant of mutants) {
  for (const selected of mutant.tests) {
    uniqueTests.set(`${selected.file}\0${selected.pattern}`, selected);
  }
}

const main = async () => {
  await mkdir(join(root, '.verify-runs'), { recursive: true });
  await copyWorkspace();

  const baseline = [];
  for (const selected of uniqueTests.values()) {
    baseline.push(await runTest(selected));
  }
  const baselineFailures = baseline.filter((result) => !result.passed);
  const results = [];

  if (!baselineFailures.length) {
    for (const mutant of mutants) {
      const line = await applyMutant(mutant);
      const testResults = [];
      for (const selected of mutant.tests) {
        testResults.push(await runTest(selected));
      }
      const killed = testResults.some((result) => !result.passed);
      results.push({
        id: mutant.id,
        control: mutant.control,
        status: killed ? 'killed' : 'survived',
        dangerous: true,
        location: { file: mutant.file, line },
        operator: mutant.operator,
        tests: testResults.map(({ output, ...result }) => result),
        failureEvidence: killed
          ? testResults.find((result) => !result.passed)?.output || ''
          : ''
      });
      await restoreFile(mutant.file);
    }
  }

  const survivors = results.filter((result) => result.status === 'survived');
  const completedAt = new Date().toISOString();
  const artifact = {
    schemaVersion: 1,
    runId,
    startedAt,
    completedAt,
    isolation: {
      temporaryWorkspace: workspace,
      productionFilesMutated: false,
      packageJsonModified: false,
      networkPolicy: 'credentials removed; selected deterministic tests only; no live/paid calls requested'
    },
    summary: {
      controls: new Set(mutants.map((mutant) => mutant.control)).size,
      mutants: mutants.length,
      killed: results.filter((result) => result.status === 'killed').length,
      survived: survivors.length,
      baselineFailures: baselineFailures.length,
      releaseBlocking: baselineFailures.length > 0 || survivors.length > 0,
      verdict: baselineFailures.length
        ? 'INCONCLUSIVE_BASELINE_FAILURE'
        : survivors.length
          ? 'BLOCKED_SURVIVING_MUTANTS'
          : 'MUTATION_CLOSED'
    },
    baseline: baseline.map(({ output, ...result }) => result),
    baselineFailures,
    mutants: results,
    releaseBlockingTestGaps: survivors.map(({ id, control, location, operator }) => ({
      id,
      control,
      file: location.file,
      line: location.line,
      operator,
      severity: 'release-blocking'
    }))
  };

  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const report = [
    '# Critical safeguard mutation closure',
    '',
    `- Verdict: **${artifact.summary.verdict}**`,
    `- Controls exercised: ${artifact.summary.controls}`,
    `- Dangerous mutants killed: ${artifact.summary.killed}/${artifact.summary.mutants}`,
    `- Surviving mutants: ${artifact.summary.survived}`,
    `- Baseline failures: ${artifact.summary.baselineFailures}`,
    `- Isolation: temporary workspace; production files and package.json were not mutated`,
    `- Network: selected deterministic tests with provider credentials removed`,
    '',
    survivors.length
      ? '## Release-blocking test gaps'
      : '## Closure',
    '',
    survivors.length
      ? survivors.map((item) =>
          `- ${item.control}: \`${item.location.file}:${item.location.line}\` — ${item.operator}`
        ).join('\n')
      : 'Every dangerous mutant was killed by its smallest selected real test.',
    '',
    `Machine-readable evidence: \`.verify-runs/mutation-closure.json\``,
    ''
  ].join('\n');
  await writeFile(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    verdict: artifact.summary.verdict,
    killed: artifact.summary.killed,
    mutants: artifact.summary.mutants,
    survivors: artifact.summary.survived,
    baselineFailures: artifact.summary.baselineFailures,
    jsonPath,
    reportPath
  }, null, 2)}\n`);

  await rm(workspace, { recursive: true, force: true });
  if (artifact.summary.releaseBlocking) process.exitCode = 1;
};

main().catch(async (error) => {
  await mkdir(join(root, '.verify-runs'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify({
    schemaVersion: 1,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    summary: {
      verdict: 'HARNESS_ERROR',
      releaseBlocking: true
    },
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || ''
    }
  }, null, 2)}\n`);
  await rm(workspace, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
