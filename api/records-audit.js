// Vercel Serverless Function that audits medical records for
// misrepresentation or omitted findings.
//
// Input: pasted medical records (raw notes, imaging reports, lab reports) and
// optionally a "summary report" (e.g. a doctor's summary letter, IME report, or
// any condensed narrative) to cross-check against.
//
// Output: a structured audit identifying:
//   - every abnormal finding in the raw records
//   - whether each abnormal finding appears in the summary
//   - findings that appear misrepresented (wording changed, severity minimized)
//   - findings that are omitted entirely
//   - normal findings in raw records but described as abnormal in summary
//
// This catches the common failure mode where a long medical record contains
// an abnormal finding (e.g. an MRI showing a lesion, a lab flag, a biopsy
// note) that never makes it into the summary the patient or next clinician
// actually reads.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { records, summary = '', condition = '', audience = 'layperson' } = req.body || {};
    if (!records || !String(records).trim()) {
      return res.status(400).json({ error: 'records is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    }

    const audienceInstr = audience === 'medical'
      ? 'Use precise medical terminology. Assume a clinician reader.'
      : 'Explain all medical terms in plain language a high-school-educated reader can follow.';

    const systemPrompt = `You are a meticulous medical records auditor. Your job is to read raw medical records (office notes, imaging reports, lab reports, hospital records) and compare them to a summary report. Your task is to identify:

1. EVERY abnormal finding in the raw records (imaging, labs, physical exam, pathology) — list each one with a direct quote from the records.
2. OMISSIONS: abnormal findings present in the raw records but missing from the summary.
3. MISREPRESENTATIONS: findings whose severity, meaning, or wording is materially changed in the summary versus the raw records.
4. FABRICATIONS: statements in the summary that are not supported by the raw records.
5. RELEVANCE: for each finding, note whether it is relevant to the primary condition being researched (${condition || 'unspecified'}).

${audienceInstr}

Respond in this exact JSON shape (and nothing else — no markdown, no prose outside the JSON):

{
  "primaryCondition": "${condition || ''}",
  "abnormalFindings": [
    {
      "finding": "short description",
      "quote": "exact quote from raw records",
      "source": "where in records (e.g. 'MRI brain 3/14/2024', 'CMP 1/2/2025')",
      "severity": "mild | moderate | severe | unclear",
      "relevantToCondition": true,
      "inSummary": true,
      "summaryQuote": "exact quote from summary or empty string",
      "summaryAccuracy": "accurate | downplayed | exaggerated | omitted | contradicted",
      "auditorNote": "plain-language explanation of why this matters"
    }
  ],
  "omittedFindings": [ "list of finding descriptions from abnormalFindings that are omitted from the summary" ],
  "misrepresentedFindings": [ "list of finding descriptions that are downplayed/exaggerated/contradicted" ],
  "unsupportedSummaryStatements": [
    { "statement": "quote from summary", "issue": "why it is unsupported" }
  ],
  "overallAssessment": "one-paragraph plain-language assessment",
  "confidence": "high | medium | low",
  "limitations": "what a human reviewer should double-check"
}

If no summary report was provided, still extract all abnormal findings and set inSummary=false, summaryAccuracy="omitted" for each, and note in overallAssessment that no summary was provided.`;

    const userContent = `RAW MEDICAL RECORDS:
"""
${String(records).slice(0, 180000)}
"""

SUMMARY REPORT (may be empty):
"""
${String(summary).slice(0, 60000)}
"""`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!anthropicRes.ok) {
      const errorData = await anthropicRes.json().catch(() => ({}));
      return res.status(anthropicRes.status).json({
        error: errorData.error?.message || 'Anthropic request failed',
        details: errorData
      });
    }

    const data = await anthropicRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = textBlock?.text || '';

    let parsed = null;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (e) {
      parsed = null;
    }

    return res.status(200).json({
      raw,
      audit: parsed,
      parseError: parsed ? null : 'Could not parse structured audit; see raw field.'
    });
  } catch (error) {
    console.error('records-audit.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
