# API Backend

Vercel serverless functions in `api/` plus shared `lib/` modules invoked
in-process (not separate HTTP routes).

## HTTP routes (`api/`)

| Route | File | Purpose |
| ----- | ---- | ------- |
| `POST /api/research` | `research.js` | Main pipeline — research, repurpose, trials narrative, chat, gather/synth phases, plus utility modes (see below) |
| `POST /api/trials` | `trials.js` | Live ClinicalTrials.gov v2 pull with enrichment |
| `GET /api/health` | `health.js` | Platform readiness (no AI spend) |
| `POST /api/alerts-subscribe` | `alerts-subscribe.js` | Weekly digest subscriptions |
| `GET/POST /api/alerts-cron` | `alerts-cron.js` | Cron-triggered digest sender (gated by `CRON_SECRET`) |
| `GET/POST /api/brain-cron` | `brain-cron.js` | Nightly dynamic-KB refresh queue |

## In-process modules (`lib/`)

These export Vercel-style handlers used by `research.js`, `evidence.js`, and
the e2e/regression harness — **not** mounted as their own `/api/*` routes:

- `evidence.js` — fan-out orchestrator (PubMed, Europe PMC, OpenAlex, openFDA, Unpaywall)
- `validate.js` — cross-AI citation audit (Perplexity / OpenAI / xAI)
- `kb.js` — curated per-disease knowledge-base loader
- `pubmed.js`, `europe-pmc.js`, `openalex.js`, `openfda.js`, `unpaywall.js` — source APIs
- `perplexity-search.js` — live web search for supplements / brain refresh
- `disease-dossier.js` — realtime disease-intake dossier agent

## POST /api/research

**Core modes** (body: `{ mode, patient, audience, userQuery?, chatHistory?, trialsData? }`):

| `mode` | Description |
| ------ | ----------- |
| `research` | Full evidence-based treatment analysis (gather → synthesize) |
| `repurpose` | EveryCure-style drug repurposing |
| `trials` | Narrative on structured `/api/trials` output (`trialsData` required) |
| `chat` | Follow-up in prior context |

- `patient`: `{ condition, stage, age, gender, weight, smoking, exercise, diagnoses, medications, symptoms, labWork, scans }`
- `audience`: `layperson` | `medical`
- `phase`: `gather` | `synthesize` | `all` (split pipeline to stay within function limits)
- `half`: `front` | `back` (split long synthesis calls)

**Utility modes** (multiplexed through the same endpoint):

| `mode` | Body fields | Returns |
| ------ | ----------- | ------- |
| `usage` | — | Monthly IP usage + plan status |
| `activate-plan` | `{ code }` | Activates Pro/Max plan for caller IP |
| `runtime-config` | — | Branding, monetization, ad runtime config |
| `translate` | `{ text, targetLanguage, sourceLanguage? }` | On-demand translation |
| `benchmark-models` | — | Single-run Sonnet vs Opus speed comparison |
| `resolve-condition` | `{ condition }` | Canonical condition resolution |
| `condition-subtypes` | `{ condition }` | Subtype picker options |
| `parse-patient-message` | `{ message }` | Extract patient fields from free text |
| `validate` | `{ analysisText, evidencePack, ... }` | Cross-AI audit verdicts |
| `polish-report` | `{ text, evidence, trials, validation }` | Server-side report polish |

## POST /api/trials

Body: `{ condition, recruitingOnly?, treatmentOnly?, excludePlacebo?, pageSize?, country? }`

Returns ranked trials from ClinicalTrials.gov v2: phase, recruiting status,
placebo flag, designations (fast-track/breakthrough/orphan/EA), oversight,
locations, contacts.

## Environment variables

**Required**

- `ANTHROPIC_API_KEY` — primary synthesis model

**Recommended**

- `PERPLEXITY_API_KEY` — cross-AI audit with live web search (can open cited URLs)
- `NCBI_API_KEY` — PubMed rate limit 3 → 10 req/s

**Optional**

- `ANTHROPIC_RESEARCH_MODEL` — synthesis model override (default Sonnet 4)
- `ANTHROPIC_MAX_TOKENS` — per-call output token cap
- `OPENAI_API_KEY`, `XAI_API_KEY` — audit fallbacks
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — persistent usage/subscriptions/brain store
- `RESEND_API_KEY`, `ALERTS_EMAIL_FROM`, `ALERTS_PUBLIC_URL` — email digests
- `CRON_SECRET` — gates cron endpoints
- `MRT_ACCESS_PASSCODE` — private-preview access gate (`x-access-passcode` header)
- `MRT_FREE_LIMIT`, `MRT_PRO_LIMIT`, `MRT_MAX_LIMIT` — monthly per-IP caps
- `MRT_PRO_CODES`, `MRT_MAX_CODES`, `MRT_PAID_IPS` — plan activation
- `MRT_UPGRADE_URL`, `MRT_ADS_ENABLED`, `MRT_ADSENSE_CLIENT`, ad slot vars

Set in Vercel: `vercel env add ANTHROPIC_API_KEY` (repeat for each var).

## Local development

```bash
npm run dev          # vercel dev on http://localhost:3000
npm run e2e          # invoke handlers in-process (no browser)
npm run regression:platform
```

Do **not** open `index.html` via `file://` — `/api/*` will not resolve.

## Security

- API keys stay server-side; browser calls `/api/*` only
- Access gate when `MRT_ACCESS_PASSCODE` is set (ON whenever the passcode env is present; leave unset for local/dev)
- Cron routes require `CRON_SECRET`
- Internal in-process calls use `INTERNAL_CALL` symbol (not spoofable from HTTP)
