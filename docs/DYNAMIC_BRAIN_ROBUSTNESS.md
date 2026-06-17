# Dynamic-Brain Robustness — Audit, Gap Analysis & Plan

Status: design doc (offline audit). No runtime claims are made here that were not
statically verified against the code. Server/LLM were not available at authoring time.

Scope: the ~19,188 conditions in `data/disease-registry.json` (19,249 total) that have
**no** hand-curated KB file in `data/kb/*.json` (61 curated). These go through the
DYNAMIC path: dossier (registry/LLM) -> optional dynamic KB build (PubMed + Perplexity
+ Claude) -> evidence grounding -> synthesis -> render. Goal: every such condition still
returns useful, correct info with **no cross-contamination** between drugs/conditions.

---

## Part 1 — Pipeline audit (file:line)

### 1.1 `lib/kb-builder.js` — the grounded builder
- **What it does.** `buildKnowledgeBase()` (`lib/kb-builder.js:258-282`) gathers real PubMed
  papers (`gatherPubMedPapers`, `:114-164`) + Perplexity pipeline hints (`perplexityHints`,
  `:47-51`), then calls Claude as a *librarian-only* extractor (`callExtract`, `:89-112`) that
  "organizes by index" — it may only reference papers by their array number, never author a
  DOI/PMID/URL (system prompt `:53-63`). `assembleKbFromExtract` (`:166-256`) turns ref numbers
  back into real paper records.
- **Quality/validation enforced today.**
  - Refs validated against the retrieved set: `validRef` requires an integer index inside
    `[0, papers.length)` (`:167`); `ensureItem` drops out-of-range refs (`:193`).
  - URLs/DOIs come only from retrieved PubMed metadata (`:185`), never from the model.
  - `excludedAgents` are filtered hard: each must have `name && reason && evidenceRef`, and the
    ref must resolve (`:226-230`). `canonicalFacts`/`lifestyleRecommendations` require ≥1
    resolving ref (`:204-212`).
  - Negative-trial recall is *attempted* via dedicated negative queries (`:124-135`) and the
    `_neg` tag (`:146-149`); negatives are sorted first into the capped pool (`:160-163`).
  - Deterministic extraction: `temperature: 0`, `max_tokens: 4000` (`:101-102`).
- **Where it is FRAGILE for the 19K.**
  - **No JSON-schema validation/retry.** `callExtract` does `text.match(/\{[\s\S]*\}/)` then a
    single `JSON.parse` (`:109-111`). A truncated/malformed object throws and the whole build
    fails (caught upstream → null). No retry, no partial salvage.
  - **`excludedAgents` collapse to empty for rare diseases.** The `name && reason && evidenceRef`
    gate (`:226-230`) means that unless a *retrieved* paper documents a genuine failure **and**
    Claude cites it by ref, the agent is dropped. Rare Mondo conditions seldom have
    negative-trial literature indexed under the typed name → the failed-drug guardrail is
    usually empty (see Part 2).
  - **`redFlags` are model-authored free text** with no ref requirement (`:214`) — ungrounded
    safety strings.
  - **Recall ceiling.** `mode:'fast'` (the on-demand default, `:263`) runs only 2 positive + 2
    negative queries, caps at 24 papers (`:136-137`). For an ambiguous/rare disease name the
    pool can be thin or off-target, and there is no minimum-paper or relevance gate beyond
    "≥1 paper retrieved" (`:278`).
  - **Slug collisions.** `slugFromCondition` (`:14-21`) lowercases + truncates to 64 chars; two
    distinct long Mondo names can collide on the same slug and overwrite each other in the store.

### 1.2 `lib/kb-bootstrap.js` — on-demand build trigger
- `ensureDynamicKb()` (`:41-89`) is the only runtime entry that *builds*. Returns cached KB if
  fresh (`:51`), else races the build against a timeout (`buildTimeoutMs` default **28 s**,
  `:22-23`) and de-dupes concurrent builds via an in-process `inflight` map (`:7`, `:53-73`).
- On timeout it leaves the build running and returns `existing || null` (`:82-88`) — i.e. the
  first user to hit a new condition gets **nothing back** and the next user gets the result.
- **Fragile for 19K:**
  - **Hard uncertainty cutoff:** if `dossier.uncertainty >= 0.75` it refuses to build (`:45-47`).
    LLM dossiers for ambiguous rare names self-report high uncertainty, so the build never fires
    for exactly the hardest inputs.
  - **In-process inflight + in-memory store** (no Upstash) means on serverless cold starts each
    invocation is isolated; a 28 s timeout commonly returns null and the background build is lost
    when the lambda freezes. Latency budget is 5 min but the build is capped at 28 s.

### 1.3 `lib/kb-store.js` — dynamic KB persistence
- Upstash Redis when configured, else ephemeral in-memory Map (`:11-13`, `:45-49`). `putDynamicKb`
  stores by slug + an alias index (condition/slug/aliases normalized, `:79-110`); `lookupDynamicKb`
  resolves free text via the alias map then a slug guess (`:63-77`).
- **Fragile:** with no Upstash (`dynamicKbBackendName()` = "in-memory (ephemeral)", `:52`) nothing
  persists across requests/instances — every search re-builds. The alias normalization
  (`normalizeKey`, `:19-24`) strips punctuation, so subtype distinctions ("type 1.5" → "type 1 5")
  can alias-collapse distinct conditions onto one stored KB.

### 1.4 `lib/brain-queue.js`, `lib/brain-overlay.js`, `lib/brain-refresh.js`, `api/brain-cron.js`
- **Queue** (`brain-queue.js`): user searches enqueue `{canonical, slug}` (`:32-46`); cron drains
  in batches (`:52-64`). In-memory fallback is ephemeral (`:27-28`).
- **Overlay** (`brain-overlay.js`): freshness layer for *static* KBs (read-only FS on Vercel),
  merged at load time (`getBrainOverlay`/`putBrainOverlay`, `:28-46`).
- **Refresh** (`brain-refresh.js`): `refreshBrainForCondition` (`:127-184`) — static match → write
  overlay (`:143-160`); else rebuild dynamic KB (`:167-183`). `pickRefreshBatch` (`:91-125`) drains
  stale dynamic KBs then rotates static slugs (~1/7 per day, `:108-111`).
- **Cron** (`api/brain-cron.js`): daily handler (`:34-87`); batch limit ≤15 (`:50`).
- **Fragile:**
  - **Auth defaults open:** `isAuthorised` returns `true` when `CRON_SECRET` is unset
    (`api/brain-cron.js:16-23`).
  - **Refresh only ever touches conditions someone already searched or that already exist as
    dynamic KBs** — there is no proactive pre-build of the 19K (Part 3 pillar 4).
  - Refresh rebuilds reuse the same fragile builder (no schema validation), so a refresh can
    *replace* a good KB with a thinner one if literature recall regresses that day.

### 1.5 `lib/condition-resolver.js`, `lib/condition-ontology.js`, `lib/disease-registry.js`, `lib/disease-dossier.js`
- **Resolver** (`condition-resolver.js`): `resolveCondition` (`:138-307`) tries gene notation →
  ontology rules → phrase candidates against KB + registry (`:192-232`), `pickBest` requires
  `score >= 40` (`:79-82`). **No match still proceeds** with the raw user string and
  `source:'user-input'`, `matchScore:0` (`:242-246`); `confident` is then forced true for
  `user-input` (`:261`).
- **Ontology** (`condition-ontology.js`): hand rules for psychiatric/diabetes acronyms (`:30-118`),
  e.g. BPD disambiguation, LADA. Good for the curated set; covers almost none of the 19K.
- **Registry** (`disease-registry.js`): `lookupDisease` (`:107-154`) uses `scorePhrase` (`:32-52`)
  with substring-ratio scoring; accepts `score >= 55` (`:126`) or an exact alias-bucket hit
  (`:133-142`). `soften` strips one trailing plural `s` on ≥5-char words (`:17-22`).
  `buildDossierFromRegistry` sets `uncertainty: 0.12` (`:179`).
- **Dossier** (`disease-dossier.js`): `getDossier` (`:309-408`) short-circuits to curated KB
  (`uncertainty 0.05`, `:302`/`:336-347`), then registry (`score>=55`, `uncertainty 0.12`,
  `:357-366`), then the LLM agent (self-reported uncertainty, `:380-407`); hard fallback is
  `uncertainty 0.95` (`:267`).
- **Fragile for 19K:**
  - **Substring scoring false-positives:** `scorePhrase` rewards substring containment by length
    ratio (`:45-49`), so a short typed term can match a longer unrelated Mondo name (or vice-versa)
    above 55 and ground the report on the **wrong disease**. There is no token-level disambiguation
    against sibling Mondo entries.
  - **`user-input` passthrough:** an unmatched messy string flows straight into gather as if
    confident (`:242-261`), producing a report for whatever PubMed returns for that literal string.
  - **Uncertainty coupling:** registry hits get a fixed low `0.12`, so a *wrong* registry match
    looks confident downstream and is eligible for a dynamic build.

### 1.6 `lib/kb.js` — `loadKb` and guardrail serving
- `matchKb` (`:92-116`) scores candidate strings against curated KB slug/condition/aliases
  (`score>=40`, exact=100). `loadKb` (`:249-296`) tries curated match → dynamic store lookup
  (`:276-283`) → optional `ensureBuild` (`:285-293`).
- `kbRecordToLoadResult` (`:154-227`) maps a KB record to the evidence-pack shape. **The recent
  fix:** `redFlags`, `pipelineDrugs`, and `excludedAgents` are now served **unconditionally**,
  regardless of `reviewed` status (`:206-214` + the explanatory comment) — previously suppressed
  for unreviewed KBs, which silently disabled the failed-drug guardrail.
- **Fragile:** serving the guardrail is fixed, but for dynamic KBs the guardrail arrays are
  usually *empty at generation time* (Part 2) — so "served unconditionally" yields nothing to
  serve. Dynamic lookups are assigned a flat `score: 88` (`:232`, `:237`) regardless of match
  quality.

### 1.7 `lib/evidence.js` — grounded-evidence orchestrator
- `handler` (`:227-670`) fans out PubMed/EPMC/OpenAlex/Cochrane/openFDA/Perplexity, dedupes by
  DOI/PMID (`dedupe`, `:191-213`), scores (`scoreArticle`, `:156-189`; curated KB +60, `:171`),
  hard-filters retractions/predatory (`:443-449`), and builds a 25-item prompt pack with ≥10 live
  slots (`:489-495`). Pipeline-drug query expansion guarantees KB pipeline drugs are searched
  (`:312-320`). It passes `pipelineDrugs`/`excludedAgents` straight through from the KB
  (`:617-618`).
- **Fragile for 19K:** for a non-curated condition `kb.meta` is absent, so `pipelineDrugs:[]` and
  `excludedAgents:[]` (`:617-618`) — the anti-omission and failed-drug guardrails are empty. There
  is **no minimum-evidence gate**: if the fan-out returns few/low-tier papers the pack is just
  small; nothing fails loud. `qualityBreakdown` (`:551-571`) is reported but never gates display.

### 1.8 `api/research.js` — grounding, fallback & contamination paths
- **Fallback ladder.** `ensureGroundedEvidence` (`:424-437`): if live evidence is unusable, try
  `buildKbFallbackEvidence` (`:239-318`, carries `excludedAgents` from `kb.meta`, `:295`), then
  `buildDossierFallbackEvidence` (`:329-422`). `evidenceIsUsable` only checks
  `groundedForPrompt.length > 0` (`:320-323`).
- **Required mentions / coverage.** `buildRequiredMentionsBlock` (`:689-722`) injects pipeline +
  excluded agents into the prompt; `scanForMissedPipelineDrugs` (`:796-808`) + the post-synthesis
  coverage audit (`:2440-2520`) re-prompt on omissions — but the **forced rewrite is skipped for
  research mode** (`skipReprompt = mode === 'research'`, `:2456`) for latency.
- **Contamination filter.** `filterExcludedAgentMentions` (`:2371`) strips excluded-agent content
  before `finalizeReportText` (`:2381`).
- **Validation.** Second-AI cross-check runs when keys+spend allow (`:2555-2574`);
  `detectValidationMismatch` (`condition-resolver.js:312-338`) flags wrong-condition reports.
- **Fragile for 19K — silent degradation.** `buildDossierFallbackEvidence` hardcodes
  `pipelineDrugs: []` and **`excludedAgents: []`** (`:398-399`) and synthesizes "evidence" rows
  from dossier red-flags/landmark trials (`:357-389`) tagged `accessLevel:'dossier'`. This passes
  `evidenceIsUsable` (length>0) and the report renders with **no honest "thin evidence" label** to
  the user. This is the core silent-degradation path for non-curated conditions.

### 1.9 `lib/report-polish.js` — output sanitation
- `excludedAgentNames` (`:288-303`) builds the excluded set (name + first token, ≥4 chars);
  `filterExcludedRepurposeCandidates` (`:305-318`) drops whole `CANDIDATE:` blocks naming an
  excluded agent; `filterExcludedAgentMentions` (`:320-336`) also strips prose lines.
  `collectAllowedUrls` (`:230-257`) + `sanitizeMarkdownLinks` (`:274-286`) demote any link/URL not
  traceable to a retrieved source — the model-authored-URL guard at render time.
- **Fragile:** the excluded filter is keyed on `evidence.excludedAgents`, which is empty for
  dynamic conditions → nothing to filter. URL allow-listing is robust but only as good as
  `groundedForPrompt`; dossier-fallback rows often have no URL, so a model may still name a
  paper it cannot link.

### 1.10 `lib/repurpose-quality.js` & `index.html` candidate parser
- `countCandidateBlocks` / `isLaneTruncated` (`repurpose-quality.js:10-24`) detect short/truncated
  lanes. The client parser `parseCandidates` (`index.html:733-787`) treats a **repeated field
  inside an open block as a new candidate boundary** (`:749`) — this is the fix that prevents one
  drug's CONFIDENCE/SAFETY/SOURCES from overwriting another's when the model drops a `CANDIDATE:`
  delimiter (the "Magnesium card showing Lumateperone's data" bug, commented `:742-748`); orphan
  fragments with no candidate name are dropped in de-dup (`:774-784`).
- **Fragile:** the containment lives in client JS (not a shared module), so it is only verifiable
  by string/parse fixtures, not unit import (see `scripts/condition-matrix.mjs`).

### 1.11 `lib/profile-coherence.js` & `api/trials.js` relevance
- **Coherence** (`profile-coherence.js`): only male/female-breast vs gender mismatches are caught
  (`:8-36`, `:39-70`). No general condition/age/sex coherence for the 19K.
- **Trials relevance** (`api/trials.js`): `scoreTrialRelevance` (`:412-492`) scores by dossier/KB
  phrase overlap; when CT.gov lists explicit conditions that don't match and title score < 5 it
  returns **-100 "wrong disease"** (`:445-452`), with a cell/gene-therapy escape hatch (`:480-486`).
  `applyPatientPromiseAdjustment` (`:119`) + `normalizePromise` (`:113`) clamp to 0-100 and apply
  status/age penalties.
- **Fragile for 19K:** relevance phrases come from the dossier/KB; a thin dossier (few synonyms)
  weakens the wrong-disease screen, so trials sharing only a drug name can slip in as "weak match".

---

## Part 2 — Gap analysis for the ~19,188 non-curated conditions

### 2.1 Are `excludedAgents` (the failed-drug guardrail) generated for dynamic conditions? — **No, almost never.**
This is the headline finding. The guardrail is *attempted* but, in practice, **empty** for the
vast majority of the 19K, for three compounding reasons:

1. **Strict generation filter.** In `assembleKbFromExtract`, every excluded agent must satisfy
   `name && reason && evidenceRef`, and `evidenceRef` is kept only when `validRef(x.ref)` resolves
   to a retrieved paper (`lib/kb-builder.js:226-230`). So an excluded agent survives only if (a)
   the negative PubMed queries actually retrieved a paper documenting a *genuine human failure*
   for that exact condition, and (b) Claude cited it by ref. For rare Mondo diseases that
   negative-trial literature usually does not exist (or is not indexed under the typed name), so
   the array filters down to `[]`.
2. **Fast-mode recall is shallow.** On-demand builds run `mode:'fast'` (2 negative queries, ≤24
   papers, `lib/kb-builder.js:124-137`, `:263`), reducing the chance of catching a real failure
   paper even when one exists.
3. **Fallback hardcodes empty.** When the live build is unavailable/too slow (the common case —
   28 s timeout, ephemeral store), synthesis grounds on `buildDossierFallbackEvidence`, which sets
   **`excludedAgents: []`** and `pipelineDrugs: []` outright (`api/research.js:398-399`).

Consequence: the recent `lib/kb.js` fix to *serve* `excludedAgents`/`redFlags` regardless of
`reviewed` (`lib/kb.js:206-214`) is correct and necessary, but for dynamic conditions there is
typically **nothing to serve** — the guardrail must be *generated*, not just *served*. The
downstream contamination filter (`filterExcludedAgentMentions`) is therefore a no-op for these
conditions. `redFlags` are more often populated but are **model-authored, ungrounded** strings
(`lib/kb-builder.js:214`).

### 2.2 Grounding/quality thresholds & silent degradation — **thresholds are weak; degradation is silent.**
- The only gate before a report is shown is `evidenceIsUsable`, which checks
  `groundedForPrompt.length > 0` (`api/research.js:320-323`). There is **no** minimum on paper
  count, journal tier, access level, or recency.
- `lib/evidence.js` computes a rich `qualityBreakdown` (`:551-571`) but **never uses it to gate**
  display — it is reporting only.
- The fallback ladder degrades **silently**: live → KB-only (`buildKbFallbackEvidence`) →
  dossier-only (`buildDossierFallbackEvidence`). The dossier-only tier manufactures
  `accessLevel:'dossier'` rows from red-flags/landmark-trial names (`api/research.js:357-389`).
  The report renders normally; the user is **not told** the evidence base was thin or
  dossier-derived. `lib/report-polish.js` even strips internal phrases like "No grounded
  evidence" (`:4-20`), which can *remove* the honest hedge if the model emitted one.
- Net: a non-curated condition with poor literature recall produces a confident-looking report
  built on a handful of dossier-derived "sources" — the exact failure mode the user wants to
  eliminate.

### 2.3 Where cross-contamination can arise for dynamic conditions
- **Build stage.** A wrong/ambiguous condition→registry resolution (2.4) seeds PubMed queries with
  the wrong disease; the resulting KB is internally consistent but **about the wrong disease**.
  Slug collision/alias-collapse in the store (`kb-store.js:19-24`, `kb-builder.js:14-21`) can also
  serve drug B's KB for condition A.
- **Evidence assignment.** `dedupe` merges by DOI/PMID only (`lib/evidence.js:191-213`); papers
  with no DOI/PMID fall back to `source:id`. Web/dossier rows without identifiers cannot
  cross-merge but also carry no provenance tag binding them to *this* drug/condition.
- **Repurpose parsing/synthesis.** Mitigated but not eliminated: the `parseCandidates` duplicate-
  field boundary (`index.html:749`) contains the field-bleed overwrite, and
  `filterExcludedRepurposeCandidates` drops excluded drugs — **but only if `excludedAgents` is
  populated**, which (2.1) it usually is not for dynamic conditions.
- **Trials matching.** Shared drug names pull unrelated diseases; the wrong-disease screen
  (`api/trials.js:445-452`) depends on dossier/KB phrases, which are sparse for the 19K, so the
  `-100` screen fires less often and "weak match" trials for other diseases can surface.
- **No end-to-end provenance assertion** exists anywhere: nothing checks that a rendered card for
  drug X under condition Y contains no foreign drug/condition tokens (Part 3 pillar 3).

### 2.4 Reliability of condition→registry resolution for messy input
- **Synonyms/acronyms:** handled well only where an ontology rule (`condition-ontology.js:30-118`)
  or a registry synonym exists; otherwise an acronym is matched by raw substring scoring.
- **Misspellings:** `condition-typo.js` repair + `extractMedicalCore` help, but there is no fuzzy
  edit-distance match against the 19K — a misspelling that isn't repaired falls to `user-input`
  passthrough (`condition-resolver.js:242-246`).
- **Subtypes:** alias normalization can collapse subtype markers (e.g. "type 1.5") and the
  registry often only has numbered subtypes, so a subtype query can match a parent or sibling.
- **False matches:** the biggest risk. `scorePhrase` substring-ratio (`disease-registry.js:45-49`)
  + the `>=55` accept threshold (`:126`) can confidently match the **wrong** Mondo entry; the
  fixed `uncertainty:0.12` (`:179`) then makes the wrong match look trustworthy, and synthesis
  grounds the entire report on the wrong disease. The only late safety net is the second-AI
  `detectValidationMismatch` (`condition-resolver.js:312-338`), which is best-effort and
  key/spend-dependent.

---

## Part 3 — Prioritized plan (5 pillars, with risk tiers)

Risk tiers: **(a)** low-risk, safe to implement + verify later offline; **(b)** needs live
runtime verification before trusting; **(c)** needs a user/product decision.

### Pillar 1 — Grounding-sufficiency gate that fails LOUD
**Goal:** never render a confident report on thin/dossier-only evidence without an honest label.
- **`api/research.js` — replace `evidenceIsUsable` (`:320-323`) with a graded
  `assessGroundingSufficiency(evidence)`** returning `{ tier: 'strong'|'thin'|'dossier-only',
  realPaperCount, topTierCount, reasons[] }`. Count rows with `accessLevel ∈ {full-text,abstract}`
  and a resolvable URL/PMID/DOI; treat `accessLevel:'dossier'` rows as non-grounding. **(a)**
- **Thread the tier into the response** (`api/research.js:2602-2616`) and into the synthesis
  header so the model is instructed to label the report "Limited evidence base" when tier≠strong.
  **(a)** for plumbing; **(b)** to confirm the model honors the instruction.
- **Stop stripping the honest hedge:** narrow `INTERNAL_PHRASE_PATTERNS`
  (`lib/report-polish.js:4-20`) so a deliberate "thin evidence" banner is preserved. **(a)**
- **Product decision:** the exact thresholds (e.g. "≥3 abstract+ papers from ≥2 sources = strong")
  and whether to *block* vs *label* a dossier-only report. **(c)**

### Pillar 2 — Strict JSON-schema validation + retry on the builder output
**Goal:** builder output is structurally valid, every ref resolves to a retrieved paper, no
model-authored DOIs/URLs, required sections present.
- **`lib/kb-builder.js` — add `validateExtract(ex, papers)`** called inside `callExtract`
  (`:89-112`): assert shape of `pinnedItems/canonicalFacts/excludedAgents/pipelineDrugs`, every
  `ref`/`refs` integer in range (reuse `validRef`), and reject any string field containing a
  `doi.org`/`pubmed`/`http` token (the model must never author identifiers). On failure, **retry
  once** with a repair instruction appended, then fall back to `assembleKbFromExtract` of whatever
  validates. **(a)** to write + unit-test offline; **(b)** to confirm against live model output.
- **Persist a builder QA stamp** on the KB (`schemaVersion`, `refsResolved`, `excludedAgentsCount`,
  `negativePaperCount`) in `assembleKbFromExtract` (`:232-256`) so the store and verifier can
  detect thin builds. **(a)**
- **Add a post-assemble invariant:** every `canonicalFacts[].evidenceRefs` and
  `excludedAgents[].evidenceRef` must point to an emitted `items[].id`. **(a)**

### Pillar 3 — End-to-end anti-contamination provenance
**Goal:** a per-drug/per-condition tag flows build→evidence→synthesis→render; assert no foreign
names leak into a card.
- **Tag at the source:** stamp `conditionSlug` (and, for drug rows, `drugKey`) onto every grounded
  item in `lib/evidence.js` (`groundedForPrompt`, `:497-526`) and on KB fallback rows
  (`api/research.js:200-225`, `toGroundedItem`). **(a)**
- **Render-time assertion:** add `assertNoForeignEntities(card, { conditionSlug, allowedDrugKeys })`
  in `lib/report-polish.js` (alongside `excludedAgentNames`/`drugBaseKey`, `:58-72`, `:288-303`)
  that flags/strips a parsed candidate or treatment card whose name set contains a drug key not in
  the allowed set, or a condition token not matching `conditionSlug`. Wire into
  `finalizeReportText` (`:374-384`). **(a)** logic; **(b)** to confirm it doesn't over-strip on
  real reports.
- **Generalize coherence:** extend `lib/profile-coherence.js` (`:8-70`) beyond breast/sex to a
  data-driven canonical-vs-typed condition check using dossier synonyms. **(a)**
- **Strengthen dedupe provenance:** in `lib/evidence.js:191-213`, when merging rows that disagree
  on `conditionSlug`, keep them separate rather than merging on a coincidental shared key. **(b)**

### Pillar 4 — Precompute/cache the 19K within the 5-min budget
**Goal:** the common case is a cache hit; on-demand build is the fallback; refresh keeps it fresh.
- **Offline batch builder:** new `scripts/build-registry-kb.mjs` (mirror `scripts/build-kb.mjs`)
  that iterates `data/disease-registry.json`, calls `buildKnowledgeBase({mode:'full'})`, runs the
  Pillar-2 validator, and writes only KBs that pass into the dynamic store (Upstash) — not into
  `data/kb` (those stay hand-curated). Run in waves (rare/most-searched first). **(b)** (needs
  live PubMed/LLM); **(c)** for budget/scope (how many of the 19K, in what order, cost ceiling).
- **On-demand as fallback:** raise `MRT_DYNAMIC_KB_BUILD_TIMEOUT_MS` toward the 5-min budget for
  the *foreground* build (`lib/kb-bootstrap.js:22-23`) and persist the result so the *next* user
  always hits cache. Relax/remove the `uncertainty>=0.75` refusal (`:45-47`) — let it build and
  let Pillar 1 label confidence. **(a)** config; **(c)** the timeout/refusal policy.
- **Persistence is mandatory:** require Upstash for the dynamic store in production
  (`lib/kb-store.js:11-13`) — the in-memory backend defeats precompute. **(c)**
- **Refresh policy:** have `pickRefreshBatch` (`lib/brain-refresh.js:91-125`) also walk
  un-built registry slugs, and protect against regressions by only overwriting a stored KB when
  the new build's QA stamp (Pillar 2) is ≥ the existing one. **(a)/(b)**

### Pillar 5 — Verification at scale + CI with email alert
**Goal:** invariants enforced continuously across curated AND dynamic conditions.
- **`scripts/condition-matrix.mjs`** (delivered now): dual-mode invariant harness — OFFLINE
  STRUCTURAL (schema, guardrail serving, parser/contamination fixtures, trials fixtures) + LIVE
  (gather+synth per condition asserting I1–I5). Includes curated + genuinely non-curated Mondo
  conditions, each marked for server-need. **(a)** offline; **(b)** live.
- **CI wiring (delivered):** `.github/workflows/ci.yml` runs the two **offline** suites
  (`node scripts/regression-platform.mjs` then `node scripts/condition-matrix.mjs`) on every
  `push`/`pull_request` to `main`, on manual `workflow_dispatch`, and on a daily `schedule`
  (07:17 UTC). The job uses Node 20 and `npm ci`. No API keys, no running server, no network to
  Anthropic/PubMed are required for this job. On any non-zero exit a final step gated on
  `if: failure()` emails **shaque025@gmail.com** via `dawidd6/action-send-mail`, including the
  repo, branch/ref, trigger, commit SHA, failed job, and the failing run URL.
- **Live matrix (optional, deferred):** the `--live` mode (`npm run regression:matrix:live`)
  still needs a deployed/running server + API keys and is **not** in CI yet. Wire it later as a
  secret-gated, schedule-only job pointing `MRT_BASE_URL` at a deployed URL.

#### GitHub secrets the owner must add
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret          | Value (Gmail App Password path)                                     |
| --------------- | ------------------------------------------------------------------- |
| `SMTP_HOST`     | `smtp.gmail.com`                                                    |
| `SMTP_PORT`     | `465`                                                              |
| `SMTP_USERNAME` | `shaque025@gmail.com`                                              |
| `SMTP_PASSWORD` | a **Gmail App Password** (NOT the normal account password)         |

To mint the Gmail App Password: Google Account → **Security** → enable **2-Step Verification**
(required) → **App passwords** → generate one for "Mail" / "Other (CI)" → copy the 16-character
value into `SMTP_PASSWORD`. The recipient address is hard-coded as `shaque025@gmail.com` in the
workflow, so it is not a secret. A transactional provider (SendGrid/Mailgun/Postmark) works too:
just set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USERNAME`/`SMTP_PASSWORD` to that provider's SMTP creds.

Without these secrets the test steps still run and gate `main` correctly; only the failure email
is skipped (the action no-ops with empty credentials).

---

## Implementation + verification checklist (when the dev server is up)

Offline (no server, no LLM) — safe now / safe to verify later:
- [ ] `node --check scripts/condition-matrix.mjs` (done at authoring).
- [ ] `node scripts/condition-matrix.mjs` (offline structural mode) → exits 0; all schema,
      guardrail-serving, parser/contamination, and trials fixtures pass.
- [ ] `node scripts/regression-platform.mjs` still green.
- [ ] Implement Pillar 1 grading + Pillar 2 validator/retry + Pillar 3 provenance tags & assertion
      (all (a)); re-run both scripts.

Live (server + keys) — needs runtime verification (do not trust until run):
- [ ] `MRT_BASE_URL=http://localhost:3000 node scripts/condition-matrix.mjs --live` for a curated
      condition (e.g. IPF) and a non-curated Mondo entry (e.g. "Tuberculous fibrosis of lung").
- [ ] Confirm dynamic build now populates a QA stamp and that thin builds are labeled, not silently
      rendered (Pillar 1).
- [ ] Confirm contamination assertion does not over-strip legitimate content (Pillar 3).
- [ ] Run the offline batch builder on a small wave; confirm cache hits on re-query (Pillar 4).

Product decisions required (c):
- [ ] Grounding thresholds; block vs label dossier-only reports.
- [ ] How many of the 19K to precompute, ordering, and cost ceiling; mandate Upstash in prod.
- [ ] Foreground build timeout / uncertainty-refusal policy.
- [ ] CI provider + secret storage for the scheduled live matrix + email alerts.

---

## Bottom line
The dynamic path is **functional but not yet "useful + no contamination" for the 19K.** It
reliably *serves* guardrails and sanitizes output, but for non-curated conditions the guardrails
are usually **empty at generation time**, grounding can degrade **silently** to dossier-derived
"sources", and resolution can **confidently match the wrong Mondo entry**. Highest-leverage
changes, in order: (1) the loud grounding-sufficiency gate (Pillar 1) to kill silent degradation;
(2) builder schema validation + retry and a QA stamp (Pillar 2) so a build is trustworthy or
rejected; (3) precompute + mandatory persistence (Pillar 4) so the common case is a vetted cache
hit within budget; then (3-provenance) and (5-verification) to lock it in.

