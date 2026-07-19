#!/usr/bin/env node

const required = [
  'MRT_BASE_URL',
  'MRT_EXPECTED_SHA',
  'MRT_ACCESS_PASSCODE',
  'MRT_REVIEWER_TOKEN',
  'MRT_REPORT_SEAL_SECRET',
  'RESEND_API_KEY',
  'ALERTS_EMAIL_FROM',
  'ALERTS_PUBLIC_URL',
  'ALERTS_MONITOR_WEBHOOK_URL',
  'CRON_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN'
];

const missing = required.filter((name) => !String(process.env[name] || '').trim());
const failures = missing.map((name) => `${name} is required for release verification`);
if (process.env.MRT_BASE_URL && !/^https:\/\//i.test(process.env.MRT_BASE_URL)) {
  failures.push('MRT_BASE_URL must use https://');
}
if (process.env.ALERTS_PUBLIC_URL && !/^https:\/\//i.test(process.env.ALERTS_PUBLIC_URL)) {
  failures.push('ALERTS_PUBLIC_URL must use https://');
}
if (process.env.ALERTS_MONITOR_WEBHOOK_URL && !/^https:\/\//i.test(process.env.ALERTS_MONITOR_WEBHOOK_URL)) {
  failures.push('ALERTS_MONITOR_WEBHOOK_URL must use https://');
}
if (process.env.MRT_EXPECTED_SHA && !/^[a-f0-9]{40}$/i.test(process.env.MRT_EXPECTED_SHA)) {
  failures.push('MRT_EXPECTED_SHA must be the full 40-character reviewed Git SHA');
}
if (process.env.ALERTS_EMAIL_FROM && /onboarding@resend\.dev/i.test(process.env.ALERTS_EMAIL_FROM)) {
  failures.push('ALERTS_EMAIL_FROM must use a verified production sender, not onboarding@resend.dev');
}

if (failures.length) {
  console.error('Release configuration validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Release configuration variables are present and structurally valid.');
