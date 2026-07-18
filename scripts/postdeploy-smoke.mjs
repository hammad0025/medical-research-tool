#!/usr/bin/env node

const base = String(process.env.MRT_BASE_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//i.test(base)) {
  console.error('MRT_BASE_URL must be an https:// deployment URL');
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

try {
  const response = await request('/');
  if (!response.ok) failures.push(`homepage returned HTTP ${response.status}`);
  const cacheControl = response.headers.get('cache-control') || '';
  if (!/no-store/i.test(cacheControl)) failures.push('homepage is missing Cache-Control: no-store');
} catch (error) {
  failures.push(`homepage probe failed: ${error.message}`);
}

if (failures.length) {
  console.error('Post-deploy smoke failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Post-deploy smoke passed for ${base}`);
