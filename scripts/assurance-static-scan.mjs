#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const TEXT_ASSETS = new Set(['index.html', 'terms.html', 'vercel.json']);
const GENERATED = new Set(['app.js']);
const TEST_PATTERN = /\.test\.(?:mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.verify-runs', '.verify-screenshots', 'tmp', 'coverage', 'dist']);

const posix = (value) => value.split(sep).join('/');
const lineOf = (source, index) => source.slice(0, index).split('\n').length;
const lineCount = (source) => source === '' ? 0 : source.split(/\r?\n/).length;
const codeLineCount = (source) => source.split(/\r?\n/).filter((line) => {
  const trimmed = line.trim();
  return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') &&
    !trimmed.startsWith('/*') && !trimmed.startsWith('<!--');
}).length;

async function walk(directory, predicate = () => true) {
  const output = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path, predicate));
    else if (predicate(path)) output.push(path);
  }
  return output;
}

const readUtf8 = (path) => readFile(path, 'utf8');
const isCommentPosition = (source, index) => {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  if (source.slice(lineStart, index).trimStart().startsWith('//')) return true;
  return source.lastIndexOf('/*', index) > source.lastIndexOf('*/', index);
};

function importsFrom(source) {
  const imports = [];
  const pattern = /(?:\bimport\s*(?:[^'"]*?\sfrom\s*)?|\bexport\s+[^'"]*?\sfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  for (const match of source.matchAll(/['"]((?:\.\.?\/)[^'"]+\.(?:js|mjs|cjs|jsx|ts|tsx|json|html))['"]/g)) {
    imports.push(match[1]);
  }
  return imports;
}

function maskComments(source) {
  const chars = [...source];
  let quote = null;
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' ';
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === '/' && next === '*') {
      chars[index] = chars[index + 1] = ' ';
      index += 2;
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
        if (chars[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      if (index < chars.length) {
        chars[index] = chars[index + 1] = ' ';
        index += 1;
      }
    }
  }
  return chars.join('');
}

async function resolveImport(root, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(importer), specifier);
  const alternatives = extname(candidate)
    ? [candidate]
    : [candidate, ...[...SOURCE_EXTENSIONS].map((extension) => `${candidate}${extension}`), join(candidate, 'index.js')];
  for (const path of alternatives) {
    try {
      if ((await stat(path)).isFile()) return posix(relative(root, path));
    } catch {
      // Not a local file.
    }
  }
  return null;
}

function routeMethods(source) {
  const methods = new Set();
  for (const match of source.matchAll(/req\.method\s*(?:===|!==)\s*['"]([A-Z]+)['"]/g)) methods.add(match[1]);
  for (const match of source.matchAll(/\[['"]([A-Z]+)['"](?:\s*,\s*['"]([A-Z]+)['"])*\]\.includes\(req\.method\)/g)) {
    for (const method of match[0].match(/['"]([A-Z]+)['"]/g) || []) methods.add(method.slice(1, -1));
  }
  methods.delete('OPTIONS');
  return [...methods].sort();
}

function addFinding(findings, ruleId, severity, category, file, source, match, message) {
  findings.push({
    ruleId,
    severity,
    category,
    file,
    line: lineOf(source, match.index),
    message,
    evidence: String(match[0]).replace(/\s+/g, ' ').slice(0, 180)
  });
}

function isSanitizedHtmlSink(source, match) {
  const context = source.slice(Math.max(0, match.index - 2200), match.index + 500);
  if (/(?:sanitizeReportHtml|sanitizeRenderedHtml)\s*\(/.test(context)) return true;
  const assignment = source.slice(match.index, match.index + 300)
    .match(/(?:innerHTML\s*=\s*|__html\s*:\s*)([A-Za-z_$][\w$]*)\s*\(/);
  if (!assignment) return false;
  const definition = source.search(new RegExp(`(?:const|function)\\s+${assignment[1]}\\b`));
  return definition >= 0 &&
    /(?:sanitizeReportHtml|sanitizeRenderedHtml)\s*\(/.test(source.slice(definition, definition + 2500));
}

function isFixedHostExpression(source, expression, index) {
  const identifier = /^[A-Za-z_$][\w$]*$/.test(expression) ? expression : null;
  if (identifier) {
    const constant = new RegExp(`const\\s+${identifier}\\s*=\\s*['"]https:\\/\\/[^'"]+['"]`);
    if (constant.test(source)) return true;
    const fixedBuilder = new RegExp(
      `const\\s+${identifier}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\`https:\\/\\/[^\\n]+\\$\\{encodeURIComponent`
    );
    if (fixedBuilder.test(source)) return true;
    const context = source.slice(Math.max(0, index - 900), index);
    const base = context.match(new RegExp(`const\\s+${identifier}\\s*=\\s*\`\\$\\{([A-Z][A-Z0-9_]*)\\}`))?.[1];
    if (base && new RegExp(`const\\s+${base}\\s*=\\s*['"]https:\\/\\/[^'"]+['"]`).test(source)) return true;
  }
  return false;
}

function scanPatterns(file, source, findings) {
  const code = maskComments(source);
  const patterns = [
    ['unsafe-html-sink', 'high', 'unsafe-sink', /(?:dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\()/g,
      'Raw HTML sink requires a proven sanitization boundary.'],
    ['dynamic-code-execution', 'critical', 'code-execution', /(?<![\w$.])eval\s*\(|new\s+Function\s*\(/g,
      'Dynamic code execution can turn untrusted text into executable code.'],
    ['child-process-runtime', 'high', 'code-execution', /(?:node:child_process|from\s*['"]child_process['"]|require\s*\(\s*['"]child_process['"]\s*\))/g,
      'Production runtime imports child_process; verify inputs cannot influence commands.'],
    ['weak-cryptography', 'high', 'cryptography', /createHash\s*\(\s*['"](?:md5|sha1)['"]|createHmac\s*\(\s*['"](?:md5|sha1)['"]|crypto\.createCipher\s*\(/gi,
      'Weak or deprecated cryptography is used.'],
    ['wildcard-cors', 'critical', 'cors', /Access-Control-Allow-Origin['"]?\s*,\s*['"]\*['"]|Access-Control-Allow-Origin\s*:\s*\*/gi,
      'Wildcard browser origin is unsafe for authenticated or sensitive endpoints.'],
    ['security-bypass-marker', 'medium', 'security-bypass', /\b(?:TODO|FIXME)\b[^\n]*(?:security|auth|permission|consent|cors|bypass)|\b(?:security|auth|consent)\b[^\n]*(?:TODO|FIXME|bypass)/gi,
      'Security-sensitive TODO or bypass marker requires review.'],
    ['unreachable-constant-branch', 'medium', 'unreachable-code', /\b(?:if|while)\s*\(\s*(?:false|0|null)\s*\)/g,
      'Constant-false branch appears unreachable.'],
    ['sensitive-logging', 'high', 'sensitive-logging', /console\.(?:log|info|warn|error)\s*\([^\n]*(?:req\.body|req\.headers|authorization|cookie|passcode|password|token|secret|patient|email)/gi,
      'Logging may expose credentials, patient data, or request contents.'],
    ['insecure-cookie', 'high', 'cookie-security', /Set-Cookie[\s\S]{0,240}(?=(?:\n|$))/g,
      'Cookie must include HttpOnly, Secure, and SameSite attributes.']
  ];
  for (const [ruleId, severity, category, pattern, message] of patterns) {
    const searched = ['wildcard-cors', 'insecure-cookie', 'security-bypass-marker'].includes(ruleId) ? source : code;
    for (const match of searched.matchAll(pattern)) {
      if (ruleId === 'unsafe-html-sink' &&
          (isCommentPosition(source, match.index) || isSanitizedHtmlSink(source, match))) continue;
      if (ruleId === 'insecure-cookie' &&
          /HttpOnly/i.test(match[0]) && /Secure/i.test(match[0]) && /SameSite=(?:Strict|Lax)/i.test(match[0])) continue;
      addFinding(findings, ruleId, severity, category, file, source, match, message);
    }
  }

  if (file.startsWith('api/')) {
    const isPrivateStatic = file === 'api/private-static.js';
    const isCron = /-cron\.js$/.test(file);
    const isBootstrap = file === 'api/access-session.js';
    const isConsent = file === 'api/terms-consent.js';
    if (!isPrivateStatic && !/setSameOriginCors\s*\(/.test(source)) {
      findings.push({ ruleId: 'route-missing-cors', severity: 'high', category: 'cors', file, line: 1,
        message: 'API route has no same-origin CORS enforcement.', evidence: 'export default handler' });
    }
    if (!isPrivateStatic && !isBootstrap && !isCron && !/requireAccess\s*\(/.test(source)) {
      findings.push({ ruleId: 'route-missing-auth', severity: 'critical', category: 'access-control', file, line: 1,
        message: 'Patient-facing API route has no access-control gate.', evidence: 'export default handler' });
    }
    if (!isPrivateStatic && !isBootstrap && !isConsent && !isCron && !/requireTermsConsent\s*\(/.test(source)) {
      findings.push({ ruleId: 'route-missing-terms', severity: 'high', category: 'terms-consent', file, line: 1,
        message: 'Patient-facing API route has no Terms consent gate.', evidence: 'export default handler' });
    }
    const acceptsBody = /req\.body/.test(source);
    if (acceptsBody && !/(?:requireJsonObjectBody|content-length|MAX_(?:BODY|REQUEST))/i.test(source)) {
      findings.push({ ruleId: 'route-missing-body-limit', severity: 'high', category: 'input-boundary', file, line: 1,
        message: 'Route reads a request body without an explicit byte or payload-size limit.', evidence: 'req.body' });
    }
    if (acceptsBody && !/(?:requireJsonObjectBody|typeof\s+req\.body|Array\.isArray\(req\.body\)|validate|parse[A-Z]\w*\(req\.body|schema)/.test(source)) {
      findings.push({ ruleId: 'route-missing-schema-validation', severity: 'medium', category: 'input-boundary', file, line: 1,
        message: 'Route reads a request body without a visible object/schema boundary.', evidence: 'req.body' });
    }
  }

  const boundedGlobalFetch = /window\.fetch\s*=\s*async[\s\S]{0,1800}AbortController[\s\S]{0,1800}signal\s*:\s*controller\.signal/.test(code);
  for (const match of code.matchAll(/\bfetch\s*\((?!WithTimeout)/g)) {
    if (isCommentPosition(source, match.index)) continue;
    if (boundedGlobalFetch && file.startsWith('src/')) continue;
    const nearby = code.slice(match.index, match.index + 700);
    if (!/\bsignal\s*:|AbortSignal\.timeout|AbortController/.test(nearby)) {
      addFinding(findings, 'fetch-missing-timeout', 'high', 'network-timeout', file, source, match,
        'Raw fetch has no nearby AbortSignal; use bounded timeout/cancellation.');
    }
  }

  for (const match of code.matchAll(/\bfetch(?:WithTimeout)?\s*\(\s*([A-Za-z_$][\w$]*|`[^`]*\$\{[^}]+\}[^`]*`)/g)) {
    const expression = match[1];
    if (isFixedHostExpression(source, expression, match.index)) continue;
    if (/^`https?:\/\/[^`]*\$\{/.test(expression) || /^[A-Za-z_$]/.test(expression)) {
      const context = code.slice(Math.max(0, match.index - 600), match.index + 250);
      if (/(?:req\.(?:body|query)|new URL\s*\(|URLSearchParams)/.test(context)) {
        addFinding(findings, 'unsafe-url-construction', 'medium', 'ssrf-url', file, source, match,
          'Dynamic outbound URL is near request-derived data; verify host allowlisting and encoded parameters.');
      }
    }
  }

  if (/(?:new Map|new Set|\[\])\s*\(/.test(source) && /(store|cache|queue|usage|rate.?limit)/i.test(file) &&
      !/(?:VERCEL_ENV|NODE_ENV|production|Upstash|Redis)/i.test(source)) {
    findings.push({ ruleId: 'production-memory-fallback', severity: 'high', category: 'production-state', file, line: 1,
      message: 'Stateful module appears to use process memory without an explicit production guard.', evidence: 'in-memory state' });
  }
}

function duplicateFindings(sources) {
  const fingerprints = new Map();
  const findings = [];
  for (const [file, source] of sources) {
    const lines = source.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line.length >= 8 && !line.startsWith('//') && !line.startsWith('*') && line !== '};' && line !== '}');
    for (let index = 0; index + 9 < lines.length; index += 5) {
      const block = lines.slice(index, index + 10).join('\n');
      if (block.length < 220) continue;
      const digest = createHash('sha256').update(block).digest('hex').slice(0, 16);
      const prior = fingerprints.get(digest);
      if (prior && prior.file !== file) {
        findings.push({
          ruleId: 'duplicate-logic-block',
          severity: 'low',
          category: 'duplicate-logic',
          file,
          line: 1,
          message: `Substantial code block duplicates logic in ${prior.file}.`,
          evidence: block.slice(0, 180).replace(/\s+/g, ' ')
        });
        break;
      }
      fingerprints.set(digest, { file });
    }
  }
  return findings;
}

export async function collectInventory({ root = process.cwd() } = {}) {
  root = resolve(root);
  const codeFiles = [
    ...await walk(join(root, 'api'), (path) => SOURCE_EXTENSIONS.has(extname(path))),
    ...await walk(join(root, 'lib'), (path) => SOURCE_EXTENSIONS.has(extname(path))),
    ...await walk(join(root, 'src'), (path) => SOURCE_EXTENSIONS.has(extname(path)))
  ];
  for (const asset of [...TEXT_ASSETS, ...GENERATED]) {
    const path = join(root, asset);
    try {
      if ((await stat(path)).isFile()) codeFiles.push(path);
    } catch {
      // Optional asset.
    }
  }
  const dataFiles = await walk(join(root, 'data'), (path) => extname(path) === '.json');
  const testFiles = await walk(join(root, 'test'), (path) => TEST_PATTERN.test(path));
  const sourceByFile = new Map();
  for (const path of [...codeFiles, ...testFiles]) sourceByFile.set(posix(relative(root, path)), await readUtf8(path));

  const importGraph = new Map();
  for (const path of [...codeFiles, ...testFiles]) {
    const file = posix(relative(root, path));
    const imports = [];
    for (const specifier of importsFrom(sourceByFile.get(file))) {
      const resolved = await resolveImport(root, path, specifier);
      if (resolved) imports.push(resolved);
    }
    for (const dataPath of dataFiles) {
      const dataFile = posix(relative(root, dataPath));
      if (sourceByFile.get(file).includes(dataFile.split('/').pop())) imports.push(dataFile);
    }
    importGraph.set(file, [...new Set(imports)]);
  }

  const coverage = new Map(codeFiles.map((path) => [posix(relative(root, path)), new Set()]));
  const dataCoverage = new Map(dataFiles.map((path) => [posix(relative(root, path)), new Set()]));
  for (const testPath of testFiles) {
    const testFile = posix(relative(root, testPath));
    const testSource = sourceByFile.get(testFile);
    const queue = [...(importGraph.get(testFile) || [])];
    const seen = new Set();
    while (queue.length) {
      const imported = queue.shift();
      if (seen.has(imported)) continue;
      seen.add(imported);
      if (coverage.has(imported)) coverage.get(imported).add(testFile);
      if (dataCoverage.has(imported)) dataCoverage.get(imported).add(testFile);
      queue.push(...(importGraph.get(imported) || []));
    }
    for (const dataFile of dataCoverage.keys()) {
      const base = dataFile.split('/').pop();
      if (testSource.includes(dataFile) || testSource.includes(base)) dataCoverage.get(dataFile).add(testFile);
      if (dataFile.startsWith('data/kb/') &&
          /(?:KB_DIR|data\/kb|listKbs|readdir\s*\([^)]*(?:kb|KB))/i.test(testSource)) {
        dataCoverage.get(dataFile).add(testFile);
      }
    }
  }

  const modules = [];
  for (const path of codeFiles.sort()) {
    const file = posix(relative(root, path));
    const source = sourceByFile.get(file);
    modules.push({
      file,
      kind: file.startsWith('api/') ? 'route' : file.startsWith('lib/') ? 'module' :
        file.startsWith('src/') ? 'frontend-source' : GENERATED.has(file) ? 'generated-bundle' : 'asset',
      generated: GENERATED.has(file),
      loc: { physical: lineCount(source), code: codeLineCount(source) },
      imports: importGraph.get(file) || [],
      tests: [...(coverage.get(file) || [])].sort()
    });
  }

  const data = [];
  for (const path of dataFiles.sort()) {
    const file = posix(relative(root, path));
    const source = await readUtf8(path);
    let records = null;
    try {
      const parsed = JSON.parse(source);
      records = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    } catch {
      // Invalid JSON is surfaced as a finding by scanStatic.
    }
    data.push({
      file,
      bytes: Buffer.byteLength(source),
      loc: lineCount(source),
      records,
      tests: [...(dataCoverage.get(file) || [])].sort()
    });
  }

  let vercel = {};
  try {
    vercel = JSON.parse(await readUtf8(join(root, 'vercel.json')));
  } catch {
    // Missing/invalid config is reported later.
  }
  const routes = modules.filter((module) => module.file.startsWith('api/')).map((module) => {
    const source = sourceByFile.get(module.file);
    const name = module.file.slice(4, -3);
    return {
      file: module.file,
      path: `/api/${name}`,
      methods: routeMethods(source),
      controls: {
        cors: /setSameOriginCors\s*\(/.test(source),
        access: /requireAccess\s*\(/.test(source),
        terms: /requireTermsConsent\s*\(/.test(source),
        cronAuth: /CRON_SECRET|requireCron|timingSafeEqual/.test(source),
        bodyLimit: /(?:content-length|body.{0,20}(?:limit|max)|MAX_(?:BODY|REQUEST))/i.test(source)
      },
      configured: (vercel.routes || []).some((route) =>
        route.dest === `/api/${name}` || route.dest === '/api/$1') ||
        (vercel.crons || []).some((cron) => cron.path === `/api/${name}`),
      tests: module.tests
    };
  });

  const totals = {
    modules: modules.length,
    routes: routes.length,
    dataFiles: data.length,
    physicalLoc: modules.reduce((sum, item) => sum + item.loc.physical, 0),
    codeLoc: modules.reduce((sum, item) => sum + item.loc.code, 0),
    dataLoc: data.reduce((sum, item) => sum + item.loc, 0),
    testedModules: modules.filter((item) => item.tests.length).length,
    testedDataFiles: data.filter((item) => item.tests.length).length
  };
  return { root, totals, modules, routes, data, testFiles: testFiles.map((path) => posix(relative(root, path))).sort() };
}

export async function scanStatic({ root = process.cwd() } = {}) {
  root = resolve(root);
  const inventory = await collectInventory({ root });
  const findings = [];
  const sourceEntries = [];
  for (const module of inventory.modules) {
    if (module.generated) continue;
    const source = await readUtf8(join(root, module.file));
    sourceEntries.push([module.file, source]);
    scanPatterns(module.file, source, findings);
  }
  for (const item of inventory.data) {
    try {
      JSON.parse(await readUtf8(join(root, item.file)));
    } catch (error) {
      findings.push({ ruleId: 'invalid-production-json', severity: 'high', category: 'data-integrity',
        file: item.file, line: 1, message: `Production JSON is invalid: ${error.message}`, evidence: 'JSON.parse' });
    }
  }
  findings.push(...duplicateFindings(sourceEntries));
  for (const route of inventory.routes) {
    if (!route.configured) {
      findings.push({ ruleId: 'dead-route', severity: 'medium', category: 'route-reachability',
        file: route.file, line: 1, message: `${route.path} is not reachable from deployment routing.`, evidence: route.path });
    }
  }
  for (const module of inventory.modules) {
    if (!module.tests.length && !module.generated) {
      findings.push({ ruleId: 'module-without-test-map', severity: 'low', category: 'coverage-map',
        file: module.file, line: 1, message: 'No direct or transitive test maps to this production module.', evidence: module.kind });
    }
  }
  for (const item of inventory.data) {
    if (!item.tests.length) {
      findings.push({ ruleId: 'data-without-test-map', severity: 'low', category: 'coverage-map',
        file: item.file, line: 1, message: 'No test maps to this production data file.', evidence: `${item.bytes} bytes` });
    }
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
  return {
    scanner: 'assurance-static-scan',
    generatedAt: new Date().toISOString(),
    inventory,
    summary: {
      findings: findings.length,
      bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((severity) =>
        [severity, findings.filter((finding) => finding.severity === severity).length])),
      byCategory: Object.fromEntries([...new Set(findings.map((finding) => finding.category))].sort().map((category) =>
        [category, findings.filter((finding) => finding.category === category).length]))
    },
    findings
  };
}

async function main() {
  const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : process.cwd();
  const report = await scanStatic({ root });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
