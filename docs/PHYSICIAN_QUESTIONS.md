# Physician Questions and Product Proof

This guide is for a candid product review with physicians and healthcare investors. Answers are limited to current repository behavior. Never imply that an automated check is a clinical validation, that a saved example is live, or that a source link makes a claim medically correct.

## Before showing the product

- Use a synthetic profile from `data/demo/golden-profiles.json`; do not enter a real person's identifiers.
- Open the current Terms and state that the prototype is not HIPAA-compliant (`docs/TERMS_OF_USE.md`).
- Confirm that the deployed SHA is the reviewed SHA before calling a presentation production-ready (`scripts/demo-smoke.mjs`, `docs/RELEASE_CONTROLS.md`).
- If the live path is unavailable, load the saved example only with the visible **SAVED DEMO — NOT LIVE** label (`data/demo/saved-verified-report.json`, `test/demo-readiness.test.mjs`).
- Review the rendered interface, generated text, screenshots, and exports for professional language. Stop if any term from the prohibited-language list supplied for this review appears in visible material (`src/app.jsx`, `index.html`, `terms.html`).

## Product and clinical role

### What is this actually for?

It helps a patient, caregiver, or clinician find and organize published treatment research, regulatory labels, and clinical trials, then prepare questions for a qualified clinician. It is educational research support, not diagnosis or treatment selection.

**Show:** the disclaimer in the sticky footer, then open `/terms`.  
**Repository proof:** `docs/TERMS_OF_USE.md`, `src/app.jsx`.

### Who is the primary user?

The interface supports both lay and medical audiences. The safest near-term workflow is clinician-supervised research or patient preparation for a clinician visit, because every factual claim still requires independent verification.

**Show:** the audience selector and the **Profile** and **Research** views.  
**Repository proof:** `src/app.jsx`, `README.md`.

### What problem is the product solving?

It reduces the manual work of searching several medical sources, reconciling duplicate records, finding readable links, checking condition relevance, and organizing trial and treatment questions. The repository does not prove clinical outcomes, time savings, or product-market fit.

**Show:** source totals and access labels in **Export & Links**, then open a primary source.  
**Repository proof:** `lib/evidence.js`, `src/app.jsx`.

### What is the business model?

No validated business model is demonstrated in the repository. The software is proprietary and includes usage and spend controls, so subscription, licensed workflow, or clinician-reviewed research-service models are technically plausible. Pricing, conversion, retention, reimbursement, and acquisition economics remain unproven.

**Show:** do not show a financial claim. State the commercial hypothesis plainly.  
**Repository proof:** `package.json`, `lib/usage-store.js`, `lib/spend-controls.js`.

## Sources and claims

### Where does the medical information come from?

Condition-specific references under `data/kb/` are combined with PubMed, Europe PMC, OpenAlex, Cochrane-indexed results, openFDA/DailyMed, Unpaywall, and ClinicalTrials.gov. Perplexity can supply current web leads when configured, but those leads are not treated as equivalent to peer-reviewed literature.

**Show:** **Export & Links**, including source title, journal, year, and full-text/abstract/metadata status.  
**Repository proof:** `lib/evidence.js`, `lib/openfda.js`, `api/trials.js`.

### Does the model search the whole medical literature?

No. It queries several broad services with bounded searches and ranking. Indexing delays, query design, provider failures, rate limits, and access restrictions can omit relevant work. Incomplete trial retrieval is explicitly labeled.

**Show:** a degraded-coverage notice if available; otherwise explain that absence of a notice does not prove exhaustive retrieval.  
**Repository proof:** `lib/evidence.js`, `lib/trial-coverage.js`.

### How do you stop fabricated citations?

Clickable links must exactly match retrieved literature, a specific trial record, or a specific regulatory label. Search placeholders, unsafe schemes, invented paths, and known dead addresses are converted to plain text or removed. Document links are also checked for treatment and condition relevance when source text is available.

**Show:** open a citation beside a claim, then find the same title in **Export & Links**.  
**Repository proof:** `lib/citation-gate.js`, `lib/grounding-gate.js`, `lib/report-links.js`, `test/output-integrity.test.mjs`.

### Do you verify that the paper says what the summary claims?

The repository performs deterministic matching for source identity, condition, treatment subject, and numerical details, and may use a second AI provider for independent review. These controls can remove unsupported claims, but they are not a substitute for reading the paper.

**Show:** the independent review panel and the adjacent source link; then open the paper.  
**Repository proof:** `lib/validate.js`, `lib/grounding-gate.js`, `test/output-integrity.test.mjs`.

### What happens if a link is dead?

Definitively missing or inaccessible links are removed from clickable output. A direct ClinicalTrials.gov study link can replace a failed link only when the existing label already contains the NCT identifier. Timeouts and temporary upstream failures are not treated as proof that a source is dead.

**Show:** the link section and explain that the saved all-condition result is dated, not continuous.  
**Repository proof:** `lib/link-check.js`, `.verify-runs/link-audit/all-conditions-kb.json`.

### What does the saved link-check artifact show?

The repository artifact covers 61 condition files, 3,942 citation references, and 1,645 unique URLs; it records no banned or dead URLs at its recorded check time (`.verify-runs/link-audit/all-conditions-kb.json`). Verify its recorded date before presentation. This is a snapshot and should not be described as a current or permanent guarantee.

**Show:** `.verify-runs/link-audit/all-conditions-kb.json`.

## Unsupported statements and condition mix-ups

### Can the AI still be wrong?

Yes. The Terms explicitly say summaries can be incomplete, outdated, incorrect, or associated with unsupported citations. The controls reduce risk but do not eliminate it.

**Show:** `/terms`, under AI limitations and verification responsibility.  
**Repository proof:** `docs/TERMS_OF_USE.md`.

### What prevents a paper about another disease from appearing?

Sources are screened for the requested condition before generation. Curated records require matching condition provenance, and final text is checked again for named foreign diseases. Regression cases remove wrong-condition literature and rows.

**Show:** explain the rule; do not manufacture a live failure for the meeting.  
**Repository proof:** `lib/disease-contamination.js`, `test/output-integrity.test.mjs`.

### Why use a second AI if it can also be wrong?

It provides a different review path for disputed, unsupported, or nonexistent citations. The repository does not blindly accept that judgment: a deterministic source check can preserve a claim when the retrieved source or curated fact supports it.

**Show:** the independent review panel and, if present, a preserved source-supported claim.  
**Repository proof:** `lib/validate.js`, `lib/grounding-gate.js`.

### Can a user-submitted correction improperly influence future reports?

User-submitted flags are stored for review but do not become high-authority model instructions. Only findings produced by the validator can enter the future-run warning block, and global writes require a separate reviewer credential.

**Show:** the **Flag an error** control, while explaining that submission is not immediate medical adjudication.  
**Repository proof:** `api/research.js`, `lib/security-enforcement.js`, `test/privacy-ai-governance-ai-controls.test.mjs`.

## Safety, treatment status, and trials

### Is the safety score clinically validated?

No. It is a deterministic caution band based on matched regulatory-label content and supplied patient context. It is not a validated risk model and should not drive treatment.

**Show:** a treatment's safety notes and the source label.  
**Repository proof:** `lib/safety-score.js`, `test/safety-fail-closed.test.mjs`.

### What happens when important safety information is missing?

The band becomes **Unknown** when pregnancy, kidney, or liver context is missing, or when the label does not match the drug identity, strength, route, or formulation. Unknown must not be interpreted as safe.

**Show:** leave a material field blank in a synthetic profile and point to the resulting unknown state if using a controlled local example.  
**Repository proof:** `test/safety-fail-closed.test.mjs`, `lib/safety-score.js`.

### Does the product determine trial eligibility?

No. It removes clear age or sex mismatches and checks selected explicit criteria, but the record remains `eligible: false` with criteria described as unchecked, unavailable, unknown, or a hard mismatch. The study team must decide eligibility.

**Show:** a trial card's eligibility caution and direct ClinicalTrials.gov link.  
**Repository proof:** `api/trials.js`, `lib/demographic-gate.js`.

### What if laboratory, genetic, pregnancy, organ-function, or treatment-history data are missing?

The relevant trial check returns unknown. The product does not infer a negative genetic result, normal organ function, or non-pregnant status from a blank field.

**Show:** the **Profile** fields and a trial caution.  
**Repository proof:** `api/trials.js`, `lib/genetics.js`, `test/trial-patient-remediation.test.mjs`.

### What does “FDA-approved” mean in this interface?

Approval for one indication does not establish approval for the patient's condition. The interface separates approved treatments for the condition, drugs approved for another or unspecified indication, investigational agents, and mechanism-only ideas.

**Show:** approved treatments first, then the separate repurposing sections.  
**Repository proof:** `lib/drug-registry.js`, `lib/repurpose-quality.js`, `lib/report-polish.js`, `src/app.jsx`.

### Is a repurposing idea an off-label recommendation?

No. It is a research lead or clinician conversation topic. A mechanism-only item has no direct human evidence for the condition, and a studied item may still lack condition-specific approval, adequate efficacy evidence, or patient suitability.

**Show:** the evidence-strength badge and regulatory-status wording on an idea.  
**Repository proof:** `lib/repurpose-quality.js`, `src/app.jsx`.

### Does a DailyMed or openFDA link prove efficacy?

No. It can establish label identity, approved uses, warnings, contraindications, interactions, and formulation details. It does not establish that the drug works for a new condition.

**Show:** open the label and distinguish the labeled indication from the research rationale.  
**Repository proof:** `lib/openfda.js`, `lib/safety-score.js`.

## Privacy and governance

### Is this HIPAA-compliant?

No. The Terms explicitly say it is not HIPAA-compliant and instruct users not to enter names, dates of birth, medical record numbers, addresses, phone numbers, or other direct identifiers.

**Show:** `/terms`, under privacy.  
**Repository proof:** `docs/TERMS_OF_USE.md`.

### Where does patient information go?

The browser stores the on-demand profile and recent chat locally. During generation, profile and report context can go to Anthropic. Independent review can send context and output to Perplexity, OpenAI, or xAI. Public medical services receive search terms. Alert subscriptions can store limited context in Upstash and send email through Resend.

**Show:** the privacy explanation in `/terms`.  
**Repository proof:** `docs/TERMS_OF_USE.md`, `scripts/assurance-data-flow.mjs`.

### Is the on-demand profile stored on the application server?

The repository says it is not written to the application database; it exists for the request and in browser storage. Hosting logs and downstream processors remain outside that narrow statement.

**Show:** the on-demand versus alert-data explanation in `/terms`.  
**Repository proof:** `docs/TERMS_OF_USE.md`, `lib/privacy-governance.js`.

### Can the user erase data?

The **Erase local data** control removes enumerated application browser records and resets in-memory profile, chat, and reports. Alert subscriptions require their capability token for export or deletion. Shared security, usage, and condition-level records are not all user-addressable.

**Show:** **Erase local data**, then explain the separate alert deletion path.  
**Repository proof:** `src/app.jsx`, `api/alerts-subscribe.js`, `test/privacy-ai-governance-data-lifecycle.test.mjs`.

### Do the AI providers train on submitted data?

The repository cannot answer that. Provider terms, account settings, retention, subprocessors, and model-improvement practices are external and must be checked for the configured accounts.

**Show:** the provider limitation in `/terms`.  
**Repository proof:** `docs/TERMS_OF_USE.md`, `lib/privacy-governance.js`.

### Which AI model generated this result?

The response records the actual Anthropic model used and the requested model when they differ. The allowed fallback sequence is centrally configured. The repository does not expose a complete provider-policy history or full model-call audit trail.

**Show:** runtime metadata only if the interface presents it without secrets.  
**Repository proof:** `lib/anthropic-models.js`, `api/research.js`, `scripts/assurance-data-flow.mjs`.

## Human review and regulatory questions

### Has a physician reviewed all condition content?

No. The repository review sheet states that 50 automatically generated condition libraries remain marked `reviewed: false` (`data/kb/_REVIEW.md`). The pre-push check treats unreviewed libraries as a release failure (`scripts/prepush-audit.mjs`).

**Show:** `data/kb/_REVIEW.md` and the review check in `scripts/prepush-audit.mjs`.  
**Do not say:** that source links, curator metadata, or passing software tests equal physician approval.

### Who reviewed the IPF content?

The IPF file names Syed Hammad Haque as curator and provides a dated editorial note (`data/kb/ipf.json`). The repository does not establish the curator's clinical credentials or an independent physician sign-off, so do not imply either.

**Show:** the metadata at the top of `data/kb/ipf.json`.

### Is this clinically validated?

No clinical validation study is present. The repository has software regressions and saved verification records, which establish selected software behavior—not clinical sensitivity, specificity, safety, outcomes, or utility.

**Show:** selected tests only as software-quality evidence.  
**Repository proof:** `test/`, `.verify-runs/audit-5000/MASTER-REMEDIATION.md`.

### Is this FDA-cleared or otherwise authorized as a medical product?

The repository contains no evidence of regulatory authorization. It describes educational research support and expressly disclaims diagnosis and treatment advice. Product classification and obligations depend on intended use and claims and require qualified external review.

**Show:** `/terms`.  
**Repository proof:** `docs/TERMS_OF_USE.md`.

### Is the privacy program legally certified?

No. The repository's own data-flow review says it is not legal certification. It also marks parts of model provenance, human oversight, and purpose limitation as partial.

**Show:** the scope and partial findings in `scripts/assurance-data-flow.mjs`.  
**Repository proof:** `scripts/assurance-data-flow.mjs`, `test/privacy-ai-governance-ai-controls.test.mjs`.

## Testing, audit, and release

### What tests support these claims?

Deterministic tests cover source relevance, numerical grounding, wrong-condition removal, safety unknown states, trial screening, privacy controls, completion status, link allowlists, saved-example provenance, and release configuration. Selected tests and the local saved-example smoke completed without failure during this review; no network or paid generation was used.

**Show:** `test/output-integrity.test.mjs`, `test/safety-fail-closed.test.mjs`, `test/privacy-ai-governance-data-lifecycle.test.mjs`, `test/report-completion.test.mjs`, `test/demo-readiness.test.mjs`, and `scripts/demo-smoke.mjs`.

### Did the broad repository audit find problems?

Yes. Its 5,000 rows included 450 defects, 169 warnings or partial results, 125 externally unverifiable items, and 32 consolidated blocker causes (`.verify-runs/audit-5000/MASTER-REMEDIATION.md`). Later tests address several root causes, but the original findings remain part of the honest record.

**Show:** `.verify-runs/audit-5000/MASTER-REMEDIATION.md`.

### Does the source manifest prove the deployed product?

No. The SHA-256 manifest records file hashes for one repository snapshot. Its fixed 1970 timestamp is reproducible metadata, not a deployment time (`.verify-runs/integrity-manifest.sha256.json`). Deployment identity requires the reviewed Git SHA to match the live SHA and production checks to pass.

**Show:** `.verify-runs/integrity-manifest.sha256.json`, then `docs/RELEASE_CONTROLS.md`.  
**Repository proof:** `.verify-runs/integrity-manifest.sha256.json`, `scripts/postdeploy-smoke.mjs`.

### Is production ready right now?

That cannot be concluded from this repository review. A release requires the deterministic pre-push command, reviewed medical content, exact deployed SHA, authenticated production preflight, and post-deployment checks. External branch protection, hosting, DNS, Upstash, Resend, monitoring, and provider settings must also be verified.

**Show:** the current readiness result only if it was run against the exact deployment being presented.  
**Repository proof:** `docs/RELEASE_CONTROLS.md`, `scripts/prepush-audit.mjs`, `scripts/demo-smoke.mjs`, `scripts/postdeploy-smoke.mjs`.

## Live and saved presentation paths

### Is this result live?

If a new request completed against current services, say it is a live run and show the result timestamp and current source links. If the saved example was loaded, say: **“This is a previously saved, reviewed example; it is not a live result.”**

**Show:** the visible saved-example label and provenance.  
**Repository proof:** `data/demo/saved-verified-report.json`, `test/demo-readiness.test.mjs`.

### What happens when a provider fails?

The live route can retry within bounded limits, label incomplete coverage, return degraded output, or stop. It must not call a partial result complete. The saved example is the honest fallback for continuing a presentation.

**Show:** the completion label and, if applicable, the degraded notice.  
**Repository proof:** `lib/report-completion.js`, `lib/trial-coverage.js`, `scripts/demo-smoke.mjs`.

### Can browser code turn a partial response into a complete report?

The server assesses completion and signs the result. Required sections, fresh profile binding, trial state, current Terms, validation, citation checks, and coverage are evaluated before export. The browser verifies the signed result; incomplete reports remain blocked.

**Show:** attempt export only on a controlled incomplete fixture or point to the blocked state.  
**Repository proof:** `lib/report-completion.js`, `api/report-completion.js`, `test/report-completion.test.mjs`.

### Are saved results subject to the same export rule?

Yes. Saved provenance must include a valid generation timestamp and reviewed Git SHA, and the saved content must satisfy the same completion checks before it can receive a signed export status.

**Show:** the saved label and export control.  
**Repository proof:** `scripts/demo-smoke.mjs`, `test/demo-readiness.test.mjs`.

## Closing answer

### Why should a physician or investor care now?

The repository shows a credible direction for clinician-supervised medical research: broad retrieval, condition-aware source controls, conservative unknown states, explicit regulatory-status separation, and blocked incomplete exports. The next value-creating work is not stronger marketing language. It is qualified medical review, clinical workflow testing, measured user value, external privacy and regulatory review, and verified production operations.

**Show:** one claim with its primary source, one unknown safety or eligibility state, the Terms, and the saved-versus-live label. Those four screens communicate both utility and current limits.
