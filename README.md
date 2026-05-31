# researchingmycondition.com

![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![Status](https://img.shields.io/badge/status-Phase%203-brightgreen.svg)
![License](https://img.shields.io/badge/license-Proprietary-red.svg)

An AI-powered medical research platform (researchingmycondition.com) that gives patients, caregivers, and
clinicians evidence-based treatment research for any condition — grounded in
peer-reviewed literature, cross-audited by a second AI model, and personalized
to the patient's actual medications, comorbidities, and labs.

**Developer:** Syed Hammad Haque (<shaque025@gmail.com>)

---

## Why this exists

Consumer AI tools are confidently wrong about medicine. They cite papers that
don't say what they claim, recommend drugs that interact badly with what the
patient is already taking, and gloss over findings they can't verify. A patient
researching a serious diagnosis deserves better than that.

This tool is built around six principles:

1. **Grounded citations only.** The AI can only cite from a live-fetched
   evidence pack of real peer-reviewed sources. If the pack doesn't support a
   claim, the AI must say so instead of making one up.
2. **Honest access tagging.** Every citation is labeled `[FULL-TEXT]`,
   `[ABSTRACT-ONLY]`, or `[METADATA-ONLY]` so you know exactly how much of the
   paper the AI actually read.
3. **Curated knowledge-base floor.** For conditions we've hand-curated
   (currently IPF), landmark guidelines, RCTs, and FDA labels are pinned into
   every query — you get the canonical ground truth *plus* this week's new
   PubMed research, never one without the other.
4. **Cross-AI audit.** A second, independent model (Perplexity / OpenAI / xAI)
   independently re-checks every factual claim against the same evidence pack
   and flags confirmed / disputed / unsupported / hallucinated citations.
5. **Patient-specific safety.** Every recommendation is checked against the
   patient's current medications for interactions and against comorbidities for
   contraindications.
6. **Low-quality sources excluded.** Stem-cell clinics in jurisdictions with no
   meaningful regulatory oversight, and drug source-labs with active FDA
   warning letters, are flagged and deprioritized.

## Features

### AI Treatment Research

Works for any condition. Personalized to the patient's full profile
(age, gender, weight, smoking, exercise, all diagnoses, all medications,
symptoms, labs/PFTs, imaging). Audience toggle between **10th-grade
layperson** and **medical professional**. Structured output:

- Standard of care
- Best experts and clinics worldwide (peer-recognition, not self-advertising)
- Ranked treatments (Efficacy 0–100, Safety 0–100, verbatim quoted evidence)
- Drug-drug interaction check against the patient's current medications
- Non-drug / lifestyle recommendations
- Stem cell landscape (excluding low-reliability jurisdictions)
- Gene therapy landscape
- Cost and insurance-coverage outlook

### Drug Repurposing (EveryCure-style)

"Professor-to-students" reasoning that scans existing FDA-approved drugs and
supplements for mechanistic logic suggesting they could help a condition they
aren't formally indicated for. Each candidate has:

- Mechanism of action / molecular target
- Evidence strength (from empirical trials to pure hypothesis)
- Confidence score
- Safety profile
- Patient-specific risks (interactions with current meds, contraindications)
- Talking points for a physician conversation

### Clinical Trials Deep-Dive

Live query against ClinicalTrials.gov v2. Every field that matters for a
decision: phase, recruiting status, accepting new patients, placebo vs.
open-label, fast-track / breakthrough / orphan designations, post-trial /
expanded-access / compassionate-use availability, IRB and DSMB status,
country, and contact info. A per-patient AI narrative ranks the best trials
and names specific interactions with the patient's current medications.

### Medical Records Audit

Paste raw records plus (optionally) a summary report. The tool extracts every
abnormal finding with verbatim quotes and flags omissions, downplayed
findings, or unsupported statements in the summary.

### Curated Knowledge Base

Per-disease JSON files under `data/kb/` contain hand-curated landmark
references (guidelines, RCTs, FDA labels, authoritative reviews). The KB is
pinned into every query on that condition as a ground-truth floor, then
supplemented by live-fetched PubMed / Europe PMC / OpenAlex / Unpaywall /
openFDA results.

Shipped now: **Idiopathic Pulmonary Fibrosis** (21 curated items including
the ATS/ERS/JRS/ALAT 2022 guideline, CAPACITY, ASCEND, INPULSIS, INBUILD,
PANTHER-IPF, and FDA labels for pirfenidone and nintedanib).

### Cross-AI Citation Audit

After Claude produces an analysis, a second independent model (Perplexity
with live web search is preferred; OpenAI GPT or xAI Grok are fallbacks)
re-checks every factual claim against the same evidence pack. Output:
overall agreement score, and structured lists of claims that are confirmed,
disputed, unsupported, or citations that were hallucinated.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (index.html · React via Babel · Vercel static)        │
└───────────────┬─────────────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────────────┐
│  Vercel serverless functions (api/)                             │
│                                                                  │
│  /api/research     →  Claude Sonnet with grounded evidence pack │
│  /api/evidence     →  fan-out orchestrator (pulls and merges)   │
│  /api/kb           →  serves curated per-disease ground truth   │
│  /api/pubmed       →  NCBI E-utilities (metadata + abstracts)   │
│  /api/europe-pmc   →  Europe PMC (+ legal open-access fulltext) │
│  /api/openalex     →  OpenAlex (+ abstract inverted index)      │
│  /api/openfda      →  FDA labels + FAERS adverse events         │
│  /api/unpaywall    →  locate legal OA PDFs for paywalled DOIs   │
│  /api/trials       →  ClinicalTrials.gov v2                     │
│  /api/records-audit→  records-vs-summary discrepancy check      │
│  /api/validate     →  cross-AI citation audit                   │
└─────────────────────────────────────────────────────────────────┘
```

See [api/README.md](api/README.md) for full endpoint documentation.

## Quick Start

### Deploy to Vercel (recommended)

1. Get an Anthropic API key from <https://console.anthropic.com/settings/keys>
2. Sign in to <https://vercel.com> with GitHub
3. Import this repository
4. Add environment variable `ANTHROPIC_API_KEY`
5. Deploy

**Optional** environment variables to unlock extra features:

| Variable                    | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | Required. Primary AI model.                                   |
| `PERPLEXITY_API_KEY`        | Recommended. Cross-AI audit (web-search verification).        |
| `OPENAI_API_KEY`            | Alternative cross-AI auditor.                                 |
| `XAI_API_KEY`               | Alternative cross-AI auditor (Grok).                          |
| `NCBI_API_KEY`              | Lifts PubMed rate limit from 3 req/s to 10 req/s.             |
| `RESEND_API_KEY`            | Enables weekly email digests (free tier 3k/month at resend.com). |
| `ALERTS_EMAIL_FROM`         | "From" address for digests. Default `onboarding@resend.dev`.  |
| `ALERTS_PUBLIC_URL`         | Base URL for unsubscribe links in emails (e.g. `https://…vercel.app`). |
| `UPSTASH_REDIS_REST_URL`    | Persistent subscription store. Free tier at upstash.com.      |
| `UPSTASH_REDIS_REST_TOKEN`  | Paired with the URL above.                                    |
| `CRON_SECRET`               | Gates `/api/alerts-cron` against unauthenticated invocations. |
| `MRT_ACCESS_PASSCODE`       | Private-preview access gate. Comma-separate to issue multiple passcodes (one per tester). Every `/api/*` endpoint requires a matching `x-access-passcode` header. Fail-open when unset. |

### Weekly email digests

`vercel.json` registers a cron at `0 14 * * 1` (Monday 14:00 UTC / 9am CT)
that hits `/api/alerts-cron`. For each active subscription the cron runs
the same grounded pipeline the webapp uses, diffs against a per-subscriber
"already sent" ledger, and emails the net-new items via Resend.

To enable in production:

1. Create an account at [resend.com](https://resend.com) and set
   `RESEND_API_KEY` in Vercel. For your own domain, verify it in Resend
   and update `ALERTS_EMAIL_FROM`.
2. Create a free database at [upstash.com](https://upstash.com) → "Redis"
   → copy the REST URL + token into `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`. Without these, subscriptions live in an
   in-memory Map that resets on every cold start.
3. Set `CRON_SECRET` to a random string and add the same value to Vercel's
   cron-job config so only the scheduler can trigger it.
4. Set `ALERTS_PUBLIC_URL` to your deployment URL so unsubscribe links
   in the emails resolve correctly.

You can fire the cron manually for testing:

```bash
# Dry run (no emails sent) — returns the rendered subjects + counts
curl "https://YOUR-APP.vercel.app/api/alerts-cron?dryRun=1&secret=$CRON_SECRET"

# Real run targeting one email only
curl "https://YOUR-APP.vercel.app/api/alerts-cron?onlyEmail=you@example.com&secret=$CRON_SECRET"
```

### Local development

The UI and `/api/*` serverless functions only work together when served by
the Vercel dev server. **Do not** open `index.html` directly (`file://`) or
use `python -m http.server` — those serve static files only and every
`/api/*` call will 404 or fail with a generic server error.

```bash
git clone https://github.com/hammad0025/medical-research-tool.git
cd medical-research-tool
npm i -g vercel   # if needed
vercel env pull .env.local   # must include ANTHROPIC_API_KEY
npm run dev        # same as: vercel dev
```

Then open **http://localhost:3000** (not the file path).

**Port 3000 already in use?** Another app may be bound to it (common on
Mac). Stop that process or run on another port:

```bash
vercel dev --listen 3001
# open http://localhost:3001
```

**501 / "Server unavailable" on localhost** usually means `vercel dev` is
not running, you opened the wrong port, or something other than Vercel is
listening on that port (e.g. a React dev server that does not proxy
`/api/research`).

Or run the end-to-end test harness against the local functions (no browser):

```bash
npm run e2e
```

## Evidence pipeline

On every query for a condition:

1. **Curated KB lookup** (instant, in-process) — if the condition has a KB
   file, 20+ pinned landmark references are loaded.
2. **Live fan-out** (parallel, ~3–5 s) — PubMed, Europe PMC, OpenAlex, and
   Cochrane are queried for the core condition plus any named treatments.
   openFDA is queried for every named drug. Rate limits are respected.
3. **Open-access upgrade** — for paywalled top-ranked items, Unpaywall is
   queried for legal OA copies (NIH / funder-mandated author manuscripts).
4. **Dedup and rank** — items are merged by DOI / PMID. Scoring uses journal
   tier (A+/A/B/C), citation count, recency, open-access status, study type
   (meta-analysis > RCT > review), and a large bonus for curated-KB items.
5. **Access-level tagging** — each item is stamped `full-text`, `abstract`,
   or `metadata-only` based on what content is actually available.
6. **Prompt pack assembly** — the top 25 items are fed to Claude, guaranteed
   to include both KB-curated and live-fetched items (no layer monopolizes).
7. **Cross-AI audit** — after Claude responds, a second model independently
   re-checks every claim against the same pack.

A typical IPF query yields **60–80 unique peer-reviewed sources** in the
pool; **25 reach Claude's prompt** (≈15 curated KB + ≈10 freshly fetched).

## Use cases

### Patients and caregivers
- Understand current and emerging treatments for a diagnosis.
- Explore clinical trials matched to the patient's specific profile.
- Get plain-language explanations (10th-grade reading level option).
- Compare treatments with safety and efficacy numbers.
- Identify world-class experts and treatment centers.
- Check current medications for interactions and contraindications.

### Medical professionals
- Rapid literature reviews grounded in peer-reviewed sources.
- Clinical trial identification with IRB / fast-track / orphan flags.
- Patient-specific recommendations considering comorbidities, meds, age, labs.
- Cost and insurance outlook.
- Stem-cell and gene-therapy landscape scanning.
- Second-opinion cross-AI citation verification before quoting a paper.

## Journal / source quality

| Tier | Examples                                                       | Weight |
| ---- | -------------------------------------------------------------- | ------ |
| A+   | NEJM, Lancet, JAMA, BMJ, Nature Medicine, Cochrane Reviews     | Full   |
| A    | AJRCCM, European Respiratory Journal, Thorax, Chest, Circulation, ERJ, JACC | High |
| B    | Mid-tier specialty journals                                    | Moderate |
| C    | Everything else                                                | Low    |

Geographic weighting: US and Western European research is weighted normally;
research from jurisdictions with documented systemic integrity concerns is
flagged and deprioritized. Stem cell clinics in regions without meaningful
regulatory oversight are excluded from recommendations by default.

## Disclaimers

- **Decision-support research only.** Not medical advice, not a diagnosis,
  not a substitute for a licensed physician.
- **Not HIPAA-compliant.** Do not enter real patient identifying information.
  Strip names, DOBs, MRNs, addresses, and anything else identifying before
  pasting medical content.
- **AI outputs must be independently verified** before acting on them. The
  cross-AI audit layer reduces but does not eliminate hallucination risk.
- **Evidence cutoffs** are inherent in any research tool; the live fan-out
  reaches whatever PubMed / Europe PMC have indexed at query time.

## License

Proprietary. See [LICENSE](LICENSE). Contact <shaque025@gmail.com> for
licensing inquiries.
