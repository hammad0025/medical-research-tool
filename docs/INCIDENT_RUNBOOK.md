# Production incident runbook

## Stop conditions

Treat any of these as a release-blocking incident:

- Access without the configured user or cron credential
- Public access to `/lib`, `/data`, `/scripts`, `/docs`, `.verify-*`, or temporary files
- Executable model-supplied HTML or JavaScript
- Wrong-condition evidence, unsupported efficacy/safety claims, or invented citations
- Duplicate alert email, lost queue work, uncontrolled provider spend, or unhealthy dependencies reported as healthy

## Immediate response

1. Stop the active deployment and scheduled crons.
2. Promote the last known-good immutable deployment.
3. Rotate exposed passcodes, cron secrets, Redis credentials, provider keys, and email-provider keys as applicable.
4. Preserve the deployment SHA, request IDs, provider IDs, timestamps, and redacted logs.
5. Determine whether patient data, subscriber data, or provider spend was affected.
6. Do not restore traffic until `npm run audit:prepush` and the production smoke check pass from the exact replacement SHA.

## Recovery verification

```sh
npm ci
npm run audit:prepush
MRT_BASE_URL=https://replacement.example npm run smoke:postdeploy
```

Verify the deployed SHA matches the reviewed commit. Exercise the public/user/operator/cron access matrix, a wrong-condition medical fixture, a valid citation, and an intentionally unsafe citation.

## Follow-up

- Record root cause, impact window, affected records/requests, and recovery SHA.
- Add a behavioral regression that reproduces the incident.
- Repair corrupted queue, subscription, ledger, usage, or KB state before re-enabling jobs.
  For stale dynamic-KB index entries specifically (an index pointer with no
  backing record, from an older non-transactional write), run
  `npm run repair:kb-store` — it only removes dead pointers, never real data.
- Notify affected users when required by the facts and applicable obligations.
- Never resolve an incident by weakening or skipping a release gate.
