# researchingmycondition.com - Private Research Beta

A source-first, private-beta medical-research product for Dorothy's review. It accepts any entered diagnosis, subtype, gene, or phenotype; IPF is an enriched example with a curator-reviewed reference pack.

## What it demonstrates

- Live multi-source evidence retrieval for any condition: PubMed, Europe PMC, Crossref, Semantic Scholar, NIH RePORTER, openFDA labels when relevant, and OpenAlex when configured
- Optional broad web discovery through Perplexity, with raw web results kept separate from clinical claims until another supported source verifies them
- A target-linked hypothesis path: Open Targets disease-to-target associations and ChEMBL compound-target activity records can create named research questions, but only after PubMed and Europe PMC find no condition match
- A separate, worker-ready transcriptomic-inversion engine for curated human disease signatures and measured CMap/LINCS compound signatures; it is source-linked, thresholded, and withheld until literature checks finish
- An optional plain-language intake that extracts only explicitly stated facts into reviewable profile fields
- A curator-reviewed IPF evidence core that does not depend on model memory
- A separate, explicitly exploratory workbench for mechanisms and research questions
- Live recruiting interventional trials and active research sites from ClinicalTrials.gov
- A source list that separates retrieved records, metadata-only records withheld from AI, unavailable databases, and authoritative manual search routes
- A safety check that withholds ungrounded, prescriptive, dosing, and unsupported guideline-strength language
- Direct source links next to the report's major claims and in exports
- A server-checked passcode, private-beta Terms, Privacy notice, and plain-language safety notices
- A no-profile-database design: the app does not create patient accounts or save submitted profiles and reports in an application database
- Browser security headers and a best-effort server-side rate limit for expensive research runs

The suggestion chips are only shortcuts. A user can enter any condition, subtype, gene, or phenotype. The report always shows the main sections: treatment ideas, research questions, daily-life topics, study sites, and current-trial next steps. When live retrieval is thin or temporarily unavailable, a clearly labeled AI starting map fills the gap with cautious ideas to verify. It does not pretend those ideas are proven evidence or personal medical advice.

## Run locally

```bash
cd /Users/hammadhaque/Documents/Codex/2026-08-08/s/work/app
npm run dev
```

Open the local Vite URL, normally `http://127.0.0.1:5173`.

Create `.env.local` from `.env.example` and set a private passcode before starting the demo:

```bash
SITE_ACCESS_PASSCODE=choose-a-long-private-passcode
SITE_ACCESS_SECURE_COOKIE=false
npm run dev
```

Restart the dev server after changing `.env.local`. The passcode is checked by the local server and creates a 12-hour HttpOnly session cookie. `SITE_ACCESS_SECURE_COOKIE` must be `true` when the app is served over HTTPS; keep it `false` for local HTTP.

For a Vercel deployment, set these **server-side** Vercel environment variables before deploying. The included `api/[...path].js` function serves the same API routes used locally, and `vercel.json` makes Vercel run the release gate before building:

```bash
SITE_ACCESS_PASSCODE=choose-a-long-private-passcode
SITE_ACCESS_SECURE_COOKIE=true
SITE_ACCESS_SESSION_SECRET=at-least-32-random-characters
RESEARCH_RUN_MAX_PER_WINDOW=6
```

`SITE_ACCESS_SESSION_SECRET` is required on serverless hosting so the signed access cookie works across separate function instances. Generate a different random value for each environment and keep it in the host secret store. A Vercel deployment without a strong signing secret or secure cookies stays locked instead of exposing the research API. `RESEARCH_RUN_MAX_PER_WINDOW` controls an in-memory per-connection safeguard against repeated paid research calls; it is best effort on serverless hosting, not an account quota. The included Vercel function is allowed up to five minutes so it matches the app's four-minute report timeout; make sure Fluid Compute remains enabled in the Vercel project.

The IPF evidence core works without any model key. Configure a local server-side Anthropic or OpenAI key to enable the writer and a separate source-check pass. When Anthropic writes and OpenAI reviews, the reviewer is a different provider; if the writer falls back to OpenAI, the app labels the result as a separate second pass rather than an independent-provider review. OpenAlex is optional and adds a separate scholarly-metadata lane when its key is configured:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENALEX_API_KEY=...
npm run dev
```

`ANTHROPIC_API_KEY` enables the preferred writer. `OPENAI_API_KEY` enables a writer fallback and reviewer. PubMed, Europe PMC, openFDA, and ClinicalTrials.gov work without additional keys. `OPENALEX_API_KEY` is optional; without it, its source lane is shown as not connected. No key is sent to the browser.

## Architecture

1. The browser first requests a server-issued passcode session, then collects a temporary research intake and calls `/api/research-run`.
2. The browser requires a private-beta safety acknowledgement and links to Terms and Privacy pages. The server rejects missing acknowledgement and blocks several obvious direct identifiers, such as email addresses, phone numbers, dates of birth, insurance/member numbers, medical-record numbers, and street addresses.
3. If the optional plain-language intake is used, Anthropic extracts only explicitly stated facts into the form; the user reviews those fields before research can run.
4. For IPF, the local server adds its curated reference packet; every run also retrieves independent exact-condition records from PubMed, Europe PMC, Crossref, Semantic Scholar, openFDA labels where relevant, NIH RePORTER active projects, and OpenAlex when configured. An optional Perplexity web-search lane discovers relevant sites beyond those databases but remains link-only until another supported source verifies a claim.
5. The server deduplicates records by PMID, DOI, or title, rejects retracted or condition-mismatched sources, and withholds metadata-only records from the AI packet while retaining them in the source ledger.
6. For a target-linked research question, the server requires an exact Open Targets disease-to-target association and a ChEMBL compound-target activity record. It then searches the condition and the candidate together in PubMed and Europe PMC. Any result in the condition, a close medical name, or an included related disease model blocks the card from being labeled “Not researched for this condition.”
7. The server pulls live recruiting studies from ClinicalTrials.gov and shows matching active research sites, never an invented "best doctor" ranking.
8. Cochrane Library, WHO ICTRP, and EU CTIS appear as authoritative search routes until a supported record-level or licensed connector is integrated. They are not scraped or represented as retrieved evidence.
9. The preferred Anthropic writer, or OpenAI fallback, receives only the eligible source packet and returns structured JSON. It may only discuss entities and source IDs in that packet.
10. A second reviewer request receives the draft plus the same packet and may approve, rewrite, or reject every item. The interface calls it an independent-provider review only when the writer and reviewer use different providers.
11. A deterministic server gate accepts only known source IDs and blocks medical instructions, dosage language, unsafe promotional claims, invented center rankings, and ungrounded content.

The important product choice is that the AI cannot rewrite retrieved or curated source material. It can only produce a separately labeled research briefing after the reviewer accepts it. Accepted model content renders with direct source links.

## Transcriptomic research worker

`scripts/transcriptomicInversionWorker.mjs` is intentionally outside the Vercel
report request. It ranks named compounds with measured CMap/LINCS signatures
against a curated human disease signature, then requires complete PubMed and
Europe PMC checks before releasing a research hypothesis. It does not generate
molecules, train a model, infer efficacy, or write treatment advice. See
[`docs/transcriptomic-inversion-worker.md`](docs/transcriptomic-inversion-worker.md)
for the job contract and deployment boundary.

`scripts/geoSignatureIngestionWorker.mjs` provides the first data-ingestion
step: it searches GEO, downloads a selected Series metadata manifest, and turns
a curator-verified DGE table into a signed human disease signature. It does not
infer cohorts or generate statistics from a raw matrix.

`scripts/exportLincsGctxSlice.py` and `scripts/lincsSignatureIngestionWorker.mjs`
provide the matching local LINCS path. The Python exporter requires a separate
compute environment with `h5py` and an authorized local GCTx file; the Node
importer only accepts documented Level 5 MODZ small-molecule signatures.

For a private AWS Batch implementation of this worker, including encrypted S3
source/result buckets, an ECR worker image, job isolation, and an explicit
no-patient-data input contract, see
[`infra/aws/README.md`](infra/aws/README.md). It is intentionally separate from
the Vercel website and is not deployed until AWS account and source-license
details are supplied.

## Verification

```bash
npm run check
npm run build
```

`npm run build` runs `npm run check` first, so a normal Vercel or other Node-hosted deployment fails before publishing if linting or unit tests fail.

## Deployment verification

Use the release check after a deploy. It makes only fictional requests and does not use a real patient profile. Without a test passcode, it confirms that the landing page works, the server-side passcode is enabled, anonymous API access is blocked, and an incorrect passcode is rejected:

```bash
DEPLOYMENT_URL=https://your-deployment.example npm run verify:deployment
```

For a complete release check, store the deployed site's `SITE_ACCESS_PASSCODE` again as `DEPLOYMENT_TEST_PASSCODE` in your CI secret store. The command then signs in, verifies the privacy acknowledgement, runs a fictional Retinitis Pigmentosa report, confirms it contains treatment ideas, lifestyle topics, safety items, and research connections, then confirms logout re-locks the API:

```bash
DEPLOYMENT_URL=https://your-deployment.example \
DEPLOYMENT_TEST_PASSCODE=your-ci-only-test-passcode \
npm run verify:deployment
```

Keep `DEPLOYMENT_TEST_PASSCODE` in your deployment or CI secret store, never in source code, browser variables, screenshots, or chat. The checker expects the deployed server to have the same value in `SITE_ACCESS_PASSCODE`. Set `DEPLOYMENT_FULL_RUN=false` only when you deliberately want an authenticated API check without spending a report run.

## Privacy and safety

- This is for learning and research. It is not medical advice, a diagnosis, a prescription, or a medical recommendation. It is not for emergencies.
- Do not enter real patient details. The optional profile helper and a research run send supplied context to the configured AI providers and research services. The built-in identifier check is only a safety net; it cannot reliably catch every identifying detail.
- The app is designed not to create patient accounts or save submitted profiles and reports in an application database. It still processes submitted information during the request, and providers may process it under their own terms and data policies.
- This private beta is not HIPAA-ready and must not be described as HIPAA compliant.
- The passcode protects this local Vite server and its API routes. For a public deployment, put an equivalent server-side or host-level access control in front of the full site and API. A browser-only passcode screen is not sufficient security.
- Real patient use requires legal, privacy, security, clinical-governance, and vendor-contract review before launch, including the controls required for the specific organization and data involved.

## Private-beta launch gate

See [PRIVATE_BETA_LAUNCH.md](PRIVATE_BETA_LAUNCH.md) before accepting money, allowing real patient data, or describing the product as clinical or HIPAA compliant.
