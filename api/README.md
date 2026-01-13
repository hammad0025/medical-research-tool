# API Backend

This directory contains Vercel serverless functions that act as a secure backend for the IPF Research Assistant.

## Structure

```
api/
└── research.js    # Anthropic API proxy endpoint
```

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
- `ANTHROPIC_API_KEY` - Your Anthropic API key

Set in Vercel:
```bash
vercel env add ANTHROPIC_API_KEY
# Paste your key when prompted
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
