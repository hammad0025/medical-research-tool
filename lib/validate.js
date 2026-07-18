// Second-AI cross-validator (Perplexity / OpenAI / xAI).
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
//      Model: `sonar` (cost-cut 2026-04-23; previously `sonar-reasoning-pro`
//      which was ~30s per call and ~5x more expensive. `sonar` still does
//      live web validation and lands in ~5-8s.)
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
//   disputed:  [{ claim, quote, reason, correction }],
//   unsupported: [{ claim, reason }],
//   hallucinatedCitations: [{ url, issue }],
//   missingPerspectives: [string],
//   overall: "one-paragraph plain-language verdict"
// }

import { detectValidationMismatch } from './condition-resolver.js';
import { recordConditionErrors } from './error-store.js';
import { buildGroundingIndex, partitionValidatorFindings } from './grounding-gate.js';
import { geneticSnapshotRow } from './genetics.js';

// Turn the primary verdict's findings into error-store records so future
// reports for the same condition can be told not to repeat them. Disputed and
// unsupported claims become records keyed on the verbatim quote (falls back to
// the claim); hallucinated citations become records keyed on the bad URL.
export const verdictToErrorRecords = (primary) => {
  if (!primary || typeof primary !== 'object') return [];
  const records = [];
  for (const d of Array.isArray(primary.disputed) ? primary.disputed : []) {
    records.push({
      type: 'disputed',
      claim: d?.claim,
      quote: d?.quote,
      reason: d?.reason,
      correction: d?.correction,
      source: 'validator'
    });
  }
  for (const u of Array.isArray(primary.unsupported) ? primary.unsupported : []) {
    records.push({
      type: 'unsupported',
      claim: u?.claim,
      reason: u?.reason,
      source: 'validator'
    });
  }
  for (const h of Array.isArray(primary.hallucinatedCitations) ? primary.hallucinatedCitations : []) {
    records.push({
      type: 'hallucinated_citation',
      claim: h?.url,
      url: h?.url,
      reason: h?.issue,
      source: 'validator'
    });
  }
  return records;
};

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
  "disputed":  [{ "claim": "short description", "quote": "the exact sentence or phrase copied VERBATIM from the first AI's output that is wrong", "reason": "what is wrong", "correction": "a full, ready-to-substitute corrected sentence to put in place of the quote (a complete replacement, never a fragment)" }],
  "unsupported": [{ "claim": "short description", "reason": "no evidence in the pack for this" }],
  "hallucinatedCitations": [{ "url": "<url>", "issue": "e.g. paper does not exist / URL 404s / URL is a DailyMed or Google SEARCH results page (not a specific document) / URL is non-specific or does not resolve / URL resolves but the source does NOT support the specific claim or drug it is attached to" }],
  "demographicMismatches": [{ "quote": "the exact sentence/line copied VERBATIM from the first AI's output that surfaces a study/trial the patient cannot fit", "reason": "why this study/trial does not fit THIS patient (e.g. female-only study but patient is male; pediatric trial but patient is an adult; wrong-condition pull)" }],
  "missingPerspectives": ["list of important considerations Claude did not address"],
  "overall": "one-paragraph plain-language verdict for a non-medical reader"
}

You are also an ENFORCEMENT gate: the pipeline will DELETE or repair whatever you flag, before the reader sees it. Flag decisively (but only when you are confident) in these three catch-all categories:
1. BAD LINKS → put in "hallucinatedCitations". A citation is BAD when: the URL 404s / does not resolve; it is a SEARCH results page (DailyMed search.cfm?query=…, Google /search, or any query-list page) rather than a specific document; it is non-specific/navigational used as if it were a source; OR it is a real live page whose content does not actually support the claim/drug next to it (CITATION-CLAIM MISMATCH — e.g. a generic "Treatment of Androgenetic Alopecia" review linked on a Clascoterone card that never mentions clascoterone). Copy the offending "url" verbatim.
2. CITATION-CLAIM MISMATCH → also "hallucinatedCitations" (issue = "URL resolves but source does not support the claim/drug"). If you can open the URL and it does not mention the specific drug/mechanism/claim it is attached to, flag it.
3. DEMOGRAPHIC / ELIGIBILITY MISMATCH → put in "demographicMismatches". Using the PATIENT SNAPSHOT (sex, age, condition), flag any study or trial the first AI surfaced that the patient CANNOT fit: a female-only study shown to a male patient (or vice versa), a pediatric trial for an adult (or an adult-only trial for a child), or a wrong-condition pull. Copy the offending sentence/line VERBATIM into "quote". Do NOT flag a study that merely PENALIZES the patient's odds — only ones they are hard-INELIGIBLE for. This is patient-driven, not condition-specific.

Rules:
- Mark a citation HALLUCINATED / BAD only when you are confident (e.g. URL 404s, is a search-results page, or the paper exists but clearly does not support the claim/drug).
- Mark a claim UNSUPPORTED if no item in the evidence pack backs it up, but it might still be true.
- Mark a claim DISPUTED if the evidence pack contradicts it or significantly qualifies it.
- For every DISPUTED claim, copy the offending sentence WORD-FOR-WORD from the first AI's output into "quote" (do NOT paraphrase, summarize, or shorten it — it must match the report character-for-character) and put a complete replacement sentence in "correction" that can stand in for the quote verbatim. Never return a fragment.
- FAILED-AGENT-AS-NEW-IDEA CHECK (general — applies to any condition): if the first AI presents a drug or supplement as a NEW repurposing candidate / "new idea" / "worth trying" / "might help" even though the evidence pack or live trials show that agent ALREADY FAILED a completed trial for THIS condition (missed its primary endpoint, no benefit vs placebo, or was stopped for futility/harm), mark it DISPUTED. It was already tried and failed, so it is not a novel candidate. Quote the candidate sentence verbatim and correct it to state plainly that the agent was already studied for this condition and did not show benefit (cite the failed trial).
- CITED-BUT-UNSUPPORTED ELIGIBILITY / GENE-COVERAGE CHECK (critical patient-safety + citation-integrity rule — applies even when the cited URL is REAL and live): a claim that a therapy is "gene-agnostic", "<GENE>-eligible", "eligible for <GENE>", "covers <GENE>", works "regardless of mutation/genotype", or applies to "all genetic forms" is only supported when the cited source ITSELF establishes that gene-coverage or eligibility. When the first AI appends such an eligibility qualifier to a finding whose citation supports only the finding (e.g. "Phase 1 improved retinal sensitivity [#6]. Gene-agnostic — CERKL-eligible." where the paper is a phase-1 efficacy result that never addresses the patient's gene or eligibility), mark the eligibility qualifier DISPUTED. The real citation validates the phase-1 finding, NOT the patient-specific eligibility claim. Quote the offending sentence verbatim and set "correction" to the sentence with the unsupported eligibility qualifier removed (keep the genuinely-cited finding and its [#N] reference). Do NOT flag the underlying cited finding itself — only the appended eligibility/gene-coverage claim.
- CITATION METADATA-MISMATCH CHECK (citation-integrity — you can open URLs): when the first AI states a citation's YEAR, JOURNAL, or AUTHOR that disagrees with the actual linked source, flag it. Signals: the stated publication year differs from the source's real year (e.g. labeled "AJO 2020" but the link resolves to a 2019 article — note that a ScienceDirect PII like S00029394193... encodes the year, here "19" → 2019), or the stated journal/author does not match the page you open. Mark it DISPUTED, quote the offending citation text verbatim, and set "correction" to the same citation with the year/journal/author corrected to match the linked source (keep the link). If you cannot open the URL to confirm, do NOT guess — leave it. Prefer correcting the metadata over deleting the citation.
- If you cannot actually access the internet, say so in "overall" and do your best from the evidence-pack text alone.
- Be terse and specific. No fluff.
`;

// The validator must see the SAME patient facts the first AI was given.
// Previously this snapshot listed only age/sex/meds/comorbidities, so the
// second AI flagged legitimately-grounded facts (disease stage, imaging
// findings, genetic status) as "hallucinations" simply because IT never
// received them — producing false alarms and eroding trust in the check.
// Every field the generator gets (buildPatientContext in api/research.js) is
// mirrored here so a dispute reflects a real contradiction, not a context gap.
export const buildPatientSnapshot = (p = {}) => {
  // Genetic status is labelled by CLASS (positive variant / provided negative /
  // not-tested) via geneticSnapshotRow (lib/genetics.js) so the validator sees a
  // provided negative result as a RESULT, not a "confirmed mutation," and does
  // not flag it as a hallucination (Dorothy's "no genetic component" case).
  const geneticRow = geneticSnapshotRow(p.geneticVariant);
  const rows = [
    ['Age', p.age],
    ['Sex', p.gender],
    ['Disease stage', p.stage],
    ['Weight', p.weight],
    ['Smoking history', p.smoking],
    ['Exercise / activity', p.exercise],
    ['Comorbidities / other diagnoses', p.diagnoses],
    ['Current medications', p.medications],
    ['Current symptoms', p.symptoms],
    ['Lab work / pulmonary function / studies', p.labWork],
    ['Recent imaging / scans', p.scans],
    ...(geneticRow ? [geneticRow] : []),
    ['Caregiver context', p.caregiverContext]
  ].filter(([, v]) => v != null && String(v).trim() !== '');
  return rows.length
    ? rows.map(([k, v]) => `- ${k}: ${String(v).trim()}`).join('\n')
    : '- (no patient details provided)';
};

const buildValidatorUser = (payload) => {
  const { analysisText, evidencePack, patient, condition, audience } = payload;
  const packStr = JSON.stringify((evidencePack || []).slice(0, 25), null, 1).slice(0, 60000);
  return `CONDITION: ${condition || patient?.condition || 'unspecified'}
AUDIENCE: ${audience || 'layperson'}

=== PATIENT SNAPSHOT (the SAME details the first AI was given — do NOT flag a fact as hallucinated if it is grounded in these fields) ===
${buildPatientSnapshot(patient)}

=== EVIDENCE PACK THE FIRST AI WAS GIVEN ===
${packStr}

=== OUTPUT THE FIRST AI PRODUCED ===
${String(analysisText || '').slice(0, 60000)}

Now audit. Return the JSON only.`;
};

// Repair a JSON string that was truncated (e.g. the model hit its token cap
// mid-response) or has minor structural defects. Validator output was being
// silently discarded on a single strict JSON.parse failure, which threw away
// real findings (disputed claims, hallucinated citations). This closes open
// strings/objects/arrays and strips trailing commas so a partial-but-usable
// verdict still parses.
const repairJson = (s) => {
  if (!s) return null;
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  // Close a string left open by truncation.
  if (inStr) out += '"';
  // Drop a dangling trailing comma / partial key before closing structures.
  out = out.replace(/,\s*$/, '');
  // Close any still-open arrays/objects, innermost first.
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  // Remove trailing commas that precede a closing bracket/brace.
  out = out.replace(/,\s*([}\]])/g, '$1');
  return out;
};

export const extractJson = (raw) => {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : (raw.trim().startsWith('{') ? raw : null);
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch (_) {}
  // Strict parse failed — attempt a tolerant repair before giving up.
  try {
    const repaired = repairJson(candidate);
    if (repaired) return JSON.parse(repaired);
  } catch (_) {}
  return null;
};

const boundedString = (value, max = 4000) =>
  typeof value === 'string' && value.length <= max ? value : null;

const validateRows = (rows, fields) => {
  if (!Array.isArray(rows) || rows.length > 100) return null;
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const clean = {};
    for (const [field, required] of fields) {
      const value = boundedString(row[field]);
      if (required && !value) return null;
      if (value) clean[field] = value;
    }
    out.push(clean);
  }
  return out;
};

export const validateVerdictSchema = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const score = Number(parsed.overallScore);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (!['high', 'moderate', 'low'].includes(parsed.agreement)) return null;
  const confirmed = validateRows(parsed.confirmed, [['claim', true], ['evidenceRef', true]]);
  const disputed = validateRows(parsed.disputed, [
    ['claim', true], ['quote', true], ['reason', true], ['correction', true]
  ]);
  const unsupported = validateRows(parsed.unsupported, [['claim', true], ['reason', true]]);
  const hallucinatedCitations = validateRows(parsed.hallucinatedCitations, [['url', true], ['issue', true]]);
  const demographicMismatches = validateRows(parsed.demographicMismatches || [], [['quote', true], ['reason', true]]);
  if ([confirmed, disputed, unsupported, hallucinatedCitations, demographicMismatches].some((v) => !v)) return null;
  if (hallucinatedCitations.some(({ url }) => !/^https?:\/\//i.test(url))) return null;
  if (!Array.isArray(parsed.missingPerspectives) || parsed.missingPerspectives.length > 100) return null;
  const missingPerspectives = parsed.missingPerspectives.map((v) => boundedString(v, 1000));
  const overall = boundedString(parsed.overall, 8000);
  if (missingPerspectives.some((v) => v === null) || overall === null) return null;
  return {
    overallScore: score,
    agreement: parsed.agreement,
    confirmed,
    disputed,
    unsupported,
    hallucinatedCitations,
    demographicMismatches,
    missingPerspectives,
    overall
  };
};

// The validator sometimes "thinks out loud" inside a `reason`/`correction`
// field and then contradicts itself — e.g. it lists a claim under `disputed`
// but the reason text says "This is actually CONFIRMED by the pack. I will
// remove this from disputed." Because the model never actually edited its own
// JSON, the self-retracted item still shows up in the UI's "Disagreed with"
// list and inflates the disputed count. It also leaks its private deliberation
// ("wait, the pack DOES say... Let's stick to...") into the reason shown to
// patients. This function cleans that up deterministically:
//   1. drop rows the validator itself retracted (move them to `confirmed`)
//   2. strip trailing chain-of-thought from the reason text that remains
const SELF_RETRACT_RE =
  /\b(is|are|it'?s|this is|that one is|actually)\b[^.]*\bconfirmed\b|\bconfirmed by the pack\b|\bi will remove\b|\bremove (it|this|that)?\s*(from )?disputed\b|\bso that one is confirmed\b/i;

const META_CUT_RE =
  /\s*(?:—\s*)?\b(?:wait,|let'?s\b|i will\b|i'?ll\b|let me\b|so that one\b|however, the most\b|more critically\b|actually,\s|on second thought\b)/i;

const cleanReason = (s) => {
  if (!s) return s;
  const str = String(s);
  const m = str.search(META_CUT_RE);
  const cut = m >= 0 ? str.slice(0, m) : str;
  return cut.replace(/[\s,;:.\-–—]+$/, '').trim() + (cut.trim() && !/[.!?]$/.test(cut.trim()) ? '.' : '');
};

export const sanitizeVerdict = (parsed) => {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const confirmed = Array.isArray(parsed.confirmed) ? [...parsed.confirmed] : [];
  const scrub = (rows) => {
    if (!Array.isArray(rows)) return rows;
    const kept = [];
    for (const r of rows) {
      const blob = `${r?.reason || ''} ${r?.correction || ''}`;
      if (SELF_RETRACT_RE.test(blob)) {
        // Validator retracted this itself → it's really a confirmation.
        confirmed.push({ claim: r?.claim || r?.quote || 'claim', evidenceRef: 'validator self-confirmed' });
        continue;
      }
      kept.push({ ...r, reason: cleanReason(r?.reason) });
    }
    return kept;
  };
  const disputed = scrub(parsed.disputed);
  const unsupported = scrub(parsed.unsupported);
  return { ...parsed, confirmed, disputed, unsupported };
};

// ========== PROVIDERS ==========
const callPerplexity = async (payload) => {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const body = {
    // `sonar` is Perplexity's cheapest model ($1/M input, $1/M output
    // as of 2026-04). It still grounds responses against a live web
    // search, which is the whole reason we use Perplexity here. The
    // more expensive `sonar-reasoning-pro` costs ~5x more and takes
    // ~30s — a ~6x latency overage that was pushing us past Vercel's
    // 60s serverless ceiling when validator fired after synthesis.
    model: process.env.PERPLEXITY_MODEL || 'sonar',
    messages: [
      { role: 'system', content: VALIDATOR_SYSTEM },
      { role: 'user', content: buildValidatorUser(payload) }
    ],
    temperature: 0.1,
    max_tokens: 2000,
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

    // Clean each validator's verdict: the model sometimes retracts its own
    // disputed claims inside the reason text without editing its JSON, and
    // leaks chain-of-thought into reasons. Fix that deterministically here.
    for (const r of results) {
      if (r && r.parsed) {
        const validated = validateVerdictSchema(r.parsed);
        r.parsed = validated ? sanitizeVerdict(validated) : null;
        if (!validated) r.error = r.error || 'Validator returned an invalid schema';
      }
    }

    // Primary verdict = first successful parsed result.
    const primary = results.find((r) => r && r.parsed);

    // Simple consensus: when ≥2 validators agree on agreement level, we call it "consensus".
    const agreements = results.map((r) => r?.parsed?.agreement).filter(Boolean);
    const counts = {};
    agreements.forEach((a) => { counts[a] = (counts[a] || 0) + 1; });
    const consensus = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

    const validation = {
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
    };

    // Persist this verdict's findings into the per-condition error memory so
    // future reports for the same condition are told not to repeat them.
    // Wrapped in try/catch — a store failure must NEVER break validation. We
    // await it (serverless: no fire-and-forget; the function may freeze the
    // moment the response is sent, killing an in-flight write).
    const learnCondition = payload.condition || payload.patient?.condition || '';
    if (learnCondition && validation.primary) {
      try {
        // GROUNDING GATE (see lib/grounding-gate.js). Do NOT persist a
        // disputed/unsupported finding as permanent "do-not-repeat" memory when
        // our own grounding (canonical facts + the evidence pack the first AI
        // saw) already supports the claim — the validator is likely wrong (the
        // GERD/87% antacid regression). Persisting it would poison every future
        // report for this condition. Hallucinated citations are always kept
        // (a dead URL is objectively checkable). Ungrounded disputed/unsupported
        // findings still persist so real mistakes are learned from.
        const groundingIndex = buildGroundingIndex({
          canonicalFacts: payload.canonicalFacts || [],
          evidencePack: payload.evidencePack || [],
          lifestyle: payload.lifestyle || [],
          redFlags: payload.redFlags || []
        });
        const { disputed, unsupported, overruled } =
          partitionValidatorFindings(validation.primary, groundingIndex);
        if (overruled.length) {
          console.warn(
            `[validate.js] grounding gate: NOT persisting ${overruled.length} grounded finding(s) ` +
            `(validator overruled) for "${learnCondition}"`
          );
        }
        const persistablePrimary = {
          ...validation.primary,
          disputed,
          unsupported
        };
        const records = verdictToErrorRecords(persistablePrimary);
        if (records.length) await recordConditionErrors(learnCondition, records);
      } catch (e) {
        console.warn('[validate.js] error-store persist failed (non-fatal):', e?.message || e);
      }
    }

    return res.status(200).json({
      ...validation,
      validationMismatch: detectValidationMismatch(
        validation,
        payload.condition || payload.patient?.condition || ''
      )
    });
  } catch (e) {
    console.error('validate.js error', e);
    return res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
