#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(path.join(ROOT, name), 'utf8');

const finding = (id, severity, title, evidence, remediation) => ({
  id, severity, title, evidence, remediation
});

export async function runAssuranceSecurityScan() {
  const apiNames = (await readdir(path.join(ROOT, 'api')))
    .filter((name) => name.endsWith('.js'))
    .sort();
  const entries = await Promise.all([
    ...apiNames.map(async (name) => [`api/${name}`, await read(`api/${name}`)]),
    ['lib/access-gate.js', await read('lib/access-gate.js')],
    ['lib/access-rate-limit.js', await read('lib/access-rate-limit.js')],
    ['lib/cors.js', await read('lib/cors.js')],
    ['lib/link-check.js', await read('lib/link-check.js')],
    ['lib/security-enforcement.js', await read('lib/security-enforcement.js')],
    ['vercel.json', await read('vercel.json')]
  ]);
  const sources = Object.fromEntries(entries);
  const allSource = Object.entries(sources)
    .filter(([name]) => name.endsWith('.js'))
    .map(([, source]) => source)
    .join('\n');
  const vercel = JSON.parse(sources['vercel.json']);
  const findings = [];
  const passes = [];

  const ordinaryApis = apiNames.filter((name) =>
    !['access-session.js', 'alerts-cron.js', 'brain-cron.js', 'private-static.js'].includes(name)
  );
  const missingAccess = ordinaryApis.filter((name) =>
    !/requireAccess\s*\(/.test(sources[`api/${name}`])
  );
  if (missingAccess.length) {
    findings.push(finding(
      'AUTH_ROUTE_COVERAGE',
      'high',
      'API routes missing access enforcement',
      missingAccess.join(', '),
      'Require the access gate before processing each ordinary API request.'
    ));
  } else {
    passes.push('All ordinary API handlers invoke requireAccess.');
  }

  const termsExempt = new Set(['access-session.js', 'terms-consent.js']);
  const missingTerms = ordinaryApis.filter((name) =>
    !termsExempt.has(name) && !/requireTermsConsent\s*\(/.test(sources[`api/${name}`])
  );
  if (missingTerms.length) {
    findings.push(finding(
      'TERMS_ROUTE_COVERAGE',
      'high',
      'API routes missing terms enforcement',
      missingTerms.join(', '),
      'Require a current server-signed terms cookie before handling the request.'
    ));
  } else {
    passes.push('Terms consent covers every applicable ordinary API handler.');
  }

  if (
    /x-forwarded-host/.test(sources['lib/cors.js']) &&
    /new URL\(origin\)\.host\.toLowerCase\(\) === requestHost\(req\)/.test(sources['lib/cors.js'])
  ) {
    findings.push(finding(
      'CORS_FORWARDED_HOST_TRUST',
      'high',
      'Origin validation trusts a forwarded host value',
      'lib/cors.js compares Origin to x-forwarded-host before host and has no required canonical origin.',
      'In production, require MRT_ALLOWED_ORIGINS or compare against a deployment-controlled canonical origin; do not derive trust from a client-reachable forwarding header.'
    ));
  } else {
    passes.push('CORS origin decisions do not trust forwarded-host headers.');
  }

  const rawErrorLeaks = Object.entries(sources)
    .filter(([name]) => name.startsWith('api/'))
    .flatMap(([name, source]) => {
      const lines = source.split('\n');
      return lines.flatMap((line, index) =>
        /(?:message|detail|error)\s*:\s*(?:e|err|error)(?:\?|\.)*\.?message/.test(line)
          ? [`${name}:${index + 1}`]
          : []
      );
    });
  if (rawErrorLeaks.length) {
    findings.push(finding(
      'RAW_ERROR_DISCLOSURE',
      'high',
      'Unhandled exception messages are returned to clients',
      rawErrorLeaks.join(', '),
      'Return stable public error codes and keep provider, storage, path, and stack details in server-side logs only.'
    ));
  } else {
    passes.push('API error responses do not serialize caught exception messages.');
  }

  if (
    /x-forwarded-for/.test(sources['lib/access-rate-limit.js']) &&
    (!/access-fail:network:/.test(sources['lib/access-rate-limit.js']) ||
      !/access-fail:global/.test(sources['lib/access-rate-limit.js']))
  ) {
    findings.push(finding(
      'DISTRIBUTED_ACCESS_GUESSING',
      'medium',
      'Access-passcode throttling is IP-only',
      'lib/access-rate-limit.js keys rejected attempts solely by the first forwarded IP.',
      'Add a global low-rate circuit breaker and a passcode/account or proof-of-work dimension while retaining the durable per-IP counter.'
    ));
  } else {
    passes.push('Anonymous access guessing is bounded by IP, network, and global counters without account keys.');
  }

  if (
    /await resolver\(host/.test(sources['lib/link-check.js']) &&
    /fetchImpl\(current/.test(sources['lib/link-check.js'])
  ) {
    findings.push(finding(
      'SSRF_DNS_REBIND_WINDOW',
      'medium',
      'URL probing has DNS validation/use separation',
      'lib/link-check.js validates resolver answers, then fetch performs a separate DNS resolution.',
      'Pin the validated public address through a controlled connector or revalidate the connected peer address; preserve redirect-by-redirect checks.'
    ));
  } else if (
    /lookup:\s*lookupPinned/.test(sources['lib/link-check.js']) &&
    /approved\.check\(remote/.test(sources['lib/link-check.js'])
  ) {
    passes.push('URL probes pin approved DNS answers and verify the connected peer address.');
  }

  if (
    sources['lib/link-check.js'].includes('parsed.hostname.toLowerCase()') &&
    sources['lib/link-check.js'].includes('if (isIP(host))') &&
    !sources['lib/link-check.js'].includes("replace(/^\\[|\\]$/g, '')")
  ) {
    findings.push(finding(
      'SSRF_IPV6_LITERAL_NORMALIZATION',
      'high',
      'Bracketed IPv6 literals skip direct IP classification',
      'Node URL.hostname retains brackets for IPv6 literals, while lib/link-check.js passes the bracketed value to isIP.',
      'Normalize URL hostname brackets before isIP/private-range classification and add loopback, link-local, ULA, and IPv4-mapped regressions.'
    ));
  } else {
    passes.push('SSRF address normalization covers bracketed and mapped IPv6 literals.');
  }

  const privateRoute = vercel.routes?.find((route) =>
    String(route.src).includes('verify-runs') && route.dest === '/api/private-static'
  );
  const catchAll = vercel.routes?.find((route) =>
    route.src === '^/.*$' && route.dest === '/api/private-static'
  );
  if (privateRoute && catchAll) {
    passes.push('Private repository paths and unknown static paths are routed to a fixed 404.');
  } else {
    findings.push(finding(
      'STATIC_EXPOSURE_ROUTING',
      'high',
      'Private or unknown static paths are not uniformly denied',
      'Expected private-prefix and final catch-all routes were not both found.',
      'Route private repository prefixes and all unknown paths to a no-store 404 handler.'
    ));
  }

  if (/(?:^|\n)\s*(?:eval|new Function)\s*\(|child_process|execFile(?:Sync)?\s*\(/.test(allSource)) {
    findings.push(finding(
      'CODE_INJECTION_SINK',
      'high',
      'Server source contains a dynamic code or shell execution sink',
      'A lexical sink pattern matched in API or library source.',
      'Remove dynamic execution or isolate it behind strict constant commands and argument allowlists.'
    ));
  } else {
    passes.push('No dynamic-code or child-process sink found in server source.');
  }

  const authProtocolRoutes = apiNames.filter((name) =>
    /(?:saml|oidc|oauth|sso|openid|login|callback)/i.test(name)
  );
  const sso = {
    applicability: 'not-implemented',
    exposedProtocolRoutes: authProtocolRoutes,
    fakeOrBypassEndpointsAbsent: authProtocolRoutes.length === 0 && !!catchAll,
    integrationRequirements: [
      'Choose and configure a real identity provider; do not emulate SAML/OIDC assertions locally.',
      'OIDC: validate issuer, audience, nonce, state, PKCE, signature algorithm, JWKS rotation, redirect URI, and token expiry.',
      'SAML: validate signature and certificate trust, issuer/audience, destination/recipient, InResponseTo, time bounds, and replay IDs.',
      'Map immutable provider subject and explicit groups to least-privilege roles; never trust client-submitted role claims.',
      'Add login CSRF, session fixation/rotation, logout, account-linking, deprovisioning, and IdP outage tests before exposing endpoints.'
    ]
  };
  if (!sso.fakeOrBypassEndpointsAbsent) {
    findings.push(finding(
      'UNEXPECTED_FEDERATED_AUTH_ROUTE',
      'high',
      'Federated-auth-like endpoint exists without a declared integration',
      authProtocolRoutes.join(', '),
      'Remove the route or complete and test a real SAML/OIDC integration.'
    ));
  } else {
    passes.push('No SSO/SAML/OIDC endpoint is exposed; integration is correctly marked not implemented.');
  }

  const limitations = [
    {
      class: 'request-smuggling',
      status: 'edge-integration-required',
      detail: 'Node handler unit tests cannot prove CDN/proxy handling of duplicate Content-Length, Transfer-Encoding, HTTP/2 downgrade, or obs-fold. Verify at the deployed edge with a non-destructive staging test.'
    },
    {
      class: 'cache-poisoning',
      status: 'edge-integration-required',
      detail: 'Static checks verify no-store API policy and Origin variance; CDN cache-key behavior still needs staging validation.'
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: 'local-offline-read-only',
    summary: {
      high: findings.filter((item) => item.severity === 'high').length,
      medium: findings.filter((item) => item.severity === 'medium').length,
      low: findings.filter((item) => item.severity === 'low').length,
      passes: passes.length
    },
    findings,
    passes,
    sso,
    limitations
  };
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const report = await runAssuranceSecurityScan();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log('Local/offline security assurance scan');
    console.log(`Findings: ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low`);
    for (const item of report.findings) {
      console.log(`- [${item.severity.toUpperCase()}] ${item.id}: ${item.title}`);
      console.log(`  Evidence: ${item.evidence}`);
      console.log(`  Remediation: ${item.remediation}`);
    }
    console.log(`SSO/SAML/OIDC: ${report.sso.applicability}; fake/bypass endpoints absent=${report.sso.fakeOrBypassEndpointsAbsent}`);
    for (const requirement of report.sso.integrationRequirements) {
      console.log(`  - ${requirement}`);
    }
    for (const item of report.limitations) {
      console.log(`- [LIMITATION] ${item.class}: ${item.detail}`);
    }
  }
  if (process.argv.includes('--strict') && report.summary.high > 0) {
    process.exitCode = 1;
  }
}
