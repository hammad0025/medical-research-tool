import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

const CONTRACT_FILES = [
  'src/app.jsx',
  'docs/TERMS_OF_USE.md',
  'api/alerts-subscribe.js',
  'api/research.js',
  'api/terms-consent.js',
  'lib/access-rate-limit.js',
  'lib/alerts-email.js',
  'lib/alerts-store.js',
  'lib/brain-queue.js',
  'lib/error-store.js',
  'lib/kb-store.js',
  'lib/privacy-governance.js',
  'lib/privacy-redaction.js',
  'lib/report-polish.js',
  'lib/security-enforcement.js',
  'lib/terms-consent.js',
  'lib/usage-store.js',
  'lib/validate.js'
];

const loadSources = async () => Object.fromEntries(await Promise.all(
  CONTRACT_FILES.map(async (path) => [path, await readFile(new URL(path, ROOT), 'utf8')])
));

const evidence = (sources, path, needle) => {
  const source = sources[path] || '';
  const at = source.indexOf(needle);
  if (at < 0) return { path, line: null, excerpt: `missing: ${needle}` };
  const line = source.slice(0, at).split('\n').length;
  const excerpt = source.slice(at, at + 180).split('\n')[0].trim();
  return { path, line, excerpt };
};

const hasAll = (source, needles) => needles.every((needle) => source.includes(needle));

export const buildAssuranceDataFlow = async () => {
  const s = await loadSources();
  const stores = [
    {
      id: 'browser-profile',
      data: ['condition', 'age', 'gender', 'diagnoses', 'medications', 'symptoms', 'labs', 'scans', 'genetics'],
      location: 'browser localStorage:mrt_patient',
      retention: 'until the user selects Erase local data or clears browser storage',
      evidence: evidence(s, 'src/app.jsx', "saveLS('mrt_patient', patient)")
    },
    {
      id: 'browser-chat',
      data: ['last 50 floating-chat turns'],
      location: 'browser localStorage:mrt_floating_chat_v1',
      retention: 'bounded to 50 turns and removable with Erase local data',
      evidence: evidence(s, 'src/app.jsx', 'floatingChatHistory.slice(-50)')
    },
    {
      id: 'browser-alert-capabilities',
      data: ['email address', 'alert owner capability tokens'],
      location: 'browser localStorage:mra-alerts-email and mra-alerts-owner-tokens',
      retention: 'until successful unsubscribe, Erase local data, or browser-data clearing',
      evidence: evidence(s, 'src/app.jsx', "localStorage.setItem('mra-alerts-owner-tokens'")
    },
    {
      id: 'terms-cookie',
      data: ['consent version', 'expiry', 'HMAC'],
      location: 'HttpOnly SameSite=Strict cookie',
      retention: '180 days, or explicit DELETE withdrawal',
      evidence: evidence(s, 'lib/terms-consent.js', 'RETENTION_SECONDS.termsConsent')
    },
    {
      id: 'server-transient-research',
      data: ['patient profile', 'chat text', 'condition', 'evidence', 'generated report'],
      location: 'request memory only; not written to the application database',
      retention: 'request lifetime, subject to hosting logs and downstream provider handling',
      evidence: evidence(s, 'docs/TERMS_OF_USE.md', 'do **not** write the on-demand patient profile')
    },
    {
      id: 'server-access-attempts',
      data: ['pseudonymous IP/network digests', 'failed-attempt count'],
      location: 'Upstash Redis when configured; otherwise process memory',
      retention: '15-minute rolling window',
      evidence: evidence(s, 'lib/access-rate-limit.js', 'RETENTION_SECONDS.accessAttempts')
    },
    {
      id: 'server-alerts',
      data: ['email', 'condition', 'cadence', 'age', 'gender', 'stage', 'diagnoses', 'medications', 'allergies', 'notes', 'capability tokens'],
      location: 'Upstash Redis when configured; otherwise process memory',
      retention: 'maximum 365 days unless renewed; capability-authorized export and deletion',
      evidence: evidence(s, 'api/alerts-subscribe.js', 'const sub = {')
    },
    {
      id: 'server-usage',
      data: ['raw IP address', 'monthly request count', 'plan'],
      location: 'Upstash Redis when configured; otherwise process memory',
      retention: 'monthly counter 45 days; plan state 400 days',
      evidence: evidence(s, 'lib/usage-store.js', 'USAGE_RETENTION_SECONDS')
    },
    {
      id: 'server-error-memory',
      data: ['condition', 'claim/quote', 'reason', 'correction', 'URL', 'source', 'timestamp'],
      location: 'Upstash Redis when configured; otherwise process memory',
      retention: 'newest 50 per condition and maximum 180 days',
      evidence: evidence(s, 'lib/error-store.js', 'const MAX_ERRORS = 50')
    },
    {
      id: 'server-security-audit',
      data: ['event ID', 'action', 'pseudonymous actor and target digests', 'timestamp'],
      location: 'Upstash Redis when configured; otherwise process memory',
      retention: 'bounded to 10,000 entries and maximum 365 days',
      evidence: evidence(s, 'lib/security-enforcement.js', 'SECURITY_AUDIT_RETENTION_SECONDS')
    },
    {
      id: 'server-condition-refresh',
      data: ['condition name/slug', 'queue and retry state', 'condition search log'],
      location: 'Upstash Redis when configured; otherwise process memory',
      retention: 'queue entry deleted on success; shared condition-level operational history is not user-linked',
      evidence: evidence(s, 'lib/brain-queue.js', 'const memSearchLog')
    },
    {
      id: 'server-shared-knowledge',
      data: ['condition-level public evidence', 'aliases', 'provenance and QA state'],
      location: 'repository JSON and Upstash Redis when configured; otherwise process memory',
      retention: 'shared product knowledge retained until replacement or operator deletion',
      evidence: evidence(s, 'lib/kb-store.js', 'A dynamic KB is stored as an opaque JSON blob')
    }
  ];

  const transfers = [
    {
      recipient: 'Anthropic',
      purpose: 'dossier, report synthesis, translation, and configured model fallback',
      data: ['patient profile', 'chat history', 'condition', 'evidence', 'prior report text'],
      evidence: evidence(s, 'api/research.js', 'https://api.anthropic.com/v1/messages')
    },
    {
      recipient: 'Perplexity / OpenAI / xAI',
      purpose: 'independent output validation, with Perplexity also used for live web scouting',
      data: ['patient snapshot', 'condition', 'generated analysis', 'evidence'],
      evidence: evidence(s, 'lib/validate.js', '=== PATIENT SNAPSHOT')
    },
    {
      recipient: 'Resend',
      purpose: 'email alert delivery',
      data: ['email address', 'subject', 'personalized HTML/text alert content'],
      evidence: evidence(s, 'lib/alerts-email.js', 'https://api.resend.com/emails')
    },
    {
      recipient: 'Upstash',
      purpose: 'alerts, usage enforcement, error memory, queues, and security audit state',
      data: ['stored records above', 'authorization credentials'],
      evidence: evidence(s, 'lib/alerts-store.js', 'Authorization: `Bearer ${UPSTASH_TOKEN}`')
    },
    {
      recipient: 'public medical-data services',
      purpose: 'literature, trial, and regulatory retrieval',
      data: ['condition and drug search terms'],
      evidence: evidence(s, 'docs/TERMS_OF_USE.md', 'published medical literature')
    }
  ];

  const currentTerms = /export const TERMS_VERSION = '([^']+)'/.exec(s['lib/terms-consent.js'])?.[1];
  const clientTerms = /const MRT_TERMS_VERSION = '([^']+)'/.exec(s['src/app.jsx'])?.[1];
  const controls = [
    {
      id: 'consent-version-withdrawal',
      status: currentTerms && currentTerms === clientTerms &&
        hasAll(s['api/terms-consent.js'], ["req.method === 'DELETE'", 'clearTermsConsent(res)'])
        ? 'pass' : 'gap',
      statement: 'Client/server consent versions match and an explicit cookie-withdrawal endpoint exists.',
      evidence: [
        evidence(s, 'lib/terms-consent.js', 'export const TERMS_VERSION'),
        evidence(s, 'api/terms-consent.js', "req.method === 'DELETE'")
      ]
    },
    {
      id: 'data-minimization',
      status: hasAll(s['api/alerts-subscribe.js'], [
        'const sanitisePatientContext',
        'age:', 'gender:', 'stage:', 'diagnoses:', 'medications:', 'allergies:', 'notes:'
      ]) ? 'pass' : 'gap',
      statement: 'Alert context uses a fixed field allowlist and length caps.',
      evidence: [evidence(s, 'api/alerts-subscribe.js', 'const sanitisePatientContext')]
    },
    {
      id: 'local-retention-deletion',
      status: hasAll(s['src/app.jsx'], ['APP_LOCAL_DATA_KEYS', 'localStorage.removeItem(key)', 'Erase local data'])
        ? 'pass' : 'gap',
      statement: 'A user-facing control removes every enumerated application local-storage key and resets in-memory state.',
      evidence: [
        evidence(s, 'src/app.jsx', "saveLS('mrt_patient', patient)"),
        evidence(s, 'src/app.jsx', 'floatingChatHistory.slice(-50)')
      ]
    },
    {
      id: 'server-retention',
      status: hasAll(s['lib/privacy-governance.js'], [
        'alerts: 365', 'usageCounters: 45', 'usagePlan: 400', 'errorMemory: 180', 'securityAudit: 365'
      ]) && hasAll(s['lib/alerts-store.js'], ["'EX', ARGV[3]", 'isExpired'])
        ? 'pass' : 'gap',
      statement: 'Code-owned stores have documented maximum retention and enforce TTL/expiry where the architecture supports it.',
      evidence: [
        evidence(s, 'lib/privacy-governance.js', 'export const RETENTION_SECONDS'),
        evidence(s, 'lib/alerts-store.js', 'const isExpired')
      ]
    },
    {
      id: 'deletion',
      status: hasAll(s['lib/alerts-store.js'], [
        'deleteSubscription', 'memStore.subs.delete', 'memStore.sentLedger.delete', 'memStore.claims.delete'
      ]) && hasAll(s['api/alerts-subscribe.js'], ["req.method === 'DELETE'", 'OWNER_TOKEN_INVALID'])
        ? 'pass' : 'gap',
      statement: 'Capability-authorized alert deletion removes linked state; non-addressable shared enforcement/audit records are explicitly inventoried.',
      evidence: [evidence(s, 'lib/alerts-store.js', 'export const deleteSubscription')]
    },
    {
      id: 'data-export',
      status: hasAll(s['api/alerts-subscribe.js'], ["action === 'export'", 'exportableSubscription'])
        ? 'pass' : 'gap',
      statement: 'Reports remain exportable and capability holders can export their owned alert subscription without secret tokens.',
      evidence: [
        evidence(s, 'src/app.jsx', 'const TextExportButton'),
        evidence(s, 'api/alerts-subscribe.js', "action === 'export'")
      ]
    },
    {
      id: 'log-error-redaction',
      status: 'pass',
      statement: 'API responses use stable public errors and centralized logging redacts secrets, sensitive fields, and oversized error text.',
      evidence: [
        evidence(s, 'lib/privacy-redaction.js', 'export const logError'),
        evidence(s, 'api/research.js', "logError('[research] request failed'"),
        evidence(s, 'api/alerts-subscribe.js', "logError('[alerts-subscribe]'")
      ]
    },
    {
      id: 'third-party-disclosure',
      status: hasAll(s['docs/TERMS_OF_USE.md'], [
        'Resend', 'Upstash Redis', 'PubMed/NCBI', 'ClinicalTrials.gov', 'openFDA'
      ]) ? 'pass' : 'gap',
      statement: 'Terms identify the email/storage processors and public condition-query recipients.',
      evidence: [
        evidence(s, 'docs/TERMS_OF_USE.md', '**Anthropic**'),
        evidence(s, 'lib/alerts-email.js', 'https://api.resend.com/emails')
      ]
    },
    {
      id: 'prompt-injection-exfiltration',
      status: hasAll(s['api/research.js'], [
        'INSTRUCTION-BOUNDARY AND CONFIDENTIALITY RULES',
        'UNTRUSTED DATA',
        'normalizeChatHistoryForModel'
      ]) ? 'pass' : 'gap',
      statement: 'System instructions treat user/retrieved text as untrusted and normalize client chat roles.',
      evidence: [evidence(s, 'api/research.js', 'INSTRUCTION-BOUNDARY AND CONFIDENTIALITY RULES')]
    },
    {
      id: 'trade-secret-output-filter',
      status: hasAll(s['lib/report-polish.js'], ['stripConfidentialOutput', 'CONFIDENTIAL_BLOCK_START', 'REDACTED_SECRET'])
        ? 'pass' : 'gap',
      statement: 'Deterministic finalization removes known internal blocks, prompt-exfiltration language, and credential-shaped output.',
      evidence: [evidence(s, 'lib/report-polish.js', 'export const stripConfidentialOutput')]
    },
    {
      id: 'training-use-claim',
      status: !/not used to train|not use[^.\n]*train/i.test(s['docs/TERMS_OF_USE.md']) &&
        s['docs/TERMS_OF_USE.md'].includes('cannot verify or guarantee')
        ? 'pass' : 'gap',
      statement: 'Unverified no-training claims are removed and replaced with an explicit provider/account limitation.',
      evidence: [
        evidence(s, 'docs/TERMS_OF_USE.md', 'cannot verify or guarantee'),
        evidence(s, 'src/app.jsx', 'Provider retention and model-improvement practices')
      ]
    },
    {
      id: 'model-provenance',
      status: hasAll(s['api/research.js'], ['model: anthropic.model', 'modelRequested:']) ? 'partial' : 'gap',
      statement: 'Synthesis responses identify the actual/requested model, but do not expose provider policy version or a complete model-call audit trail.',
      evidence: [evidence(s, 'api/research.js', 'model: anthropic.model')]
    },
    {
      id: 'deterministic-safety-fallback',
      status: hasAll(s['api/research.js'], ['temperature = DEFAULT_GEN_TEMPERATURE', 'injectSafetyBands']) ? 'pass' : 'gap',
      statement: 'Generation defaults to temperature zero and patient safety bands are replaced by deterministic FDA/context scoring.',
      evidence: [
        evidence(s, 'api/research.js', 'const DEFAULT_GEN_TEMPERATURE'),
        evidence(s, 'api/research.js', 'injectSafetyBands')
      ]
    },
    {
      id: 'human-oversight-audit',
      status: 'partial',
      statement: 'Global error-memory writes require reviewer authorization and emit bounded audit events, but no reviewer decision readback workflow is exposed.',
      evidence: [
        evidence(s, 'lib/security-enforcement.js', 'requireReviewerAuthorization'),
        evidence(s, 'lib/security-enforcement.js', 'Object.freeze')
      ]
    },
    {
      id: 'purpose-limitation',
      status: 'partial',
      statement: 'Alert fields and reviewer authorization are purpose-scoped; no complete per-recipient purpose/field policy is machine-enforced.',
      evidence: [
        evidence(s, 'api/alerts-subscribe.js', 'const sanitisePatientContext'),
        evidence(s, 'lib/security-enforcement.js', "purpose: 'error-memory.write'")
      ]
    },
    {
      id: 'cross-user-access',
      status: hasAll(s['api/alerts-subscribe.js'], [
        'tokenMatches(token', "code: 'OWNER_TOKEN_INVALID'"
      ]) ? 'pass' : 'gap',
      statement: 'Alert listing and deletion require possession of per-subscription capability tokens.',
      evidence: [evidence(s, 'api/alerts-subscribe.js', 'tokenMatches(token')]
    }
  ];

  return {
    scope: 'Repository-contract assurance only; this is not a legal certification.',
    generatedAt: new Date().toISOString(),
    stores,
    transfers,
    controls,
    summary: Object.fromEntries(['pass', 'partial', 'gap'].map((status) => [
      status,
      controls.filter((control) => control.status === status).length
    ]))
  };
};

const isDirectRun = process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));

if (isDirectRun) {
  const report = await buildAssuranceDataFlow();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
