#!/usr/bin/env node

import { TERMS_VERSION } from '../lib/terms-consent.js';

const base = String(process.env.MRT_BASE_URL || '').replace(/\/+$/, '');
const expectedSha = String(process.env.MRT_EXPECTED_SHA || '').trim();
const accessPasscode = String(process.env.MRT_ACCESS_PASSCODE || '').trim();
if (!/^https:\/\//i.test(base)) {
  console.error('MRT_BASE_URL must be an https:// deployment URL');
  process.exit(2);
}
if (!/^[a-f0-9]{40}$/i.test(expectedSha)) {
  console.error('MRT_EXPECTED_SHA must be the full reviewed Git SHA');
  process.exit(2);
}
if (!accessPasscode) {
  console.error('MRT_ACCESS_PASSCODE is required for authenticated production smoke checks');
  process.exit(2);
}

const failures = [];
const request = async (path, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`${base}${path}`, {
      redirect: 'manual',
      cache: 'no-store',
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
};
const cookieFrom = (response) => String(response.headers.get('set-cookie') || '').split(';')[0];

for (const path of [
  '/lib/access-gate.js',
  '/data/kb/ipf.json',
  '/scripts/e2e-test.mjs',
  '/docs/TERMS_OF_USE.md',
  '/.verify-runs/patient.json',
  '/tmp/'
]) {
  try {
    const response = await request(path);
    if (![401, 403, 404].includes(response.status)) {
      failures.push(`${path} exposed with HTTP ${response.status}`);
    }
  } catch (error) {
    failures.push(`${path} probe failed: ${error.message}`);
  }
}

try {
  const response = await request('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'runtime-config' })
  });
  if (response.status !== 401) {
    failures.push(`unauthenticated research request returned HTTP ${response.status}, expected 401`);
  }
} catch (error) {
  failures.push(`access-gate probe failed: ${error.message}`);
}

let accessCookie = '';
try {
  const response = await request('/api/access-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: accessPasscode })
  });
  accessCookie = cookieFrom(response);
  if (!response.ok || !accessCookie) {
    failures.push(`access-session setup returned HTTP ${response.status} without a session cookie`);
  }
} catch (error) {
  failures.push(`access-session setup failed: ${error.message}`);
}

try {
  const response = await request('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: accessCookie },
    body: JSON.stringify({ mode: 'runtime-config' })
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 428 || body?.code !== 'TERMS_ACCEPTANCE_REQUIRED') {
    failures.push(`authenticated request without consent returned HTTP ${response.status}, expected TERMS_ACCEPTANCE_REQUIRED`);
  }
} catch (error) {
  failures.push(`Terms enforcement probe failed: ${error.message}`);
}

let termsCookie = '';
try {
  const response = await request('/api/terms-consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: accessCookie },
    body: JSON.stringify({ accepted: true, termsVersion: TERMS_VERSION })
  });
  termsCookie = cookieFrom(response);
  if (!response.ok || !termsCookie) {
    failures.push(`Terms acceptance returned HTTP ${response.status} without a consent cookie`);
  }
} catch (error) {
  failures.push(`Terms acceptance probe failed: ${error.message}`);
}

const authenticatedCookies = [accessCookie, termsCookie].filter(Boolean).join('; ');

try {
  const response = await request('/api/report-completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authenticatedCookies },
    body: JSON.stringify({})
  });
  const body = await response.json().catch(() => null);
  if (
    response.status !== 409 ||
    body?.contract?.eligible !== false ||
    typeof body?.seal !== 'string' ||
    body.seal.length < 32
  ) {
    failures.push(`report-completion safe contract returned HTTP ${response.status} without a sealed ineligible contract`);
  }
} catch (error) {
  failures.push(`report-completion contract probe failed: ${error.message}`);
}

try {
  const response = await request('/');
  if (!response.ok) failures.push(`homepage returned HTTP ${response.status}`);
  const cacheControl = response.headers.get('cache-control') || '';
  if (!/no-store/i.test(cacheControl)) failures.push('homepage is missing Cache-Control: no-store');
  const csp = response.headers.get('content-security-policy') || '';
  const scriptPolicy = csp.match(/(?:^|;\s*)script-src\s+([^;]+)/)?.[1] || '';
  if (!scriptPolicy || /unsafe-inline|unsafe-eval|https?:/i.test(scriptPolicy)) {
    failures.push('homepage script-src permits inline, eval, or third-party JavaScript');
  }
  const html = await response.text();
  if (!/<script defer src="\/app\.js"><\/script>/.test(html)) {
    failures.push('homepage does not load the repository-built app.js bundle');
  }
} catch (error) {
  failures.push(`homepage probe failed: ${error.message}`);
}

try {
  const response = await request('/terms');
  const html = await response.text();
  if (!response.ok || !/Terms of Use/i.test(html)) {
    failures.push(`/terms returned HTTP ${response.status} without the Terms document`);
  }
} catch (error) {
  failures.push(`Terms route probe failed: ${error.message}`);
}

try {
  const response = await request('/api/trials', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.invalid',
      Cookie: authenticatedCookies
    },
    body: JSON.stringify({ condition: 'asthma' })
  });
  if (response.status !== 403) {
    failures.push(`foreign-origin trials request returned HTTP ${response.status}, expected 403`);
  }
} catch (error) {
  failures.push(`trials CORS probe failed: ${error.message}`);
}

if (authenticatedCookies) {
  const deadline = Date.now() + 5 * 60_000;
  let deployedSha = '';
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/health', {
        headers: { Cookie: authenticatedCookies }
      });
      lastStatus = response.status;
      const body = await response.json().catch(() => null);
      deployedSha = String(body?.deploymentSha || '');
      if (deployedSha === expectedSha) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (deployedSha !== expectedSha) {
    failures.push(`deployed SHA ${deployedSha || '(missing)'} did not match reviewed SHA ${expectedSha} (last health HTTP ${lastStatus || 'network error'})`);
  }
}

if (failures.length) {
  console.error('Post-deploy smoke failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Post-deploy smoke passed for ${base}`);
