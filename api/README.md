# API Backend

Vercel serverless functions for the Medical Research Assistant. Six HTTP routes
live here; evidence sources and cross-AI validation run as **in-process lib
handlers** (not separate `/api/*` routes) to stay within Vercel Hobby function
limits.

## Routes (`api/`)

```
api/
├── research.js         # Main pipeline — research | repurpose | trials | chat
│                       # + utility modes: usage, activate-plan, runtime-config,
│                         translate, benchmark-models
├── trials.js           # ClinicalTrials.gov v2 pull with structured enrichment
├── health.js           # Infra / KB health check
├── alerts-subscribe.js # Email alert subscription management
├── alerts-cron.js      # Scheduled alert delivery (CRON_SECRET)
└── brain-cron.js       # Scheduled KB brain refresh (CRON_SECRET)
```

## In-process lib handlers (`lib/`)

Called directly from `research.js` (and cron jobs) — no HTTP hop:

```
lib/
├── evidence.js         # Fan-out: PubMed + Europe PMC + OpenAlex + openFDA → evidence pack
├── validate.js         # Cross-AI audit (Perplexity / OpenAI / xAI)
├── perplexity-search.js
├── pubmed.js           # NCBI E-utilities
├── europe-pmc.js       # Europe PMC + OA full text
├── openalex.js         # OpenAlex scholarly coverage
└── openfda.js          # openFDA labels, FAERS, enforcement
```

Internal calls use `INTERNAL_CALL` (see `lib/internal-call.js`) so peer
handlers are not exposed as public endpoints.

## Endpoints

### POST /api/research

Primary entry point. Body shape depends on `mode`:

| mode | purpose |
|------|---------|
| `research` (default) | Full evidence-based treatment analysis |
| `repurpose` | EveryCure-style drug repurposing |
| `trials` | Narrative analysis on live trial data (pass `trialsData` from `/api/trials`) |
| `chat` | Follow-up in existing context |
| `usage` | Monthly IP usage + plan status |
| `activate-plan` | Activate paid plan with `{ code }` |
| `runtime-config` | Branding / monetization / ad runtime config |
| `translate` | On-demand translation `{ text, targetLanguage, sourceLanguage? }` |
| `benchmark-models` | Single-run Sonnet vs Opus speed comparison |

Common fields: `patient`, `audience` (`layperson` | `medical`), optional
`userQuery`, `chatHistory`.

For `research` and `repurpose`, the handler gathers a grounded evidence pack
in-process, then calls Anthropic with instructions to cite only from that pack.

### POST /api/trials

Body: `{ condition, recruitingOnly?, treatmentOnly?, excludePlacebo?, pageSize?, country? }`

Returns ranked trials from ClinicalTrials.gov v2 (phase, recruiting status,
placebo flag, designations, oversight, locations, contacts).

### GET /api/health

Infra status and loaded KB summary.

### POST /api/alerts-subscribe

Subscribe / manage email research alerts.

### GET /api/alerts-cron · GET /api/brain-cron

Vercel cron routes — require `CRON_SECRET`, not for browser use.

## Flow

1. Frontend calls `/api/research` (or `/api/trials` for structured trial data).
2. `research.js` enforces access gate, usage limits, and spend controls.
3. Evidence fan-out runs in-process via `lib/evidence.js`.
4. Anthropic synthesizes from the grounded pack; optional cross-AI audit via `lib/validate.js`.
5. Response returns to the frontend for chart parsing.

## Environment variables

**Required**

- `ANTHROPIC_API_KEY` — Anthropic API key

**Optional — models & evidence**

- `ANTHROPIC_RESEARCH_MODEL` — synthesis model (default `claude-sonnet-4-20250514`)
- `ANTHROPIC_MAX_TOKENS` — output token cap override
- `NCBI_API_KEY` — PubMed rate limit (3 → 10 req/s)
- `PERPLEXITY_API_KEY` — cross-AI audit (recommended; live web search)
- `OPENAI_API_KEY`, `XAI_API_KEY` — audit fallbacks

**Optional — access & usage**

- `MRT_ACCESS_PASSCODE` — site-wide passcode gate (comma-separated)
- `MRT_FREE_LIMIT`, `MRT_PRO_LIMIT`, `MRT_MAX_LIMIT` — monthly caps per IP
- `MRT_PRO_CODES`, `MRT_MAX_CODES`, `MRT_PAID_CODES` — plan activation codes
- `MRT_PAID_IPS` — always-max IP allowlist
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — durable usage store

**Optional — UI / monetization**

- `MRT_UPGRADE_URL`, `MRT_PRO_PRICE_USD`, `MRT_MAX_PRICE_USD`
- `MRT_ADS_ENABLED`, `MRT_ADSENSE_CLIENT`, `MRT_AD_SLOT_*`

Set in Vercel: `vercel env add <NAME>`

## Local testing

```bash
npm i -g vercel
vercel dev

curl -X POST http://localhost:3000/api/research \
  -H "Content-Type: application/json" \
  -d '{"mode":"research","patient":{"condition":"IPF"},"audience":"layperson"}'
```

## Security

- API keys stay server-side only
- CORS configured on all routes
- Access gate via `MRT_ACCESS_PASSCODE` when enabled
- IP-based usage metering (Redis or in-memory fallback)
- Cron routes protected by `CRON_SECRET`
