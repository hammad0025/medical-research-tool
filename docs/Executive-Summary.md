# Medical Research Assistant — Executive Summary

## What this is

An AI-powered medical research platform that answers evidence-based clinical
questions for any condition — grounded in peer-reviewed literature, cross-
audited by a second independent AI model, and personalized to the patient's
actual medications, comorbidities, age, and labs.

Primary audiences are patients and caregivers researching a serious diagnosis,
and medical professionals doing rapid literature reviews.

## The problem

Consumer AI tools are confidently wrong about medicine in ways that matter:

- They cite papers that don't say what the AI claims they say.
- They recommend drugs that interact badly with what the patient is already
  taking.
- They paraphrase when they haven't actually read the paper, then present the
  paraphrase as a verbatim finding.
- They weight a preprint or retracted paper the same as a Cochrane review.
- They have no independent check on their own claims.

A patient researching a serious diagnosis cannot afford any of that.

## What makes this different

### 1. Grounded evidence architecture

Before Claude generates an analysis, a live fan-out is run across:

- NCBI PubMed (metadata + abstracts)
- Europe PMC (metadata + abstracts + open-access full text)
- OpenAlex (broad scholarly coverage, reconstructed abstracts)
- Cochrane Library (gold-standard systematic reviews)
- openFDA (FDA labels, FAERS adverse events, enforcement actions)
- Unpaywall (locates legal open-access PDFs for paywalled DOIs)

Results are deduplicated, scored (journal tier + citations + recency + study
type), and packaged into a "grounded evidence pack." Claude is allowed to
cite *only* from this pack. Hallucinated citations become structurally
impossible.

### 2. Curated knowledge base — pinned ground truth

For conditions we've hand-curated, a per-disease JSON file under `data/kb/`
contains landmark references (society guidelines, defining RCTs, FDA labels,
authoritative reviews). These are *pinned* into every query alongside the
live fan-out, so the AI always has the canonical ground truth as a floor —
not just whatever PubMed happened to rank highly this minute.

Currently curated: **Idiopathic Pulmonary Fibrosis (21 landmark references)**.

### 3. Honest access-level tagging

Every evidence item is stamped `full-text`, `abstract`, or `metadata-only`
based on what content is actually available. The AI is instructed to append
this tag to every citation, and is forbidden from claiming findings from a
paper it only has the abstract for. For paywalled papers, Unpaywall is
automatically queried for legal open-access versions (NIH and EU funders
mandate author-manuscript deposit on institutional repositories, so a
paywalled NEJM paper often has a legal OA PDF elsewhere).

### 4. Cross-AI citation audit

After Claude produces an analysis, a second *independent* model (Perplexity
with live web search is preferred; OpenAI GPT and xAI Grok are fallbacks)
re-checks every factual claim against the same evidence pack. Output:

- Overall agreement score (0–100)
- Agreement level (high / moderate / low)
- Claims the second model **confirmed**
- Claims the second model **disputes** (with correction)
- Claims it found **unsupported** by the pack
- Citations it flagged as **hallucinated** (URL 404s, paper doesn't exist,
  or paper exists but doesn't say what Claude claims)

The audit is rendered as expandable panels in the UI.

### 5. Patient-specific safety

Every recommendation is:

- Checked against the patient's current medications for pharmacokinetic and
  pharmacodynamic interactions.
- Checked against comorbidities for contraindications.
- Checked against age, weight, smoking status, exercise, and lab values for
  suitability.
- Flagged if inappropriate for this specific patient even when otherwise
  effective in the general population.

### 6. Source-quality weighting

Journals are tagged A+ / A / B / C. Stem-cell clinics in jurisdictions
without meaningful regulatory oversight, and drug source-labs with active
FDA warning letters, are flagged and deprioritized. Research from
jurisdictions with documented systemic integrity issues is weighted lower
and flagged explicitly.

## Capability surface

### Core research
- Standard of care for any condition
- Best experts and clinics (peer-recognition, not self-advertising)
- Ranked treatments with Efficacy (0–100) and Safety (0–100)
- Drug-drug interaction check against current medications
- Non-drug / lifestyle recommendations
- Stem cell landscape (reputable sources only)
- Gene therapy landscape
- Cost and insurance outlook

### Drug repurposing (EveryCure-style)
A "professor-to-students" reasoning prompt scans FDA-approved drugs and
supplements for mechanistic logic suggesting they could help a condition
they aren't formally indicated for. Each candidate reports mechanism,
evidence strength, confidence, safety profile, and patient-specific risks.

### Clinical trials deep-dive
Live query against ClinicalTrials.gov v2. Every field that matters:
phase, recruiting status, placebo vs. open-label, fast-track / breakthrough
/ orphan designations, post-trial / expanded-access availability, IRB and
DSMB status, country, contact info.

### Medical records audit
Paste raw records plus (optionally) a summary report. The tool extracts
every abnormal finding with verbatim quotes and flags omissions,
downplayed findings, or unsupported statements in the summary.

### Audience toggle
Every mode can render for either a 10th-grade layperson or a medical
professional — same evidence, different explanation register.

## Architecture

Frontend: single React + Babel HTML file (`index.html`), deployed as a static
asset on Vercel.

Backend: Vercel serverless functions in `api/`, one endpoint per external
source plus one orchestrator (`/api/evidence`) and one AI pipeline
(`/api/research`).

No database. Patient profiles live in `localStorage`. Per-disease knowledge
bases live as JSON files in `data/kb/` and are hot-loaded at request time.

See `README.md` for full architecture diagram and `api/README.md` for
per-endpoint documentation.

## Current status

**Phase 3 shipped.** Curated IPF knowledge base pinned, EveryCure-style
drug repurposing redesigned, cross-AI audit integrated, access-level
tagging honest across the stack, chat mode working substantively, full
e2e test harness passing.

## Roadmap

- **3.1** — Multi-condition KBs (ALS, glioblastoma, others by request) and
  scheduled weekly email alerts on new research.
- **3.2** — OCR for uploaded PDF medical records; structured PHI-strip.
- **4.0** — Mobile app (iOS/Android).
- **4.1** — HIPAA-compliant tenant for clinical deployments (encryption,
  RBAC, audit logs, BAAs with AI providers).

## Licensing & disclaimers

Proprietary. Decision-support research only; not medical advice. All
AI output must be independently verified by a licensed physician before
any clinical action. This prototype is not HIPAA-compliant; no PHI should
be entered. See `LICENSE` for full terms.
