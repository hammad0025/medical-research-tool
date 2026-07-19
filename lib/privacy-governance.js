export const RETENTION_SECONDS = Object.freeze({
  termsConsent: 180 * 24 * 60 * 60,
  accessAttempts: 15 * 60,
  alerts: 365 * 24 * 60 * 60,
  usageCounters: 45 * 24 * 60 * 60,
  usagePlan: 400 * 24 * 60 * 60,
  errorMemory: 180 * 24 * 60 * 60,
  securityAudit: 365 * 24 * 60 * 60
});

export const SERVER_DATA_INVENTORY = Object.freeze([
  Object.freeze({
    id: 'access-attempt-enforcement',
    fields: 'pseudonymous IP and network digests, failed-attempt count',
    store: 'Upstash Redis when configured; otherwise ephemeral process memory',
    retention: '15-minute rolling window',
    export: 'not user-addressable because records contain only one-way digests and aggregate network state',
    deletion: 'expires automatically; success clears the requesting IP/network counters'
  }),
  Object.freeze({
    id: 'on-demand-profile',
    fields: 'patient profile, chat context, generated report inputs',
    store: 'not written to an application database',
    retention: 'request lifetime, subject to infrastructure and processor handling',
    export: 'the report can be exported; transient request payloads cannot be reconstructed',
    deletion: 'no application record exists to delete'
  }),
  Object.freeze({
    id: 'alert-subscription',
    fields: 'email, condition, cadence, allowlisted alert context, capability tokens, delivery state',
    store: 'Upstash Redis when configured; otherwise ephemeral process memory',
    retention: 'maximum 365 days unless renewed by a new subscription',
    export: 'capability-token holder can export the owned subscription',
    deletion: 'capability-token holder can unsubscribe/delete the owned subscription'
  }),
  Object.freeze({
    id: 'usage-enforcement',
    fields: 'IP address, monthly request count, plan state',
    store: 'Upstash Redis when configured; otherwise ephemeral process memory',
    retention: 'counter 45 days; plan state 400 days and renewed when changed',
    export: 'not user-addressable because an IP can represent multiple people',
    deletion: 'not user-addressable because deleting by IP could affect other people on the same network'
  }),
  Object.freeze({
    id: 'condition-error-memory',
    fields: 'condition-scoped incorrect claim, reason, correction, source URL, timestamp',
    store: 'Upstash Redis when configured; otherwise ephemeral process memory',
    retention: 'maximum 180 days and newest 50 records per condition',
    export: 'reviewer/system operational record, not assigned to an end-user identity',
    deletion: 'not user-addressable; reviewer authorization governs global writes'
  }),
  Object.freeze({
    id: 'security-audit',
    fields: 'event ID, action, pseudonymous actor and target digests, timestamp',
    store: 'Upstash Redis when configured; otherwise ephemeral process memory',
    retention: 'maximum 365 days and bounded stream length',
    export: 'not exposed to end users because it is a security-control record',
    deletion: 'not user-addressable because selective deletion would defeat audit integrity'
  }),
  Object.freeze({
    id: 'condition-refresh-queue',
    fields: 'condition name/slug, queue time, retry/lease state, condition search log',
    store: 'Upstash Redis when configured; otherwise ephemeral process memory',
    retention: 'operational queue entries are deleted on success; dead letters and search logs are shared condition-level records',
    export: 'not assigned to an end-user identity',
    deletion: 'operator queue controls only; records contain no email, IP, profile, or capability token'
  }),
  Object.freeze({
    id: 'shared-knowledge-cache',
    fields: 'condition-level public evidence, provenance, QA state, aliases, freshness overlays',
    store: 'repository JSON and Upstash Redis when configured; otherwise ephemeral process memory',
    retention: 'shared product knowledge retained until replaced or removed by an operator',
    export: 'patient-facing reports expose the relevant sources; cache internals are not a personal-data export',
    deletion: 'operator-managed because content is shared public medical knowledge, not linked to an end user'
  })
]);

export const PUBLIC_PROVIDER_LIMITATIONS = Object.freeze([
  'The application cannot verify or enforce downstream provider retention or training practices from repository code.',
  'Provider terms, account settings, subprocessors, and policy versions must be reviewed outside this repository.',
  'Public literature, trial, and regulatory services receive condition or drug query terms needed to answer a request.'
]);
