# 🚀 DEPLOY TO VERCEL - COMPLETE GUIDE

## ✅ What You're Deploying

**Full-stack application:**
- ✅ Frontend (HTML/React)
- ✅ Backend (Serverless function)
- ✅ Anthropic API integration
- ✅ $0/month hosting

---

## 📋 Prerequisites

1. **GitHub account** (you have this)
2. **Anthropic API key** (get from console.anthropic.com)
3. **5 minutes**

---

## 🎯 DEPLOYMENT STEPS

### Step 1: Get Your Anthropic API Key (2 minutes)

1. Go to: https://console.anthropic.com/settings/keys
2. Click "Create Key"
3. Copy the key (starts with `sk-ant-...`)
4. **SAVE IT** - you'll need it in Step 3

**Don't have an account?**
- Sign up at console.anthropic.com (free tier available)
- Get $5 free credit for testing

---

### Step 2: Push Code to GitHub (30 seconds)

```bash
cd /path/to/ipf-research-assistant-mvp
git push -u origin main
```

**Already pushed?** Skip this step!

---

### Step 3: Deploy to Vercel (2 minutes)

#### Option A: Using Vercel Website (Easiest)

1. **Go to:** https://vercel.com/signup
2. **Sign in with GitHub**
3. **Click:** "Add New" → "Project"
4. **Import:** `hammad0025/medical-research-tool`
5. **Configure:**
   - Framework Preset: Other
   - Root Directory: `./`
   - Build Command: (leave empty)
   - Output Directory: `./`
6. **Add Environment Variable:**
   - Click "Environment Variables"
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (your key from Step 1)
   - Select all environments (Production, Preview, Development)
7. **Click:** "Deploy"

**Wait 1-2 minutes... DONE!** 🎉

Your app will be live at:
```
https://medical-research-tool.vercel.app
```

#### Option B: Using Vercel CLI (For Developers)

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
cd ipf-research-assistant-mvp
vercel

# Follow prompts:
# - Link to existing project? No
# - Project name? medical-research-tool
# - Directory? ./
# - Override settings? No

# Add environment variable
vercel env add ANTHROPIC_API_KEY

# Paste your API key when prompted
# Select: Production, Preview, Development

# Deploy to production
vercel --prod
```

---

## ✅ Verify Deployment

1. **Visit your URL:** `https://medical-research-tool.vercel.app`
2. **Click:** "AI Research" tab
3. **Type:** "What are FDA-approved IPF treatments?"
4. **Hit:** "Research" button

**If it works:** You're live! 🚀

**If you get an error:**
- Check: Vercel Dashboard → Settings → Environment Variables
- Verify: ANTHROPIC_API_KEY is set correctly
- Redeploy: Deployments → Click "..." → Redeploy

---

## 🔧 Project Structure

```
ipf-research-assistant-mvp/
├── index.html              # Frontend (React app)
├── api/
│   └── research.js         # Backend (Serverless function)
├── vercel.json            # Vercel configuration
└── (other docs)
```

**How it works:**
1. User types question in browser
2. Frontend calls `/api/research`
3. Backend (serverless function) calls Anthropic
4. Response goes back to user
5. All secure, API key hidden

---

## 💰 Cost Breakdown

### Vercel Hosting
- **Free tier:** 100GB bandwidth/month
- **Your usage:** ~1GB/month (if 500 users)
- **Cost:** $0

### Vercel Serverless Functions
- **Free tier:** 100,000 invocations/month
- **Your usage:** ~1,000/month
- **Cost:** $0

### Anthropic API
- **Pricing:** ~$3 per 1M input tokens
- **Your usage:** ~100 requests/month = 50K tokens
- **Cost:** ~$0.15/month

### Total Monthly Cost
```
Hosting: $0
Backend: $0
API calls: ~$0.15

TOTAL: $0.15/month
```

**That's like... one gumball.** 🍬

---

## 🌐 Custom Domain (Optional)

Want `ipf-research.com` instead of `vercel.app`?

### Buy Domain ($10/year)
- Namecheap.com
- GoDaddy.com
- Google Domains

### Add to Vercel
1. **Vercel Dashboard** → Your Project → Settings → Domains
2. **Add Domain:** `ipf-research.com`
3. **Update DNS:** (Vercel gives you instructions)
4. **Wait 24 hours** for DNS propagation

**Done!** Now it's at your custom domain.

---

## 🔒 Security Features

✅ **API Key Protected:** Never exposed to users  
✅ **HTTPS Enabled:** All traffic encrypted  
✅ **CORS Configured:** Prevents unauthorized access  
✅ **Rate Limited:** Vercel limits abuse automatically  
✅ **Serverless:** No servers to hack  

---

## 📊 Monitoring & Analytics

### View Usage:
1. **Vercel Dashboard** → Your Project
2. **Analytics:** See visitor count, performance
3. **Logs:** View function calls and errors

### Monitor API Costs:
1. **Anthropic Console** → Usage
2. See your monthly API spend
3. Set up billing alerts

---

## 🐛 Troubleshooting

### "API Error" when testing

**Problem:** API key not set correctly

**Fix:**
```bash
# Check environment variables
vercel env ls

# If ANTHROPIC_API_KEY is missing, add it:
vercel env add ANTHROPIC_API_KEY

# Then redeploy:
vercel --prod
```

---

### "CORS Error"

**Problem:** Browser blocking requests

**Fix:** Already handled in `api/research.js` with CORS headers. If still happening:
```bash
# Redeploy the latest code:
git pull
vercel --prod
```

---

### Blank Page

**Problem:** File not found

**Fix:**
1. Check `index.html` is in repository root
2. Verify `vercel.json` configuration
3. Redeploy

---

### High API Costs

**Problem:** Too many requests

**Fix:** Add rate limiting:
```javascript
// api/research.js - add at top
const rateLimit = {}; // Simple in-memory rate limit

export default async function handler(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Allow 100 requests per hour per IP
  if (rateLimit[ip] && rateLimit[ip] > 100) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  
  rateLimit[ip] = (rateLimit[ip] || 0) + 1;
  
  // ... rest of code
}
```

---

## 🔄 Updating Your App

### Automatic Updates (Recommended)

Every time you push to GitHub, Vercel auto-deploys:

```bash
# Make changes to your code
git add .
git commit -m "Updated feature X"
git push origin main

# Vercel automatically deploys in 1-2 minutes
```

**Watch deployment:**
- Go to Vercel Dashboard → Deployments
- See real-time build logs

---

### Manual Updates

```bash
cd ipf-research-assistant-mvp
vercel --prod
```

---

## 📱 Test on Mobile

Your app works on all devices automatically!

**Test:**
1. Open `https://medical-research-tool.vercel.app` on phone
2. Responsive design scales automatically
3. Touch-friendly interface

---

## 👥 Share with Dorothy & Tim

### Send them:

```
Hi Dorothy,

The IPF Research Assistant is live and ready!

🔗 https://medical-research-tool.vercel.app

Features:
✅ Patient profile management
✅ AI-powered research (Claude Sonnet 4)
✅ Treatment comparisons with ratings
✅ Citation verification
✅ Works on desktop & mobile
✅ Secure & fast

Try entering a patient profile, then ask research questions.
All responses are evidence-based with citations.

Let me know what you think!

Best,
Syed
```

---

## 🎯 Success Checklist

After deployment, verify:

- [ ] App loads at Vercel URL
- [ ] Patient profile tab works
- [ ] Research query returns results
- [ ] No console errors
- [ ] Works on mobile
- [ ] API key is secure (not in frontend code)
- [ ] Shared URL with Dorothy & Tim

---

## 💡 Pro Tips

### Save Money:
- Monitor usage at console.anthropic.com
- Set billing alerts ($5/month threshold)
- Cache common queries (future enhancement)

### Improve Performance:
- Vercel edge functions = instant worldwide
- No server startup time
- Auto-scales with traffic

### Go Professional:
- Add custom domain ($10/year)
- Enable Vercel Analytics (free)
- Set up error monitoring

---

## 📞 Support

### Vercel Issues:
- Docs: https://vercel.com/docs
- Support: vercel.com/support
- Community: github.com/vercel/vercel/discussions

### Anthropic API:
- Docs: https://docs.anthropic.com
- Support: support@anthropic.com
- Status: status.anthropic.com

### This Project:
- Email: shaque025@gmail.com
- GitHub: https://github.com/hammad0025/medical-research-tool

---

## 🎉 You're Done!

**Your app is:**
- ✅ Live on the internet
- ✅ Costing $0/month (+ tiny API costs)
- ✅ Auto-updating from GitHub
- ✅ Secure and fast
- ✅ Production-ready

**Congratulations!** 🚀

Share with Dorothy and start Phase 2 planning.

---

**Total time to deploy: 5 minutes**  
**Total monthly cost: ~$0.15**  
**Headaches: Zero** 😎