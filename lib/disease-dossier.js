// /api/disease-dossier — realtime disease-intake agent.
//
// Problem we're solving
// ---------------------
// Any hand-curated CONDITION_SYNONYMS / TOP_CENTERS map is obsolete the day
// it ships. There are ~10,000 clinically meaningful diseases. We can't list
// LADA, achondroplasia, tardive dyskinesia, neonatal jaundice, Hashimoto's,
// schizoaffective disorder, celiac disease etc. etc. in code.
//
// Instead: when a user types ANY disease string ("IPF", "LADA diabetes",
// "my mom's Lewy body", "6-month-old with jaundice"), we first hit this
// endpoint, which runs a tiny Claude call that returns a structured dossier:
//
//   {
//     canonical:          "Latent Autoimmune Diabetes in Adults",
//     synonyms:           ["LADA", "type 1.5 diabetes", ...],
//     meshTerms:          ["Diabetes Mellitus, Type 1", ...],
//     icd10:              "E10",
//     subspecialty:       "Endocrinology / Autoimmune Diabetes",
//     topCenters:         [{ name, city, why }],
//     keyInvestigators:   [{ name, affiliation, why }],
//     patientAdvocacy:    [{ name, url }],
//     landmarkTrials:     [{ acronym, topic }],
//     commonComorbidities:[...],
//     redFlags:           [...],
//     uncertainty:        0-1 (Claude's self-reported confidence)
//   }
//
// This dossier then drives:
//   - trials.js synonym + MeSH fan-out on ClinicalTrials.gov
//   - evidence.js synonym fan-out on PubMed / Europe PMC / OpenAlex
//   - research.js system prompt (so Claude knows the specialty-specific
//     top centers, landmark trial names, and advocacy orgs for ANY disease
//     — without us having to hand-curate them).
//
// Cost / latency
// --------------
// Uses Haiku by default: ~500 input tokens, ~500 output tokens per dossier,
// roughly $0.0009 per call. Cached in-memory with 24h TTL so repeat queries
// for the same condition are free and sub-ms.
//
// Safety
// ------
// Claude is explicitly instructed to return uncertainty: 0-1 self-assessment
// and to OMIT fields it is not confident about rather than hallucinate. We
// also guardrail downstream: if uncertainty > 0.6 we show the dossier in the
// UI with a "LOW CONFIDENCE" banner and do NOT inject it into the research
// system prompt (we fall back to just the raw condition string).

// Default to the same Sonnet model the research endpoint uses. We tried
// Haiku originally for cost but at least on this API key it was returning
// 404s / parse failures which fell through to the "uncertainty 0.95" empty
// dossier — and the downstream chat/research prompts then had nothing to
// work with. Sonnet is ~3x the cost (~$0.025 per dossier at 1.6k tokens)
// but we cache 24h in memory, so common conditions (IPF, RP, LADA, AD,
// PD) are free on the second request regardless.
//
// Cost cut 2026-04-23: for ANY condition that has a curated KB file, we
// skip this call entirely and build the dossier deterministically from
// KB data. See `buildDossierFromKb()` below — ~$0.025 saved per run for
// every KB-matched condition.
const DOSSIER_MODEL = process.env.ANTHROPIC_DOSSIER_MODEL || 'claude-sonnet-4-20250514';
const DOSSIER_MAX_TOKENS = 1600;
const DOSSIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Persistent-cache toggle. DISABLED by default during the beta integrity
// phase (Apr-2026). Dorothy's explicit ask: "disable the cache so we can
// run the same query multiple times and see variance — prove the
// methodology is sound rather than serving a cached answer." Flip by
// setting MRT_DOSSIER_CACHE=1 in the Vercel env once the methodology is
// established and latency/cost matter more than integrity-verification.
//
// Note: this only disables the cross-run PERSISTENT cache. The in-flight
// promise dedup (below) still fires within a single user-triggered run so
// research.js / evidence.js / trials.js calling concurrently share one
// Claude call in the same ~10s window. That's intra-request coalescing,
// not cross-run caching — it doesn't "train the pipeline wrong."
const PERSISTENT_CACHE_ENABLED = process.env.MRT_DOSSIER_CACHE === '1';

// In-memory cache. Keyed by lowercase-trimmed condition string.
// Shape: Map<normalized, { dossier, cachedAt }>
// Shared across warm invocations of the same Vercel function instance.
const dossierCache = new Map();

// In-flight promise cache. When research.js, evidence.js and trials.js all
// call getDossier() at roughly the same time (which they do on every run),
// we want them to share ONE Claude call — not three racing Claude calls
// that each take ~8-10s and push the gather phase past Vercel's 60s cap.
// Keyed by normalized condition; value is the pending promise. Entries are
// removed when the underlying call resolves so a later request is free to
// hit Claude again if the main cache expires.
const dossierInflight = new Map();

const normalizeKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// JSON extraction helper: Claude Haiku sometimes wraps JSON in ```json``` or
// prose. Try strict parse first, then extract the largest balanced {} block.
const extractJson = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
};

// Normalise + clip dossier fields to keep downstream consumers sane.
// Never throws — always returns a shape that research/trials/evidence can
// consume, even if Claude returned something partial.
const sanitizeDossier = (raw, inputCondition) => {
  const r = raw || {};
  const arr = (v, max) => Array.isArray(v) ? v.filter(Boolean).slice(0, max) : [];
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v, lo, hi, fb) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return fb;
    return Math.max(lo, Math.min(hi, n));
  };
  const canonical = str(r.canonical, 160) || inputCondition;
  const synonyms = arr(r.synonyms, 12)
    .map((s) => str(s, 100))
    .filter(Boolean);
  // Always include the canonical and the raw input string in synonyms.
  if (!synonyms.some((s) => s.toLowerCase() === canonical.toLowerCase())) synonyms.unshift(canonical);
  if (inputCondition && !synonyms.some((s) => s.toLowerCase() === inputCondition.toLowerCase())) {
    synonyms.push(inputCondition);
  }
  const objArr = (v, max, keys) =>
    arr(v, max).map((item) => {
      const out = {};
      if (item && typeof item === 'object') {
        for (const k of keys) out[k] = str(item[k], 200);
      }
      return out;
    }).filter((o) => o.name || o.acronym);

  return {
    inputCondition,
    canonical,
    synonyms: [...new Set(synonyms)].slice(0, 12),
    meshTerms: arr(r.meshTerms, 8).map((s) => str(s, 100)).filter(Boolean),
    icd10: str(r.icd10, 20),
    icd11: str(r.icd11, 20),
    subspecialty: str(r.subspecialty, 160),
    topCenters: objArr(r.topCenters, 8, ['name', 'city', 'country', 'why']),
    keyInvestigators: objArr(r.keyInvestigators, 8, ['name', 'affiliation', 'why']),
    patientAdvocacy: objArr(r.patientAdvocacy, 6, ['name', 'url', 'why']),
    landmarkTrials: objArr(r.landmarkTrials, 8, ['acronym', 'name', 'topic']),
    commonComorbidities: arr(r.commonComorbidities, 10).map((s) => str(s, 100)).filter(Boolean),
    redFlags: arr(r.redFlags, 8).map((s) => str(s, 400)).filter(Boolean),
    lifestyleCategories: arr(r.lifestyleCategories, 8).map((s) => str(s, 200)).filter(Boolean),
    uncertainty: num(r.uncertainty, 0, 1, 0.5),
    notes: str(r.notes, 800),
    generatedBy: DOSSIER_MODEL,
    generatedAt: new Date().toISOString()
  };
};

// System prompt for the dossier agent. Short, structured, low-temperature.
const DOSSIER_SYSTEM_PROMPT = `You are a medical ontology and clinical-knowledge agent. Given ANY disease or medical condition string, return a compact JSON dossier describing it.

You MUST return ONLY valid JSON. No prose, no explanation, no markdown. Output exactly one JSON object.

Fields (all optional except canonical + synonyms + uncertainty):
{
  "canonical":            <preferred full clinical name>,
  "synonyms":             [<up to 12 aliases, abbreviations, older names, closely-related disease names a user might search — e.g. for RP: "retinitis pigmentosa", "rod-cone dystrophy", "inherited retinal dystrophy">],
  "meshTerms":            [<up to 8 NCBI MeSH heading terms for PubMed search>],
  "icd10":                <ICD-10 code if well-established>,
  "icd11":                <ICD-11 code if well-established>,
  "subspecialty":         <the medical specialty that manages this disease, e.g. "Pulmonology / Interstitial Lung Disease", "Neurology / Movement Disorders">,
  "topCenters":           [<up to 8 WORLD-CLASS academic medical centers known for this specific disease, NOT generic famous hospitals. Each: { "name": "...", "city": "...", "country": "...", "why": "one-line reason this center leads for this disease" }>],
  "keyInvestigators":     [<up to 8 living clinicians/researchers known as leaders for this disease. Each: { "name": "...", "affiliation": "...", "why": "one-line reason" }. Only include names you are highly confident about.>],
  "patientAdvocacy":      [<up to 6 patient advocacy orgs, foundations, registries. Each: { "name": "...", "url": "https://...", "why": "one-line" }>],
  "landmarkTrials":       [<up to 8 landmark trial acronyms / studies. Each: { "acronym": "...", "name": "...", "topic": "..." }>],
  "commonComorbidities":  [<up to 10 frequently co-occurring conditions>],
  "redFlags":             [<up to 8 things patients or generalists commonly get wrong about this disease, e.g. "LADA is often misdiagnosed as T2D and treated with sulfonylureas, which can accelerate beta-cell failure">],
  "lifestyleCategories":  [<up to 8 broad lifestyle factors that materially affect prognosis, e.g. "sleep hygiene", "protein timing", "low-oxalate diet", "sun protection">],
  "uncertainty":          <your own self-assessed confidence that this dossier is accurate, 0.0 (certain) to 1.0 (very uncertain). Rare diseases, ambiguous input, or anything where you would hedge in conversation should be >= 0.5.>,
  "notes":                <one short paragraph of caveats if anything about the input was ambiguous>
}

CRITICAL RULES:
- OMIT fields you are not confident about. Do not invent center names, investigator names, or URLs.
- For topCenters and keyInvestigators: if you would hesitate to tell a patient "call this center", OMIT it. It is better to return 2 confident centers than 8 guessed ones.
- Patient advocacy URLs MUST be well-known org homepages (e.g. https://www.pulmonaryfibrosis.org, https://www.alz.org, https://www.jdrf.org). If you are not sure of the URL, omit the url field but keep the name.
- meshTerms should be ACTUAL NCBI MeSH headings (singular nouns like "Pulmonary Fibrosis", not descriptions).
- If the input is ambiguous or unrecognised, set uncertainty >= 0.8, put your best guess in canonical, and note why in notes.
- If the input looks like a symptom rather than a disease (e.g. "jaundice", "fatigue"), still fill the dossier treating the symptom as the query topic, set subspecialty accordingly ("Hepatology / Neonatal jaundice"), and explain in notes.`;

// Call Claude for a single dossier. Returns parsed + sanitised dossier, or
// falls through to a minimal fallback dossier if anything goes wrong.
async function callDossierAgent(condition, apiKey) {
  const userMsg = `Disease / condition input from a patient-facing medical research UI: "${condition}"

Return the JSON dossier now.`;
  const body = {
    model: DOSSIER_MODEL,
    max_tokens: DOSSIER_MAX_TOKENS,
    temperature: 0.2,
    system: DOSSIER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }]
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      console.warn(`[disease-dossier] Claude call failed status=${r.status} model=${DOSSIER_MODEL} err=${errTxt.slice(0, 400)}`);
      return { _error: `HTTP ${r.status}: ${errTxt.slice(0, 200)}` };
    }
    const data = await r.json();
    const text = (data.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text).join('\n');
    const parsed = extractJson(text);
    if (!parsed) {
      console.warn(`[disease-dossier] could not parse JSON from ${DOSSIER_MODEL}. First 500 chars of response: ${text.slice(0, 500)}`);
      return { _error: 'dossier model returned non-JSON text' };
    }
    return parsed;
  } catch (e) {
    console.warn(`[disease-dossier] fetch threw model=${DOSSIER_MODEL}:`, e.message);
    return { _error: `fetch threw: ${e.message}` };
  }
}

// Minimal dossier used when the agent is unavailable (no API key, network
// failure, parse failure). Downstream consumers must still work.
const makeFallback = (inputCondition) => sanitizeDossier({
  canonical: inputCondition,
  synonyms: [inputCondition],
  uncertainty: 0.95,
  notes: 'Fallback dossier: the disease-intake agent was unavailable; downstream searches use the raw input string only.'
}, inputCondition);

// Build a dossier DETERMINISTICALLY from curated KB metadata. This is the
// cost-cut short-circuit: if the user's condition matches a KB file (IPF,
// RP, etc.) we don't need to pay Claude to guess the subspecialty, top
// centers, landmark trials, and patient advocacy orgs — the curator has
// already written them into the KB. Saves ~$0.025 per run and ~8-10s of
// latency. Returns null if the KB has no match or no usable fields.
const buildDossierFromKb = (input, kbMeta) => {
  if (!kbMeta || !kbMeta.condition) return null;
  const hasAnyRealField =
    !!kbMeta.subspecialty ||
    (kbMeta.topCenters || []).length > 0 ||
    (kbMeta.keyInvestigators || []).length > 0 ||
    (kbMeta.patientAdvocacy || []).length > 0 ||
    (kbMeta.landmarkTrials || []).length > 0 ||
    (kbMeta.meshTerms || []).length > 0;
  if (!hasAnyRealField) return null;
  return sanitizeDossier({
    canonical: kbMeta.condition,
    synonyms: [kbMeta.condition, ...(kbMeta.aliases || []).filter(Boolean)],
    meshTerms: kbMeta.meshTerms || [],
    icd10: kbMeta.icd10 || '',
    icd11: kbMeta.icd11 || '',
    subspecialty: kbMeta.subspecialty || '',
    topCenters: kbMeta.topCenters || [],
    keyInvestigators: kbMeta.keyInvestigators || [],
    patientAdvocacy: kbMeta.patientAdvocacy || [],
    landmarkTrials: kbMeta.landmarkTrials || [],
    commonComorbidities: kbMeta.commonComorbidities || [],
    redFlags: kbMeta.redFlags || [],
    lifestyleCategories: kbMeta.lifestyleCategories || [],
    // Curated data is authoritative — very low uncertainty.
    uncertainty: 0.05,
    notes: `Dossier assembled from curated KB (${kbMeta.slug} v${kbMeta.version || '?'}, ${kbMeta.itemCount || 0} pinned refs). No LLM inference involved.`
  }, input);
};

// PUBLIC: importable function used by trials.js / evidence.js / research.js.
// Always resolves to a sanitised dossier object. Never throws.
export async function getDossier(condition, { bypassCache = false } = {}) {
  const input = String(condition || '').trim();
  if (!input) return makeFallback('');

  const key = normalizeKey(input);

  // In-flight promise dedup ALWAYS fires (see comment at top of file).
  // This is intra-request coalescing, not cross-run caching.
  if (!bypassCache) {
    const pending = dossierInflight.get(key);
    if (pending) return pending;
  }
  // Persistent cross-run cache only fires when explicitly enabled.
  if (!bypassCache && PERSISTENT_CACHE_ENABLED) {
    const hit = dossierCache.get(key);
    if (hit && Date.now() - hit.cachedAt < DOSSIER_CACHE_TTL_MS) {
      return { ...hit.dossier, cacheHit: true, cacheDisabled: false };
    }
  }

  // ============================================================
  // COST CUT: curated-KB short-circuit.
  // ============================================================
  // If the condition matches a curated KB file, build the dossier
  // from KB metadata and skip the Claude call entirely. This is the
  // single biggest cost cut in the pipeline — ~$0.025 saved and
  // ~8-10s of latency removed for every KB-matched request.
  try {
    const { loadKb } = await import('./kb.js');
    const kb = await loadKb(input);
    if (kb && kb.matched && kb.meta) {
      const kbDossier = buildDossierFromKb(input, kb.meta);
      if (kbDossier) {
        kbDossier.generatedBy = `curated-kb:${kb.meta.slug}`;
        kbDossier.source = 'curated-kb';
        return { ...kbDossier, cacheHit: false, cacheDisabled: !PERSISTENT_CACHE_ENABLED, skippedLlm: true };
      }
    }
  } catch (err) {
    console.warn('[disease-dossier] KB short-circuit failed, falling back to LLM:', err?.message || err);
    // non-fatal — fall through to the Claude path below
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const fb = makeFallback(input);
    if (PERSISTENT_CACHE_ENABLED) {
      dossierCache.set(key, { dossier: fb, cachedAt: Date.now() });
    }
    return { ...fb, cacheHit: false, cacheDisabled: !PERSISTENT_CACHE_ENABLED, fallbackReason: 'no_api_key' };
  }

  const work = (async () => {
    const raw = await callDossierAgent(input, apiKey);
    // If the agent errored, use the fallback but attach the error reason
    // so downstream (chat / research prompt, UI) can say WHY the dossier
    // is empty instead of pretending everything is fine.
    const errored = raw && raw._error;
    const dossier = (raw && !errored)
      ? sanitizeDossier(raw, input)
      : makeFallback(input);
    if (errored) dossier.fallbackReason = raw._error;
    // IMPORTANT: only cache successful dossiers. Previously we cached the
    // fallback too, which meant one transient Anthropic timeout/429 on
    // the first request permanently (for 24h) pinned this condition to
    // an "agent was unavailable" empty dossier even though retrying
    // would have worked. Don't cache failures — let each request get a
    // fresh attempt until one succeeds.
    if (!errored && PERSISTENT_CACHE_ENABLED) {
      dossierCache.set(key, { dossier, cachedAt: Date.now() });
    }
    return { ...dossier, cacheHit: false, cacheDisabled: !PERSISTENT_CACHE_ENABLED };
  })();

  dossierInflight.set(key, work);
  try {
    return await work;
  } finally {
    dossierInflight.delete(key);
  }
}

// Clear the cache (used by tests).
export function clearDossierCache() {
  dossierCache.clear();
}

// PUBLIC: HTTP endpoint. Lets the frontend pre-fetch + display the dossier
// so the user sees what the AI thinks their disease is before running the
// full analysis.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const condition = body.condition || body.q;
    const bypassCache = body.bypassCache === true || body.bypassCache === 'true';

    if (!condition) {
      return res.status(400).json({ error: 'condition is required' });
    }

    const dossier = await getDossier(condition, { bypassCache });
    return res.status(200).json(dossier);
  } catch (e) {
    console.error('[disease-dossier] handler error:', e);
    return res.status(500).json({ error: 'dossier_failed', message: e.message });
  }
}
