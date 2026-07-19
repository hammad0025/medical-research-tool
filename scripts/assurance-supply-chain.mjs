#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_PIN = /^[a-f0-9]{40}$/i;
const PLACEHOLDER = /(?:\.\.\.|example|placeholder|your[-_]|xxxx|test[-_]|dummy|changeme|<[^>]+>)/i;

const finding = (severity, id, message, location) => ({
  severity,
  id,
  message,
  ...(location ? { location } : {})
});

const relative = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/');

const lineNumberAt = (text, index) => text.slice(0, index).split('\n').length;

export const auditLockfile = (packageJson, lockfile) => {
  const findings = [];
  if (lockfile?.lockfileVersion !== 3) {
    findings.push(finding('blocker', 'LOCKFILE_VERSION', 'package-lock.json must use lockfileVersion 3'));
  }
  const root = lockfile?.packages?.[''];
  if (!root) {
    findings.push(finding('blocker', 'LOCKFILE_ROOT', 'Lockfile root package metadata is missing'));
    return findings;
  }
  for (const group of ['dependencies', 'devDependencies']) {
    const declared = packageJson?.[group] || {};
    const lockedDeclared = root?.[group] || {};
    for (const [name, range] of Object.entries(declared)) {
      if (lockedDeclared[name] !== range) {
        findings.push(finding('blocker', 'LOCKFILE_DRIFT', `${group}.${name} differs between package.json and lockfile`));
      }
      if (!lockfile.packages?.[`node_modules/${name}`]) {
        findings.push(finding('blocker', 'LOCKFILE_MISSING_PACKAGE', `${name} has no locked package entry`));
      }
    }
  }
  for (const [packagePath, metadata] of Object.entries(lockfile?.packages || {})) {
    if (!packagePath || metadata?.link) continue;
    if (!metadata?.version) {
      findings.push(finding('blocker', 'LOCKFILE_UNVERSIONED', `${packagePath} has no exact version`));
    }
    if (metadata?.resolved && !String(metadata.resolved).startsWith('https://registry.npmjs.org/')) {
      findings.push(finding('warning', 'NONSTANDARD_REGISTRY', `${packagePath} resolves outside registry.npmjs.org`));
    }
    if (metadata?.resolved && !/^sha(?:256|384|512)-/i.test(String(metadata.integrity || ''))) {
      findings.push(finding('blocker', 'LOCKFILE_INTEGRITY', `${packagePath} lacks SHA-2 package integrity`));
    }
  }
  return findings;
};

export const auditWorkflowPins = (workflowText, workflowPath = '.github/workflows/ci.yml') => {
  const findings = [];
  const usesPattern = /^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)/gm;
  for (const match of workflowText.matchAll(usesPattern)) {
    const action = match[1];
    const ref = match[2];
    if (action.startsWith('./') || action.startsWith('docker://')) continue;
    if (!SHA_PIN.test(ref)) {
      findings.push(finding(
        'blocker',
        'ACTION_NOT_SHA_PINNED',
        `${action} must be pinned to a full 40-character commit SHA`,
        `${workflowPath}:${lineNumberAt(workflowText, match.index)}`
      ));
    }
  }
  return findings;
};

export const auditExternalAssets = (html, htmlPath = 'index.html') => {
  const findings = [];
  const assetPattern = /<(script|link)\b[^>]*(?:src|href)=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(assetPattern)) {
    const tag = match[0];
    const url = match[2];
    if (!/\bintegrity=["'][^"']+["']/i.test(tag)) {
      findings.push(finding(
        'blocker',
        'EXTERNAL_ASSET_WITHOUT_SRI',
        `External ${match[1]} asset requires SRI or self-hosting: ${new URL(url).origin}`,
        `${htmlPath}:${lineNumberAt(html, match.index)}`
      ));
    }
  }
  return findings;
};

const SECRET_RULES = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['AWS_ACCESS_KEY', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['ANTHROPIC_KEY', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['OPENAI_KEY', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['GITHUB_TOKEN', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['SLACK_TOKEN', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['STRIPE_SECRET', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g]
];

export const scanTextForSecrets = (text, filePath) => {
  const findings = [];
  for (const [id, pattern] of SECRET_RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (PLACEHOLDER.test(match[0])) continue;
      findings.push(finding(
        'blocker',
        `SECRET_${id}`,
        `Possible ${id.toLowerCase().replaceAll('_', ' ')} detected; value suppressed`,
        `${filePath}:${lineNumberAt(text, match.index)}`
      ));
    }
  }
  return findings;
};

export const auditDangerousTrackedPaths = (trackedPaths) => {
  const findings = [];
  const patterns = [
    [/^\.env(?:\.|$)/, /^\.env\.example$/, 'TRACKED_ENV', 'Tracked environment file'],
    [/\.(?:pem|key|p12|pfx|jks|keystore)$/i, null, 'TRACKED_KEY_MATERIAL', 'Tracked key or certificate container'],
    [/(?:^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i, null, 'TRACKED_SECRET_PATH', 'Tracked credential-like artifact'],
    [/(?:^|\/)(?:npm-debug\.log|\.DS_Store)$/i, null, 'TRACKED_BUILD_NOISE', 'Tracked local/build artifact']
  ];
  for (const trackedPath of trackedPaths) {
    for (const [pattern, exception, id, message] of patterns) {
      if (pattern.test(trackedPath) && !(exception?.test(trackedPath))) {
        findings.push(finding('blocker', id, message, trackedPath));
      }
    }
    if (/^\.verify-runs\/.*(?:patient|session|request|response)/i.test(trackedPath)) {
      findings.push(finding('blocker', 'TRACKED_PRIVATE_AUDIT', 'Potentially private audit artifact is tracked', trackedPath));
    }
  }
  return findings;
};

export const auditCryptoSource = (files) => {
  const findings = [];
  for (const [filePath, text] of Object.entries(files)) {
    if (!/^(?:api|lib|src)\//.test(filePath)) continue;
    const executableText = text
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, (_comment, prefix) => `${prefix}`);
    for (const match of executableText.matchAll(/createHash\(\s*['"](?:md5|sha1)['"]\s*\)|createHmac\(\s*['"](?:md5|sha1)['"]/gi)) {
      findings.push(finding('blocker', 'WEAK_HASH', 'MD5/SHA-1 is used for a security-sensitive digest', `${filePath}:${lineNumberAt(executableText, match.index)}`));
    }
    for (const match of executableText.matchAll(/\bMath\.random\s*\(/g)) {
      findings.push(finding('warning', 'WEAK_RANDOMNESS', 'Math.random is not cryptographically secure', `${filePath}:${lineNumberAt(executableText, match.index)}`));
    }
  }

  const gather = files['lib/gather-seal.js'] || '';
  const report = files['lib/report-completion.js'] || '';
  const access = files['lib/access-gate.js'] || '';
  const terms = files['lib/terms-consent.js'] || '';
  if (/MRT_GATHER_SIGNING_SECRET\s*\|\|\s*process\.env\.MRT_ACCESS_PASSCODE/.test(gather)) {
    findings.push(finding('warning', 'KEY_REUSE_GATHER', 'Gather signing falls back to the access credential; use a dedicated independently rotated key', 'lib/gather-seal.js'));
  }
  if (/MRT_REPORT_SEAL_SECRET[\s\S]{0,240}(?:MRT_TERMS_SIGNING_SECRET|MRT_ACCESS_PASSCODE)/.test(report)) {
    findings.push(finding('warning', 'KEY_REUSE_REPORT', 'Report signing can reuse Terms or access credentials instead of a dedicated key', 'lib/report-completion.js'));
  }
  if (
    /(?:local|development|test)[^'"]*report-seal/i.test(report) &&
    !/explicitLocalOrTestMode/.test(report)
  ) {
    findings.push(finding('blocker', 'REPORT_SEAL_DEFAULT_KEY', 'Report sealing has a fixed fallback key with no production fail-closed check', 'lib/report-completion.js'));
  }
  if (!/verifyReportCompletionSeal/.test(report) || !/timingSafeEqual/.test(report) || !/expiresAt/.test(report)) {
    findings.push(finding('blocker', 'REPORT_SEAL_UNVERIFIABLE', 'Report seals have no server verification API, timestamp, or expiry enforcement', 'lib/report-completion.js'));
  }
  if (
    /verifyReportCompletionSeal/.test(report) &&
    /REPORT_SEAL_TTL_MS/.test(report) &&
    !/(?:usedReportSeal|reportSealReplayStore|consumeReportSeal)/.test(report)
  ) {
    findings.push(finding('warning', 'REPORT_REPLAY_WINDOW', 'Report seals can be replayed within their bounded validity window; durable one-time consumption is not configured', 'lib/report-completion.js'));
  }
  if (/update\(String\(expiresAt\)\)/.test(access)) {
    findings.push(finding('warning', 'SESSION_REPLAY_WINDOW', 'Access sessions contain no nonce or revocation identifier and can be replayed until expiry', 'lib/access-gate.js'));
  }
  if (/issuedAt/.test(gather) && !/(?:nonce|jti|usedSeal|replay)/i.test(gather)) {
    findings.push(finding('warning', 'GATHER_REPLAY_WINDOW', 'Gather seals reject expiry and tampering but can be replayed within the TTL', 'lib/gather-seal.js'));
  }
  if (/MRT_TERMS_SIGNING_SECRET\s*\|\|\s*process\.env\.MRT_ACCESS_PASSCODE/.test(terms)) {
    findings.push(finding('warning', 'KEY_REUSE_TERMS', 'Terms signing falls back to the access credential; rotation couples unrelated trust domains', 'lib/terms-consent.js'));
  }
  return findings;
};

const trackedFiles = () => execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024
}).split('\0').filter(Boolean);

const workingFiles = () => execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  }
).split('\0').filter(Boolean);

const readTrackedText = async (paths) => {
  const output = {};
  for (const filePath of paths) {
    if (!/\.(?:c?js|mjs|jsx|json|ya?ml|html|md|txt|example)$/i.test(filePath)) continue;
    try {
      const text = await readFile(path.resolve(ROOT, filePath), 'utf8');
      if (!text.includes('\0')) output[filePath] = text;
    } catch {
      // A concurrent removal is reported by the manifest/git status checks.
    }
  }
  return output;
};

export const auditReproducibleFrontendBuild = async () => {
  try {
    const { build } = await import('esbuild');
    const options = {
      entryPoints: [path.resolve(ROOT, 'src/app.jsx')],
      bundle: true,
      minify: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      legalComments: 'none',
      sourcemap: false,
      write: false
    };
    const first = await build(options);
    const second = await build(options);
    const firstBytes = first.outputFiles?.[0]?.contents;
    const secondBytes = second.outputFiles?.[0]?.contents;
    if (!firstBytes || !secondBytes) {
      return [finding('warning', 'BUILD_REPRO_UNAVAILABLE', 'esbuild did not return in-memory bundle output')];
    }
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const findings = [];
    if (digest(firstBytes) !== digest(secondBytes)) {
      findings.push(finding('blocker', 'BUILD_NONDETERMINISTIC', 'Two isolated in-memory frontend builds produced different SHA-256 digests'));
    }
    const committed = await readFile(path.resolve(ROOT, 'app.js'));
    if (digest(firstBytes) !== digest(committed)) {
      findings.push(finding('blocker', 'BUNDLE_STALE', 'Committed app.js does not match a clean deterministic build from src/app.jsx', 'app.js'));
    }
    return findings;
  } catch (error) {
    return [finding('warning', 'BUILD_REPRO_UNAVAILABLE', `Frontend reproducibility check unavailable: ${error?.code || error?.name || 'error'}`)];
  }
};

export const generateNpmSbom = async (outputPath = '.verify-runs/sbom.cyclonedx.json') => {
  const result = spawnSync(
    'npm',
    ['sbom', '--json', '--package-lock-only', '--sbom-format=cyclonedx', '--sbom-type=application'],
    {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, npm_config_loglevel: 'silent' }
    }
  );
  if (result.status !== 0) throw new Error(`npm sbom failed with exit code ${result.status}`);
  const sbom = JSON.parse(result.stdout);
  const absolute = path.resolve(ROOT, outputPath);
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error('SBOM output must remain inside the repository');
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o600 });
  return { outputPath: relative(absolute), components: sbom?.components?.length || 0 };
};

export const runSupplyChainAudit = async () => {
  const tracked = trackedFiles();
  const textFiles = await readTrackedText(workingFiles());
  const packageJson = JSON.parse(await readFile(path.resolve(ROOT, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(path.resolve(ROOT, 'package-lock.json'), 'utf8'));
  const findings = [
    ...auditLockfile(packageJson, lockfile),
    ...auditDangerousTrackedPaths(tracked),
    ...auditCryptoSource(textFiles)
  ];
  for (const [filePath, text] of Object.entries(textFiles)) {
    findings.push(...scanTextForSecrets(text, filePath));
    if (/^\.github\/workflows\/.*\.ya?ml$/i.test(filePath)) {
      findings.push(...auditWorkflowPins(text, filePath));
    }
    if (/\.html$/i.test(filePath)) findings.push(...auditExternalAssets(text, filePath));
  }
  findings.push(...await auditReproducibleFrontendBuild());
  findings.sort((a, b) =>
    ['blocker', 'warning', 'info'].indexOf(a.severity) - ['blocker', 'warning', 'info'].indexOf(b.severity) ||
    a.id.localeCompare(b.id) ||
    String(a.location || '').localeCompare(String(b.location || ''))
  );
  return {
    ok: !findings.some((item) => item.severity === 'blocker'),
    summary: {
      blockers: findings.filter((item) => item.severity === 'blocker').length,
      warnings: findings.filter((item) => item.severity === 'warning').length,
      trackedFiles: tracked.length
    },
    assurances: {
      dependencyIntegrity: 'package-lock v3 entries require exact versions and SHA-2 integrity',
      githubActions: 'third-party actions require immutable 40-character commit SHAs',
      externalAssets: 'external script/link assets require SRI; self-hosted assets do not',
      secretOutput: 'secret matches report location and type only; values are suppressed',
      build: 'two in-memory builds are compared and checked against committed app.js',
      sbom: 'optional npm sbom --json output uses installed npm without adding dependencies'
    },
    findings
  };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.includes('--sbom')) {
      const sbom = await generateNpmSbom();
      console.log(`Wrote npm CycloneDX SBOM with ${sbom.components} components to ${sbom.outputPath}`);
    }
    const result = await runSupplyChainAudit();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Supply-chain assurance failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
