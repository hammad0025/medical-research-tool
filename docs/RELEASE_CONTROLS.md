# Release controls

Repository checks fail closed, but the repository cannot configure GitHub branch protection, Vercel project settings, DNS, Resend, Upstash, or an incident-monitoring account.

## Required GitHub configuration

Protect `main` and require the `Offline regression + condition matrix` and `Production containment smoke` checks. Disable direct pushes and require reviewed pull requests.

Configure these Actions values:

- Variable `PRODUCTION_URL` — canonical `https://` production origin.
- Variable `ALERTS_EMAIL_FROM` — verified Resend sender.
- Variable `ALERTS_PUBLIC_URL` — canonical public origin.
- Secret `MRT_SMOKE_ACCESS_PASSCODE` — one production access passcode.
- Secrets `MRT_REPORT_SEAL_SECRET`, `RESEND_API_KEY`, `ALERTS_MONITOR_WEBHOOK_URL`, `CRON_SECRET`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`.

The smoke job verifies the report-completion route returns a sealed, ineligible contract for an empty report without invoking paid providers. It also waits for production to report the reviewed `${{ github.sha }}` and fails if a different deployment is live. Vercel's Git integration must deploy `main`; do not mark a release complete until this job passes.

## Required provider configuration

- Vercel: set the runtime variables documented in `.env.example`, attach `researchingmycondition.com`, and make the canonical production URL resolve to the project.
- Resend: verify the sender domain used by `ALERTS_EMAIL_FROM`.
- Monitoring: configure `ALERTS_MONITOR_WEBHOOK_URL` to a staffed destination and test its escalation policy.
- Upstash: provision persistent Redis and set both REST credentials.
- Medical review: run `npm run kb:review`; a qualified human must review every `reviewed: false` KB and record `reviewedBy` and `reviewedAt`. Automation must not create sign-off.

Run `npm run audit:prepush` before proposing a push. Post-deploy checks are intentionally separate from deterministic pre-push checks.
