# Physician demo checklist

Use only fictional profiles. This checklist covers local, mocked, no-spend verification and does not establish production readiness.

## Required commands

```sh
npm run demo:physician-check
npm run demo:smoke
```

Both commands must finish successfully. Do not provide network credentials or enable paid-model switches.

## Required checks

1. The Profile screen exposes the exact IPF, USH2A retinitis pigmentosa, and type 2 diabetes with CKD fixtures from `data/demo/golden-profiles.json`.
2. Reset clears browser profile, chat, and report state and removes access and Terms cookies without claiming to delete server alert subscriptions.
3. The default preflight makes no network or model request.
4. Every saved-report region is clearly labeled saved and not live, including the trial-list heading.
5. Report links come from the saved allowlist, open in an isolated tab, and trial links use ClinicalTrials.gov.
6. Incomplete reports are export-blocked, degraded reports remain explicitly degraded, and complete reports receive a server seal.
7. Approved treatments and research-stage or supportive-care ideas remain in separate sections.
8. Every trial row shows the eligibility-review status, unknown or missing patient facts, and the warning that recruiting or accepting does not establish personal eligibility.
9. Treatment cards preserve risk, monitoring, interaction, and patient-specific safety context.
10. Word, text, and PDF export paths require a current completion contract and server-sealed status.
11. Candidate cards include natural-language questions for the physician.
12. Follow-up prompts challenge ranking, omissions, medication interactions, urgent harms, and combination evidence.
13. Mocked provider failures are bounded, remain visibly unavailable or degraded, and route to the clearly labeled saved fallback.
14. Website copy, generated answers, API response text, reports, and exports contain none of the internal vocabulary asserted in `test/physician-demo.test.mjs`.

## Meeting-day checks

- Record browser, zoom, viewport, local SHA, and start time.
- Use a clean profile and only fictional data.
- Read the saved/not-live disclosure aloud before using fallback content.
- Open one PubMed or FDA source and one ClinicalTrials.gov source.
- Verify recruitment status is not described as personal eligibility.
- Download Word and text outputs and inspect each sealed status.
- Use print-to-PDF and inspect the saved PDF.
- Ask one ranking question, one interaction question, one omitted-treatment question, and one urgent-harm question.
- Simulate provider failure and time recovery to the saved path.
- Stop on any contradictory live/saved label, hidden eligibility uncertainty, unsafe source, unsupported claim, or export without a current server seal.
