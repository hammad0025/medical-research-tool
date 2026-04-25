# API Backend

This directory contains Vercel serverless functions that power the Medical
Research Assistant.

## Structure

```
api/
├── research.js        # Main Anthropic pipeline. Modes: research | repurpose | trials | chat
│                       # Fetches grounded evidence + optional cross-AI audit after Claude
├── trials.js          # Live ClinicalTrials.gov v2 pull with structured enrichment
├── pubmed.js          # NCBI E-utilities (esearch + esummary + efetch abstracts)
├── europe-pmc.js      # Europe PMC — includes OA full-text retrieval
├── openalex.js        # OpenAlex — broad scholarly coverage + journal tiering
├── openfda.js         # openFDA — drug labels, FAERS, enforcement actions
├── evidence.js        # Fan-out orchestrator: builds a grounded evidence pack
├── validate.js        # Cross-AI validator (Perplexity / OpenAI / xAI)
├── usage.js           # Monthly per-IP usage status (free vs paid limits)
├── activate-plan.js   # Activate paid plan for current IP via upgrade code
├── runtime-config.js  # Frontend monetization + ad runtime toggles
├── translate.js       # On-demand analysis translation endpoint
└── records-audit.js   # Anthropic-based medical-records audit
```

## Endpoints

### POST /api/research
Body: `{ mode, patient, audience, userQuery?, chatHistory?, trialsData? }`
- `mode`: `research` (default) | `repurpose` | `trials` | `chat`
- `patient`: `{ condition, stage, age, gender, weight, smoking, exercise, diagnoses, medications, symptoms, labWork, scans }`
- `audience`: `layperson` | `medical`
- For `mode=trials`, pass the structured output of `/api/trials` as `trialsData`.

### POST /api/trials
Body: `{ condition, recruitingOnly?, treatmentOnly?, excludePlacebo?, pageSize?, country? }`
Returns ranked, classified trials from ClinicalTrials.gov v2 including phase,
recruiting status, placebo flag, designations (fast-track/breakthrough/orphan/
expanded-access/PTA/OLE), oversight (IRB/DSMB/FDA-regulated), locations, contacts.

### POST /api/pubmed
Body: `{ query, limit?, sort?, withAbstract? }`
Returns PubMed articles with PMID, title, authors, journal, year, abstract, DOI,
and a direct pubmedUrl. Set `NCBI_API_KEY` env var for higher rate limits.

### POST /api/records-audit
Body: `{ records, summary?, condition?, audience? }`
Returns a structured audit of abnormal findings, omissions, misrepresentations,
and unsupported summary statements.

### POST /api/validate
Body: `{ analysisText, evidencePack, patient?, condition?, audience? }`
Runs an **independent second AI** (Perplexity preferred, then OpenAI, then xAI)
against Claude's output and the same grounded evidence pack. Returns verdicts
per claim: CONFIRMED / DISPUTED / UNSUPPORTED / HALLUCINATED-CITATION.

This is the safeguard against hallucinated references — it's the explicit
"have Perplexity cross-check Claude" pattern. It can run on-demand from the
frontend (Audit button) and can also run in-process when explicitly requested.

Perplexity is preferred because `sonar-reasoning-pro` has built-in live web
### GET /api/usage
Returns monthly IP usage and active plan:
`{ usage: { used, limit, remaining, plan }, pricing: ... }`

### POST /api/activate-plan
Body: `{ code }`
Activates paid plan for the caller IP if code is valid (codes configured via
`MRT_PAID_CODES` env var).

### GET /api/runtime-config
Returns frontend runtime settings for branding, monetization limits, upgrade
URL, and ad slots (for ad provider scripts).

### POST /api/translate
Body: `{ text, targetLanguage, sourceLanguage? }`
Translates markdown analysis output on-demand while preserving links, trial
IDs, drug names, and structure.

search — it can actually open the URLs Claude cites and confirm whether the
paper exists and says what was claimed.

## How It Works

1. **Frontend** (`index.html`) calls `/api/research`
2. **Serverless function** (`research.js`) receives request
3. **Function** calls Anthropic API with secure API key
4. **Response** sent back to frontend
5. **User** sees AI-powered results

## Why We Need This

❌ **Can't do this:** Call Anthropic directly from browser
- Exposes API key to users
- CORS blocks the request
- Security nightmare

✅ **Do this instead:** Use serverless backend
- API key stays secret
- CORS properly configured
- Rate limiting possible
- Audit logs available

## Environment Variables

Required:
- `ANTHROPIC_API_KEY` — Your Anthropic API key (used by `research.js` and `records-audit.js`)

Optional:
- `NCBI_API_KEY` — NCBI E-utilities key (raises PubMed rate limit from 3 to 10 req/s)
- `PERPLEXITY_API_KEY` — enables the cross-AI audit via Perplexity `sonar-reasoning-pro` (recommended primary validator — has live web search so it can actually open cited URLs)
- `OPENAI_API_KEY` — cross-AI audit fallback (GPT-4.1)
- `XAI_API_KEY` — cross-AI audit fallback (Grok)
- `MRT_FREE_LIMIT` — monthly free runs per IP (default 4)
- `MRT_PAID_LIMIT` — monthly paid runs per IP (default 15)
- `MRT_PAID_PRICE_USD` — displayed paid price in UI (default 10)
- `MRT_PAID_CODES` — comma-separated activation codes for paid-plan unlock
- `MRT_PAID_IPS` — comma-separated always-paid IP allowlist
- `MRT_UPGRADE_URL` — checkout/payment URL shown to users
- `MRT_ADS_ENABLED` — `1` to enable ad slots in UI
- `MRT_ADSENSE_CLIENT` — Adsense client id (e.g. `ca-pub-xxxx`)
- `MRT_AD_SLOT_RESEARCH_TOP`, `MRT_AD_SLOT_REPURPOSE_TOP`, `MRT_AD_SLOT_TRIALS_TOP`, `MRT_AD_SLOT_FOOTER`

Set in Vercel:
```bash
vercel env add ANTHROPIC_API_KEY
vercel env add PERPLEXITY_API_KEY   # strongly recommended for citation verification
vercel env add OPENAI_API_KEY       # optional fallback validator
vercel env add NCBI_API_KEY         # optional
```

## Endpoint

**POST** `/api/research`

**Request:**
```json
{
  "system": "You are a medical research assistant...",
  "messages": [
    { "role": "user", "content": "What are IPF treatments?" }
  ]
}
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "IPF treatments include..."
    }
  ]
}
```

## Local Testing

```bash
# Install Vercel CLI
npm i -g vercel

# Run locally
vercel dev

# Test endpoint
curl -X POST http://localhost:3000/api/research \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}]}'
```

## Security Features

- ✅ API key stored as environment variable
- ✅ CORS headers configured
- ✅ Request validation
- ✅ Error handling
- ✅ No direct API exposure

## Cost

**Vercel Serverless Functions:**
- Free tier: 100,000 invocations/month
- Typical usage: ~1,000/month
- Cost: $0

**Anthropic API:**
- ~$3 per 1M input tokens
- Typical usage: ~50K tokens/month
- Cost: ~$0.15/month

## Monitoring

View function logs in Vercel Dashboard:
1. Go to project → Functions
2. Click on `research.js`
3. See invocation logs and errors

## Rate Limiting

Currently no rate limiting. To add:

```javascript
// Simple IP-based rate limiting
const rateLimit = new Map();

export default async function handler(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetAt: now + 3600000 });
  } else {
    const limit = rateLimit.get(ip);
    if (now > limit.resetAt) {
      limit.count = 1;
      limit.resetAt = now + 3600000;
    } else {
      limit.count++;
      if (limit.count > 100) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
    }
  }
  
  // ... rest of code
}
```

## Troubleshooting

**"API key not set" error:**
- Check environment variables in Vercel
- Redeploy after adding key

**CORS error:**
- Verify CORS headers in response
- Check browser console for details

**Timeout:**
- Anthropic API can take 5-30 seconds
- Vercel timeout is 10s (free), 60s (pro)
- Consider streaming responses for long queries

## Future Enhancements

- [ ] Add rate limiting per user/IP
- [ ] Cache common queries
- [ ] Add request logging
- [ ] Implement streaming responses
- [ ] Add authentication
- [ ] Monitor API costs automatically
