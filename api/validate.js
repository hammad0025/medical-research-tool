// /api/validate — second-AI cross-validator.
//
// The problem: a single LLM grading its own work is weak, and hallucinated
// citations are the most damaging failure mode for AI in medical research.
// The fix is to run an INDEPENDENT model over Claude's output + the same
// evidence pack and ask it to audit every factual claim. Disagreements are
// surfaced to the user as badges so they can see exactly where the two models
// diverge before trusting anything.
//
// Providers (attempted in order, first one with an API key wins):
//   1. Perplexity — has built-in live web search, so it can actually open the
//      URLs Claude cited and verify them. This is the single best validator
//      for the specific failure mode "AI cites a paper that doesn't say that."
//      https://docs.perplexity.ai/ — model: sonar-reasoning-pro
//   2. OpenAI GPT — independent training, good reasoning. model: gpt-4.1
//   3. xAI Grok — third perspective.
//
// Env vars (set any one or more):
//   PERPLEXITY_API_KEY  — recommended primary (live web validation)
//   OPENAI_API_KEY      — fallback
//   XAI_API_KEY         — fallback
//
// Output schema (always the same regardless of provider):
// {
//   provider, model,
//   overallScore: 0-100,
//   agreement: "high" | "moderate" | "low",
//   confirmed: [{ claim, evidenceRef }],
//   disputed:  [{ claim, reason, correction }],
//   unsupported: [{ claim, reason }],
//   hallucinatedCitations: [{ url, issue }],
//   missingPerspectives: [string],
//   overall: "one-paragraph plain-language verdict"
// }

const VALIDATOR_SYSTEM = `You are an independent scientific auditor. A first AI (Claude)
has produced a medical research analysis based on a specific GROUNDED EVIDENCE PACK that was
given to it. Your job is to cross-check every factual claim in Claude's output against that
same evidence pack and, if you have access to the open web, verify that each cited URL
actually says what Claude claims it says.

Respond in this exact JSON schema — no markdown, no prose outside the JSON:

{
  "overallScore": <0-100>,
  "agreement": "high" | "moderate" | "low",
  "confirmed": [{ "claim": "short description", "evidenceRef": "URL or pack item id" }],
  "disputed":  [{ "claim": "short description", "reason": "what is wrong", "correction": "what it should say instead" }],
  "unsupported": [{ "claim": "short description", "reason": "no evidence in the pack for this" }],
  "hallucinatedCitations": [{ "url": "<url>", "issue": "e.g. paper does not exist / URL 404s / URL exists but paper says the opposite" }],
  "missingPerspectives": ["list of important considerations Claude did not address"],
  "overall": "one-paragraph plain-language verdict for a non-medical reader"
}

Rules:
- Mark a citation HALLUCINATED only when you are confident (e.g. URL 404s, or the paper exists but clearly does not support the claim).
- Mark a claim UNSUPPORTED if no item in the evidence pack backs it up, but it might still be true.
- Mark a claim DISPUTED if the evidence pack contradicts it or significantly qualifies it.
- If you cannot actually access the internet, say so in "overall" and do your best from the evidence-pack text alone.
- Be terse and specific. No fluff.
`;

const buildValidatorUser = (payload) => {
  const { analysisText, evidencePack, patient, condition, audience } = payload;
  const packStr = JSON.stringify((evidencePack || []).slice(0, 25), null, 1).slice(0, 60000);
  return `CONDITION: ${condition || patient?.condition || 'unspecified'}
PATIENT SNAPSHOT: age ${patient?.age || '?'}, sex ${patient?.gender || '?'}, meds "${patient?.medications || '?'}", comorbidities "${patient?.diagnoses || '?'}"
AUDIENCE: ${audience || 'layperson'}

=== EVIDENCE PACK THE FIRST AI WAS GIVEN ===
${packStr}

=== OUTPUT THE FIRST AI PRODUCED ===
${String(analysisText || '').slice(0, 60000)}

Now audit. Return the JSON only.`;
};

const extractJson = (raw) => {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
};

// ========== PROVIDERS ==========
const callPerplexity = async (payload) => {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const body = {
    model: 'sonar-reasoning-pro',
    messages: [
      { role: 'system', content: VALIDATOR_SYSTEM },
      { role: 'user', content: buildValidatorUser(payload) }
    ],
    temperature: 0.1,
    max_tokens: 4000,
    return_citations: true
  };
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Perplexity ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  return {
    provider: 'Perplexity',
    model: body.model,
    webCitations: data.citations || [],
    raw: text,
    parsed: extractJson(text)
  };
};

const callOpenAI = async (payload) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const body = {
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: VALIDATOR_SYSTEM },
      { role: 'user', content: buildValidatorUser(payload) }
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  return {
    provider: 'OpenAI',
    model: body.model,
    raw: text,
    parsed: extractJson(text)
  };
};

const callXai = async (payload) => {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  const body = {
    model: 'grok-beta',
    messages: [
      { role: 'system', content: VALIDATOR_SYSTEM },
      { role: 'user', content: buildValidatorUser(payload) }
    ],
    temperature: 0.1
  };
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`xAI ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  return {
    provider: 'xAI',
    model: body.model,
    raw: text,
    parsed: extractJson(text)
  };
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    if (!payload.analysisText) {
      return res.status(400).json({ error: 'analysisText required' });
    }

    const hasPerplexity = !!process.env.PERPLEXITY_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasXai = !!process.env.XAI_API_KEY;

    if (!hasPerplexity && !hasOpenAI && !hasXai) {
      return res.status(503).json({
        error: 'No validator API key configured',
        hint: 'Set PERPLEXITY_API_KEY (recommended), OPENAI_API_KEY, or XAI_API_KEY.',
        validators: []
      });
    }

    const jobs = [];
    if (hasPerplexity) jobs.push(callPerplexity(payload).catch((e) => ({ provider: 'Perplexity', error: e.message })));
    if (hasOpenAI)     jobs.push(callOpenAI(payload).catch((e) => ({ provider: 'OpenAI', error: e.message })));
    if (hasXai)        jobs.push(callXai(payload).catch((e) => ({ provider: 'xAI', error: e.message })));

    const results = (await Promise.all(jobs)).filter(Boolean);

    // Primary verdict = first successful parsed result.
    const primary = results.find((r) => r && r.parsed);

    // Simple consensus: when ≥2 validators agree on agreement level, we call it "consensus".
    const agreements = results.map((r) => r?.parsed?.agreement).filter(Boolean);
    const counts = {};
    agreements.forEach((a) => { counts[a] = (counts[a] || 0) + 1; });
    const consensus = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

    return res.status(200).json({
      primary: primary
        ? {
            provider: primary.provider,
            model: primary.model,
            webCitations: primary.webCitations || [],
            ...primary.parsed
          }
        : null,
      validators: results.map((r) => ({
        provider: r.provider,
        model: r.model,
        webCitations: r.webCitations || [],
        parsed: r.parsed,
        error: r.error,
        rawExcerpt: r.raw ? String(r.raw).slice(0, 600) : undefined
      })),
      consensus: consensus
        ? { level: consensus[0], validatorsAgreeing: consensus[1], totalValidators: results.length }
        : null
    });
  } catch (e) {
    console.error('validate.js error', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
