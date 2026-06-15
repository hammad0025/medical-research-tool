# Production infrastructure — brain DB setup

This is the **complete checklist** for making the AI brain persistent and self-improving. You should not need to invent infra — follow this once.

## What you already have (Vercel Production)

| Variable | Status |
|----------|--------|
| `ANTHROPIC_API_KEY` | Set |
| `PERPLEXITY_API_KEY` | Set |
| `MRT_ACCESS_PASSCODE` | Set |

## What you must add (15 minutes)

### 1. Upstash Redis — the brain database

**Why:** Without this, every dynamic knowledge pack, daily refresh, usage limit, and email subscription **vanishes on cold start**. This is the #1 missing piece.

1. Go to [https://upstash.com](https://upstash.com) → sign up (free).
2. **Create Database** → name: `medical-research-brain` → region: **US-East-1** (or nearest to Vercel).
3. Open the database → tab **REST API** (not Redis CLI).
4. Copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

5. Vercel → **medical-research-tool** → Settings → Environment Variables → add both for **Production** (and Preview if you want).

6. **Redeploy** (Deployments → latest → Redeploy).

**Alternative:** Vercel Marketplace → search **Upstash Redis** → Add Integration → auto-injects the same two vars.

### 2. CRON_SECRET — secure daily brain refresh

**Why:** `/api/brain-cron` runs daily at 6am UTC. Without a secret, anyone could trigger it.

```bash
openssl rand -hex 32
```

Add to Vercel as `CRON_SECRET` (Production). Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on scheduled crons.

Redeploy again.

## Verify

```bash
# Local env check (after vercel env pull or .env.local)
node scripts/verify-infra.mjs

# Live production check
MRT_ACCESS_PASSCODE=your-passcode node scripts/verify-infra.mjs --live

# Test daily brain cron manually
MRT_ACCESS_PASSCODE=xxx CRON_SECRET=xxx node scripts/verify-infra.mjs --live --cron
```

Or open the app → runtime-config should show `"store": "upstash-redis"` not `"in-memory"`.

## What runs automatically once Upstash is set

| Schedule | Endpoint | Does |
|----------|----------|------|
| Daily 6am UTC | `/api/brain-cron` | Refreshes 8 conditions: PubMed + Perplexity + ClinicalTrials.gov |
| Monday 2pm UTC | `/api/alerts-cron` | Weekly email digests (needs Resend too) |

Every user search also:
- Pulls live PubMed + Perplexity + trials
- Queues the condition for tomorrow's brain refresh
- Builds a dynamic KB on first search if none exists

## Optional (later)

| Variable | Purpose |
|----------|---------|
| `NCBI_API_KEY` | Faster PubMed (free at ncbi.nlm.nih.gov) |
| `RESEND_API_KEY` | Weekly email alerts |
| `ALERTS_PUBLIC_URL` | Unsubscribe links in emails |
| Custom domain | researchingmycondition.com in Vercel → Domains |

## Architecture

```
User search
    → Live PubMed + Perplexity + CT.gov (every time)
    → Static KB (61 diseases on disk) OR Dynamic KB (Redis)
    → Daily cron refreshes Redis overlays + dynamic KBs

Redis keys (Upstash):
    kb:dynamic:{slug}        — full brain for new diseases
    brain:overlay:{slug}     — daily trial/web updates for static KBs
    brain:refresh:queue      — user-searched conditions to refresh next
    alerts:*                 — email subscriptions
    usage:*                  — monthly run limits per IP
```

## Troubleshooting

**Still shows `in-memory` after adding Upstash**
- Redeploy after adding env vars (vars don't apply to running deployments).
- Check both URL and TOKEN are set (not just one).

**brain-cron returns 401**
- Set `CRON_SECRET` in Vercel and redeploy.
- Manual test: `curl ".../api/brain-cron?secret=YOUR_SECRET"`

**Brain empty after deploy**
- Expected before first search or first cron run. Search a condition once, or trigger brain-cron manually.
