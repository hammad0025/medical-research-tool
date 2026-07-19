# Investor demo readiness runbook

This runbook is operational guidance, not evidence that production is ready. A demo is ready only when the exact reviewed/deployed SHA passes the authenticated preflight and a human completes the rehearsal checklist.

## Commands

Deterministic local smoke (default; no network, credentials, or paid model calls):

```sh
npm run demo:smoke
```

Authenticated production preflight (explicit opt-in; probes Anthropic model metadata and Upstash, but does not generate a report):

```sh
MRT_BASE_URL=https://your-reviewed-deployment.example \
MRT_EXPECTED_SHA="$(git rev-parse HEAD)" \
MRT_DEMO_ACCESS_PASSCODE='one-operator-passcode' \
npm run demo:preflight
```

The production command fails closed on a SHA mismatch, access or current-Terms failure, missing/unavailable configured model, Upstash failure, missing report-seal secret, deterministic temperature drift, or critical-route failure. Retries are bounded to two attempts by default (`MRT_DEMO_ATTEMPTS`, maximum 3).

To deliberately add one paid production golden-profile generation after preflight, use both explicit switches with the same credentials:

```sh
MRT_DEMO_PRODUCTION=1 MRT_DEMO_ALLOW_PAID=1 \
MRT_BASE_URL=https://your-reviewed-deployment.example \
MRT_EXPECTED_SHA="$(git rev-parse HEAD)" \
MRT_DEMO_ACCESS_PASSCODE='one-operator-passcode' \
npm run demo:smoke
```

Without both switches, the smoke never requests report generation.

## Meeting-day warm-up (15–20 minutes before)

1. Confirm the working tree and reviewed commit. Do not deploy or present an unreviewed dirty build.
2. Run `npm run audit:prepush` for the reviewed commit. Medical, citation, access, SSRF/XSS, seal, or privacy failures are blockers.
3. Run authenticated `npm run demo:preflight` with the full 40-character reviewed SHA.
4. In a clean browser profile, sign in with the demo access code and accept the current Terms.
5. Use one golden profile from `data/demo/golden-profiles.json`; never enter real identifying patient data.
6. Run one live Full Report only if the meeting requires it. Confirm the UI does not say complete while any stage is failed, missing, stale, or still running.
7. Check treatment safety/interaction fields, real citation links, ClinicalTrials.gov links, the Export & Links tab, and one sealed Text or Word export.
8. Re-run the preflight immediately before screen sharing. Keep this runbook and the saved-demo recovery button available.

## Live-demo settings

- Keep `ANTHROPIC_TEMPERATURE` unset or `0`.
- Do not change the configured model, fallback chain, spend switches, or evidence gates during the meeting.
- Do not repeatedly click Run. Wait for the bounded request to finish or fail.
- A degraded server-sealed report must remain labeled degraded. An incomplete or stale report must remain export-blocked.
- The saved fallback is always labeled **SAVED DEMO — NOT LIVE**, with its generation timestamp and source SHA. Say that it is a previously prepared example.

## Recovery

1. **Transient page/network error:** retry once after 15 seconds. Do not loop.
2. **Synthesis failed after gather:** use “Retry report (skip search)” once when offered.
3. **Provider, model, Upstash, seal, Terms, access, or SHA failure:** stop the live path. Do not bypass a gate or relabel partial output as complete.
4. **Need to continue the presentation:** click “Load saved demo (not live)” and state: “This is a previously saved, reviewed example; it is not a live result.”
5. **Browser state is confusing or stale:** click “Reset demo/browser data,” confirm, sign in again, and reaccept Terms. This clears browser data and access/Terms cookies; it does not delete server alert subscriptions.
6. Record the failing stage, HTTP status/code, deployed SHA, and time after the meeting. Do not expose passcodes, API keys, cookies, or patient text in screenshots.

## Human rehearsal still required

- Visual layout on the exact presentation laptop/display and browser zoom.
- Passcode entry, current Terms acceptance, golden-profile selection, one live run, tabs, links, and export download.
- Spoken disclosure for educational use, no HIPAA, and saved-demo provenance.
- Confirmation that downloaded files open correctly and that no real patient identifiers appear.
- A timed fallback rehearsal from live failure to the saved-demo screen.

Production credentials are required only for authenticated production preflight and a deliberate live report. The local smoke and saved-fixture checks do not use them.
