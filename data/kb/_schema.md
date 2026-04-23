# Curated Knowledge Base Schema

Each disease gets its own JSON file: `data/kb/<slug>.json`.

The contents of a KB file are **pinned ground truth** — they get included in
every evidence pack for that condition, alongside live-fetched PubMed /
Europe PMC / OpenAlex / FDA results. Claude sees KB items tagged
`[CURATED KB]` so it knows these are the canonical references.

## File schema

```jsonc
{
  "condition": "Idiopathic Pulmonary Fibrosis",
  "slug": "ipf",
  "aliases": ["IPF", "UIP", "usual interstitial pneumonia"],
  "version": "2026-04",
  "curatedBy": "Syed Hammad Haque",
  "lastUpdated": "2026-04-21",

  "items": [
    {
      "id": "ipf-ats-ers-2022",
      "category": "clinical-guideline",       // guideline | rct | review | fda-label | expert-consensus | negative-trial
      "tier": "A+",                            // A+ | A | B | C (for UI ranking)
      "title": "ATS/ERS/JRS/ALAT Clinical Practice Guideline: IPF and Progressive Pulmonary Fibrosis (2022 update)",
      "authors": "Raghu G, Remy-Jardin M, Richeldi L, et al.",
      "journal": "American Journal of Respiratory and Critical Care Medicine",
      "year": 2022,
      "doi": "10.1164/rccm.202202-0399ST",
      "pmid": "35486072",
      "url": "https://www.atsjournals.org/doi/10.1164/rccm.202202-0399ST",
      "accessLevel": "full-text",              // full-text | abstract | metadata-only
      "summary": "One-paragraph editorial summary for Claude context.",
      "keyPassages": [
        { "topic": "pirfenidone", "quote": "verbatim passage..." }
      ]
    }
  ],

  "canonicalFacts": [
    {
      "claim": "Median survival after IPF diagnosis without antifibrotic therapy is 3-5 years.",
      "evidenceRefs": ["ipf-ats-ers-2022", "ipf-raghu-2006"]
    }
  ],

  "lifestyleRecommendations": [
    {
      "recommendation": "Treat GERD aggressively; micro-aspiration is implicated in IPF progression.",
      "evidenceRefs": ["ipf-ats-ers-2022"]
    }
  ],

  "redFlags": [
    "Do NOT use prednisone + azathioprine + NAC triple therapy — PANTHER-IPF showed harm (increased mortality and hospitalization)."
  ],

  // Pipeline drugs / agents the synthesis MUST evaluate. This is the
  // anti-"AI slop" guardrail: every drug listed here is (a) expanded into
  // explicit drug-name search queries across PubMed/EPMC/OpenAlex and
  // ClinicalTrials.gov so the evidence pack is guaranteed to include it,
  // (b) injected as a REQUIRED MENTION into the synthesis prompt, and
  // (c) checked against the final output by a post-synthesis coverage
  // audit that forces Claude to rewrite the analysis if any listed drug
  // was omitted.
  //
  // Include everything serious: FDA-approved, phase 3 active, phase 2b
  // with positive readout, and any high-visibility pipeline agent a
  // patient/physician might reasonably ask about.
  "pipelineDrugs": [
    {
      "name": "Nerandomilast",
      "aliases": ["BI 1015550", "BI1015550"],
      "mechanism": "preferential PDE4B inhibitor (anti-inflammatory + anti-fibrotic)",
      "sponsor": "Boehringer Ingelheim",
      "status": "phase 3 — FIBRONEER-IPF met primary endpoint Sept 2024; FDA filing anticipated",
      "approvalStatus": "investigational",
      "pmid": "35569036",
      "doi": "10.1056/NEJMoa2201737",
      "nct": "NCT05321069",
      "whyItMatters": "First mechanistically novel IPF agent to read out positive in phase 3 in a decade. Best-in-class pipeline candidate."
    }
  ],

  // Agents explicitly excluded from recommendation, with reason. These
  // appear in the "Agents evaluated" transparency block so users can see
  // that we considered and rejected them — they are NOT silently dropped.
  "excludedAgents": [
    {
      "name": "Triple therapy (prednisone + azathioprine + N-acetylcysteine)",
      "reason": "PANTHER-IPF (2012) — early DSMB stop for increased mortality and hospitalization.",
      "evidenceRef": "ipf-panther-2012"
    }
  ]
}
```

## Rules for adding items

1. **Real DOIs and real URLs only.** Every `url` must resolve and every `doi`
   must be valid. If it 404s, we've failed our own hallucination test.
2. **`accessLevel` must be honest.** If the full text is paywalled, set
   `"abstract"`. If we only have the title and no abstract text, set
   `"metadata-only"`. The grounding prompt depends on this to constrain
   what Claude is allowed to claim.
3. **Verbatim quotes only in `keyPassages.quote`.** No paraphrasing. If you
   can't find a verbatim passage in an open-access source, leave
   `keyPassages` empty and rely on `summary`.
4. **Editorial `summary` is clearly labeled.** Claude is told this is an
   editor's synopsis, not a verbatim paper quote — so it won't quote the
   summary back as if it were from the paper.
5. **Categories that belong in a KB:**
   - `clinical-guideline` — society-endorsed practice guidelines
   - `rct` — landmark randomized controlled trials
   - `negative-trial` — trials that disproved a treatment (e.g. PANTHER-IPF)
   - `review` — authoritative review articles
   - `fda-label` — current FDA drug labels
   - `expert-consensus` — non-RCT expert position statements
6. **Do NOT include items just because they're recent.** Recency is handled
   by the live-fetch layer. The KB is the canonical floor.

## How to add a new disease

1. Copy `ipf.json` to `<slug>.json`.
2. Replace `condition`, `slug`, `aliases`, `items`, `canonicalFacts`,
   `lifestyleRecommendations`, `redFlags`.
3. Restart the server (items are read at request time so no rebuild needed).
4. Confirm `/api/kb?condition=<name>` returns the new KB.
