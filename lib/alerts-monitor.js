import { fetchWithTimeout } from './fetch-timeout.js';

export const isAlertMonitoringConfigured = () =>
  /^https:\/\//i.test(String(process.env.ALERTS_MONITOR_WEBHOOK_URL || '').trim());

export const notifyAlertFailure = async (summary = {}) => {
  const url = String(process.env.ALERTS_MONITOR_WEBHOOK_URL || '').trim();
  if (!isAlertMonitoringConfigured()) {
    return { sent: false, reason: 'ALERTS_MONITOR_WEBHOOK_URL missing' };
  }
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Medical Research Tool alert delivery failure',
      event: 'alerts_cron_failure',
      timestamp: new Date().toISOString(),
      attempted: Number(summary.attempted || 0),
      failures: Number(summary.failures || 0),
      backend: String(summary.backend || 'unknown'),
      deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null
    })
  }, { timeoutMs: 5_000, provider: 'Alert monitoring webhook' });
  if (!response.ok) throw new Error(`Alert monitoring webhook returned HTTP ${response.status}`);
  return { sent: true };
};
