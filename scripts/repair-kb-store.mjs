#!/usr/bin/env node
// Ops tool: repair the dynamic-KB index after an incident or a known bad
// write (see docs/INCIDENT_RUNBOOK.md "Repair corrupted queue, subscription,
// ledger, usage, or KB state before re-enabling jobs").
//
// repairDynamicKbStore() removes index entries that point at conditions with
// no actual stored KB record (leftover from older, non-transactional writes).
// It never touches or deletes real KB data — only stale index pointers.
//
// Run: node scripts/repair-kb-store.mjs
// Needs the same env as production (UPSTASH_REDIS_REST_URL / _TOKEN) to repair
// the real store; without them it repairs the local in-memory store, which is
// only useful for exercising the script itself.

import { repairDynamicKbStore } from '../lib/kb-store.js';

const result = await repairDynamicKbStore();
console.log(`Checked ${result.checked} dynamic-KB index entries.`);
if (result.removed.length) {
  console.log(`Removed ${result.removed.length} stale entry(ies): ${result.removed.join(', ')}`);
} else {
  console.log('No stale entries found.');
}
