# Demo talking points (operator notes — not patient UI)

Short sheet for live demos after Dorothy’s feedback. **No videos.** Production: `medical-research-tool.vercel.app` (Vercel from `main`).

## Dorothy email status (fixable items)

| Topic | Status | What to say |
|---|---|---|
| Hallucinated patient facts (mild IPF / honeycombing, imaging) | Fixed | Fill **stage** and **scans** on the profile before the run; empty fields stay empty — the model must not invent them. |
| NAD / unknown meds labeled as “sunscreen” etc. | Fixed | Ambiguous abbreviations stay “identity unclear — confirm with prescriber.” |
| Genetics “not tested” → “tested negative” | Fixed | Provided negatives are stated honestly; blank genetics ≠ negative. |
| “Disagreed with” / “not backed by sources” panels | Fixed | Unsupported claims are removed; the independent source-check panel no longer presents unsupported URLs as links. |
| Unsupported efficacy percentages (45/48/50) | Fixed | Cards show reported study outcomes (for example, milliliters per year). Percentage-only scores are removed. |
| Why repurposed drugs might help | Fixed | “Why it might help” / rationale is on every candidate card. |
| Dead / invented paper links | Fixed | Pack + CT.gov + DailyMed only; dead links demoted; Google is never “the paper.” |
| Save errors & learn | Live | Validator findings persist per condition; “Flag an error” teaches future runs. |
| GERD ~87% / antacid | Live | Grounding gate keeps KB-backed claims the second AI wrongly disputes. |
| 25 linked repurposing ideas | Minimum target | Additional searches and registry records are used to find supported ideas. The product shows an honest count and a notice when fewer than 25 are found. |
| Development programs / trials toward 25 | Live | Up to 25 rows from the reviewed reference collection or ClinicalTrials.gov, each with a specific source link; the product reports an honest count when fewer are found. |
| Run 3× and average | **Not built** | See talking point below. |
| Videos / Oregon comparison packages | **Out of scope** | Explicitly not shipping. |
| researchingmycondition.com DNS | Open infra | Use the Vercel URL unless DNS is fixed. |

## If she asks: “Should we run it 3× and average?”

**Say:** We are not averaging three full AI-generated reports tonight. That would triple cost without guaranteeing consistent wording. Current consistency controls include deterministic generation settings, stable drug-library ordering, a minimum candidate target, source-support checks, and dead-link checks. Repeated-run comparison remains a future product decision.

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
- Development programs / trials: specific ClinicalTrials.gov study links only; fewer than 25 is acceptable when fewer relevant records are found
- Independent source-check panel: unsupported URLs appear as plain text rather than links
