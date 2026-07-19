#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  challengeMatrixMetadata,
  clinicianInvestorChallenges
} from '../test/clinician-investor-challenge-matrix.mjs';

if (process.env.ALLOW_PAID_CALLS === '1') {
  console.error('This audit is fixture-only and refuses paid-call mode.');
  process.exit(2);
}

const counts = (field) => Object.fromEntries(
  [...new Set(clinicianInvestorChallenges.map((row) => row[field]))]
    .sort()
    .map((value) => [
      value,
      clinicianInvestorChallenges.filter((row) => row[field] === value).length
    ])
);

console.log(JSON.stringify({
  audit: 'clinician-investor-medical-safety',
  version: challengeMatrixMetadata.version,
  fixtureOnly: true,
  paidCalls: false,
  scenarios: clinicianInvestorChallenges.length,
  domains: counts('domain'),
  conditions: counts('condition'),
  invariants: counts('invariant')
}, null, 2));

const result = spawnSync(
  process.execPath,
  ['--test', 'test/clinician-investor-challenge.test.mjs'],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: 'inherit' }
);

process.exit(result.status ?? 1);
