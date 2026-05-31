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

import evidenceHandler from '../lib/evidence.js';
import validateHandler from '../lib/validate.js';
import trialsHandler from './trials.js';
import { getDossier } from '../lib/disease-dossier.js';
import {
  consumeResearchCredit,
  limits as usageLimits,
  pricing as usagePricing,
  getUsage,
  isUsageLimitBypassed,
  verifyPlanCode,
  activatePlanForIp
} from '../lib/usage-store.js';
import { requireAccess } from '../lib/access-gate.js';

// Primary synthesis model. User requested "Opus instead of Sonnet" support:
// set ANTHROPIC_RESEARCH_MODEL in env to any Anthropic model your account has
// access to (e.g. an Opus model). Defaults to Sonnet for speed/cost balance.
const DEFAULT_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-4-20250514';

// Serverless timeout safety: Opus is typically slower token/sec than Sonnet,
// so we cap max_tokens lower by default to reduce timeout risk. You can still
// override directly with ANTHROPIC_MAX_TOKENS if needed.
const resolveMaxTokens = (model) => {
  const forced = Number(process.env.ANTHROPIC_MAX_TOKENS || 0);
  if (forced > 0) return forced;
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 1400;
  if (m.includes('sonnet')) return 2000;
  return 2200; // haiku / unknown
};

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
const invokeTrials = (body) => invokeInProcess(trialsHandler, body);

// Gather returns pools to the browser, which POSTs them back for synthesize.
// Trials + evidence can exceed 1MB and break slow clients; trim to what the
// UI and synth path actually need (matches the final-response shape below).
const trimGatherPools = ({ dossier, evidence, trials }) => ({
  dossier,
  evidence: evidence
    ? {
        condition: evidence.condition,
        dossier: evidence.dossier,
        pipelineDrugs: evidence.pipelineDrugs || [],
        excludedAgents: evidence.excludedAgents || [],
        totalUnique: evidence.totalUnique,
        totalFetched: evidence.totalFetched,
        perSourceCounts: evidence.perSourceCounts,
        uniqueJournals: evidence.uniqueJournals,
        corpusFootprint: evidence.corpusFootprint,
        accessBreakdown: evidence.accessBreakdown,
        promptPackBreakdown: evidence.promptPackBreakdown,
        qualityBreakdown: evidence.qualityBreakdown,
        knowledgeBase: evidence.knowledgeBase,
        topRanked: (evidence.topRanked || []).slice(0, 25).map((a) => ({
          ...a,
          fullText: (a.fullText || '').slice(0, 2000),
          abstract: (a.abstract || '').slice(0, 1500)
        })),
        groundedForPrompt: evidence.groundedForPrompt,
        fdaLabels: evidence.fdaLabels,
        fdaManufacturers: evidence.fdaManufacturers
      }
    : null,
  trials: trials
    ? {
        total: trials.total,
        returned: trials.returned,
        breakdown: trials.breakdown,
        subQueries: trials.subQueries,
        query: trials.query,
        studies: (trials.studies || []).slice(0, 25)
      }
    : null
});

const getClientIp = (req) => {
  const xff = String(req.headers?.['x-forwarded-for'] || '').trim();
  if (xff) return xff.split(',')[0].trim();
  return String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
};

const TRANSLATE_MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-3-5-haiku-20241022';
const TRANSLATE_MAX_CHARS = 65000;
const sanitize = (v) => (v == null ? '' : String(v).trim());

// Build a Claude-readable digest of the disease-intake dossier. This is the
// AI's "what do I know about this disease" context — canonical name, synonyms,
// subspecialty, the world-class centers known for this specific disease (not
// just generic famous hospitals), the landmark trial acronyms, the patient
// advocacy orgs. Without this, Claude researches IPF and Retinitis Pigmentosa
// with the same generic vocabulary; with this, it knows to talk about
// Pittsburgh Simmons + UCSF for ILD and Bascom Palmer + Wilmer for RP.
const buildDossierBlock = (dossier) => {
  if (!dossier) return '';
  const safe = (v) => (v == null ? '' : String(v));
  const lines = [];
  lines.push(`DISEASE DOSSIER (realtime intake, generated by ${safe(dossier.generatedBy) || 'AI agent'}, uncertainty ${dossier.uncertainty ?? '?'}):`);
  lines.push(`  Canonical name: ${safe(dossier.canonical)}`);
  if (dossier.subspecialty) lines.push(`  Subspecialty: ${dossier.subspecialty}`);
  if ((dossier.synonyms || []).length) {
    lines.push(`  Known synonyms / aliases: ${dossier.synonyms.join(', ')}`);
  }
  if ((dossier.meshTerms || []).length) {
    lines.push(`  NCBI MeSH terms used for PubMed fan-out: ${dossier.meshTerms.join(', ')}`);
  }
  if (dossier.icd10) lines.push(`  ICD-10: ${dossier.icd10}`);
  if ((dossier.topCenters || []).length) {
    lines.push(`  Top centers specific to this disease (dossier — you MUST surface these in the "Top Centers & Experts" section unless you have grounded evidence to override):`);
    dossier.topCenters.forEach((c) => {
      const loc = [c.city, c.country].filter(Boolean).join(', ');
      lines.push(`    - ${safe(c.name)}${loc ? ` (${loc})` : ''}${c.why ? ` — ${c.why}` : ''}`);
    });
  }
  if ((dossier.keyInvestigators || []).length) {
    lines.push(`  Key investigators (dossier):`);
    dossier.keyInvestigators.forEach((i) => {
      lines.push(`    - ${safe(i.name)}${i.affiliation ? ` (${i.affiliation})` : ''}${i.why ? ` — ${i.why}` : ''}`);
    });
  }
  if ((dossier.patientAdvocacy || []).length) {
    lines.push(`  Patient advocacy / registries (include these in the "Patient Advocacy & Resources" section):`);
    dossier.patientAdvocacy.forEach((a) => {
      lines.push(`    - ${safe(a.name)}${a.url ? ` — ${a.url}` : ''}${a.why ? ` — ${a.why}` : ''}`);
    });
  }
  if ((dossier.landmarkTrials || []).length) {
    lines.push(`  Landmark trials / acronyms:`);
    dossier.landmarkTrials.forEach((t) => {
      lines.push(`    - ${safe(t.acronym)}${t.name ? ` (${t.name})` : ''}${t.topic ? ` — ${t.topic}` : ''}`);
    });
  }
  if ((dossier.commonComorbidities || []).length) {
    lines.push(`  Common comorbidities to screen for: ${dossier.commonComorbidities.join(', ')}`);
  }
  if ((dossier.redFlags || []).length) {
    lines.push(`  Literature safety considerations (cover these in Section 8 "Safety Considerations Reported in Literature"):`);
    dossier.redFlags.forEach((r) => lines.push(`    - ${r}`));
  }
  if (dossier.notes) lines.push(`  Agent notes: ${dossier.notes}`);
  if (dossier.uncertainty != null && dossier.uncertainty >= 0.6) {
    lines.push(`  IMPORTANT: the dossier agent flagged HIGH UNCERTAINTY for this condition. Treat the dossier as a starting hypothesis, not fact. Prefer grounded evidence and explicitly disclose when you are relying on the dossier for a non-grounded claim.`);
  }
  return lines.join('\n') + '\n';
};

// Build a compact Claude-readable digest of the trials fan-out. We give
// Claude a ranked list of the TOP trials by category (recruiting, expanded
// access, OLE) so it can explicitly cover each section without blowing the
// token budget on hundreds of studies. Without this block the user gets a
// research answer that is silently blind to Expanded Access and OLE
// programs — which is exactly what they caught us missing.
const buildTrialsBlock = (trials) => {
  if (!trials) return '';
  const studies = Array.isArray(trials.studies) ? trials.studies : [];
  if (!studies.length) return '';

  const fmt = (s) => {
    const phase = (s.phases || []).join('/') || 'N/A';
    const loc = (s.contacts?.locations || []).slice(0, 2)
      .map((l) => [l.facility, l.city, l.country].filter(Boolean).join(', '))
      .join(' | ') || 'no sites listed';
    const centers = (s.topCenters || []).slice(0, 3).join('; ');
    const designations = [];
    if (s.designations?.fastTrack) designations.push('fast-track');
    if (s.designations?.breakthrough) designations.push('breakthrough');
    if (s.designations?.orphan) designations.push('orphan');
    if (s.designations?.hasExpandedAccess) designations.push('EXPANDED-ACCESS');
    if (s.designations?.hasOpenLabelExtension) designations.push('OPEN-LABEL-EXTENSION');
    if (s.designations?.hasPostTrialAccess) designations.push('post-trial-access');
    if (s.designations?.hasPayToAccess) designations.push('PAY-TO-ACCESS');
    return `  - ${s.nctId} · ${phase} · ${s.status} · ${s.briefTitle || '(untitled)'}
    Sponsor: ${s.sponsor || 'unknown'}${centers ? ` · Top centers: ${centers}` : ''}
    Sites: ${loc}${designations.length ? ` · Flags: ${designations.join(', ')}` : ''}
    Interventions: ${(s.interventions || []).slice(0, 3).map((i) => i.name).join(' | ') || '(none listed)'}
    URL: ${s.url}`;
  };

  // Same budget story as the grounding block: bigger trial lists chew
  // input tokens AND output tokens (Claude tries to discuss each).
  // 6 + 3 + 3 + 3 is enough to surface the most important programs in
  // each pathway while leaving Claude enough output budget to finish
  // sections 5-8.
  const recruiting = studies.filter((s) => s.acceptingNewPatients && !s.isExpandedAccessStudy && !s.designations?.hasOpenLabelExtension).slice(0, 6);
  const ea = studies.filter((s) => s.designations?.hasExpandedAccess).slice(0, 3);
  const ole = studies.filter((s) => s.designations?.hasOpenLabelExtension).slice(0, 3);
  const topCenter = studies.filter((s) => s.hasTopCenter).slice(0, 3);

  const chunks = [];
  chunks.push(`LIVE CLINICAL TRIALS PULL (ClinicalTrials.gov, fanned across condition + synonyms + expanded-access studyType + OLE title search):
Breakdown: ${trials.breakdown ? JSON.stringify(trials.breakdown) : '(unknown)'}
Synonyms used: ${(trials.dossier?.synonyms || []).join(', ') || '(single term)'}
MeSH terms used: ${(trials.dossier?.meshTerms || []).join(', ') || '(none)'}`);

  if (recruiting.length) {
    chunks.push(`\nRECRUITING TRIALS (top ${recruiting.length} by promise score):\n${recruiting.map(fmt).join('\n\n')}`);
  }
  if (ea.length) {
    chunks.push(`\nEXPANDED ACCESS / COMPASSIONATE USE (${ea.length} record(s) — patients who don't qualify for a trial may still be able to get the drug this way):\n${ea.map(fmt).join('\n\n')}`);
  } else {
    chunks.push(`\nEXPANDED ACCESS / COMPASSIONATE USE: none surfaced by CT.gov studyType=EXPANDED_ACCESS query. DO NOT invent programs. If you know of a well-publicised compassionate use program that isn't on CT.gov (e.g. a company-run charitable access pathway), name it with a direct-to-sponsor URL and explicitly flag it as "not listed on CT.gov — verify with the sponsor."`);
  }
  if (ole.length) {
    chunks.push(`\nOPEN-LABEL EXTENSION STUDIES (${ole.length} record(s) — for patients already in a prior trial):\n${ole.map(fmt).join('\n\n')}`);
  } else {
    chunks.push(`\nOPEN-LABEL EXTENSION STUDIES: none surfaced. Still mention in the answer that patients currently in Phase 2/3 trials should ask their PI whether an OLE is planned — most multi-year programs have one even before it lists on CT.gov.`);
  }
  if (topCenter.length) {
    chunks.push(`\nTRIALS AT TOP CENTERS (${topCenter.length}):\n${topCenter.map(fmt).join('\n\n')}`);
  }

  return chunks.join('\n') + '\n';
};

// Build a REQUIRED MENTIONS block from the KB's pipelineDrugs + excludedAgents.
// This is the anti-"AI slop" guardrail that prevents Claude from silently
// omitting drugs that matter. The evidence.js response carries these
// straight through from the curated KB; if the KB has no entry for this
// condition (which is fine for rare / uncurated diseases) the block is
// empty and the prompt behaves as before.
//
// We inject this into the system prompt for research + repurpose modes.
// After Claude answers, a coverage audit (scanForMissedPipelineDrugs,
// below) checks that every `name`/alias was actually mentioned and
// re-prompts Claude if any was missed.
const buildRequiredMentionsBlock = (evidence) => {
  const pipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  const excludedAgents = Array.isArray(evidence?.excludedAgents) ? evidence.excludedAgents : [];
  if (!pipelineDrugs.length && !excludedAgents.length) return '';

  // Tight one-liner per drug. We dropped the sponsor + PMID + DOI + whyItMatters
  // prose that was here before — it's already in the evidence pack below,
  // plus the KB-curated grounding block. What matters for the anti-omission
  // guardrail is the NAME, the aliases (so Claude doesn't skip by using a
  // different synonym), and the approval status (so Claude knows which
  // section to file it in). ~70% smaller than the previous block.
  // Cost cut 2026-04-23: saves ~600-900 input tokens per synthesis call.
  const drugLines = pipelineDrugs.map((d) => {
    const aliases = Array.isArray(d.aliases) && d.aliases.length ? ` (${d.aliases.join(' / ')})` : '';
    const status = d.approvalStatus ? ` — ${d.approvalStatus}` : '';
    return `- **${d.name}**${aliases}${status}`;
  }).join('\n');

  const excludedLines = excludedAgents.map((x) => `- **${x.name}** — ${x.reason}`).join('\n');

  return `=== REQUIRED MENTIONS (anti-omission guardrail) ===
Every pipeline drug below MUST appear by name (or listed alias) in your output. Approved agents belong in Section 3; investigational in Section 4 or 5; discontinued/failed in Section 8 (Safety Considerations Reported in Literature).

PIPELINE DRUGS:
${drugLines || '- (none)'}

EXCLUDED AGENTS (mention in Section 8 — Safety Considerations Reported in Literature — with the reason):
${excludedLines || '- (none)'}

=== END REQUIRED MENTIONS ===
`;
};

// Post-synthesis coverage audit. Scans the Claude output text for every
// pipelineDrug name + its aliases. Returns the list of drugs whose name
// was NOT found in the output, so the caller can force a rewrite. Simple
// case-insensitive substring search is enough — we don't care about
// morphology, only whether the drug was mentioned AT ALL.
const scanForMissedPipelineDrugs = (claudeText, pipelineDrugs) => {
  if (!claudeText || !Array.isArray(pipelineDrugs) || !pipelineDrugs.length) return [];
  const lower = claudeText.toLowerCase();
  const missed = [];
  for (const drug of pipelineDrugs) {
    const candidates = [drug.name, ...(Array.isArray(drug.aliases) ? drug.aliases : [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    const found = candidates.some((n) => lower.includes(n));
    if (!found) missed.push(drug);
  }
  return missed;
};

// Build a deterministic "Agents Evaluated" transparency block that gets
// appended to every research + repurpose synthesis. This is the methodology-
// visibility requirement: the user can see, explicitly, which agents were
// in the consideration set and whether they made it into the analysis.
// The LLM cannot silently drop a drug — if one is in pipelineDrugs but
// missing from the analysis text, this block will say so.
const buildAgentsEvaluatedBlock = (claudeText, evidence) => {
  const pipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  const excludedAgents = Array.isArray(evidence?.excludedAgents) ? evidence.excludedAgents : [];
  if (!pipelineDrugs.length && !excludedAgents.length) return '';

  const lower = (claudeText || '').toLowerCase();
  const evaluated = pipelineDrugs.map((d) => {
    const candidates = [d.name, ...(Array.isArray(d.aliases) ? d.aliases : [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    const found = candidates.some((n) => lower.includes(n));
    const status = d.approvalStatus || 'investigational';
    return `- **${d.name}** — ${status}${d.status ? ` · ${d.status}` : ''}${found ? ' · ✓ discussed above' : ' · **NOT DISCUSSED** in this analysis'}`;
  }).join('\n');

  const excluded = excludedAgents.map((x) => `- **${x.name}** — ${x.reason}`).join('\n');

  return `\n\n---\n\n## Agents evaluated for this analysis\n\nThis is the complete consideration set for this condition from our curated knowledge base. Every agent listed was searched for in the literature (PubMed / Europe PMC / OpenAlex / Cochrane) and on ClinicalTrials.gov before the analysis was written. If any agent is marked "NOT DISCUSSED" above, it was either not supported by the evidence pack for this specific patient profile, or was outside the scope of the sections produced — check the curated KB file for the full rationale.\n\n### Pipeline drugs (FDA-approved + phase 2b/3 + pivotal)\n${evaluated || '_(none listed in curated KB for this condition)_'}\n\n### Excluded agents (considered and rejected)\n${excluded || '_(none listed)_'}\n\n_Curated KB source: \`data/kb/\`. If an agent you expected to see is missing, that's an editor-level gap in our KB — open an issue or add it to the file._\n`;
};

const buildGroundingBlock = (evidence) => {
  if (!evidence) return '';
  // Top-6 rather than top-8 (or top-25 originally). Each item costs
  // ~200-400 input tokens even with the tightened excerpt length.
  // Empirically, Claude concentrates its citations in the top 3-5
  // items anyway; items 7+ show up in maybe 15% of runs. Cost cut
  // 2026-04-23: saves ~500-800 input tokens per synthesis call,
  // which is ~8-12% of the pack's total input contribution.
  const items = (evidence.groundedForPrompt || []).slice(0, 6);
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
    // Quality signals — render the two most important positive and negative
    // flags inline so Claude weights the source appropriately when citing.
    const qualityTags = [];
    if (it.isMetaAnalysis) qualityTags.push('META-ANALYSIS');
    else if (it.isSystematicReview) qualityTags.push('SYSTEMATIC-REVIEW');
    else if (it.isRCT) qualityTags.push('RCT');
    if (it.isPreprint) qualityTags.push('PREPRINT-NOT-PEER-REVIEWED');
    // (First-author-country integrity flag removed 2026-04 per product
    // decision; we no longer down-weight literature based on author
    // country. Retraction + predatory-publisher flags still apply.)
    const qTag = qualityTags.length ? ` [${qualityTags.join(' · ')}]` : '';
    const src = (it.sources || []).join('+');
    const pubLine = it.publisher ? ` · Publisher: ${it.publisher}` : '';
    const countryLine = it.firstAuthorCountry ? ` · 1st-author country: ${it.firstAuthorCountry}` : '';
    return `[#${i + 1}]${kbTag}${tierLabel}${access}${oa}${qTag} ${it.title || '(no title)'}
      Journal: ${it.journal || '?'}${pubLine} · Year: ${it.year || '?'} · Sources: ${src} · Citations: ${it.citations || 0}${countryLine}
      URL: ${it.url || '(no URL)'}
      Content: ${(it.text || '').slice(0, 2000) || '(no text available — metadata only; you may name this paper but MUST NOT claim anything about its results, methods, or conclusions)'}`;
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

LITERATURE SAFETY CONSIDERATIONS (established concerns from guidelines/trials — report as cited evidence for physician discussion; NEVER as directives like "do not take"):
${redFlags.map((r) => `  - ${r}`).join('\n') || '  (none)'}

Use these canonical facts and safety considerations as your backbone. Live evidence supplements them. If a live item contradicts a canonical fact, say so explicitly and weigh the quality of each.
`;
  }

  // Quality-exclusion summary — tell Claude what we already filtered OUT so
  // it doesn't cite papers we pulled out of the pool and doesn't try to
  // compensate by naming known-retracted titles from general knowledge.
  const qb = evidence.qualityBreakdown;
  let qualityNoteBlock = '';
  if (qb) {
    const bits = [];
    if (qb.retractedExcluded > 0) {
      bits.push(`${qb.retractedExcluded} retracted paper(s) were FOUND in the initial pool and EXCLUDED from this pack. Do not cite these titles from memory: ${qb.retractedTitles.map((r) => `"${(r.title || '').slice(0, 80)}"`).join('; ')}.`);
    }
    if (qb.predatoryExcluded > 0) {
      bits.push(`${qb.predatoryExcluded} paper(s) from publishers with documented integrity concerns were filtered from this prompt pack.`);
    }
    if (qb.preprintsInPool > 0) {
      bits.push(`${qb.preprintsInPool} preprint(s) are still present but tagged — flag them to the user as "preprint, not peer-reviewed".`);
    }
    if (qb.countryConcernInPromptPack > 0) {
      bits.push(`${qb.countryConcernInPromptPack} of the items below have a first author from a jurisdiction with documented systemic research-integrity concerns (CN, RU, IR, PK, IN, VN). They carry a "FIRST-AUTHOR-*-INTEGRITY-CONCERN" tag. You may still cite them, but: (a) prefer equivalent Western-origin evidence when available, (b) when you do cite them, explicitly note the origin in the text of your answer, and (c) never cite them as the SOLE evidence for a safety-critical claim.`);
    }
    if (bits.length) qualityNoteBlock = `SOURCE-QUALITY NOTES FOR THIS PACK:\n${bits.map((b) => `- ${b}`).join('\n')}\n\n`;
  }

  return `GROUNDED EVIDENCE PACK — you MUST cite only from this list. If a claim is not supported by one of these items, say "No grounded evidence in pack" instead of making one up.

${kbBlock}

${qualityNoteBlock}CITATION ACCESS RULES (strict — many medical journals are paywalled and we deliberately only pull what is legal to share):
- Each item is tagged [FULL-TEXT], [ABSTRACT-ONLY], or [METADATA-ONLY] to tell you exactly how much of it you have read.
- Items also tagged [CURATED KB] are hand-curated landmark references — prefer them when the topic is directly covered.
- [FULL-TEXT] items: you may cite methods, results, secondary endpoints, subgroups, adverse events, and figures, because you actually have the body text.
- [ABSTRACT-ONLY] items: you may ONLY cite things that literally appear in the Content field (which is the peer-reviewed abstract or, for KB items, editor summary + verbatim passages). You may NOT claim anything about sub-group analyses, exact adverse-event frequencies beyond what the abstract states, study methods beyond what the abstract states, or any detail that requires having read the full paper.
- [METADATA-ONLY] items: you may NAME the paper and reference it as "peer-reviewed source exists (abstract/full text unavailable in this pack)" but you may NOT claim anything about its findings.
- In EVERY citation you write, append the access tag in brackets after the URL, exactly like this: \`[#3] (NEJM 2014) https://... [ABSTRACT-ONLY] — "quoted passage"\`. This is non-negotiable.
- When the Content shows an "Editor's summary", treat that as context — do not quote it as if it were from the paper. Quote only "Verbatim passage" blocks verbatim, or abstract text for live items.
- When you quote, copy the text verbatim from the Content field below and include the URL.

SOURCE-QUALITY PRIORITY ORDER (use this when two items conflict):
  1. [CURATED KB] items (hand-curated landmark refs for this disease)
  2. Cochrane Systematic Reviews + [META-ANALYSIS]
  3. [SYSTEMATIC-REVIEW] + [RCT] in A+ / A tier journals
  4. Observational / cohort studies in A+ / A tier journals
  5. [RCT] / [META-ANALYSIS] in B tier journals
  6. Anything else peer-reviewed
  7. [PREPRINT-NOT-PEER-REVIEWED] items (only cite as supplementary, flag explicitly)
  Items carrying FIRST-AUTHOR-*-INTEGRITY-CONCERN drop one tier in this order.

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
  // Genetic variant — critical for gene-therapy eligibility. We label it
  // CONFIRMED GENETIC MUTATION/VARIANT and instruct the model to filter
  // gene-targeted therapies by this variant explicitly. Without this the
  // model has historically suggested e.g. Luxturna (RPE65-only) for an
  // RP patient who actually carries USH2A — wrong eligibility, wasted
  // hope. This block tells the model: if a gene therapy targets a
  // different gene, say so out loud and don't recommend it.
  if (p.geneticVariant) {
    lines.push(`CONFIRMED GENETIC MUTATION / VARIANT (use this to gate gene-therapy and gene-targeted small-molecule recommendations): ${p.geneticVariant}
  → For EVERY gene-targeted therapy you mention, you MUST explicitly check whether the therapy targets the SAME gene as the patient's variant. If yes, call out the eligibility match. If no, write "NOT ELIGIBLE — therapy targets <other gene>, patient carries <patient's gene>." Do not silently recommend gene therapies for the wrong gene.`);
  }
  return lines.length ? lines.join('\n') : 'No patient context provided.';
};

const audienceLine = (audience) =>
  audience === 'medical'
    ? 'AUDIENCE: Medical professional. Use precise clinical terminology, include pharmacology, dosing, and mechanism where relevant.'
    : 'AUDIENCE: Non-medical reader (high-school / 10th-grade education). Explain every medical term in plain language. Keep sentences short.';

// Build the per-request dynamic header that is NEVER cached (it's different
// on every call: audience, patient profile, condition-specific context).
// Paired with the mode's *_STATIC scaffolding which IS cached. This is the
// Anthropic prompt-caching split — static scaffold gets `cache_control:
// ephemeral` and is served at 10% of the input-token price on cache hits.
const buildDynamicHeader = (patient, audience) => `${audienceLine(audience)}

PATIENT PROFILE:
${buildPatientContext(patient)}`;

const SHARED_GUARDRAILS = `
CITATION RULES (absolute — the single biggest failure mode of AI in medical research is hallucinated citations):
- CITE ONLY FROM THE GROUNDED EVIDENCE PACK provided below. Do not invent, paraphrase-without-URL, or cite from general knowledge.
- Every factual claim about efficacy, safety, interactions, or outcomes MUST reference at least one evidence-pack item by its number (e.g. "[#3]") and include a verbatim quoted passage from that item's Content AND a clickable markdown link: [short title](url).
- EVERY treatment, trial, drug, paper, guideline, and center mention MUST include a clickable markdown link when a URL exists in the evidence pack or trials pull. Bare URLs are acceptable only if markdown link syntax is impossible; prefer [title](url) always.
- If the evidence pack does not support a claim, write "No grounded evidence in pack" — DO NOT make one up.
- Prefer A+ and A tier journals (NEJM, Lancet, JAMA, BMJ, Nature Medicine, Cochrane, ERJ, AJRCCM, Thorax, Chest) over B/C.
- Weight evidence on METHODOLOGICAL grounds (RCT > observational > case report; meta-analysis > single study; larger n > smaller n; registered + pre-registered > not). Do NOT down-weight or up-weight by country of origin — a well-conducted RCT from any country is a well-conducted RCT.

ACCESS-LEVEL HONESTY (critical — many high-impact medical journals are paywalled):
- Every evidence item has an [ACCESS] tag: [FULL-TEXT], [ABSTRACT-ONLY], or [METADATA-ONLY].
- You MUST include this tag after every URL you cite.
- For [ABSTRACT-ONLY] papers: you have the peer-reviewed abstract and nothing else. You may cite what the abstract literally says. You may NOT invent numeric values, methodological details, subgroup outcomes, or adverse-event frequencies that are not in the abstract text.
- For [METADATA-ONLY] papers: you may name the paper but you must NOT claim what it found. Say "a peer-reviewed paper exists but the abstract/full text were not available to me in this pack."
- If a claim cannot be supported without overreaching past abstract content, state the limitation explicitly: "Based on the abstract; the full methods/results were not accessible."

LANGUAGE TONE (critical — legal/educational framing):
- This tool is educational decision-support, NOT medical advice or a prescription service.
- NEVER use imperative directives to patients: "do not take", "avoid", "stop", "DO NOT DO THIS", "you must not".
- Instead use literature-framed language: "Literature reports…", "Physicians often caution against…", "Evidence suggests caution regarding…", "Discuss with your physician before considering…", "Guidelines generally do not recommend…".
- Safety information must be preserved and cited — reframe it, do not delete it.

PATIENT-SPECIFIC SAFETY (critical):
- When discussing any drug, check the patient's current medication list for interactions and contraindications. Name the specific interaction and severity.
- Consider age, comorbidities, labs/PFTs, and scans when assessing suitability.
- Note treatments that literature or guidelines flag as concerning for this specific patient profile, even if effective in the general population — frame as "worth discussing with your physician."

GEOGRAPHIC / SOURCING RULES:
- For stem cell therapies, clinics in China, Vietnam, Mexico, or India must be excluded unless explicitly requested. Prefer US/Western Europe clinics whose source lab has no active FDA warning letter.
- For each stem cell treatment, state: cell type (e.g. cord blood MSCs, exosomes from MSCs, autologous adipose), source lab, delivery route (IV, nebulized/inhaled, intratracheal, intrathecal, local), dose, and whether any peer-reviewed data supports the specific product.
- Do not rely on a clinic's own advertising or press releases.

DISCLAIMERS:
- This is educational decision-support research, not medical advice. Final choices require a licensed physician.
`;

// Formatting rules that apply to EVERY section. Pulled out so the user's
// explicit complaint ("all the unecessary **** ****, make it bold or
// underlines things or bullet them") has a single, enforced source of truth.
const FORMATTING_RULES = `
OUTPUT FORMATTING RULES (enforce strictly — the user has explicitly complained about wall-of-text):
- Use MARKDOWN with headings (##, ###), bullets, and **bold** for key terms.
- **Bold every** drug name, trial acronym, NCT ID, percentage, dose, phone number, physician name, and center name.
- NO paragraphs longer than 3 lines. Break them into bullets.
- When comparing ≥3 items, USE A MARKDOWN TABLE, not prose.
- No filler words ("Furthermore", "Additionally", "It is worth noting that", "In conclusion"). Every sentence either gives a fact, a number, a name, or an action the patient can take.
- Every URL MUST be a real clickable markdown link: [PANTHER-IPF trial (NEJM 2012)](https://pubmed.ncbi.nlm.nih.gov/...) or [NCT01234567](https://clinicaltrials.gov/study/NCT01234567).
- Every drug name, trial, and paper mention in prose MUST also carry its link inline — users need to verify every finding.
- For every card (treatment / trial / candidate), use the exact fixed-field structure. Do not add prose between fields.
`;

// Front-half sections (1-3): condition snapshot, centers & experts,
// approved treatments (UI-parsed cards). These are the "here is your
// disease and what's available for it today" sections.
// (Section 4 — clinical trials & access programs — was moved to the
// BACK half because bundling trial sub-tables with 5 treatment cards
// kept blowing through max_tokens; BACK had 1000 tokens of headroom
// to absorb it.)
//
// Split into STATIC (cacheable) and a dynamic header built per-request
// so we can attach `cache_control: { type: 'ephemeral' }` to the big
// static block. Cost cut 2026-04-23: Anthropic prompt caching serves
// cached input tokens at 10% of the normal rate, so repeat runs on
// the same mode/half cost ~$0.006 instead of ~$0.06 for the static
// part. Break-even is 1 cache hit within 5 minutes.
const RESEARCH_PROMPT_FRONT_STATIC = `You are a comprehensive medical research assistant. Produce SECTIONS 1-3 of a structured analysis for the patient's primary condition. Sections 4-8 will be produced by a separate call — do NOT write them now.

LENGTH BUDGET (HARD RULE — this call has ~2,400 output tokens across 3 sections):
- Target ~800 output tokens (~600 words) per section on average.
- Dense bullets / tables. No paragraphs longer than 2 lines. No filler.
- YOU MUST FINISH ALL 3 SECTIONS. If section 3 is running long, cut to 3 treatments (not 5).

Your output MUST include the following 3 sections IN THIS ORDER, and nothing else. Do NOT add sections 4-8 — a separate call handles those.

## 1. Condition Snapshot
- One-sentence definition.
- Prevalence / incidence (from evidence pack or dossier).
- Typical trajectory if untreated.
- Primary medical specialty (from dossier) + one or two named top experts.
- Disease-dossier uncertainty score if > 0.5 (be transparent about AI confidence).

## 2. Top Centers & Experts Worldwide
**Use the disease dossier's topCenters + keyInvestigators as your starting list.** Correct/extend from grounded evidence. Present as a markdown table:

| Center | City | URL / Phone | Why it leads |
|---|---|---|---|

Then list 3–5 individual **named experts** with affiliations. Peer-recognised only — no clinic self-advertising.

## 3. Approved Treatments (Standard of Care)
Ranked by evidence strength, best first. Include the 3-5 most important treatments only. For EACH output this EXACT card structure (the UI parses these fields):

PROVIDER: <doctor / clinic / manufacturer with phone or URL>
TREATMENT: <drug / biologic / device / surgery; include dose, strength, route>
FDA_STATUS: <approved | off-label | investigational | expanded access | compassionate use | not FDA regulated>
LENGTH_FREQUENCY: <duration + frequency>
EFFICACY: <1-100>% — <one-line justification with grounded citation>
SAFETY: <1-100>% — <higher = safer, one-line justification>
RISKS: <serious AEs + THIS patient's risk given meds/comorbidities>
INTERACTIONS: <named interactions vs this patient's meds, or "None identified">
COST: <USD range, US insurance coverage note>
REFERENCES: <2-3 clickable markdown links from the evidence pack, e.g. [NEJM 2014 — pirfenidone](https://...) [ABSTRACT-ONLY]; never plain text URLs without link syntax>

${FORMATTING_RULES}

${SHARED_GUARDRAILS}`;

// Back-half sections (4-8): clinical trials & access programs, drug
// repurposing + pipeline, cell/gene, THIS patient's interaction &
// access plan, red flags. These are the "here's how to get into a
// trial, what to try, and what to avoid" sections — safety-critical
// and personalised.
const RESEARCH_PROMPT_BACK_STATIC = `You are a comprehensive medical research assistant. Produce SECTIONS 4-8 of a structured analysis for the patient's primary condition. Sections 1-3 were produced by a previous call — do NOT repeat them. Start straight at section 4.

LENGTH BUDGET (HARD RULE — this call has ~2,500 output tokens across 5 sections):
- Target ~500 output tokens (~375 words) per section on average. Section 4 (trials) may be larger; compensate by keeping 5-8 tighter.
- Dense bullets / tables. No paragraphs longer than 2 lines. No filler.
- YOU MUST FINISH ALL 5 SECTIONS. Sections 7-8 are safety-critical — do NOT starve them.
- Begin your output with the "## 4." heading. Do NOT write any preamble.

Your output MUST include the following 5 sections IN THIS ORDER, and nothing else.

## 4. Clinical Trials & Access Programs
**This single section MUST cover ALL FOUR access pathways.** Pull directly from the LIVE CLINICAL TRIALS PULL block below.

**A. Recruiting trials (top 5):** Markdown table —
| NCT ID | Phase | Title | Top Center? | Accepting? | URL |
|---|---|---|---|---|---|

**B. Open-Label Extension (OLE) studies:** For each OLE trial flagged in the pull, one line: NCT, parent trial, sponsor, closest open site. If none surfaced, say so AND tell the user: *"Patients in any Phase 2/3 should ask their PI whether an OLE is planned — most multi-year programs have one even before it lists on CT.gov."*

**C. Expanded Access / Compassionate Use:** For each EA record from the trials pull, one bullet: program name + NCT (or sponsor URL) · eligibility · how to apply · cost to patient. If none surfaced on CT.gov, check the dossier's landmarkTrials + your grounded knowledge for **industry-sponsored EAPs** (e.g. Ocugen's OCU400 for RP, lecanemab EAP for early AD). Name them with the sponsor-side URL and flag *"not listed on CT.gov — verify with sponsor."*

**D. Pay-to-Access / Charitable:** Any paid post-trial access programs the patient should know about (e.g. the ~$40k tier some sponsors charge between trial completion and market launch). If you don't know of any, say so — do NOT invent programs.

## 5. Drug Repurposing + Pipeline Watch
- **Repurposing teaser (2-3 candidates):** existing drugs/supplements with plausible mechanistic rationale. One line each. Point user to the dedicated Drug Repurposing tab for the full analysis.
- **Pipeline watch (2-3 early-phase programs):** Phase 1/2 worth watching, with NCT IDs and rough timeline-to-possible-approval.

## 6. Cell, Gene & Advanced Therapies
*If not applicable: one line "**N/A** — no active cell/gene therapy program for this condition."*
- **Stem cell:** reputable US / W. Europe labs only. Cell type · source lab · route · **FDA warning-letter status**. Exclude China / Vietnam / Mexico / India clinics by default.
- **Gene therapy:** approved? in trial? theoretical? Name specific NCT IDs + sponsors. Distinguish "cure" vs "slow progression."

## 7. This Patient's Interaction & Access Plan
Tailored to **this specific patient profile**:
- **Drug-drug interactions:** walk the patient's current meds vs the Section-3 recommendations. List every clinically meaningful interaction.
- **Non-drug / lifestyle:** practical bullets from the dossier's lifestyleCategories (e.g. IPF → GERD treatment, feather pillows, pulm rehab, vaccinations, O₂. RP → UV protection, vitamin A caveats, omega-3 caveats).
- **Patient advocacy:** 2-4 orgs / registries / foundations from the dossier's patientAdvocacy list, with homepage URLs.
- **Insurance & cost:** what US commercial / Medicare typically covers. Rough out-of-pocket. Red-flag overseas clinics with undisclosed pricing.

## 8. Safety Considerations Reported in Literature
From the dossier's redFlags + your grounded-evidence knowledge. Frame each item as cited literature for physician discussion — NEVER as patient directives:
- e.g. IPF: *"Literature reports increased mortality with prednisone+azathioprine+NAC triple therapy ([PANTHER-IPF, NEJM 2012](url)) — physicians generally avoid this combination; discuss with your doctor before considering it."*
- e.g. LADA: *"Evidence suggests sulfonylureas may accelerate beta-cell failure in LADA when misclassified as type 2 diabetes ([citation](url)) — worth verifying diagnosis and treatment approach with an endocrinologist."*
- e.g. RP: *"High-dose vitamin A palmitate carries teratogenic risk reported in literature ([citation](url)) — pregnancy planning should be discussed with a physician before use."*

Also cover: overseas clinic concerns (with source URLs where available), unproven 'cures' contradicted by grounded evidence, and excluded agents from the REQUIRED MENTIONS list — each with a clickable link.

${FORMATTING_RULES}

${SHARED_GUARDRAILS}`;

const REPURPOSE_PROMPT_STATIC = `You are a medical research professor leading a graduate seminar. Your students are looking at an existing drug library and asking, for a specific patient condition, "Which already-approved medications or widely-available supplements might logically help this condition — even though no formal guideline endorses them yet?"

This is the EveryCure / drug-repurposing methodology. Think outside the box. Reason from first principles about:
- the pathophysiology of the primary condition
- known mechanisms of action of existing drugs
- shared molecular pathways with other conditions where a drug is already effective
- supportive (not definitive) peer-reviewed evidence

## Mechanistic Hypotheses (no direct disease research required)
Produce 5-8 candidates where EVIDENCE_STRENGTH is MECHANISTIC_ONLY or PRECLINICAL.
These MUST be drugs/supplements with plausible pathway logic for THIS condition even if
zero human trials exist for this indication. Examples of the thinking we want:
- Anti-inflammatory already used in Condition B → shared pathway with patient's condition
- Metabolic drug → overlaps with disease pathophysiology
- Supplement targeting oxidative stress when disease involves ROS

For EACH mechanistic candidate, SUPPORTING_EVIDENCE must say explicitly:
"Mechanistic hypothesis only — no human data for [condition] yet" when true.
Still cite adjacent-condition papers or pathway reviews from the evidence pack when available.

Output these mechanistic/preclinical candidates FIRST, each using the CANDIDATE block format below.
Then continue with additional candidates that may have observational or trial data.

QUOTA (mandatory): At least 30% of your 12-25 total candidates MUST have EVIDENCE_STRENGTH of MECHANISTIC_ONLY or PRECLINICAL. Do NOT fill the list only with drugs that already have RCTs on this condition — the user specifically wants logic-based ideas with honest "no human data for this condition yet" labeling when that is true.

Produce a ranked list of 12-25 candidate repurposed drugs or supplements total. For EACH candidate output this exact block (the UI parses it):

CANDIDATE: <name>
CLASS: <drug class or supplement category>
APPROVED_FOR: <current FDA-approved or common use>
MECHANISM_TARGET: <the specific molecular target, pathway, or biological mechanism relevant to the condition (e.g. "TGF-β signalling", "AMPK activation / autophagy", "vitamin D receptor → anti-fibrotic gene expression")>
REPURPOSE_RATIONALE: <the mechanistic logic — why would this help the primary condition? Explain the biology step-by-step, at the specified audience level.>
EVIDENCE_STRENGTH: <one of: MECHANISTIC_ONLY | PRECLINICAL | CASE_REPORT | OBSERVATIONAL | SMALL_RCT | LARGE_RCT>
SUPPORTING_EVIDENCE: <peer-reviewed support with clickable markdown links [title](url) from the evidence pack plus verbatim quoted passages. If no grounded evidence exists in the pack, say "Mechanistic hypothesis only — no human data yet".>
EFFICACY_HYPOTHESIS: <1-100>% — <one-line justification>
SAFETY: <1-100>% — <higher = safer; reference FDA label / FAERS reactions if available>
CONFIDENCE: <1-100>% — <overall confidence that this is worth physician discussion>
PATIENT_SPECIFIC_RISKS: <interactions with THIS patient's meds, age, comorbidities>
HOW_TO_DISCUSS_WITH_DOCTOR: <practical script / questions the patient should ask a physician>

After the candidate list, include:

## Combination Candidates
Dorothy explicitly asked: "is it looking at drug combinations that may not have actually been researched for possible treatments?" — answer that question here.

Produce 5-10 combination candidates (pairings or triples of agents from the list above, or pairings of a listed candidate with a standard-of-care drug). For EACH combo output this exact block (the UI parses it):

COMBO: <Agent A + Agent B [+ Agent C]>
RATIONALE: <one or two sentences on why the mechanisms are complementary or synergistic for THIS condition — pathway diagram in words>
EVIDENCE_TIER: <one of: MECHANISTIC_ONLY | PRECLINICAL | CASE_REPORT | OBSERVATIONAL | SMALL_RCT | LARGE_RCT>
SUPPORTING_EVIDENCE: <verbatim quotes + clickable markdown links [title](url) from the evidence pack, or "Mechanistic hypothesis only — no human combo data yet" if there is no grounded evidence.>
INTERACTION_RISK: <severity LOW | MODERATE | HIGH plus the specific pharmacokinetic / pharmacodynamic interaction; reference FDA label drug-interaction text when available>
PATIENT_SPECIFIC_RISKS: <interactions with THIS patient's current medications + comorbidities; if none, write "None identified">
CONFIDENCE: <1-100>% — <overall confidence that this combo is worth physician discussion>
HOW_TO_DISCUSS_WITH_DOCTOR: <practical script — "I read about combining X and Y for [condition] because [pathway]; can we discuss whether monitoring [labs/AEs] would let us trial it?">

Combinations are HYPOTHESIS-GENERATION ONLY. Many real-world combos carry significant interaction risk (additive QT prolongation, serotonin syndrome, bleeding risk). When literature or pharmacology suggests interaction risk may dominate any plausible benefit, report that honestly with citations — list those as confidence < 25% and INTERACTION_RISK: HIGH. Frame as "physicians generally caution against combining… — discuss with your doctor."

## Reasoning Summary
Explain the top 3 single-agent candidates and the top 2 combination candidates in plain language.

## What This Is NOT
Clearly say this is hypothesis-generation, not a prescription, and must be discussed with a physician before any change. Combinations carry compounding risk even when each agent is individually safe.

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
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-access-passcode'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Site-wide access gate. When MRT_ACCESS_PASSCODE is set, the caller
  // must present a matching x-access-passcode header. Fail-open when
  // the env var is unset so local dev + tests keep working.
  if (!requireAccess(req, res)) return;

  try {
    const {
      mode = 'research',
      patient = {},
      audience = 'layperson',
      userQuery = '',
      chatHistory = [],
      trialsData = null,
      // Two-phase pipeline to stay under Vercel's 60s serverless cap.
      //   phase='gather'     — fan out to dossier+evidence+trials, return
      //                         those pools to the client, DON'T call Claude.
      //   phase='synthesize' — skip fan-out, use dossier+evidence+trials
      //                         provided by the client, run Claude only.
      //   phase='all' (default for backward compat & chat/trials/repurpose modes):
      //                         do everything in one request. Research mode
      //                         from the UI now uses gather→synthesize; the
      //                         single-shot path is still there for the API.
      phase = 'all',
      // When phase='synthesize' for the research mode, the client runs
      // TWO successive synth calls — each gets its own 60s Vercel slot
      // so Claude always finishes its half without hitting max_tokens
      // truncation.
      //   half='front' → sections 1-4 (snapshot, centers, treatments,
      //                  trials & access programs)
      //   half='back'  → sections 5-8 (repurposing+pipeline, cell/gene,
      //                  patient plan, red flags)
      // The frontend stitches the two responses together.
      half = 'front',
      providedDossier = null,
      providedEvidence = null,
      providedTrials = null,
      // For split synthesis on the BACK half: the client sends the
      // FRONT half's output text here so the server-side "Agents
      // evaluated" transparency block can correctly mark approved
      // drugs (which appear in the front half's section 3) as
      // discussed.
      priorText = ''
    } = req.body || {};
    const model = String(req.body?.model || DEFAULT_MODEL);
    const maxTokens = resolveMaxTokens(model);

    // ============================================================
    // Utility modes consolidated into /api/research so we stay
    // within Vercel Hobby's 12-function cap.
    // ============================================================
    if (mode === 'runtime-config') {
      const adsEnabled = String(process.env.MRT_ADS_ENABLED || '').trim() === '1';
      const adsenseClient = String(process.env.MRT_ADSENSE_CLIENT || '').trim();
      const prices = usagePricing();
      const lim = usageLimits();
      const devUnlimited = isUsageLimitBypassed(getClientIp(req));
      return res.status(200).json({
        branding: { productName: 'researchingmycondition.com' },
        ai: { researchModel: String(process.env.ANTHROPIC_RESEARCH_MODEL || DEFAULT_MODEL) },
        monetization: {
          devUnlimited,
          freeRunsPerMonth: devUnlimited ? 999999 : lim.free,
          proRunsPerMonth: devUnlimited ? 999999 : lim.pro,
          maxRunsPerMonth: devUnlimited ? 999999 : lim.max,
          proPriceUsd: prices.proPriceUsd,
          maxPriceUsd: prices.maxPriceUsd,
          // Backward compat for older clients
          paidRunsPerMonth: devUnlimited ? 999999 : lim.pro,
          paidPriceUsd: prices.proPriceUsd,
          upgradeUrl: String(process.env.MRT_UPGRADE_URL || '').trim(),
          tiers: devUnlimited
            ? [{ id: 'dev', label: 'Development', runsPerMonth: 999999, priceUsd: 0 }]
            : [
                { id: 'free', label: 'Free', runsPerMonth: lim.free, priceUsd: 0 },
                { id: 'pro', label: 'Pro', runsPerMonth: lim.pro, priceUsd: prices.proPriceUsd },
                { id: 'max', label: 'Max', runsPerMonth: lim.max, priceUsd: prices.maxPriceUsd }
              ]
        },
        ads: {
          enabled: adsEnabled,
          provider: adsEnabled ? 'google-adsense' : 'none',
          adsenseClient,
          slots: {
            researchTop: String(process.env.MRT_AD_SLOT_RESEARCH_TOP || '').trim(),
            repurposeTop: String(process.env.MRT_AD_SLOT_REPURPOSE_TOP || '').trim(),
            trialsTop: String(process.env.MRT_AD_SLOT_TRIALS_TOP || '').trim(),
            footer: String(process.env.MRT_AD_SLOT_FOOTER || '').trim()
          }
        }
      });
    }

    if (mode === 'usage') {
      try {
        const ip = getClientIp(req);
        const usage = await getUsage(ip);
        const lim = usageLimits();
        const prices = usagePricing();
        const devUnlimited = isUsageLimitBypassed(ip);
        return res.status(200).json({
          ok: true,
          usage,
          devUnlimited,
          limits: lim,
          pricing: devUnlimited
            ? {
                freeTier: 'Development — unlimited runs',
                proTier: 'Development — unlimited runs',
                maxTier: 'Development — unlimited runs',
                paidTier: 'Development — unlimited runs',
                tiers: [{ id: 'dev', runsPerMonth: 999999, priceUsd: 0 }]
              }
            : {
                freeTier: `${lim.free} runs / month`,
                proTier: `$${prices.proPriceUsd}/month for up to ${lim.pro} runs`,
                maxTier: `$${prices.maxPriceUsd}/month for up to ${lim.max} runs`,
                paidTier: `$${prices.proPriceUsd}/month for up to ${lim.pro} runs`,
                tiers: [
                  { id: 'free', runsPerMonth: lim.free, priceUsd: 0 },
                  { id: 'pro', runsPerMonth: lim.pro, priceUsd: prices.proPriceUsd },
                  { id: 'max', runsPerMonth: lim.max, priceUsd: prices.maxPriceUsd }
                ]
              }
        });
      } catch (err) {
        return res.status(500).json({ error: err?.message || 'Failed to fetch usage' });
      }
    }

    if (mode === 'activate-plan') {
      const code = String(req.body?.code || '').trim();
      if (!code) return res.status(400).json({ error: 'code is required' });
      const tier = verifyPlanCode(code);
      if (!tier) return res.status(403).json({ error: 'Invalid upgrade code' });
      try {
        const ip = getClientIp(req);
        await activatePlanForIp(ip, tier);
        const usage = await getUsage(ip);
        return res.status(200).json({
          ok: true,
          message: `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan activated for this IP.`,
          plan: tier,
          usage
        });
      } catch (err) {
        return res.status(500).json({ error: err?.message || 'Plan activation failed' });
      }
    }

    if (mode === 'translate') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
      const rawText = sanitize(req.body?.text);
      const targetLanguage = sanitize(req.body?.targetLanguage);
      const sourceLanguage = sanitize(req.body?.sourceLanguage) || 'English';
      if (!rawText) return res.status(400).json({ error: 'text is required' });
      if (!targetLanguage) return res.status(400).json({ error: 'targetLanguage is required' });
      if (rawText.length > TRANSLATE_MAX_CHARS) {
        return res.status(400).json({ error: `text too long (${rawText.length} chars). Max ${TRANSLATE_MAX_CHARS}.` });
      }
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
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: TRANSLATE_MODEL,
            max_tokens: 2800,
            temperature: 0,
            messages: [{ role: 'user', content: translatePrompt }]
          })
        });
        const raw = await r.text();
        let j;
        try { j = JSON.parse(raw); }
        catch {
          return res.status(502).json({ error: `Anthropic returned non-JSON (HTTP ${r.status})`, raw: raw.slice(0, 200) });
        }
        if (!r.ok) return res.status(502).json({ error: j?.error?.message || `Anthropic error (HTTP ${r.status})` });
        const translatedText = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!translatedText) return res.status(502).json({ error: 'Translation returned empty output' });
        return res.status(200).json({ translatedText, model: TRANSLATE_MODEL, sourceLanguage, targetLanguage });
      } catch (err) {
        return res.status(500).json({ error: err?.message || 'Translation failed' });
      }
    }

    if (mode === 'benchmark-models') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
      const SONNET_MODEL = process.env.ANTHROPIC_BENCHMARK_SONNET_MODEL || 'claude-sonnet-4-20250514';
      const OPUS_MODEL = process.env.ANTHROPIC_BENCHMARK_OPUS_MODEL || process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-opus-4-20250514';
      const MAX_BENCH_TOKENS = Number(process.env.ANTHROPIC_BENCHMARK_MAX_TOKENS || 700);
      const BENCH_PROMPT = 'Write 6 concise bullets on idiopathic pulmonary fibrosis: standard of care, one pipeline agent, one safety monitoring point, one trial-access note. Under 350 words.';
      const runOne = async (m) => {
        const started = Date.now();
        const rr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: m,
            max_tokens: MAX_BENCH_TOKENS,
            temperature: 0.1,
            messages: [{ role: 'user', content: BENCH_PROMPT }]
          })
        });
        const elapsedMs = Date.now() - started;
        const raw = await rr.text();
        let j;
        try { j = JSON.parse(raw); } catch { return { ok: false, model: m, elapsedMs, error: `Non-JSON HTTP ${rr.status}` }; }
        if (!rr.ok) return { ok: false, model: m, elapsedMs, error: j?.error?.message || `HTTP ${rr.status}` };
        const out = Number(j?.usage?.output_tokens || 0);
        return { ok: true, model: m, elapsedMs, outputTokens: out, tokensPerSec: elapsedMs > 0 ? Number((out / (elapsedMs / 1000)).toFixed(2)) : null };
      };
      const sonnet = await runOne(SONNET_MODEL);
      const opus = await runOne(OPUS_MODEL);
      const ratio = sonnet.ok && opus.ok && sonnet.elapsedMs > 0 ? Number((opus.elapsedMs / sonnet.elapsedMs).toFixed(2)) : null;
      return res.status(200).json({
        ok: true,
        sonnet,
        opus,
        comparison: {
          opusVsSonnetLatencyRatio: ratio,
          note: ratio ? `Opus latency is ${ratio}x Sonnet in deployment.` : 'Could not compute latency ratio.'
        }
      });
    }

    if (mode === 'validate') {
      return validateHandler(req, res);
    }

    // Monthly per-IP gate:
    // - free: first 4 runs/month
    // - paid: up to 15 runs/month
    //
    // IMPORTANT: research mode calls this endpoint multiple times per
    // user action (gather + synth + back half). We meter ONLY entry
    // requests (phase=all or phase=gather) so one "Run Full Research"
    // counts once, not 2-3x.
    const isBillableMode = mode === 'research' || mode === 'repurpose' || mode === 'trials';
    const ip = getClientIp(req);
    const shouldMeter = isBillableMode && (phase === 'all' || phase === 'gather') && !isUsageLimitBypassed(ip);
    if (shouldMeter) {
      const quota = await consumeResearchCredit(ip);
      if (!quota.allowed) {
        const lim = usageLimits();
        const prices = usagePricing();
        const planLabel = quota.plan === 'max' ? 'Max' : quota.plan === 'pro' ? 'Pro' : 'Free';
        return res.status(402).json({
          error: `Monthly limit reached for this IP (${quota.used}/${quota.limit} on ${planLabel} plan). Free: ${lim.free}/mo · Pro: $${prices.proPriceUsd} → ${lim.pro}/mo · Max: $${prices.maxPriceUsd} → ${lim.max}/mo.`,
          code: 'USAGE_LIMIT_REACHED',
          upgradeRequired: true,
          usage: quota,
          pricing: {
            freeRunsPerMonth: lim.free,
            proRunsPerMonth: lim.pro,
            maxRunsPerMonth: lim.max,
            proPriceUsd: prices.proPriceUsd,
            maxPriceUsd: prices.maxPriceUsd,
            paidRunsPerMonth: lim.pro,
            paidPriceUsd: prices.proPriceUsd,
            upgradeUrl: String(process.env.MRT_UPGRADE_URL || '').trim()
          }
        });
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Server configuration error: ANTHROPIC_API_KEY not set.'
      });
    }

    // Effective condition — prefer patient.condition, but fall back to the
    // user's latest message (chat input) if the profile field is empty. This
    // is the fix for the "I type RP in the chat, AI refuses because no
    // condition set" UX bug. The dossier agent itself vets whatever we
    // pass; a junk string returns a high-uncertainty fallback.
    const latestUserMsg = (() => {
      if (userQuery && String(userQuery).trim()) return String(userQuery).trim();
      const lastUser = [...(chatHistory || [])].reverse().find((m) => m?.role === 'user');
      return lastUser?.content ? String(lastUser.content).trim() : '';
    })();
    // Heuristic: trim long conversational messages down to the medical noun
    // phrase. "Ok RP, give me info" → "RP". If the message is short (< 60
    // chars), just pass it whole to the dossier agent (it handles aliases).
    const extractConditionFromMessage = (msg) => {
      if (!msg) return '';
      const clean = msg.replace(/["?.,!]+/g, ' ').trim();
      if (clean.length < 60) return clean;
      const m = clean.match(/\b([A-Z]{2,6}|[a-z][a-z\- ]{3,40})\b/);
      return (m && m[1]) ? m[1] : clean.slice(0, 60);
    };
    const effectiveCondition =
      (patient.condition || '').trim() ||
      extractConditionFromMessage(latestUserMsg);

    // Research pipeline — three phases:
    //   (1) Disease-intake agent (Haiku, 24h cache) — builds structured
    //       dossier for ANY condition, including aliases like "RP" or
    //       "LADA". Runs for ALL modes now, even chat, so the agent has
    //       disease context from the very first turn.
    //   (2) Evidence + Trials in parallel, sharing the one dossier call.
    //   (3) Claude Sonnet synthesis with the dossier injected as context.
    let evidence = null;
    let trials = null;
    let dossier = null;

    // Phase: 'synthesize' trusts client-provided pools, skips fan-out.
    // Everything else (gather / all) does the live pulls.
    if (phase === 'synthesize') {
      dossier = providedDossier || null;
      evidence = providedEvidence || null;
      trials = providedTrials || null;
    } else {
      // Hard deadline for the entire gather phase. Hobby caps each function
      // at 60s (see vercel.json maxDuration). Default 50s leaves headroom for
      // JSON serialization + response flush. Override with MRT_GATHER_DEADLINE_MS
      // on Pro (e.g. 90000) if you raise maxDuration there.
      const GATHER_DEADLINE_MS = Number(process.env.MRT_GATHER_DEADLINE_MS || 50_000);
      const withDeadline = (p, label) => Promise.race([
        p.catch((e) => {
          console.warn(`[research.gather] ${label} threw:`, e?.message || e);
          return null;
        }),
        new Promise((resolve) => setTimeout(() => {
          console.warn(`[research.gather] ${label} exceeded ${GATHER_DEADLINE_MS}ms — returning partial`);
          resolve(null);
        }, GATHER_DEADLINE_MS))
      ]);

      // Kick off dossier + evidence + trials ALL IN PARALLEL. Evidence
      // and trials each call getDossier() internally and, thanks to
      // the in-flight promise dedup in disease-dossier.js, they share
      // the same pending Claude call as the one research.js started.
      // Net effect: one ~8-10s Claude dossier call runs concurrently
      // with the PubMed/EPMC/OpenAlex fan-out and the ClinicalTrials
      // API pull, instead of serially before them.
      const drugs = (patient.medications || '')
        .split(/[,;\n]/).map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 6);
      const needsEvidence = (mode === 'research' || mode === 'repurpose');
      const dossierP = effectiveCondition
        ? withDeadline(getDossier(effectiveCondition), 'dossier')
        : Promise.resolve(null);
      const evidenceP = needsEvidence
        ? withDeadline(invokeEvidence({
            condition: effectiveCondition,
            // Trimmed fan-out: 2 treatment cross-products instead of 4.
            // The dossier's synonyms + KB cover the specificity loss.
            treatments: ['treatment', 'systematic review'],
            drugs,
            manufacturers: [],
            limitPerSource: 3,
            includeFullText: true
            // NB: dossier intentionally NOT passed — evidence.js will
            // fetch it via getDossier() and hit the in-flight cache so
            // we still only make one Claude call total.
          }), 'evidence')
        : Promise.resolve(null);
      const trialsP = needsEvidence
        ? withDeadline(invokeTrials({
            condition: effectiveCondition,
            recruitingOnly: false,
            treatmentOnly: true,
            pageSize: 30
          }), 'trials')
        : Promise.resolve(null);

      const [dossierResult, evidenceResult, trialsResult] = await Promise.all([
        dossierP, evidenceP, trialsP
      ]);
      dossier = dossierResult;
      evidence = evidenceResult;
      trials = trialsResult;
    }

    // Phase='gather' short-circuits here. We hand the raw pools back to the
    // client, which will then call us again with phase='synthesize' and the
    // pools attached. This splits the >60s single-shot pipeline into two
    // sub-60s serverless invocations.
    if (phase === 'gather') {
      const trimmed = trimGatherPools({ dossier, evidence, trials });
      return res.status(200).json({
        phase: 'gather',
        model,
        maxTokens,
        ...trimmed
      });
    }
    const groundingBlock = evidence ? buildGroundingBlock(evidence) : '';
    const trialsBlock = trials ? buildTrialsBlock(trials) : '';
    const dossierBlock = dossier ? buildDossierBlock(dossier) : '';
    // Anti-omission guardrail: inject the KB's pipelineDrugs +
    // excludedAgents as REQUIRED MENTIONS. See buildRequiredMentionsBlock.
    const requiredMentionsBlock = evidence ? buildRequiredMentionsBlock(evidence) : '';

    // Extra context layers stitched onto the base mode prompt. Order matters:
    // dossier first (the AI's starting hypothesis about the disease), then
    // grounded evidence pack (what the literature actually says), then the
    // live trials pull (what's currently enrolling / offering expanded
    // access), then the REQUIRED MENTIONS list last so Claude sees the
    // anti-omission constraint immediately before starting to write.
    const extraContext = [dossierBlock, groundingBlock, trialsBlock, requiredMentionsBlock]
      .filter(Boolean)
      .join('\n\n');

    // `systemBlocks` is an array of content blocks sent to Anthropic.
    // The first block (when present) is the STATIC mode scaffolding with
    // `cache_control: { type: 'ephemeral' }` so it is served at 10% of
    // normal input-token rate on repeat requests within the 5-minute
    // cache window. The second block is the dynamic per-request header
    // (audience, patient profile, grounded evidence, trials data) which
    // is always fresh. Chat/trials modes bypass the cache split — chat
    // is too dynamic and trials embeds a big JSON blob inline.
    let systemBlocks = null;
    let systemPrompt = null;

    switch (mode) {
      case 'repurpose':
        systemBlocks = [
          { type: 'text', text: REPURPOSE_PROMPT_STATIC, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildDynamicHeader(patient, audience) + (extraContext ? `\n\n${extraContext}` : '') }
        ];
        break;
      case 'trials':
        systemPrompt = TRIALS_PROMPT(patient, audience, trialsData || {});
        break;
      case 'chat': {
        // Chat mode supports TWO scenarios:
        //   (a) Follow-up after a prior Research / Repurpose / Trials run,
        //       where the client sent the prior analyses + cached evidence
        //       pack so Claude can answer "why did you rate X over Y".
        //   (b) Cold-start: user types a disease directly into the chat bar
        //       with no profile filled in and no prior analyses. The agent
        //       must STILL answer substantively — that was the whole point
        //       of the user's complaint ("don't refuse, answer the
        //       question"). In this case we use the dossier we just built
        //       from their message as the disease context.
        const priorPieces = [];
        const prior = req.body?.priorAnalyses || {};
        if (prior.research)  priorPieces.push(`=== PRIOR "RESEARCH" ANALYSIS (produced earlier in this session) ===\n${String(prior.research).slice(0, 25000)}`);
        if (prior.repurpose) priorPieces.push(`=== PRIOR "REPURPOSE" ANALYSIS ===\n${String(prior.repurpose).slice(0, 20000)}`);
        if (prior.trials)    priorPieces.push(`=== PRIOR "TRIALS" ANALYSIS ===\n${String(prior.trials).slice(0, 20000)}`);
        const hasPriors = priorPieces.length > 0;

        const cachedPack = Array.isArray(req.body?.evidencePack) ? req.body.evidencePack.slice(0, 18) : [];
        const chatGrounding = cachedPack.length
          ? buildGroundingBlock({ groundedForPrompt: cachedPack, fdaLabels: [], fdaManufacturers: [] })
          : '';

        // If we got a usable dossier (patient.condition OR extracted from the
        // user's message), include it so Claude knows what disease we're
        // talking about even without a profile or prior analysis.
        const dossierInChat = dossier && dossier.canonical ? buildDossierBlock(dossier) : '';

        // Effective-condition context — even if the dossier agent errored,
        // the user's typed condition is still in `effectiveCondition`. Claude
        // can answer on general medical knowledge using that. This is the
        // NON-NEGOTIABLE anti-refusal clamp.
        const detectedCondition = effectiveCondition || '(none detected yet)';

        systemPrompt = `You are a senior medical research professor answering medical questions directly and substantively. The user has already accepted the decision-support disclaimer.

${audienceLine(audience)}

=== DETECTED CONDITION ===
The user appears to be asking about: **${detectedCondition}**
${dossier?.fallbackReason ? `(The disease-intake agent errored: ${dossier.fallbackReason}. Use your own medical knowledge to answer. DO NOT mention the agent or the dossier to the user.)` : ''}

PATIENT PROFILE (may be empty — that's fine):
${buildPatientContext(patient)}

${dossierInChat ? dossierInChat + '\n' : ''}${hasPriors ? priorPieces.join('\n\n') + '\n\n' : ''}=== ABSOLUTE BEHAVIOR RULES ===

1. **ANSWER THE QUESTION ON THE FIRST TURN.** Do not refuse. Do not ask for more information before answering. Do not say "I cannot..." / "I need more info to proceed" / "please provide..." / "to give you a comprehensive analysis I need...". Those responses are FAILURES.

2. If the user typed ANY disease name, abbreviation, or medical term (e.g. "RP", "LADA", "AD", "ALS", "PD", "AFib", "Retinitis Pigmentosa", "jaundice", "lupus"), IMMEDIATELY answer about that disease. Your FIRST sentence MUST confirm the condition: e.g. "**RP (Retinitis Pigmentosa)** is an inherited retinal dystrophy that..."

3. Your default chat response when the user names a disease has this shape (use markdown):

   **What it is** (1 sentence)

   **Current approved treatments**
   - bullet 1
   - bullet 2

   **Notable trials / access programs worth knowing about**
   - trial name, NCT if you know it, sponsor, what it's testing
   - any expanded-access / compassionate-use programs
   - any open-label extensions

   **Top centers / experts**
   - named centers and specialists

   **Patient resources**
   - advocacy orgs, registries

   **Safety considerations reported in literature**
   - bullets with clickable links where available; frame as evidence for physician discussion, not directives

   **For a deeper personalized analysis** — prompt them: "Add this condition to the Patient Profile tab and hit Run Research for a full 16-section personalised analysis with drug-interaction checks and the live evidence pack."

4. **Bold every** drug name, trial acronym, NCT ID, percentage, center name, and advocacy org name. Use bullets. Never write a paragraph longer than 3 lines.

5. For follow-up questions (user's message isn't a disease name — e.g. "what about side effects", "tell me more about X"), use the prior analyses + dossier + general medical knowledge. Be specific and substantive.

6. When the dossier is empty or low-confidence, answer from your own clinical knowledge. Say "Based on general clinical knowledge:" as a prefix — then give the substantive answer. NEVER use low-confidence as a reason to refuse.

7. For drug interactions / contraindications / dosing for THIS patient, check their medication list and comorbidities and give specific answers.

8. Keep disclaimers short and at the END if at all. Never lead with a disclaimer.

${chatGrounding || '(No cached evidence pack this turn — that\'s OK. Answer from the dossier, prior analyses if present, and your own medical knowledge.)'}`;
        break;
      }
      case 'research':
      default: {
        // Research mode is split across two Claude calls (half='front'
        // + half='back') so each fits under Vercel's 60s cap and
        // neither hits stop_reason=max_tokens mid-answer.
        const baseStatic = half === 'back'
          ? RESEARCH_PROMPT_BACK_STATIC
          : RESEARCH_PROMPT_FRONT_STATIC;
        systemBlocks = [
          { type: 'text', text: baseStatic, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildDynamicHeader(patient, audience) + (extraContext ? `\n\n${extraContext}` : '') }
        ];
        break;
      }
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
        model,
        max_tokens: maxTokens,
        // Prefer the cache-enabled `systemBlocks` array when the mode
        // supports it (research + repurpose); fall back to a plain
        // string for chat + trials modes where the prompt is too
        // dynamic to benefit from caching.
        system: systemBlocks || systemPrompt,
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
    let claudeText = (data.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join('\n\n');

    // === Post-synthesis coverage audit ===
    // Scan the output for every pipelineDrug in the evidence pack's
    // KB-derived list. If any is missing, force Claude to rewrite with
    // the missing drugs inserted. This is the failsafe below the REQUIRED
    // MENTIONS prompt directive — if the model ignored the directive we
    // still catch it.
    //
    // Limit: one re-prompt attempt. Two reasons:
    //   (a) Vercel Hobby has a hard 60s per-invocation cap; a second
    //       Claude call already pushes the budget.
    //   (b) If two attempts both miss the drug, that's a signal the drug
    //       is genuinely borderline for this patient — log it and move on.
    //
    // Only runs for research + repurpose modes where the pipelineDrugs
    // list is meaningful. Skipped for pure chat and for the trials mode
    // (which is a separate analysis shape).
    const isSynthesisMode = (mode === 'research' || mode === 'repurpose');
    const allPipelineDrugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];

    // Segment by which synthesis half is responsible for each agent.
    //   RESEARCH mode, split synthesis:
    //     - FRONT half (sections 1-3): FDA-approved standard-of-care agents.
    //     - BACK half  (sections 4-8): investigational, pipeline, discontinued,
    //                                  pivotal-negative agents.
    //   REPURPOSE mode: the analysis is candidate-oriented, not section-oriented.
    //     We audit only investigational/pipeline agents — approved drugs are
    //     what the patient is already on and aren't "repurposing candidates".
    //   If `half` is undefined (single-shot research mode), audit everything.
    const pipelineDrugs = (() => {
      if (mode === 'repurpose') {
        return allPipelineDrugs.filter((d) => d.approvalStatus !== 'approved');
      }
      if (mode !== 'research' || !half) return allPipelineDrugs;
      if (half === 'front') {
        return allPipelineDrugs.filter((d) => d.approvalStatus === 'approved');
      }
      return allPipelineDrugs.filter((d) => d.approvalStatus !== 'approved');
    })();

    let coverageAudit = null;
    if (isSynthesisMode && pipelineDrugs.length && claudeText) {
      const initialMissed = scanForMissedPipelineDrugs(claudeText, pipelineDrugs);
      coverageAudit = {
        half: half || 'single-shot',
        pipelineDrugsAudited: pipelineDrugs.length,
        pipelineDrugsTotal: allPipelineDrugs.length,
        initialMissed: initialMissed.map((d) => d.name),
        reprompted: false,
        finalMissed: initialMissed.map((d) => d.name)
      };
      if (initialMissed.length > 0) {
        // Construct a targeted re-prompt. We don't send the whole system
        // prompt again — we send the previous draft plus a directive that
        // calls out the missed drugs by name.
        const missedSummary = initialMissed.map((d) => {
          const aliases = d.aliases?.length ? ` (aka ${d.aliases.join(', ')})` : '';
          const bits = [d.mechanism, d.sponsor, d.status, d.nct ? `NCT ${d.nct}` : null, d.pmid ? `PMID ${d.pmid}` : null]
            .filter(Boolean).join(' · ');
          return `- **${d.name}**${aliases}: ${bits}. ${d.whyItMatters || ''}`;
        }).join('\n');

        const repromptDirective = `=== COVERAGE AUDIT FAILURE — FORCED REWRITE ===
Your previous draft FAILED the mandatory pipeline-drug coverage audit. The following agents were in the REQUIRED MENTIONS list but were NOT mentioned in your output. You MUST rewrite and return the complete analysis with each of these agents inserted in the appropriate section. Do not produce a partial response.

MISSED AGENTS:
${missedSummary}

Where they must go:
- FDA-approved agents → Section 3 (Approved Treatments)
- Phase 3 / phase 2b investigational agents → Section 4 (Clinical Trials & Access Programs) or Section 5 (Pipeline Watch)
- Discontinued or pivotal-negative agents → Section 8 (Safety Considerations Reported in Literature)

Return the full corrected analysis now, beginning again at "## 1." (front half) or "## 4." (back half) depending on which half you are generating.`;

        // Build the reprompt system in the same shape as the original — if
        // the original used cached blocks, keep them cached on the reprompt
        // (same 5-minute cache key) so we only pay for the appended
        // directive as fresh input tokens.
        const repromptSystem = systemBlocks
          ? [
              ...systemBlocks,
              { type: 'text', text: repromptDirective }
            ]
          : `${systemPrompt}\n\n${repromptDirective}`;

        try {
          const reprompt = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              system: repromptSystem,
              messages
            })
          });
          if (reprompt.ok) {
            const repromptData = await reprompt.json();
            const rewritten = (repromptData.content || [])
              .filter((c) => c?.type === 'text')
              .map((c) => c.text)
              .join('\n\n');
            if (rewritten) {
              claudeText = rewritten;
              coverageAudit.reprompted = true;
              coverageAudit.finalMissed = scanForMissedPipelineDrugs(rewritten, pipelineDrugs).map((d) => d.name);
              // Replace the content in the response so the UI renders the
              // corrected analysis, not the first draft.
              data.content = repromptData.content;
            }
          }
        } catch (err) {
          console.error('[research] coverage-audit reprompt failed:', err.message);
        }
      }
    }

    // Append the deterministic "Agents evaluated" transparency block so
    // the user can always see which agents were in the consideration set
    // and whether they made it into the analysis. This is programmatic —
    // not generated by Claude — so it can't be hallucinated.
    //
    // For split synthesis we only append on the BACK half (which is
    // appended LAST in the client) or single-shot. Otherwise the UI
    // would render two copies.
    const shouldAppendTransparency =
      isSynthesisMode &&
      allPipelineDrugs.length &&
      claudeText &&
      (!half || half === 'back');
    if (shouldAppendTransparency) {
      // For split synthesis, include the front-half text when scanning
      // so approved drugs (discussed in section 3 of the front half)
      // are correctly marked as "✓ discussed" in the transparency block.
      const textForScan = priorText ? `${priorText}\n\n${claudeText}` : claudeText;
      const transparencyBlock = buildAgentsEvaluatedBlock(textForScan, evidence);
      if (transparencyBlock) {
        claudeText = claudeText + transparencyBlock;
        // Also replace the text content in the response so the UI picks
        // it up naturally without needing a separate field to render.
        if (data.content && data.content.length) {
          const last = data.content[data.content.length - 1];
          if (last && last.type === 'text') {
            last.text = (last.text || '') + transparencyBlock;
          } else {
            data.content.push({ type: 'text', text: transparencyBlock });
          }
        }
      }
    }

    // Cross-validation: fire an INDEPENDENT second AI (Perplexity / OpenAI / xAI)
    // over Claude's output + the same evidence pack to catch hallucinated
    // citations and unsupported claims. An LLM grading its own work is weak;
    // an independent second model with different training data is a much
    // stronger safeguard.
    //
    // COST CUT 2026-04-23: validator is now OPT-IN (default OFF). Previously
    // this fired on every research run, burning ~$0.05 per request on the
    // second LLM whether the user cared about the audit or not. Users who
    // want it now click an "Audit this analysis" button in the UI, which
    // POSTs to /api/validate directly with the analysis text + evidence
    // pack. The inline call here still works if the caller explicitly
    // passes `validate: true` — handy for automated pipelines.
    let validation = null;
    const wantValidation = req.body?.validate === true;
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
      model,
      maxTokens,
      dossier: dossier
        ? {
            canonical: dossier.canonical,
            synonyms: dossier.synonyms,
            meshTerms: dossier.meshTerms,
            icd10: dossier.icd10,
            subspecialty: dossier.subspecialty,
            topCenters: dossier.topCenters || [],
            keyInvestigators: dossier.keyInvestigators || [],
            patientAdvocacy: dossier.patientAdvocacy || [],
            landmarkTrials: dossier.landmarkTrials || [],
            commonComorbidities: dossier.commonComorbidities || [],
            redFlags: dossier.redFlags || [],
            lifestyleCategories: dossier.lifestyleCategories || [],
            uncertainty: dossier.uncertainty,
            notes: dossier.notes,
            cacheHit: dossier.cacheHit,
            cacheDisabled: dossier.cacheDisabled || false,
            generatedBy: dossier.generatedBy
          }
        : null,
      evidence: evidence
        ? {
            totalUnique: evidence.totalUnique,
            accessBreakdown: evidence.accessBreakdown,
            promptPackBreakdown: evidence.promptPackBreakdown,
            qualityBreakdown: evidence.qualityBreakdown,
            knowledgeBase: evidence.knowledgeBase,
            topRanked: (evidence.topRanked || []).slice(0, 50),
            groundedForPrompt: evidence.groundedForPrompt,
            fdaLabels: evidence.fdaLabels,
            fdaManufacturers: evidence.fdaManufacturers,
            pipelineDrugs: evidence.pipelineDrugs || [],
            excludedAgents: evidence.excludedAgents || []
          }
        : null,
      trials: trials
        ? {
            total: trials.total,
            breakdown: trials.breakdown,
            subQueries: trials.subQueries,
            studies: (trials.studies || []).slice(0, 25)
          }
        : null,
      coverageAudit,
      validation
    });
  } catch (error) {
    console.error('research.js error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
