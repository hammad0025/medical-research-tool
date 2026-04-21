// Vercel Serverless Function for the main research pipeline.
//
// Modes supported:
//   - "research"   : full evidence-based analysis of treatments for the condition,
//                    tailored to patient profile, with contraindication check
//   - "repurpose"  : EveryCure-style out-of-the-box drug repurposing analysis
//                    ("professor-to-students" reasoning)
//   - "trials"     : narrative analysis layered on top of live ClinicalTrials.gov
//                    data (the structured pull happens in /api/trials)
//   - "chat"       : free-form follow-up in the same context
//
// Audience toggle: "medical" (clinician language) or "layperson" (10th-grade).
//
// GROUNDING: for "research" and "repurpose" modes, we first call /api/evidence
// to fan out across PubMed + Europe PMC + OpenAlex + Cochrane + openFDA,
// de-duplicate by DOI/PMID, pull OA full text when available, and hand Claude
// a grounded evidence pack. Claude is instructed to cite ONLY from that pack.
// This eliminates the single biggest failure mode of consumer AI medical
// research: hallucinated citations that confidently reference papers the AI
// never actually read.
//
// All modes return Claude's text; the frontend parses structured blocks
// (PROVIDER/TREATMENT/EFFICACY/SAFETY/COST/REFERENCES) into the comparison chart.

import evidenceHandler from './evidence.js';
import validateHandler from './validate.js';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 7000;

const invokeInProcess = async (handler, body) => {
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {}, status(c) { captured.status = c; return this; },
    end() {}, json(o) { captured.body = o; return this; }
  };
  try {
    await handler({ method: 'POST', body, headers: {}, query: {} }, res);
  } catch (e) {
    captured.status = 500;
    captured.body = { error: e.message };
  }
  return captured.body;
};

const invokeEvidence = (body) => invokeInProcess(evidenceHandler, body);
const invokeValidate = (body) => invokeInProcess(validateHandler, body);

const buildGroundingBlock = (evidence) => {
  if (!evidence) return '';
  const items = (evidence.groundedForPrompt || []).slice(0, 25);
  if (!items.length) return '';
  const packed = items.map((it, i) => {
    const tierLabel = it.tier ? ` [TIER ${it.tier}]` : '';
    const oa = it.openAccess ? ' [OPEN ACCESS]' : '';
    // Access level is the single most important disclosure — Claude must
    // never claim details from a paper beyond what is visible in the excerpt.
    const access =
      it.accessLevel === 'full-text' ? ' [FULL-TEXT]'
      : it.accessLevel === 'abstract' ? ' [ABSTRACT-ONLY]'
      : ' [METADATA-ONLY]';
    // Curated KB items are hand-picked landmark references for this disease
    // (guidelines, defining RCTs, FDA labels). Tag them distinctly so Claude
    // knows these are the canonical ground-truth floor.
    const kbTag = it.isCuratedKB
      ? ` [CURATED KB${it.kbCategory ? ` · ${it.kbCategory.toUpperCase()}` : ''}]`
      : '';
    const src = (it.sources || []).join('+');
    return `[#${i + 1}]${kbTag}${tierLabel}${access}${oa} ${it.title || '(no title)'}
      Journal: ${it.journal || '?'} · Year: ${it.year || '?'} · Sources: ${src} · Citations: ${it.citations || 0}
      URL: ${it.url || '(no URL)'}
      Content: ${(it.text || '').slice(0, 3000) || '(no text available — metadata only; you may name this paper but MUST NOT claim anything about its results, methods, or conclusions)'}`;
  }).join('\n\n');

  const fdaBits = [];
  (evidence.fdaLabels || []).forEach((f) => {
    if (!f.label) return;
    fdaBits.push(
      `FDA LABEL · ${f.drug || (f.label.genericName || []).join(', ')}
      Indications: ${(f.label.indications || '').slice(0, 900)}
      Warnings: ${(f.label.warnings || '').slice(0, 900)}
      Contraindications: ${(f.label.contraindications || '').slice(0, 600)}
      Drug interactions: ${(f.label.drugInteractions || '').slice(0, 900)}
      Top FAERS reactions: ${(f.topAdverseEvents || []).map((e) => `${e.reaction} (${e.reports})`).join(', ')}
      Source: ${f.label.url}`
    );
  });
  (evidence.fdaManufacturers || []).forEach((m) => {
    if (!m.enforcementActions?.length) return;
    fdaBits.push(
      `FDA ENFORCEMENT · manufacturer ${m.manufacturer}
      Actions: ${m.enforcementActions.slice(0, 6).map((a) => `${a.recallInitiationDate} Class ${a.classification}: ${a.reason}`).join(' | ')}`
    );
  });

  // Curated knowledge base context block — canonical facts, lifestyle, and
  // red-flag contraindications for this disease, from the hand-curated KB.
  const kb = evidence.knowledgeBase;
  let kbBlock = '';
  if (kb && kb.matched) {
    const facts = (kb.canonicalFacts || []).slice(0, 15);
    const lifestyle = (kb.lifestyleRecommendations || []).slice(0, 10);
    const redFlags = (kb.redFlags || []).slice(0, 10);
    kbBlock = `CURATED KNOWLEDGE BASE — ${kb.condition} (v${kb.version || '?'}, ${kb.itemCount} pinned references)
The evidence items tagged [CURATED KB] below are hand-picked landmark references for this specific disease. They are the canonical ground-truth floor; every query on this condition always sees them. Live-fetched items ([PubMed], [EuropePMC], etc.) supplement them.

CANONICAL FACTS (hand-reviewed, each backed by at least one KB item):
${facts.map((f, i) => `  - ${f.claim}  [refs: ${(f.evidenceRefs || []).join(', ')}]`).join('\n') || '  (none)'}

LIFESTYLE / NON-DRUG GUIDANCE:
${lifestyle.map((l) => `  - ${l.recommendation}`).join('\n') || '  (none)'}

ABSOLUTE RED FLAGS (these are established contraindications — do not recommend them):
${redFlags.map((r) => `  - ${r}`).join('\n') || '  (none)'}

Use these canonical facts and red flags as your backbone. Live evidence supplements them. If a live item contradicts a canonical fact, say so explicitly and weigh the quality of each.
`;
  }

  return `GROUNDED EVIDENCE PACK — you MUST cite only from this list. If a claim is not supported by one of these items, say "No grounded evidence in pack" instead of making one up.

${kbBlock}

CITATION ACCESS RULES (strict — many medical journals are paywalled and we deliberately only pull what is legal to share):
- Each item is tagged [FULL-TEXT], [ABSTRACT-ONLY], or [METADATA-ONLY] to tell you exactly how much of it you have read.
- Items also tagged [CURATED KB] are hand-curated landmark references — prefer them when the topic is directly covered.
- [FULL-TEXT] items: you may cite methods, results, secondary endpoints, subgroups, adverse events, and figures, because you actually have the body text.
- [ABSTRACT-ONLY] items: you may ONLY cite things that literally appear in the Content field (which is the peer-reviewed abstract or, for KB items, editor summary + verbatim passages). You may NOT claim anything about sub-group analyses, exact adverse-event frequencies beyond what the abstract states, study methods beyond what the abstract states, or any detail that requires having read the full paper.
- [METADATA-ONLY] items: you may NAME the paper and reference it as "peer-reviewed source exists (abstract/full text unavailable in this pack)" but you may NOT claim anything about its findings.
- In EVERY citation you write, append the access tag in brackets after the URL, exactly like this: \`[#3] (NEJM 2014) https://... [ABSTRACT-ONLY] — "quoted passage"\`. This is non-negotiable.
- When the Content shows an "Editor's summary", treat that as context — do not quote it as if it were from the paper. Quote only "Verbatim passage" blocks verbatim, or abstract text for live items.
- When you quote, copy the text verbatim from the Content field below and include the URL.

${packed}

${fdaBits.join('\n\n')}`;
};

const buildPatientContext = (p = {}) => {
  const lines = [];
  if (p.condition) lines.push(`PRIMARY CONDITION TO RESEARCH: ${p.condition}${p.stage ? ` (stage: ${p.stage})` : ''}`);
  if (p.age) lines.push(`Age: ${p.age}`);
  if (p.gender) lines.push(`Gender: ${p.gender}`);
  if (p.weight) lines.push(`Weight: ${p.weight}`);
  if (p.smoking) lines.push(`Smoking history: ${p.smoking}`);
  if (p.exercise) lines.push(`Exercise / activity: ${p.exercise}`);
  if (p.diagnoses) lines.push(`ALL current diagnoses (do NOT research these unless relevant for interactions): ${p.diagnoses}`);
  if (p.medications) lines.push(`Current medications (check every recommendation for interaction/contraindication): ${p.medications}`);
  if (p.symptoms) lines.push(`Current symptoms: ${p.symptoms}`);
  if (p.labWork) lines.push(`Lab work / pulmonary function / other studies: ${p.labWork}`);
  if (p.scans) lines.push(`Recent imaging / scans: ${p.scans}`);
  return lines.length ? lines.join('\n') : 'No patient context provided.';
};

const audienceLine = (audience) =>
  audience === 'medical'
    ? 'AUDIENCE: Medical professional. Use precise clinical terminology, include pharmacology, dosing, and mechanism where relevant.'
    : 'AUDIENCE: Non-medical reader (high-school / 10th-grade education). Explain every medical term in plain language. Keep sentences short.';

const SHARED_GUARDRAILS = `
CITATION RULES (absolute — the single biggest failure mode of AI in medical research is hallucinated citations):
- CITE ONLY FROM THE GROUNDED EVIDENCE PACK provided below. Do not invent, paraphrase-without-URL, or cite from general knowledge.
- Every factual claim about efficacy, safety, interactions, or outcomes MUST reference at least one evidence-pack item by its number (e.g. "[#3]") and include a verbatim quoted passage from that item's Content and the exact URL.
- If the evidence pack does not support a claim, write "No grounded evidence in pack" — DO NOT make one up.
- Prefer A+ and A tier journals (NEJM, Lancet, JAMA, BMJ, Nature Medicine, Cochrane, ERJ, AJRCCM, Thorax, Chest) over B/C.
- Weight evidence: US/Western Europe = full; other developed = moderate; China = low (flag explicitly). Mexico/Vietnam/India stem-cell sources should be flagged.

ACCESS-LEVEL HONESTY (critical — many high-impact medical journals are paywalled):
- Every evidence item has an [ACCESS] tag: [FULL-TEXT], [ABSTRACT-ONLY], or [METADATA-ONLY].
- You MUST include this tag after every URL you cite.
- For [ABSTRACT-ONLY] papers: you have the peer-reviewed abstract and nothing else. You may cite what the abstract literally says. You may NOT invent numeric values, methodological details, subgroup outcomes, or adverse-event frequencies that are not in the abstract text.
- For [METADATA-ONLY] papers: you may name the paper but you must NOT claim what it found. Say "a peer-reviewed paper exists but the abstract/full text were not available to me in this pack."
- If a claim cannot be supported without overreaching past abstract content, state the limitation explicitly: "Based on the abstract; the full methods/results were not accessible."

PATIENT-SPECIFIC SAFETY (critical):
- Before recommending any drug, check the patient's current medication list for interactions and contraindications. Name the specific interaction and severity.
- Consider age, comorbidities, labs/PFTs, and scans when assessing suitability.
- Flag treatments that are contraindicated for this specific patient even if they are effective in the general population.

GEOGRAPHIC / SOURCING RULES:
- For stem cell therapies, clinics in China, Vietnam, Mexico, or India must be excluded unless explicitly requested. Prefer US/Western Europe clinics whose source lab has no active FDA warning letter.
- For each stem cell treatment, state: cell type (e.g. cord blood MSCs, exosomes from MSCs, autologous adipose), source lab, delivery route (IV, nebulized/inhaled, intratracheal, intrathecal, local), dose, and whether any peer-reviewed data supports the specific product.
- Do not rely on a clinic's own advertising or press releases.

DISCLAIMERS:
- This is decision-support research, not medical advice. Final choices require a licensed physician.
`;

const RESEARCH_PROMPT = (patient, audience) => `You are a comprehensive medical research assistant. Produce an evidence-based analysis of treatment options for the patient's primary condition, personalized to the patient's profile.

${audienceLine(audience)}

PATIENT PROFILE:
${buildPatientContext(patient)}

Your output MUST include ALL of the following sections in this order:

## 1. Current Standard of Care
- Plain-language description of the mainstream medical approach today.
- Typical efficacy and typical safety profile.

## 2. Best Experts & Clinics in the World
- Name specific physicians and institutions known to lead in this condition.
- Avoid clinic self-advertising as a primary source; prefer peer-recognized leaders.
- Include contact information where publicly available.

## 3. Most Promising Treatments (ranked, best first)
For EACH treatment, use this exact structured block so the UI can parse it:

PROVIDER: <specific doctor, clinic, or manufacturer with contact info if public>
TREATMENT: <what the patient receives: drug/biologic/stem cells/gene therapy, origin lab, dose, strength, delivery route (IV, oral, inhaled, subcutaneous, intrathecal, etc.)>
FDA_STATUS: <approved | off-label | investigational | expanded access | compassionate use | not FDA regulated>
LENGTH_FREQUENCY: <duration and frequency>
EFFICACY: <number 1-100>% — <one-line justification>
SAFETY: <number 1-100>% — <one-line justification (higher = safer)>
RISKS: <specific serious adverse events, contraindications, and THIS PATIENT's risk given their meds/comorbidities>
INTERACTIONS: <named interactions with this patient's current medications, or "None identified">
COST: <typical USD range; note whether US/commercial insurance commonly covers it>
REFERENCES: <semicolon-separated list of PubMed/DOI URLs supporting this treatment, each with a quoted passage in the form "URL — quote">

## 4. Drug-Drug Interaction Check
Walk through the patient's current medications and list every clinically meaningful interaction with the treatments you recommended above.

## 5. Non-Drug / Lifestyle Recommendations
Practical things the patient can do that don't involve drugs (for IPF examples: treat reflux, avoid feather pillows, avoid cold drinks, pulmonary rehab, vaccinations, oxygen hygiene). Tailor to the actual condition.

## 6. Stem Cell Therapy Landscape (if applicable)
- Reputable labs/clinics (exclude China/Vietnam/Mexico/India).
- Source (cord blood MSCs, bone-marrow MSCs, adipose, exosomes), delivery (IV/inhaled/etc.), evidence.
- FDA warning-letter status of source labs.

## 7. Gene Therapy Landscape (if applicable)
- Whether any gene therapy is approved, in trial, or theoretically being studied.
- Does it reverse, cure, or only slow mortality?

## 8. Insurance & Cost Snapshot
- What US commercial/Medicare typically covers, rough out-of-pocket, and which overseas clinics typically hide pricing.

${SHARED_GUARDRAILS}`;

const REPURPOSE_PROMPT = (patient, audience) => `You are a medical research professor leading a graduate seminar. Your students are looking at an existing drug library and asking, for a specific patient condition, "Which already-approved medications or widely-available supplements might logically help this condition — even though no formal guideline endorses them yet?"

This is the EveryCure / drug-repurposing methodology. Think outside the box. Reason from first principles about:
- the pathophysiology of the primary condition
- known mechanisms of action of existing drugs
- shared molecular pathways with other conditions where a drug is already effective
- supportive (not definitive) peer-reviewed evidence

${audienceLine(audience)}

PATIENT PROFILE:
${buildPatientContext(patient)}

Produce a ranked list of 6-12 candidate repurposed drugs or supplements. For EACH candidate output this exact block (the UI parses it):

CANDIDATE: <name>
CLASS: <drug class or supplement category>
APPROVED_FOR: <current FDA-approved or common use>
MECHANISM_TARGET: <the specific molecular target, pathway, or biological mechanism relevant to the condition (e.g. "TGF-β signalling", "AMPK activation / autophagy", "vitamin D receptor → anti-fibrotic gene expression")>
REPURPOSE_RATIONALE: <the mechanistic logic — why would this help the primary condition? Explain the biology step-by-step, at the specified audience level.>
EVIDENCE_STRENGTH: <one of: MECHANISTIC_ONLY | PRECLINICAL | CASE_REPORT | OBSERVATIONAL | SMALL_RCT | LARGE_RCT>
SUPPORTING_EVIDENCE: <peer-reviewed support: animal studies, case reports, observational, off-label use. List URLs from the evidence pack with verbatim quoted passages. If no grounded evidence exists in the pack, say "Mechanistic hypothesis only — no human data yet".>
EFFICACY_HYPOTHESIS: <1-100>% — <one-line justification>
SAFETY: <1-100>% — <higher = safer; reference FDA label / FAERS reactions if available>
CONFIDENCE: <1-100>% — <overall confidence that this is worth physician discussion>
PATIENT_SPECIFIC_RISKS: <interactions with THIS patient's meds, age, comorbidities>
HOW_TO_DISCUSS_WITH_DOCTOR: <practical script / questions the patient should ask a physician>

After the candidate list, include:

## Reasoning Summary
Explain the top 3 candidates in plain language.

## What This Is NOT
Clearly say this is hypothesis-generation, not a prescription, and must be discussed with a physician before any change.

${SHARED_GUARDRAILS}`;

const TRIALS_PROMPT = (patient, audience, trialsData) => `You are a clinical trials analyst. You have been given a live pull of recruiting (or nearly-recruiting) trials from ClinicalTrials.gov for this patient's condition. Produce a narrative analysis that:

${audienceLine(audience)}

PATIENT PROFILE:
${buildPatientContext(patient)}

LIVE TRIAL DATA (JSON):
${JSON.stringify(trialsData, null, 2).slice(0, 120000)}

Your job:
1. Rank the most promising 5-10 trials for THIS patient based on eligibility, phase, placebo exposure, oversight (IRB, DSMB, FDA-regulated), country, and fit with their comorbidities.
2. For each, flag: accepting new patients (yes/no), placebo vs all-get-drug, fast-track / breakthrough / orphan designations, Post-Trial Access / Expanded Access / Compassionate Use / Open-Label Extension availability, location, contact info, and the direct clinicaltrials.gov URL.
3. Explicitly note any trial that is NOT a treatment study (observational, biomarker, registry) — the patient wants treatment only.
4. For each recommended trial, name the most likely interactions/contraindications vs this patient's current medications.
5. End with a plain-language "What this means for you" paragraph.

Use this structured block for each ranked trial so the UI can parse it:

TRIAL: <brief title>
NCT: <NCT ID>
URL: <https://clinicaltrials.gov/study/NCTxxxxxxxx>
PHASE: <phase(s)>
STATUS: <recruiting status>
ACCEPTING: <yes / no>
PLACEBO: <yes / no / partial>
TREATMENT_ONLY: <yes / no>
COUNTRY: <country list>
OVERSIGHT: <IRB yes/no, DSMB yes/no, FDA-regulated yes/no>
DESIGNATIONS: <fast-track / breakthrough / orphan / expanded-access / PTA / OLE flags>
FIT_FOR_PATIENT: <1-100>% — <why>
HARM_RISK: <1-100>% — <higher = safer>
INTERACTIONS: <named interactions with this patient's meds>
LOCATION_CONTACT: <closest site + contact info from data>
SUMMARY: <2-3 sentence plain-language summary>

${SHARED_GUARDRAILS}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      mode = 'research',
      patient = {},
      audience = 'layperson',
      userQuery = '',
      chatHistory = [],
      trialsData = null
    } = req.body || {};

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Server configuration error: ANTHROPIC_API_KEY not set.'
      });
    }

    // Fetch grounded evidence pack for modes that need literature grounding.
    let evidence = null;
    if (mode === 'research' || mode === 'repurpose') {
      const drugs = (patient.medications || '')
        .split(/[,;\n]/).map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 6);
      evidence = await invokeEvidence({
        condition: patient.condition || '',
        treatments: ['treatment', 'clinical trial', 'systematic review', 'meta-analysis'],
        drugs,
        manufacturers: [],
        limitPerSource: 5,
        includeFullText: true
      });
    }
    const groundingBlock = evidence ? buildGroundingBlock(evidence) : '';

    let systemPrompt;
    switch (mode) {
      case 'repurpose':
        systemPrompt = REPURPOSE_PROMPT(patient, audience) +
          (groundingBlock ? `\n\n${groundingBlock}` : '');
        break;
      case 'trials':
        systemPrompt = TRIALS_PROMPT(patient, audience, trialsData || {});
        break;
      case 'chat': {
        // Chat mode is the follow-up conversation after the user has already
        // run a Research / Repurpose / Trials analysis. Three critical
        // differences from the other modes:
        //   1. We DO NOT re-fetch a fresh evidence pack (too slow). Instead
        //      we reuse the pack the client passed back from the last run.
        //   2. We include the prior analyses (if any) as context so Claude
        //      can answer follow-ups like "why did you rate X over Y".
        //   3. The strict grounding rule ("cite only from pack or say no
        //      grounded evidence") is RELAXED for chat, because otherwise
        //      Claude hedges on every question it can't directly pack-cite.
        //      It must still be honest about where its information comes from.
        const priorPieces = [];
        const prior = req.body?.priorAnalyses || {};
        if (prior.research)  priorPieces.push(`=== PRIOR "RESEARCH" ANALYSIS (produced earlier in this session) ===\n${String(prior.research).slice(0, 25000)}`);
        if (prior.repurpose) priorPieces.push(`=== PRIOR "REPURPOSE" ANALYSIS ===\n${String(prior.repurpose).slice(0, 20000)}`);
        if (prior.trials)    priorPieces.push(`=== PRIOR "TRIALS" ANALYSIS ===\n${String(prior.trials).slice(0, 20000)}`);

        const cachedPack = Array.isArray(req.body?.evidencePack) ? req.body.evidencePack.slice(0, 18) : [];
        const chatGrounding = cachedPack.length
          ? buildGroundingBlock({ groundedForPrompt: cachedPack, fdaLabels: [], fdaManufacturers: [] })
          : '';

        systemPrompt = `You are a senior medical research professor having a substantive conversation with someone who has ALREADY run a full research analysis on this patient's condition. Your job is to answer their follow-up questions directly, thoughtfully, and in detail.

${audienceLine(audience)}

PATIENT PROFILE:
${buildPatientContext(patient)}

${priorPieces.length ? priorPieces.join('\n\n') + '\n\n' : ''}BEHAVIOR RULES FOR THIS CHAT:
- ANSWER THE QUESTION. Do not refuse, do not punt to "consult your doctor" as a dodge, do not say "I cannot provide medical advice" — the user has already accepted the decision-support disclaimer and knows this isn't medical advice. Give them the substance.
- Be direct and concrete. If they ask "why did you rate pirfenidone safer than nintedanib", explain the actual safety signal differences with numbers when you know them.
- Use the prior analyses above as your primary context — they represent what has already been established in this session.
- Use the evidence pack below when relevant, with access-level tags ([FULL-TEXT] / [ABSTRACT-ONLY] / [METADATA-ONLY]).
- When you are drawing on general medical knowledge rather than a pack citation, say so honestly: "From general clinical knowledge, not from a pack citation:" — then give the answer anyway. Do NOT just refuse.
- When asked about drug interactions, dosing, or contraindications for THIS patient, check their medication list and comorbidities and give a specific answer.
- If the user asks a speculative question ("what if we tried X"), reason through it at the specified audience level — don't punt.
- Keep the usual disclaimers short and at the end if relevant. Do NOT lead with them.

${chatGrounding || 'No evidence pack was cached for this chat turn. Lean on the prior analyses and general medical knowledge, clearly labeled as such.'}`;
        break;
      }
      case 'research':
      default:
        systemPrompt = RESEARCH_PROMPT(patient, audience) +
          (groundingBlock ? `\n\n${groundingBlock}` : '');
        break;
    }

    const messages = [
      ...chatHistory.map(m => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: userQuery || `Please perform the ${mode} analysis now for the patient profile above.`
      }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', errorData);
      return res.status(response.status).json({
        error: errorData.error?.message || 'API request failed',
        details: errorData
      });
    }

    const data = await response.json();

    // Extract Claude's text so we can feed it to the cross-validator.
    const claudeText = (data.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join('\n\n');

    // Cross-validation: fire an INDEPENDENT second AI (Perplexity / OpenAI / xAI)
    // over Claude's output + the same evidence pack to catch hallucinated
    // citations and unsupported claims. An LLM grading its own work is weak;
    // an independent second model with different training data is a much
    // stronger safeguard. Skip for pure chat mode (no structured claims to
    // audit) and when the caller opts out.
    let validation = null;
    const wantValidation = req.body?.validate !== false;
    const hasAnyValidatorKey =
      !!process.env.PERPLEXITY_API_KEY ||
      !!process.env.OPENAI_API_KEY ||
      !!process.env.XAI_API_KEY;
    if (wantValidation && mode !== 'chat' && claudeText && hasAnyValidatorKey) {
      validation = await invokeValidate({
        analysisText: claudeText,
        evidencePack: (evidence?.groundedForPrompt || []).slice(0, 18),
        patient,
        condition: patient.condition || '',
        audience
      });
    }

    return res.status(200).json({
      ...data,
      evidence: evidence
        ? {
            totalUnique: evidence.totalUnique,
            accessBreakdown: evidence.accessBreakdown,
            promptPackBreakdown: evidence.promptPackBreakdown,
            knowledgeBase: evidence.knowledgeBase,
            topRanked: (evidence.topRanked || []).slice(0, 50),
            groundedForPrompt: evidence.groundedForPrompt,
            fdaLabels: evidence.fdaLabels,
            fdaManufacturers: evidence.fdaManufacturers
          }
        : null,
      validation
    });
  } catch (error) {
    console.error('research.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
