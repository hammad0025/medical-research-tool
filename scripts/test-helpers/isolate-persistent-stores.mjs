// This module must be the first import in test harnesses that load application
// stores. Store backends are selected at module-evaluation time, so removing
// credentials here guarantees tests use their in-memory implementations.
const PERSISTENT_STORE_ENV = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN'
];

for (const key of PERSISTENT_STORE_ENV) delete process.env[key];

export const isolatedPersistentStoreEnv = Object.freeze([...PERSISTENT_STORE_ENV]);
