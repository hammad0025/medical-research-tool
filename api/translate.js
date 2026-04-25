// /api/translate
//
// On-demand translation endpoint for analysis output (research / trials /
// repurpose). We intentionally keep this OFF the main research path so we
// only spend tokens when the user explicitly asks for another language.
//
// Request body:
//   {
//     text: string,              // source markdown text
//     targetLanguage: string,    // e.g. "Spanish", "French", "Chinese"
//     sourceLanguage?: string    // optional hint; default "English"
//   }
//
// Response:
//   { translatedText, model, targetLanguage, sourceLanguage }

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-3-5-haiku-20241022';
const MAX_CHARS = 65000;

const sanitize = (v) => (v == null ? '' : String(v).trim());

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
  }

  const rawText = sanitize(req.body?.text);
  const targetLanguage = sanitize(req.body?.targetLanguage);
  const sourceLanguage = sanitize(req.body?.sourceLanguage) || 'English';

  if (!rawText) return res.status(400).json({ error: 'text is required' });
  if (!targetLanguage) return res.status(400).json({ error: 'targetLanguage is required' });
  if (rawText.length > MAX_CHARS) {
    return res.status(400).json({
      error: `text too long (${rawText.length} chars). Max ${MAX_CHARS}.`
    });
  }

  try {
    const translatePrompt = [
      `Translate the following medical-analysis markdown from ${sourceLanguage} to ${targetLanguage}.`,
      'STRICT RULES:',
      '- Preserve ALL markdown structure (headers, bullets, numbering, links).',
      '- Do NOT omit or add clinical claims.',
      '- Keep drug names, trial IDs (NCT numbers), gene names, acronyms, and dosages unchanged.',
      '- Keep URLs unchanged.',
      '- Translate explanatory prose naturally for native readers.',
      '- Return ONLY the translated markdown text (no preface, no code fences).',
      '',
      rawText
    ].join('\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2800,
        temperature: 0,
        messages: [{ role: 'user', content: translatePrompt }]
      })
    });

    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); }
    catch {
      return res.status(502).json({
        error: `Anthropic returned non-JSON (HTTP ${r.status})`,
        raw: raw.slice(0, 200)
      });
    }
    if (!r.ok) {
      return res.status(502).json({
        error: j?.error?.message || `Anthropic error (HTTP ${r.status})`
      });
    }

    const translatedText = (j.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!translatedText) {
      return res.status(502).json({ error: 'Translation returned empty output' });
    }

    return res.status(200).json({
      translatedText,
      model: MODEL,
      sourceLanguage,
      targetLanguage
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Translation failed' });
  }
}
