# Demo talking points (operator notes — not patient UI)

Short sheet for live demos after Dorothy’s feedback. **No videos.** Production: `medical-research-tool.vercel.app` (Vercel from `main`).

## Dorothy email status (fixable items)

| Topic | Status | What to say |
|---|---|---|
| Hallucinated patient facts (mild IPF / honeycombing, imaging) | Fixed | Fill **stage** and **scans** on the profile before the run; empty fields stay empty — the model must not invent them. |
| NAD / unknown meds labeled as “sunscreen” etc. | Fixed | Ambiguous abbreviations stay “identity unclear — confirm with prescriber.” |
| Genetics “not tested” → “tested negative” | Fixed | Provided negatives are stated honestly; blank genetics ≠ negative. |
| “Disagreed with” / “not backed by sources” panels | Fixed | Unbacked claims are removed; second-AI panel no longer lists fake clickable URLs. |
| Made-up efficacy % (45/48/50) | Fixed | Cards show real study outcomes (e.g. mL/year). Lone `NN%` scores are stripped. |
| Why repurposed drugs might help | Fixed | “Why it might help” / rationale is on every candidate card. |
| Dead / invented paper links | Fixed | Pack + CT.gov + DailyMed only; dead links demoted; Google is never “the paper.” |
| Save errors & learn | Live | Validator findings persist per condition; “Flag an error” teaches future runs. |
| GERD ~87% / antacid | Live | Grounding gate keeps KB-backed claims the second AI wrongly disputes. |
| 25 linked repurpose ideas | Hard floor | Multi-pass backfill + registry fill (MECHANISTIC_ONLY + DailyMed). Banner if still under 25. |
| Pipeline / trials toward 25 | Live | Up to 25 rows **from real KB / CT.gov data** with NCT or pack URL — honest count if fewer. |
| Run 3× and average | **Not built** | See talking point below. |
| Videos / Oregon comparison packages | **Out of scope** | Explicitly not shipping. |
| researchingmycondition.com DNS | Open infra | Use the Vercel URL unless DNS is fixed. |

## If she asks: “Should we run it 3× and average?”

**Say:** We’re not averaging three full LLM runs tonight. That would triple cost and still leave residual wording drift. What we *did* ship for consistency: temperature 0, deterministic drug-library ordering, Hard-25 linked floor, and grounding/dead-link gates so citations and counts don’t randomly collapse. Averaging three narrative reports is a product decision for later if she still wants it.

## If she asks about videos

**Say:** Video embeds and Oregon comparison packages are deliberately out of this release — software-only hardening for links, counts, and invented facts.

## Profile fields to fill before a demo (critical)

Leave these blank and the model correctly refuses to invent them — but her earlier screenshots looked like hallucinations when the second AI never saw the fields. For a clean IPF (or similar) demo:

1. **Primary condition** — e.g. Idiopathic pulmonary fibrosis  
2. **Age / sex**  
3. **Current medications** — list real meds; if using “NAD”, keep it as written (identity stays unclear unless you expand it)  
4. **Stage** — only if the patient actually has one (e.g. mild / moderate); otherwise leave blank or “unknown”  
5. **Scans / imaging** — only real findings; otherwise blank  
6. **Genetics** — positive variant, provided negative, or “not tested” — never invent  
7. **Comorbidities** — e.g. GERD if discussing antacids  

## Quick live checks after a run

- Repurpose tab: **≥25** cards; each REFERENCES link is pack / CT.gov / DailyMed — not Google-as-paper  
- No lone efficacy “47%” meters without endpoint language  
- Pipeline Watch / Trials: real NCT links only; fewer than 25 is OK if the pull is thin  
- Second-AI panel: removed URLs shown as plain text, not clickable fakes  
