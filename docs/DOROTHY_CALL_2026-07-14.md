# Dorothy call notes — July 14, 2026

Operational notes from the live call (timing copy + freeze plan + deliverables).

## Demo / code freeze (August meeting)

- **Meeting:** Wednesday, **August 12, 2026**
- **Hard code freeze:** **Friday, August 7, 2026** — no more feature deploys after this date
- **Why Friday not Monday:** if something breaks over the weekend, there is still Monday–Tuesday to fix; a Monday freeze leaves only Tuesday
- **Before freeze:** full dry run / run-through of the product with Dorothy’s IPF (and any other agreed conditions)
- **Rule:** do not deploy new changes in the day(s) immediately before a Dorothy meeting — deploy risk is operational, not “AI quality”

## Timing copy (agreed on call)

UI previously said Full Report takes **1 to 2 minutes**. Live runs often take **~3–6 minutes**. Agreed to stop overpromising and say **about 5 to 6 minutes** (bold in the Research tab blurb).

## Deliverables Dorothy asked for

1. **User-facing overview** (Word/README-style) — what the software does, in plain language (Hammad to draft; follow-up target discussed around **Aug 22**).
2. **Technical handoff package** (zip / Dropbox): full source, build/deploy/run/maintain instructions, env config, dependencies, scripts — plus architecture explainability (first AI / second AI, grounding, trials ranking, drug repurposing rationale vs ChatGPT).
3. **Accuracy concern (open):** drugs that have been **researched and found beneficial for the condition but are not yet FDA-approved for it** were missing in some runs. Distinct from dead-link bugs. Needs a deliberate product/prompt fix so researched off-label / evidence-backed non-SOC agents are not dropped between “Approved Treatments” and “repurposing ideas.”

## Product talking points (architecture, for the overview doc)

- Selling point vs ChatGPT: curated medical KB + live trials + grounded citations + second-AI audit, not a single chat model.
- Drug repurposing: EveryCure-style hypotheses with local/registry candidates + evidence pack — doctors rarely get paid to invent these.
- Second AI (Perplexity Sonar): independent check for bad links / unsupported claims; score panel is hidden from readers.
