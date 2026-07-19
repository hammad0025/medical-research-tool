# Physician and Investor Review

**Repository basis:** current working tree  
**Scope:** repository behavior, deterministic tests, and saved verification records only

## Bottom line

This is a research-support prototype that combines published literature, regulatory labels, clinical-trial registry data, a condition-specific reference library, and AI-generated summaries. It can help a patient, caregiver, or clinician organize questions and locate sources. It is not a diagnosis system, prescribing system, eligibility determination, medical service, or substitute for independent clinical judgment.

The strongest current product attribute is not that the AI is always correct. It is that the repository contains multiple controls designed to prevent unsupported claims, wrong-condition sources, invented links, stale exports, and unjustified safety or eligibility conclusions from being presented as settled facts. Those controls reduce risk but do not eliminate it.

The most important unresolved issue is human medical review. The repository's review sheet states that 50 automatically generated condition libraries remain marked `reviewed: false`; the release check treats any such library as a failure (`data/kb/_REVIEW.md`, `scripts/prepush-audit.mjs`). A curator name or automated source check is not the same as qualified clinical sign-off. No independent physician-review record, clinical validation study, regulatory clearance, or legal compliance opinion is present in the repository.

## What the product does

- Collects a patient-entered condition and optional context such as age, sex, diagnoses, medicines, allergies, symptoms, tests, imaging, genetics, pregnancy status, and organ function (`src/app.jsx`, `lib/patient-intake.js`).
- Searches PubMed, Europe PMC, OpenAlex, Cochrane-indexed PubMed results, openFDA, Unpaywall, ClinicalTrials.gov, and—when configured—a Perplexity web search (`lib/evidence.js`, `api/trials.js`, `lib/perplexity-search.js`).
- Combines condition-specific curated references with newly retrieved sources, removes duplicates, records whether full text, abstract, or metadata was available, and ranks sources before generation (`lib/evidence.js`).
- Uses Anthropic to generate research and repurposing summaries. It may use Perplexity, OpenAI, or xAI for independent review when configured (`api/research.js`, `lib/validate.js`, `lib/anthropic-models.js`).
- Separates treatments approved for the condition from ideas researched but not approved for that condition and from mechanism-only ideas with no direct human evidence for that condition (`lib/drug-registry.js`, `lib/repurpose-quality.js`, `lib/report-polish.js`, `src/app.jsx`).
- Retrieves ClinicalTrials.gov records and displays recruitment/access status, locations, contacts, design details, and a conservative patient-specific eligibility screen (`api/trials.js`, `lib/trial-coverage.js`).
- Allows export only after the server assesses required sections, profile freshness, Terms acceptance, source checks, and coverage. Incomplete output is blocked; degraded output remains visibly degraded (`lib/report-completion.js`, `api/report-completion.js`, `test/report-completion.test.mjs`).

## What the product does not do

- It does not diagnose, prescribe, select treatment, or create a clinician–patient relationship (`docs/TERMS_OF_USE.md`).
- It does not establish that a person is eligible for a trial. The code explicitly sets `eligible: false` and labels criteria as unchecked, unavailable, unknown, or a hard mismatch; final confirmation belongs to the study team (`api/trials.js`).
- It does not prove that every relevant publication or trial was found. Provider failures produce degraded or incomplete-coverage language (`lib/evidence.js`, `lib/trial-coverage.js`).
- It does not prove that every live link will remain available. Timeouts, rate limits, and certain trusted public hosts are handled conservatively, so a temporarily unverifiable link can remain (`lib/link-check.js`).
- It does not guarantee that AI text is accurate, current, complete, or free of unsupported statements (`docs/TERMS_OF_USE.md`).
- It does not provide HIPAA-compliant handling. The Terms tell users not to enter direct identifiers (`docs/TERMS_OF_USE.md`).
- It does not establish downstream AI-provider retention, training use, subprocessors, or account settings from repository code (`lib/privacy-governance.js`, `docs/TERMS_OF_USE.md`).
- It does not contain proof of regulatory authorization, a clinical validation study, a quality-management certification, branch-protection configuration, production-provider configuration, DNS readiness, or incident-response staffing (`docs/RELEASE_CONTROLS.md`, `.verify-runs/audit-5000/MASTER-REMEDIATION.md`).

## Intended users and business case

The interface and repository describe three practical users:

1. Patients and caregivers preparing informed questions for a clinician.
2. Clinicians performing an initial literature and trial scan before reading primary sources.
3. Research or care-navigation teams organizing published options, trial contacts, and follow-up questions.

The plausible business value is time saved in finding, organizing, and checking sources—not autonomous medical decision-making. The product could support a clinician-reviewed research service, patient-navigation workflow, specialty-clinic intake process, or licensed research tool.

The repository does not contain validated pricing, willingness-to-pay, customer acquisition cost, conversion, retention, reimbursement, market-size, clinical-outcome, or time-saved data. Any revenue or market claim would therefore be a business hypothesis, not repository evidence. The software is marked proprietary, and usage/spend controls exist, but those facts do not establish product-market fit (`package.json`, `lib/usage-store.js`, `lib/spend-controls.js`).

## How sources are selected

The practical source order is:

1. **Condition-specific curated references:** guidelines, trials, labels, and reviews stored under `data/kb/`. These receive a strong ranking preference but must still carry condition provenance (`lib/evidence.js`, `lib/disease-contamination.js`).
2. **Peer-reviewed and indexed literature:** PubMed and Cochrane-indexed results, followed by Europe PMC and OpenAlex coverage (`lib/evidence.js`).
3. **Regulatory and registry records:** openFDA/DailyMed for drug labeling and ClinicalTrials.gov for study records (`lib/openfda.js`, `api/trials.js`).
4. **Open-access copies:** Unpaywall may locate a legal open version for a high-ranked record (`lib/evidence.js`, `lib/unpaywall.js`).
5. **Current web leads:** Perplexity search results are treated as freshness leads and ranked below comparable peer-reviewed records; they do not replace source verification (`lib/evidence.js`, `lib/perplexity-search.js`).

Ranking favors journal tier, citations, recency, open access, systematic reviews, meta-analyses, randomized trials, Cochrane records, and curated references. Retractions and retraction notices are excluded before generation. Publishers on an integrity list are penalized or excluded. Country of authorship is not used as a negative ranking factor (`lib/evidence.js`).

The generator receives a bounded mixture of curated and newly retrieved material. That design avoids letting either older curated material or recent search results dominate (`lib/evidence.js`). A source with metadata only may be named, but the prompt rules do not permit claims about content that was not retrieved (`lib/evidence.js`).

## Citation and link controls

The source controls answer three separate questions:

### Does the link come from an allowed source?

Clickable report links must exactly match a URL supplied by the retrieved literature, a specific ClinicalTrials.gov study, or a specific regulatory label. Search-result placeholders, unsafe schemes, invented URL children, known dead addresses, and incomplete FDA links are removed or converted to plain text (`lib/citation-gate.js`, `lib/report-links.js`, `test/report-completion.test.mjs`, `test/output-integrity.test.mjs`).

### Does the source support the attached subject and condition?

For document links, the cited source text must mention the relevant treatment subject and the patient's condition when that can be checked. A document absent from the retrieved source index fails closed; a registry or label link can remain when the paper-specific test does not apply (`lib/grounding-gate.js`, `lib/disease-contamination.js`, `test/output-integrity.test.mjs`).

Quantitative claims require the value, unit, relevant intervention or entity, comparator when present, and time period to align within one source item. The check is intended to prevent a number from one paper and a treatment from another being combined into a new claim (`lib/grounding-gate.js`, `test/output-integrity.test.mjs`).

### Does the link resolve?

The server checks non-routine links with bounded requests. Definitive missing, gone, or inaccessible publisher pages are removed; a specific ClinicalTrials.gov replacement is permitted only when an NCT identifier is already present. Timeouts, rate limits, and server errors are treated as transient rather than proof that a valid source is dead (`lib/link-check.js`).

A repository link-check artifact reports 61 condition files, 3,942 citation references, 1,645 unique URLs, no banned URLs, and no dead URLs at the recorded check time (`.verify-runs/link-audit/all-conditions-kb.json`). Its recorded date must be verified before presentation. This saved result is not a promise that every external URL remains live.

## Controls for unsupported or wrong-condition output

- The first model is instructed to use only the retrieved sources and to say when support is absent (`api/research.js`).
- A second configured model can classify claims as supported, disputed, unsupported, or associated with a nonexistent citation (`lib/validate.js`).
- The second model is not treated as infallible. If it disputes a claim that is supported by the condition's curated facts or retrieved source text, a deterministic check can preserve the claim instead of deleting it (`lib/grounding-gate.js`).
- Unsupported hard claims are removed when no matching source exists. In a repository regression, a numerical mortality claim is deleted when the source collection is empty (`test/output-integrity.test.mjs`).
- Wrong-condition literature is removed before generation. Curated records must have matching condition provenance, and foreign-disease rows or sentences are removed from final output (`lib/disease-contamination.js`, `test/output-integrity.test.mjs`).
- User-submitted error reports are stored for review but cannot become system-level instructions for future generation. Only validator-derived records can influence future prompts (`api/research.js`, `test/privacy-ai-governance-ai-controls.test.mjs`).
- Translation is checked against a signed source-language structure so changed numbers, negation, approval status, or citations can be rejected (`lib/translation-gate.js`, `test/assurance-property-medical-gates.test.mjs`).

These are risk controls, not proof that unsupported output is impossible. The Terms still require independent verification (`docs/TERMS_OF_USE.md`).

## Safety and eligibility unknown states

The safety rating is replaced by deterministic label-and-context logic rather than accepted from model prose. A high safety band requires pregnancy, kidney, and liver context plus a matching drug identity, strength, route, and formulation. Missing context or a mismatched label produces **Unknown**, not a favorable rating (`lib/safety-score.js`, `test/safety-fail-closed.test.mjs`).

Trial screening checks age, sex, explicitly stated laboratory thresholds, organ-function language, genetics, pregnancy/breastfeeding status, and prior-treatment history when those criteria are present. Missing patient facts produce **unknown**. Clear age or sex mismatches are removed from the surfaced list. Every remaining record still says that full criteria were not reviewed and eligibility must be confirmed with the study team (`api/trials.js`, `lib/demographic-gate.js`, `test/trial-patient-remediation.test.mjs`).

Clinical meaning: **Unknown is not safe, eligible, or contraindicated.** It means the repository lacks enough matched information to make the narrower determination.

## FDA and off-label meaning

The repository distinguishes:

- **Approved for this condition:** belongs with approved treatments when supported by the condition library or label evidence.
- **Approved for another or unspecified indication:** the drug has a US approval history, but that does not establish approval, efficacy, or suitability for the patient's condition.
- **Investigational or not US-approved:** must not be called standard care.
- **Mechanism-only:** a biological rationale without direct human evidence for this condition.
- **Studied but not approved for this condition:** evidence exists, but the product must not imply FDA approval for this use.

DailyMed/openFDA material is used for label identity, warnings, contraindications, interactions, and regulatory context. It does not prove condition-specific benefit. Repurposing ideas are framed as clinician conversation topics, not prescriptions (`lib/drug-registry.js`, `lib/openfda.js`, `lib/repurpose-quality.js`, `src/app.jsx`).

## Privacy, Terms, and data movement

The current Terms version is enforced with a signed, expiring, HttpOnly, Secure, SameSite=Strict cookie. A new Terms version requires renewed acceptance, and the consent cookie can be withdrawn (`lib/terms-consent.js`, `api/terms-consent.js`, `test/privacy-ai-governance-data-lifecycle.test.mjs`).

On-demand profiles and recent chat are stored in the browser. The interface includes an **Erase local data** control that clears the application's browser records and in-memory state (`src/app.jsx`, `test/privacy-ai-governance-data-lifecycle.test.mjs`).

The application says it does not write an on-demand profile to its application database. During a request, profile, chat, condition, sources, and generated text can be sent to Anthropic. Independent review may send report text, patient context, condition, and sources to Perplexity, OpenAI, or xAI. Public medical services receive condition and drug search terms (`docs/TERMS_OF_USE.md`, `scripts/assurance-data-flow.mjs`).

Email alerts are different: email, condition, cadence, and a limited set of alert context fields can be stored in Upstash or temporary process memory and sent through Resend. Capability tokens support owned export and deletion. Other operational records include usage enforcement, condition-level error memory, security events, and shared condition knowledge, with documented retention rules (`lib/privacy-governance.js`, `api/alerts-subscribe.js`, `lib/alerts-store.js`).

The repository's own data-flow review calls itself repository-contract assurance, not legal certification. It marks model provenance, human oversight, and purpose limitation as partial rather than complete (`scripts/assurance-data-flow.mjs`, `test/privacy-ai-governance-ai-controls.test.mjs`).

## AI providers and governance

- Anthropic is the primary generator for condition classification, report synthesis, chat, and translation where configured (`api/research.js`, `lib/anthropic-models.js`).
- The default research model and fallback order are centrally allowlisted. The response records the model actually used; caller-invented model names are rejected in favor of the configured default (`lib/anthropic-models.js`, `test/privacy-ai-governance-ai-controls.test.mjs`).
- Generation defaults to temperature zero for consistency, but deterministic settings do not make an AI response clinically correct (`api/research.js`, `test/privacy-ai-governance-ai-controls.test.mjs`).
- Perplexity, OpenAI, or xAI may perform independent review, depending on configuration. Perplexity can also supply current web leads (`lib/validate.js`, `lib/perplexity-search.js`).
- Provider failures can produce degraded output or block required completion checks. Provider account policy, retention, training use, and subprocessors remain external questions (`docs/TERMS_OF_USE.md`, `lib/privacy-governance.js`).

## Test and audit evidence

A local deterministic run during this review completed without failure for the selected medical integrity, citation, safety, privacy, completion, release, and presentation-readiness tests (`test/kb-medical-integrity.test.mjs`, `test/output-integrity.test.mjs`, `test/safety-fail-closed.test.mjs`, `test/privacy-ai-governance-ai-controls.test.mjs`, `test/privacy-ai-governance-data-lifecycle.test.mjs`, `test/report-completion.test.mjs`, `test/release-controls.test.mjs`, `test/demo-readiness.test.mjs`). The local saved-example smoke also completed without network access or paid model calls (`scripts/demo-smoke.mjs`).

The repository's broader audit record is not a clean bill of health. It records 5,000 review rows, including 450 defects, 169 warnings or partial results, 125 externally unverifiable items, and 32 consolidated blocker causes (`.verify-runs/audit-5000/MASTER-REMEDIATION.md`). That record also states that some external control-plane, provider, and incident-response checks were intentionally not queried. Subsequent regression files address several identified causes, but the audit totals should not be rewritten as if the original findings never occurred.

The repository contains:

- deterministic medical, safety, privacy, security, reliability, and completion tests under `test/`;
- static regression programs and a condition matrix under `scripts/`;
- a dated all-condition link record under `.verify-runs/link-audit/`;
- a CycloneDX software inventory at `.verify-runs/sbom.cyclonedx.json`;
- a SHA-256 file manifest at `.verify-runs/integrity-manifest.sha256.json`; and
- a pre-push command that combines repository policy checks with the deterministic test sequence (`package.json`, `scripts/prepush-audit.mjs`).

The file manifest uses a fixed 1970 timestamp for reproducibility and proves recorded file hashes, not deployment identity or clinical validity (`.verify-runs/integrity-manifest.sha256.json`). No full pre-push result or authenticated production preflight was produced for this documentation task.

## Presentation architecture and fallback honesty

The live path uses the browser interface, serverless API routes, public medical sources, configured AI providers, and optional Upstash storage (`index.html`, `src/app.jsx`, `api/research.js`, `api/trials.js`).

The local readiness command validates saved examples, source links, completion status, export blocking, and browser-flow wiring without network or paid generation (`scripts/demo-smoke.mjs`, `docs/DEMO_RUNBOOK.md`).

The production preflight is separate. It requires the exact reviewed Git SHA, access, current Terms, the configured Anthropic model, Upstash, a report-signing secret, deterministic generation settings, and critical routes. It does not generate a live report unless separate explicit switches allow a paid call (`scripts/demo-smoke.mjs`, `lib/demo-readiness.js`).

If the live path fails, the interface can load a previously prepared example. The example is labeled **SAVED DEMO — NOT LIVE**, includes its generation time and reviewed source SHA, and must not be described as a current result (`data/demo/saved-verified-report.json`, `test/demo-readiness.test.mjs`, `scripts/demo-smoke.mjs`).

## Known limitations and blockers

1. **Human clinical review is incomplete.** The review sheet identifies 50 automatically generated condition libraries awaiting review (`data/kb/_REVIEW.md`). The current pre-push policy would fail while any remain marked unreviewed (`scripts/prepush-audit.mjs`).
2. **No clinical performance study is present.** Unit and integration tests show software behavior on selected cases; they do not establish sensitivity, specificity, patient benefit, or clinical safety.
3. **No regulatory conclusion is present.** The repository labels the product educational decision support, but intended use, claims, workflow, and commercialization would need review by qualified regulatory and legal professionals. This document makes no classification or compliance conclusion.
4. **No HIPAA claim is supportable.** The Terms expressly say the prototype is not HIPAA-compliant (`docs/TERMS_OF_USE.md`).
5. **External services remain dependencies.** Literature, trial, model, email, storage, hosting, DNS, and monitoring behavior cannot be proven from repository code alone (`docs/RELEASE_CONTROLS.md`).
6. **A dated link result is not continuous monitoring.** External pages can change after the saved check (`.verify-runs/link-audit/all-conditions-kb.json`).
7. **Independent AI review can also be wrong.** Deterministic source checks can overrule unsupported deletion, but clinical review remains necessary (`lib/grounding-gate.js`).
8. **Unknown fields limit personalization.** Missing pregnancy, organ function, genetics, laboratory, imaging, medication, or trial-history data can force unknown or incomplete results (`lib/safety-score.js`, `api/trials.js`).
9. **Provider privacy practices are external.** The code cannot establish provider retention, training, or subprocessor behavior (`docs/TERMS_OF_USE.md`).
10. **Release controls need external configuration.** Branch protection, deployment linkage, DNS, provider credentials, sender verification, and staffed monitoring are not set by this repository (`docs/RELEASE_CONTROLS.md`).

## Regulatory positioning

The only supportable repository-based description is:

> A research and educational tool that summarizes published literature, regulatory labels, and clinical-trial registry data to support conversations with qualified clinicians.

The repository does not support claims that the product diagnoses, treats, recommends a course of care, determines trial eligibility, replaces a clinician, is HIPAA-compliant, is validated for clinical use, or has received regulatory authorization. Whether a future intended use creates additional obligations depends on facts outside this repository and should be assessed by qualified professionals before commercialization.

## Professional-language check

Physician-facing proof should use ordinary clinical and product language. During this review, visible strings cited from `index.html`, `terms.html`, `docs/TERMS_OF_USE.md`, and rendered JSX literals in `src/app.jsx` were checked against the prohibited-language list supplied for this work. No prohibited term was found in the cited visible labels. Matching text that remains in `src/app.jsx` is confined to source comments and explicit removal rules; it is not presented as interface copy.

Before any physician meeting or screenshot:

- inspect the actual rendered **Profile**, **Research**, and **Export & Links** views;
- inspect downloaded Text, Word, and PDF output;
- inspect the saved example and any newly generated response;
- reject the material if a prohibited internal label appears anywhere visible; and
- do not rely on a source-code scan alone when the final text is generated at runtime.

## Review conclusion

The repository demonstrates a serious attempt to make AI-assisted medical research more traceable and conservative. It also documents its own limits unusually clearly. A potential product direction is a clinician-supervised research workflow with source and export controls. It is not yet evidence of a clinically validated, fully reviewed, legally cleared, or production-governed medical product.
