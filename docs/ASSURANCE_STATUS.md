# Assurance status

Generated from the offline/mock/no-paid assurance run on July 18, 2026. This is repository assurance only. It is not certification, legal compliance, or production validation.

## Result

- Aggregate command: `npm run assurance:all`
- Commands: 15 total; 14 passed; 1 blocked
- Tests observed across the aggregate and standalone runners: 312 passed; 0 failed
- Code-owned failures after remediation: 0
- Deterministic release gate: blocked by required human review/sign-off for 50 medical knowledge-base files
- Evidence: `.verify-runs/assurance-final.json`
- Supporting outputs: `.verify-runs/assurance-{static,dynamic,security,data-flow,supply-chain}.json`, `.verify-runs/sbom.cyclonedx.json`, and `.verify-runs/integrity-manifest.sha256.json`

`npm test:ci` runs once inside the full aggregate. The aggregate then runs standalone category tools without repeating focused category test commands. Running an individual category executes its focused tests plus its standalone runner.

## Durable commands

- Integration and chaos: `npm run assurance:integration`
- Static analysis and coverage mapping: `npm run assurance:static`
- Local dynamic route probes: `npm run assurance:dynamic`
- Security and pentest contracts: `npm run assurance:security`
- Privacy, data flow, and AI governance: `npm run assurance:privacy`
- Supply chain, SBOM, crypto, and SHA-256 manifest: `npm run assurance:supply-chain`
- Clinician/investor fixture review: `npm run assurance:clinician`
- Demo and physician checks: `npm run assurance:demo`
- Release configuration structure: `npm run assurance:release`
- Repository pre-push policy: `npm run assurance:prepush`
- Infrastructure configuration contract: `npm run assurance:infrastructure`
- Complete deterministic aggregate: `npm run assurance:all`

The CI offline job invokes `npm run assurance:all`. Live citation probes remain scheduled/manual, and deployed-SHA/post-deploy checks remain separate from the deterministic aggregate.

## Findings

- Static scan: one low-severity duplicate-logic heuristic between `src/app.jsx` and `api/research.js`; no critical, high, or medium findings.
- Dynamic scan: 11/11 routes imported; no findings; network was blocked by the harness.
- Security scan: no findings. Request-smuggling and CDN cache-key behavior require a deployed-edge staging check.
- Privacy/data flow: 13 controls passed, 3 are partial, and 0 are gaps. Partial items are model-policy/audit provenance, reviewer decision readback, and complete per-recipient purpose/field enforcement.
- Supply chain: 0 blockers and 5 warnings. Warnings cover bounded replay windows for gather/report/session seals and fallback key reuse for gather and Terms signing.
- SSO/SAML/OIDC is not implemented; no support is claimed.

## Fixes completed

- Added category scripts and an aggregate offline orchestrator.
- Routed CI and the pre-push release gate through the deterministic aggregate.
- Added offline infrastructure verification that does not ping configured placeholders.
- Updated stale demo smoke assertions for current patient-visible saved-demo and export-blocking language.
- Added a behavioral regression that executes the no-spend local demo smoke.
- Added hostile-origin coverage for the demo-readiness API route.
- Repaired privacy data-flow detection and regression coverage for capability-token access controls.
- Added the reviewer-token requirement to release-configuration CI inputs.

## Unresolved blockers and limitations

- Human review/sign-off remains incomplete for 50 medical knowledge-base files. The pre-push gate correctly exits non-zero.
- Production credentials, Redis connectivity/persistence, email delivery, monitoring webhook delivery, live citations, deployed SHA, and production routes were not exercised.
- Deployed-edge request smuggling and cache poisoning behavior were not tested.
- Fixture-based clinician and physician checks do not replace independent human medical review.
- No paid or live model calls, commit, push, or deployment occurred.
