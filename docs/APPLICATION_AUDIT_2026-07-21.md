# Application Audit — "Works for Any Disease" Completeness & Correctness

**Date:** 2026-07-21
**Scope:** Does the product deliver its full intended payload — approved treatments, ≥25 repurpose ideas, pipeline watch, top centers, key investigators, clinical trials, everything real-linked — for **any** condition a user can type, not just the 61 curated knowledge bases?
**Method:** Static audit of code + data (no live runtime keys). Five parallel analysis passes; all load-bearing defect claims were independently re-verified against source. One agent overstatement was caught and corrected (noted below). Citations are `file:line`.

---

## 1. Executive summary

The application has **two tiers of delivery**, and they diverge sharply:

- **The literature-evidence *body* of a report works for any well-studied disease.** For an uncurated condition (e.g. tuberculosis, Hashimoto's) the pipeline pulls real PubMed/Europe PMC/OpenAlex papers, grades the grounding honestly (`strong / thin / dossier-only`), degrades gracefully when sources fail, and never fabricates a link. This part genuinely matches the "any disease" promise.

- **The structured *headline* payload does not.** The very things the product is sold on — **top centers, key investigators, pipeline drugs, landmark trials, patient advocacy, approved-treatment label links, and the ≥25 repurpose target** — are anchored to the 61 hand-curated KB files. For the ~19,000 diseases that resolve only via the Mondo **disease registry**, these sections are **empty by construction**, presented at a confident-looking uncertainty, with **no code path that ever fills them**.

**Bottom line:** the app is a strong, honest *literature research* tool for any disease, but its "complete condition dossier" experience (centers / pipeline / linked drug tables) is effectively a **61-condition product** today. The gap is not hallucination — the pipeline is admirably fail-closed and integrity-first — it is **silent structural emptiness** on everything outside curation, plus one confident **wrong-disease resolution** bug.

### Severity dashboard

| # | Finding | Severity | Verified |
|---|---------|----------|----------|
| F1 | Registry short-circuit leaves top centers / investigators / pipeline / landmark trials / advocacy **empty** for ~19k uncurated conditions; no path ever fills them | **Critical** | ✅ code + empirical |
| F2 | Confident **wrong-disease resolution**: `tuberculosis` → `Oral tuberculosis` (score 62, uncertainty 0.12) | **High** | ✅ empirical |
| F3 | Approved-treatment **DailyMed links & safety bands missing** — openFDA is queried only for the *patient's own meds*, not the condition's approved drugs | **High** | ✅ code |
| F4 | **≥25 repurpose target is disabled in code** (floor = 1; backfill & registry-fill zeroed) | **High** | ✅ code |
| F5 | **Top centers for no-KB/no-registry conditions are LLM-generated and unverified**; the documented uncertainty gate is **not implemented** | **High** | ✅ code |
| F6 | **KB trust baseline**: 0/61 KBs affirmatively `reviewed:true`; 50 auto-generated; 149 unverified "studied & failed" claims; 190 pipeline drugs with no citation | **High (trust)** | ✅ scan |
| F7 | Pipeline Watch structured table is **empty for `evidenceRef`-only KBs** (evidenceRef never resolved to a link) — affects ~190 pipeline drugs; **not** universal (IPF is fine) | **Medium** | ✅ code + data |
| F8 | Evidence/citation edge cases: uncurated + sparse + Perplexity-off ⇒ near-zero real links; `MRT_LINKCHECK_ENABLED=0` lets dead links render; `doi.org`/PubMed never probed; fail-open on timeout | **Medium** | ✅ code |
| F9 | Safety-gate **generalization gaps**: `profile-coherence` checks breast cancer only; contamination scrub uses a ~14-disease denylist | **Medium** | ✅ code |
| F10 | Trials **recall thins** for uncurated conditions (empty synonym/MeSH/pipeline fan-out); first-request dynamic-KB build is fire-and-forget; in-memory store loses cache on serverless | **Low–Medium** | ✅ code |
| F11 | Committed generated artifact `data/kb/_REVIEW.md` is **stale** (dated 2026-06-14; counts drifted from current data) | **Low** | ✅ observed |

**The single hard runtime dependency** is Anthropic synthesis (`api/research.js:3303-3325`); all six literature/label providers fail open.

---

## 2. What a complete report is *supposed* to contain (the spec)

Grounded in `api/research.js` prompts, `lib/report-*.js`, and the docs. This is the yardstick.

**Research mode — 8 sections:** (1) Condition Snapshot (3–6 linked lifestyle bullets, top-3 safety flags); (2) Condition-Focused Centers & Experts (center table + 3–5 named experts); (3) Approved Treatments — one card per approved drug, each with a **DailyMed label link** and safety band; (4) Clinical Trials — up to 25 recruiting + OLE/expanded-access/pay pathways; (5) Pipeline Watch — up to 25 investigational rows, each real-linked; (6) Cell/Gene therapies; (7) Interaction & Access Plan (2–4 advocacy orgs); (8) Safety Considerations. (`api/research.js:1530-1660`)

**Repurpose mode:** two sections (`never-researched`, `researched-not-approved`); UI target **≥25 cards** (`docs/DEMO_TALKING_POINTS.md:18,46`); each card carries a REAL link or is explicitly never-researched.

**Citation rule ("Hard 50"):** one claim → one real inline link; every named entity clickable; search-page/invented/dead links are stripped; honest "no link" over fabrication. This is **advisory on count, hard on integrity** — the product guarantees *every link is real*, not *50 links* (`api/research.js:1436-1454, 3272-3283`).

**Gates before a report is shown/exported:** section presence + profile freshness, cross-AI validation (score ≥80, agreement high, zero unsupported/hallucinated), citation audit, coverage audit, terms consent, grounding-sufficiency grade, and an HMAC content seal (`lib/report-completion.js:108-192`).

**Explicit "any condition" intent:** README — *"Works for any condition"* (`README.md:8,49`); KB is only a "ground-truth floor" (`:90`); `docs/DYNAMIC_BRAIN_ROBUSTNESS.md` scopes ~19k registry conditions with no KB as first-class.

---

## 3. Findings in detail

### F1 — CRITICAL: the "dynamic brain" rich fields are empty for ~19k conditions

`getDossier` resolves in priority order: curated KB → disease registry → LLM dossier. A registry match at `score >= 55` **returns immediately** (`lib/disease-dossier.js:364-378`), *before* the LLM path that is the only generator of the rich fields. `buildDossierFromRegistry` hardcodes `topCenters: []`, `keyInvestigators: []`, `patientAdvocacy: []`, `landmarkTrials: []`, `meshTerms: []`, `redFlags: []` with `uncertainty: 0.12` (`lib/disease-registry.js:155-181`). The disease-registry JSON (19,249 entries) carries only name/synonym/specialty/ontology data — **no drug or center data**.

Downstream, `buildDossierBlock` only emits the Top-Centers/Investigators/Advocacy prompt sections when those arrays are non-empty (`api/research.js:857-873`), so for a registry hit they are **never injected**, and the response returns them empty. **No other code path fills them** — the dynamic KB builder emits only `pinnedItems/canonicalFacts/redFlags/pipelineDrugs/excludedAgents` (`lib/kb-builder.js:332-355`), never centers/investigators/advocacy/landmark trials. Neither the background build nor the daily cron changes this.

Empirically (registry resolver): `Hashimoto thyroiditis`, `celiac disease`, `tardive dyskinesia`, `achondroplasia` all match at score 100 with **0** centers / investigators / landmark trials / advocacy and uncertainty 0.12.

The irony: the LLM dossier that *does* generate these fields fires **only** when resolution is worst (no KB **and** no registry ≥55 — i.e. messy/misspelled input). Confident conditions get empty fields; unconfident ones get LLM-guessed fields.

### F2 — HIGH: confident wrong-disease resolution

`scorePhrase` rewards substring containment by length ratio and accepts ≥55 (`lib/disease-registry.js:45-49,126`). Verified: **`tuberculosis` → `Oral tuberculosis`** (MONDO:0005887) at score **62**, uncertainty **0.12**. A common disease is silently narrowed to a rare sibling and the entire report grounds on the wrong entity while looking confident. Unmatched input otherwise passes through as `user-input` with `confident` forced true (`lib/condition-resolver.js:302-321`). Only a best-effort, spend-dependent second-AI mismatch check can catch it (`condition-resolver.js:397-423`).

### F3 — HIGH: approved-treatment labels & safety bands are not fetched

Section 3 approval status comes from KB `pipelineDrugs` marked `approved` (`api/research.js:1561-1567`), which for uncurated conditions is one LLM extraction that **defaults to `investigational`** unless the model says otherwise (`lib/kb-builder.js:320`). The DailyMed label is the break point: openFDA *is* live but is mapped over the `drugs` array, and in the real gather that array is **`patient.medications`** (`api/research.js:2937`), with `manufacturers = []` — `evidence.js:475`. So a condition's approved drug gets a real `drugInfo.cfm?setid=` label only if the patient happens to be taking it. Consequently `enforceFdaLabelNarrative` rewrites unlinked approval/dose claims to *"Unknown — insufficient verified FDA/DailyMed label evidence"* (`lib/fda-label-gate.js:340-346`) and `injectSafetyBands` drops the SAFETY line (`lib/safety-score.js:337-357`). Approved-treatment cards for uncurated conditions frequently render **without the required label link and without a safety band**.

### F4 — HIGH: the ≥25 repurpose target is disabled in code

Verified in `lib/repurpose-quality.js`: `REPURPOSE_TARGET_TOTAL = 0` (`:20`), `REPURPOSE_SECTION_TARGET = 0` (`:17`), `REPURPOSE_BACKFILL_THRESHOLD = 0` (`:31`), `REPURPOSE_BACKFILL_MAX_PASSES = 0` (`:33`), `REPURPOSE_MIN_TOTAL = 1` (`:23`). `needsBackfill` never fires with threshold 0 (`:166`); `buildRegistryFillCandidate` **returns `''`** by design (`:314-322`); `assessRepurposeQuality.ok = linked >= 1` (`:391`). The candidate library (`selectRepurposeDrugs`) is condition-agnostic — filtered to `approvedUsa===true` and reordered by a coarse specialty-keyword boost, not disease-specific relevance (`lib/drug-registry.js:96-107,151,219`). **There is no mechanism to reach 25 and no top-up.** The `≥25` claim is unmet by design; thin output for rare diseases is expected, not exceptional. *(This may be an intentional "never pad medical suggestions" safety stance — see §5 — but then the ≥25 product claim should be dropped.)*

### F5 — HIGH: unverified LLM-generated top centers, and a safety gate that isn't wired

For conditions with **no KB and no registry match**, the ≤8 "world-class centers" are generated live by the dossier LLM (`lib/disease-dossier.js:188-201,211-269`) with **no whitelist, no grounding, no external verification** — only the prompt's self-restraint. They are injected with a **"you MUST surface these"** directive (`api/research.js:857-862`). The code comment at `disease-dossier.js:48-53` claims high-uncertainty dossiers are *not* injected into the prompt, but `buildDossierBlock` is called **unconditionally** (`api/research.js:3126`); high uncertainty only appends a soft caveat while still injecting the centers (`:890`). So model-invented hospital names can reach users for unrecognized conditions. (KB- and registry-matched conditions are safe here — the latter because their center list is simply empty, per F1.)

### F6 — HIGH (trust): the curated corpus is largely unreviewed

Automated audits **pass**: `audit-kb.mjs` ✅, `audit-kb-links.mjs --static` ✅ (3,851 refs → 1,651 unique URLs, every KB pins ≥1 citeable URL), `audit-kb-trials.mjs --static` ✅ (12 trial records), `audit-guidance-freshness.mjs` ✅. But the content trust baseline is thin: **0 of 61 KBs are affirmatively `reviewed:true`** (50 auto-generated from PubMed and flagged `reviewed:false`; 11 hand-curated with no review flag), with **149 "studied & failed" drug claims awaiting human sign-off** and **190 pipeline drugs carrying no pmid/doi/nct/url** (worst: bipolar 14, parkinson 14, duchenne 13, als 11, schizophrenia 11). 5 curated items have no link at all (als, duchenne-md, huntington-disease, lca, schizophrenia). Citation-backed but largely unverified.

### F7 — MEDIUM: Pipeline Watch structured table dead for `evidenceRef`-only KBs

`buildPipelineWatchBlock`'s `withLink` gate accepts a drug only if it has a valid `nct`, `http(s) url`, or `pmid` (`api/research.js:1071-1076`). Many KB pipeline drugs carry only `evidenceRef` (e.g. `multiple-sclerosis.json` keys: `name,…,approvalStatus,evidenceRef`), which is **never resolved to a link** before this gate — so the structured table emits its empty message and the section survives only via the anti-omission audit forcing the model to scavenge a link. **Correction to initial finding:** this is **not** universal — IPF's pipeline drugs pin `pmid`/`nct` (Nerandomilast NCT05321069 + pmid, Pamrevlumab NCT03955146, etc.) and populate the table correctly. The defect scales with F6's 190 reference-less pipeline drugs.

### F8 — MEDIUM: citation-integrity edge cases

- **Uncurated + sparse + Perplexity-off ⇒ near-zero links.** The dossier fallback's synthesized rows are stamped `accessLevel:'dossier'` and are then **rejected by the admission gate** (`lib/source-admission-gate.js:185-187`) and excluded from `realPaperCount` (`api/research.js:551`). Usable grounding then comes only from Perplexity web rows; if Perplexity is keyless/disabled, an uncurated+sparse condition can reach synthesis with ~0 admissible links → a labeled-but-near-linkless report.
- **`MRT_LINKCHECK_ENABLED=0`** skips live probing; citation status is set `degraded`, which still **passes** the export gate (`api/research.js:322-323`; `lib/report-completion.js:42-43`) — dead links can render.
- **`doi.org`/PubMed are never probed** (`lib/link-check.js:75-81`) — a well-formed but invented or wrong-but-registered DOI/PMID escapes the dead-link layer (admission + allowlist usually still catch out-of-pack ones).
- **Fail-open on transience:** timeout/429/5xx keep the link, and probing stops at a 45s budget, leaving links unprobed-but-kept (`lib/link-check.js:315-361`).

### F9 — MEDIUM: safety generalization gaps (no dynamic bypass, but narrow coverage)

No curated-vs-dynamic bypass exists — dynamic content is actually pruned **more** aggressively (thin grounding index → `isClaimGrounded` false → validator deletions), and safety bands derive from live FDA labels failing closed to `Unknown` (`lib/safety-score.js:181-210`). But two checks don't generalize: `profile-coherence.js` only validates male/female **breast** cancer (`:5-58`) — every other sex-specific condition is a no-op; and `disease-contamination.js` free-prose scrub fires only on a hardcoded ~14-disease denylist (`:16-47`). Both are partly compensated by condition-agnostic gates (study-line demographic gate, `sourceMentionsCondition`).

### F10 — LOW–MEDIUM: trials recall, first-request timing, serverless persistence

Trials fetch/filter/gate is robust (parallel CT.gov fan-out, NCT dedupe, registry-fact revalidation, demographic + eligibility hard-gates, graceful degradation to HTTP 200 + notice). But for uncurated conditions the synonym/MeSH/pipeline-drug fan-out is empty, collapsing recall toward a single raw-string query (`api/trials.js:996-1080`; dossier fallback `lib/disease-dossier.js:273-278`). Separately: the first request for an uncurated condition does **not** synchronously build the dynamic KB — `ensureDynamicKb` is fire-and-forget (`api/research.js:2992`) and declines to build when `uncertainty >= 0.75` (`lib/kb-bootstrap.js:57`); and with no Upstash the store/queue/overlay are in-memory (`lib/kb-store.js:63-70`), so on serverless every invocation re-builds and background builds are lost on freeze.

### F11 — LOW: stale committed generated artifact

`data/kb/_REVIEW.md` is checked into the repo but was last generated 2026-06-14; regenerating it shows drifted canonical-fact counts and an updated template (adds `reviewedBy`/`reviewedAt`). A generated file in version control has diverged from its source. (Left un-regenerated in this audit to avoid an unreviewed content change.)

---

## 4. What genuinely works well

This audit is about gaps, but the pipeline is strong where it counts:

- **Integrity-first citations.** Four independent layers (admission gate → citation gate → live probing → render allowlist + FDA-label seal) ensure a fabricated or search-page link does not reach the user; honest "no link" is preferred over invention (`lib/citation-gate.js`, `link-check.js`, `report-links.js`, `fda-label-gate.js`).
- **Honest degradation.** `assessGroundingSufficiency` grades every report and injects a mandatory "Limited evidence" banner when grounding is thin/dossier-only (`api/research.js:554-599`); reports are labeled, not silently faked.
- **Robust trials filtering** with demographic + eligibility hard-gates that fail closed on completeness.
- **No provenance-based safety bypass** — dynamic content is treated at least as strictly as curated; safety bands fail closed to `Unknown`.
- **Operational hardening** the stale robustness doc understates: cron fails closed without `CRON_SECRET` (`lib/cron-auth.js:11`), mandatory persistence read-back after build (`lib/kb-bootstrap.js:41-46`), schema-validated builds with repair retry + QA stamp, and provenance tags on KB items.
- **Automated KB audits pass** (links, trials, guidance freshness).

---

## 5. Prioritized recommendations

Highest leverage first. These are engineering directions, not medical content changes.

1. **Fill the rich dossier fields for registry-resolved conditions (F1).** Either (a) let the LLM dossier generate `topCenters/keyInvestigators/landmarkTrials/advocacy` even on a registry hit (drop the short-circuit for these fields while keeping the cheap name resolution), or (b) generate + persist them in the dynamic KB build so they populate after first use. Today there is *no* path — this is the single biggest gap between the vision and reality.
2. **Fix confident mis-resolution (F2).** Require a higher score for substring-only matches, penalize when the query is a strict prefix of a longer rare-sibling name, or confirm ambiguous common-disease resolutions. `tuberculosis → Oral tuberculosis` should never happen silently.
3. **Feed the condition's approved/pipeline drug *names* into the openFDA `drugs` array (F3),** so Section 3 gets real DailyMed labels + safety bands regardless of the patient's own med list.
4. **Resolve `evidenceRef → url/pmid` before `buildPipelineWatchBlock` (F7),** and back-fill citations for the 190 reference-less pipeline drugs (F6).
5. **Decide the ≥25 repurpose question (F4):** either re-enable a bounded, disease-relevant fill, or update the product claim/UI to "an honest count" and remove "≥25" from the spec.
6. **Wire the documented top-centers uncertainty gate (F5),** or add name verification, so unverified LLM centers aren't force-surfaced for unrecognized conditions.
7. **Begin human review of the 50 auto-generated KBs / 149 flagged failure claims (F6);** track `reviewed`/`reviewedBy`/`reviewedAt`.
8. **Generalize `profile-coherence` beyond breast cancer (F9)** and consider a data-driven contamination check rather than a 14-disease denylist.
9. **Treat `MRT_LINKCHECK_ENABLED=0` as non-exportable (F8)** rather than merely "degraded".

---

## 6. Methodology & caveats

- **Static audit** of code and data as of this branch — no live report was generated (no Anthropic/provider keys in this environment). Findings describe the *code paths*; a live run would confirm user-visible outcomes.
- Produced by five parallel analysis passes (spec, dynamic-brain, evidence/citations, drugs, trials/centers/safety+KB). **Every Critical/High defect was independently re-verified against source** before inclusion; one initial overstatement (Pipeline Watch "empty even for IPF") was **corrected** (F7).
- **Environmental note:** `audit-kb-metadata.mjs` could not complete — it requires live NCBI PubMed and hit HTTP 403 through the agent proxy. This is a network limitation, **not** a KB defect; re-run with network to validate metadata.
- No medical content was authored or judged in this audit; it assesses the *application's* completeness and correctness, not clinical accuracy.
