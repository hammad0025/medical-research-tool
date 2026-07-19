#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const posix = (value) => value.split(sep).join('/');

export function createMockResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    send(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    end(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    snapshot() {
      return { statusCode: this.statusCode, body: this.body, headers: Object.fromEntries(headers), ended: this.ended };
    }
  };
}

function request({ method, origin, body, headers = {}, query = {} }) {
  return {
    method,
    headers: {
      host: 'assurance.local',
      'x-forwarded-host': 'assurance.local',
      ...(origin ? { origin } : {}),
      ...headers
    },
    query,
    body,
    url: '/assurance-scan',
    socket: { remoteAddress: '127.0.0.1' }
  };
}

async function invoke(handler, req, timeoutMs) {
  const res = createMockResponse();
  let timer;
  try {
    await Promise.race([
      Promise.resolve(handler(req, res)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`handler exceeded ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return { ...res.snapshot(), error: null };
  } catch (error) {
    return { ...res.snapshot(), error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function apiFiles(root) {
  try {
    return (await readdir(join(root, 'api'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => join(root, 'api', entry.name))
      .sort();
  } catch {
    return [];
  }
}

function finding(ruleId, severity, category, file, message, evidence) {
  return { ruleId, severity, category, file, message, evidence };
}

export async function runDynamicScan({
  root = process.cwd(),
  routeFiles,
  timeoutMs = 750
} = {}) {
  root = resolve(root);
  const files = routeFiles?.map((file) => resolve(root, file)) || await apiFiles(root);
  const findings = [];
  const checks = [];
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    MRT_ACCESS_PASSCODE: process.env.MRT_ACCESS_PASSCODE,
    MRT_TERMS_SIGNING_SECRET: process.env.MRT_TERMS_SIGNING_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    MRT_ALLOWED_ORIGINS: process.env.MRT_ALLOWED_ORIGINS
  };
  const fetchCalls = [];
  globalThis.fetch = async (...args) => {
    fetchCalls.push(String(args[0]));
    throw new Error('ASSURANCE_SCAN_BLOCKED_NETWORK');
  };
  Object.assign(process.env, {
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    MRT_ACCESS_PASSCODE: 'assurance-secret-not-supplied',
    MRT_TERMS_SIGNING_SECRET: 'assurance-terms-secret-not-supplied',
    CRON_SECRET: 'assurance-cron-secret-not-supplied',
    MRT_ALLOWED_ORIGINS: 'https://assurance.local'
  });

  try {
    for (const path of files) {
      const file = posix(relative(root, path));
      const routeName = file.split('/').pop().replace(/\.js$/, '');
      let handler;
      try {
        const module = await import(`${pathToFileURL(path).href}?assurance=${Date.now()}-${encodeURIComponent(file)}`);
        handler = module.default;
        if (typeof handler !== 'function') throw new Error('default export is not a function');
      } catch (error) {
        findings.push(finding('dynamic-route-import', 'high', 'dynamic-load', file,
          'Route could not be imported in the isolated scan harness.', error?.message || String(error)));
        checks.push({ file, import: 'failed' });
        continue;
      }

      const beforeCrossOrigin = fetchCalls.length;
      const crossOrigin = await invoke(handler, request({
        method: 'OPTIONS',
        origin: 'https://evil.invalid',
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type'
        }
      }), timeoutMs);
      const wildcard = crossOrigin.headers['access-control-allow-origin'] === '*';
      const reflectedEvil = crossOrigin.headers['access-control-allow-origin'] === 'https://evil.invalid';
      if (wildcard || reflectedEvil || (crossOrigin.statusCode >= 200 && crossOrigin.statusCode < 300 &&
          routeName !== 'private-static')) {
        findings.push(finding('dynamic-cross-origin-accepted', 'critical', 'cors', file,
          'A hostile cross-origin preflight was accepted.', `status=${crossOrigin.statusCode}, origin=${crossOrigin.headers['access-control-allow-origin'] || 'unset'}`));
      }
      if (fetchCalls.length !== beforeCrossOrigin) {
        findings.push(finding('dynamic-preflight-side-effect', 'critical', 'side-effect', file,
          'Cross-origin preflight attempted outbound network activity.', fetchCalls.at(-1)));
      }

      const beforeUnauthenticated = fetchCalls.length;
      const unauthenticated = await invoke(handler, request({
        method: routeName === 'health' ? 'GET' : 'POST',
        body: Object.create(null)
      }), timeoutMs);
      const intentionallyPublic = routeName === 'access-session' || routeName === 'private-static';
      if (!intentionallyPublic && unauthenticated.statusCode >= 200 && unauthenticated.statusCode < 300) {
        findings.push(finding('dynamic-unauthenticated-accepted', 'critical', 'access-control', file,
          'Production-mode request without credentials was accepted.', `status=${unauthenticated.statusCode}`));
      }
      if (fetchCalls.length !== beforeUnauthenticated) {
        findings.push(finding('dynamic-unauthenticated-side-effect', 'critical', 'side-effect', file,
          'Unauthenticated request attempted outbound network activity.', fetchCalls.at(-1)));
      }

      const unsupported = await invoke(handler, request({ method: 'TRACE' }), timeoutMs);
      if (unsupported.statusCode >= 200 && unsupported.statusCode < 300) {
        findings.push(finding('dynamic-unsupported-method-accepted', 'high', 'method-control', file,
          'TRACE received a successful response.', `status=${unsupported.statusCode}`));
      }

      for (const result of [crossOrigin, unauthenticated, unsupported]) {
        const cookie = result.headers['set-cookie'];
        const values = Array.isArray(cookie) ? cookie : cookie ? [cookie] : [];
        for (const value of values) {
          if (!/HttpOnly/i.test(value) || !/Secure/i.test(value) || !/SameSite=(?:Strict|Lax)/i.test(value)) {
            findings.push(finding('dynamic-insecure-cookie', 'high', 'cookie-security', file,
              'Observed cookie lacks HttpOnly, Secure, or SameSite.', String(value)));
          }
        }
        if (result.error?.includes(`exceeded ${timeoutMs}ms`)) {
          findings.push(finding('dynamic-handler-timeout', 'high', 'availability', file,
            'Handler did not terminate within the local scan deadline.', result.error));
        } else if (result.error && result.error !== 'ASSURANCE_SCAN_BLOCKED_NETWORK') {
          findings.push(finding('dynamic-handler-error', 'medium', 'error-handling', file,
            'Malformed or unauthorized probe escaped the route as an exception.', result.error));
        }
      }
      checks.push({
        file,
        import: 'ok',
        crossOrigin: { status: crossOrigin.statusCode, origin: crossOrigin.headers['access-control-allow-origin'] || null },
        unauthenticated: { status: unauthenticated.statusCode },
        unsupportedMethod: { status: unsupported.statusCode }
      });
    }
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.file.localeCompare(b.file));
  return {
    scanner: 'assurance-dynamic-scan',
    generatedAt: new Date().toISOString(),
    safety: {
      networkBlocked: true,
      localOnly: true,
      destructiveInputs: false,
      timeoutMs
    },
    summary: {
      routes: files.length,
      imported: checks.filter((check) => check.import === 'ok').length,
      findings: findings.length,
      blockedNetworkAttempts: fetchCalls.length,
      bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((severity) =>
        [severity, findings.filter((item) => item.severity === severity).length]))
    },
    checks,
    findings
  };
}

async function main() {
  const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
  const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout-ms='));
  const report = await runDynamicScan({
    root: rootArg ? rootArg.slice('--root='.length) : process.cwd(),
    timeoutMs: timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : 750
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
