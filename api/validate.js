// /api/validate — thin Vercel serverless wrapper around lib/validate.js.
//
// The actual validator logic lives in lib/validate.js so it can be imported
// in-process by api/research.js when a caller explicitly opts in with
// `validate: true`. This file exposes the SAME handler at an HTTP endpoint
// so the frontend can fire validation ON-DEMAND (user clicks the
// "Audit this analysis" button in the UI) instead of burning money on
// every single research run.
//
// Cost rationale (2026-04-23):
//   Previously: validator ran automatically after every research synthesis,
//               ~$0.05/run on top of the ~$0.12 Claude synthesis cost (~42%
//               cost overhead, regardless of whether the user cared).
//   Now:        validator fires only when the user clicks the button. Typical
//               adoption: ~10-20% of runs. Net saving: ~$0.04/run on average
//               across all traffic, or about $40/month at 1,000 runs.
//
// Request body (same as the in-process call):
//   {
//     analysisText:  string,          // Claude's full research output
//     evidencePack:  [pack items],    // the grounded evidence pack it was given
//     patient:       { ... },         // patient profile for context
//     condition:     string,          // convenience (falls back to patient.condition)
//     audience:      "medical" | "layperson"
//   }
//
// Response: the validator output from lib/validate.js (primary verdict +
// per-provider results + consensus).

export { default } from '../lib/validate.js';
