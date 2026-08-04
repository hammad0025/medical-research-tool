// Candidates for the "researched, not yet approved" section were only ever
// discovered by whatever the live gather happened to surface, so a condition
// whose curated knowledge base already pins landmark trials for vitamin A,
// DHA, NAC, goji and TUDCA still shipped three of them. These are the
// highest-confidence condition-specific agents we have: they are curated,
// they carry a real pinned reference, and they need no retrieval luck.

// Interventional study categories. A general review or a natural-history
// paper is not evidence that a specific agent was studied for the condition.
const RESEARCHED_CATEGORIES = new Set([
  'rct', 'preclinical', 'systematic-review', 'observational', 'case-report', 'cohort'
]);

// Agents that must never be offered as an "idea": already-approved therapy for
// this condition belongs in Approved Treatments, and devices are not drugs.
const NOT_AN_IDEA = /\b(?:luxturna|voretigene|argus|implant|prosthes|retinal chip)\b/i;

/**
 * Pull the intervention name out of a study title. Titles follow a small set
 * of conventions ("A randomized trial of X for Y", "Oral X improves ...", "X
 * slows ..."), so a few shapes cover most of them. Returns '' when no clear
 * agent can be read, rather than guessing — a wrong name here would put an
 * unrelated drug in front of a patient.
 */
export const agentNameFromTitle = (title) => {
  const raw = String(title || '').trim();
  if (!raw) return '';
  const patterns = [
    /^(?:a\s+)?(?:randomized|randomised|double[- ]blind|placebo[- ]controlled|multicenter|phase\s*[i1-4]+)?\s*(?:clinical\s+)?trial of\s+([^,:]+?)\s+(?:in|for|supplementation)\b/i,
    /^(?:oral|topical|intravitreal|subretinal|dietary|systemic)\s+([^,:]+?)\s+(?:improves?|slows?|reduces?|preserves?|protects?|delays?|provides?)\b/i,
    /^([^,:]+?)\s+(?:slows?|reduces?|improves?|preserves?|protects?|delays?|provides?)\b/i,
    /^(?:neuroprotective\s+effect\s+of|efficacy\s+(?:and\s+safety\s+)?of|safety\s+and\s+efficacy\s+of|effect\s+of)\s+([^,:]+?)(?:\s+(?:on|in|for)\b|$)/i,
    /\busing\s+(?:a\s+)?(?:\d+[- ]month\s+)?treatment\s+with\s+([^,.:]+)/i
  ];
  for (const re of patterns) {
    const hit = raw.match(re)?.[1];
    if (!hit) continue;
    const name = hit
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name.length >= 3 && name.length <= 60 && !NOT_AN_IDEA.test(name)) return name;
  }
  return '';
};

/**
 * Curated agents with condition-specific research, each with the pinned
 * reference that establishes it. Deduplicated by agent name.
 */
// "vitamin A and vitamin E" describes two agents, not one.
const splitConjoinedAgents = (name) => {
  const parts = String(name || '')
    .split(/\s+and\s+|\s*\+\s*|\s*,\s*/i)
    .map((p) => p.replace(/\s+supplementation$/i, '').trim())
    .filter((p) => p.length >= 3 && p.length <= 60);
  return parts.length ? parts : [String(name || '').trim()].filter(Boolean);
};

const normKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "Neuroprotective Effect of Tauroursodeoxycholic Acid (TUDCA) on ..." and
// "TUDCA Slows Retinal Degeneration ..." are the same agent. Registering the
// parenthetical alias alongside the full name stops it appearing twice.
const titleAliases = (title) =>
  [...String(title || '').matchAll(/\(([A-Za-z][A-Za-z0-9-]{1,20})\)/g)].map((m) => m[1]);

export const researchedAgentSeeds = (kbItems = [], excludedAgents = [], approvedNames = []) => {
  // Agents the knowledge base rules out (vitamin E accelerated decline in the
  // Berson trial) must not be proposed at all — seeding them only to have a
  // downstream filter delete the card wastes a slot and risks the exclusion
  // reason never reaching the reader.
  const excluded = [
    ...(excludedAgents || []).map((a) => (typeof a === 'string' ? a : a?.name)),
    // An agent already approved FOR THIS CONDITION belongs in Approved
    // Treatments. Seeding it here burns a slot the lane then skips, which is
    // how IPF and ALS ended up with an empty researched section: their curated
    // landmark trials are trials of the approved drugs.
    ...(approvedNames || [])
  ].map(normKey).filter(Boolean);
  const isExcluded = (name) => {
    const key = normKey(name);
    return !!key && excluded.some((ex) => ex.includes(key) || key.includes(ex));
  };
  const seen = new Set();
  const seeds = [];
  for (const item of kbItems) {
    if (!item || item.quarantined) continue;
    const category = String(item.category || item.kbCategory || '').toLowerCase();
    if (!RESEARCHED_CATEGORIES.has(category)) continue;
    if (NOT_AN_IDEA.test(String(item.title || ''))) continue;
    const name = agentNameFromTitle(item.title);
    if (!name) continue;
    const url = item.url || (item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/` : '');
    if (!url) continue;
    // A trial of two agents names both ("vitamin A and vitamin E"). Kept whole,
    // the combined string collides with the excluded-agent list — "Vitamin E"
    // is excluded as harmful in RP, which silently deleted the vitamin A card
    // too. Split so each agent stands or falls on its own.
    for (const part of splitConjoinedAgents(name)) {
      const keys = [normKey(part), ...titleAliases(item.title).map(normKey)].filter(Boolean);
      if (!keys.length || keys.some((k) => seen.has(k))) continue;
      if (isExcluded(part)) continue;
      keys.forEach((k) => seen.add(k));
      seeds.push({
        name: part,
        url,
        year: item.year || null,
        category,
        title: item.title,
        summary: String(item.summary || item.text || '').slice(0, 150)
      });
    }
  }
  return seeds;
};

const TIER_WORDS = {
  rct: 'SMALL_RCT',
  'systematic-review': 'PRECLINICAL',
  preclinical: 'PRECLINICAL',
  observational: 'OBSERVATIONAL',
  cohort: 'OBSERVATIONAL',
  'case-report': 'CASE_REPORT'
};

export const buildResearchedAgentBlock = (
  kbItems = [], excludedAgents = [], trialStudies = [], approvedNames = [], webSeeds = []
) => {
  const curated = researchedAgentSeeds(kbItems, excludedAgents, approvedNames);
  const taken = new Set(curated.map((c) => normKey(c.name)));
  const fromTrials = trialAgentSeeds(trialStudies, { approvedNames, excludedAgents })
    .filter((t) => !taken.has(normKey(t.name)));
  fromTrials.forEach((t) => taken.add(normKey(t.name)));
  const blockedWeb = [...(approvedNames || []),
    ...(excludedAgents || []).map((a) => (typeof a === 'string' ? a : a?.name))]
    .map(normKey).filter(Boolean);
  const fromWeb = (webSeeds || []).filter((w) => {
    const key = normKey(w?.name);
    if (!key || taken.has(key)) return false;
    if (blockedWeb.some((b) => b.includes(key) || key.includes(b))) return false;
    if (NOVEL_PROGRAMME.test(w.name) || PROGRAMME_CODE.test(w.name)) return false;
    taken.add(key);
    return true;
  });
  // Bounded: 12 seeds with full summaries made the lane's prompt long enough
  // to blow the provider timeout, and a timed-out lane returns nothing at all.
  // Curated references come first so they are never the ones dropped.
  const seeds = [...curated, ...fromWeb, ...fromTrials].slice(0, 16);
  if (!seeds.length) return '';
  const lines = seeds.map((s) => {
    const strength = s.strength || (s.category === 'trial'
      ? 'OBSERVATIONAL'
      : (TIER_WORDS[String(s.category).toLowerCase()] || 'PRECLINICAL'));
    const yr = s.year ? ` (${s.year})` : '';
    return `- ${s.name} — EVIDENCE_STRENGTH: ${strength} — ${s.url}\n  Study${yr}: ${String(s.title).slice(0, 110)}`;
  });
  return `
=== AGENTS WITH CONDITION-SPECIFIC RESEARCH (curated — emit a CANDIDATE for EACH) ===
Each agent below has been studied FOR THIS CONDITION and the link is that study.
For EACH one, output a CANDIDATE block with:
  REPURPOSE_SECTION: researched-not-approved
  EVIDENCE_STRENGTH: <the value shown for that agent>
  REFERENCES: <the link shown for that agent>
State what the study actually found, including when the finding was negative or
mixed — a null result is still condition-specific research and belongs here.
Do NOT move these to the no-condition-study section, and do NOT invent a
different citation for them. Add further researched agents from the evidence
pack beyond this list where the pack supports them.

${lines.join('\n')}

=== END AGENTS WITH CONDITION-SPECIFIC RESEARCH ===
`;
};

// Agents under study FOR THIS CONDITION on ClinicalTrials.gov are, by
// definition, researched and not yet approved for it. Six curated references
// cannot fill a ten-slot section on their own; the registry is the other
// honest source of agents that belong there, and each carries its own record
// as the citation.
const NON_AGENT_INTERVENTION = /\b(?:placebo|sham|mock|vehicle|questionnaire|survey|observation|imaging|oct\b|electroretin|counsel|education|exercise|rehabilit|device|implant|prosthes|stimulat|surgery|vitrectomy|usual (?:care|treatment)|treatment as usual|as usual|standard (?:of )?care|best supportive|test drug|study drug|active comparator|control arm|no intervention)\b/i;

// A novel gene or cell therapy is a pipeline programme, not something a patient
// can raise as an existing option — those already have their own section of the
// report, and repeating them here is noise rather than an idea.
const NOVEL_PROGRAMME = /\b(?:aav\d*|crispr|cas9|gene therapy|gene[- ]edit|stem cell|progenitor|optogenetic|hesc|ipsc|allorx|umsc|msc|antisense oligonucleotide|[a-z]+vec)\b/i;
// Sponsor programme codes (OCU400, KIO-301, ADX-2191) are the same story.
const PROGRAMME_CODE = /^[A-Z]{2,5}[-\s]?[A-Z]{0,2}\d{2,}/;

// "OCU400 Low Dose" / "Second Eye Dosing" are arms of one agent, not six agents.
const baseAgentName = (name) => String(name || '')
  .replace(/^(?:drug|biological|genetic|dietary supplement|combination product)\s*:\s*/i, '')
  // Registry names carry the dose in front of the agent ("100 ug KIO-301"),
  // which would otherwise register each dose arm as its own agent.
  .replace(/^\s*\d+(?:\.\d+)?\s*(?:mg|mcg|ug|\u00b5g|g|iu|ml|%)\b\s*/i, '')
  .replace(/\b(?:low|medium|med|high|first|second)\s+(?:dose|eye)\b.*$/i, '')
  .replace(/\b(?:dose|dosing|arm|group|cohort)\b.*$/i, '')
  .replace(/\s+\d+(?:\.\d+)?\s*(?:mg|mcg|ug|\u00b5g|g|iu|ml|%)\b.*$/i, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

export const trialAgentSeeds = (studies = [], { approvedNames = [], excludedAgents = [] } = {}) => {
  const blocked = [...approvedNames, ...excludedAgents.map((a) => (typeof a === 'string' ? a : a?.name))]
    .map((n) => normKey(n)).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const study of studies || []) {
    if (String(study?.studyType || '').toUpperCase() !== 'INTERVENTIONAL') continue;
    if ((study?.relevanceScore ?? 0) < 45) continue;
    for (const iv of study?.interventions || []) {
      const type = String(iv?.type || '').toUpperCase();
      if (!['DRUG', 'BIOLOGICAL', 'DIETARY_SUPPLEMENT', 'COMBINATION_PRODUCT'].includes(type)) continue;
      const name = baseAgentName(String(iv?.name || '').replace(/\s*\([^)]*\)\s*$/, ''));
      if (!name || name.length < 3 || name.length > 60) continue;
      if (NON_AGENT_INTERVENTION.test(name)) continue;
      if (NOVEL_PROGRAMME.test(name) || PROGRAMME_CODE.test(name)) continue;
      const key = normKey(name);
      if (!key || seen.has(key)) continue;
      if (blocked.some((b) => b.includes(key) || key.includes(b))) continue;
      seen.add(key);
      out.push({
        name,
        url: study.url || (study.nctId ? `https://clinicaltrials.gov/study/${study.nctId}` : ''),
        year: null,
        category: 'trial',
        title: study.briefTitle || study.nctId || '',
        summary: `Studied for this condition in ${study.nctId || 'a registered trial'}${study.phases?.length ? ` (${study.phases.join('/')})` : ''}, status ${study.status || 'not listed'}.`
      });
    }
  }
  return out.filter((s) => s.url);
};


// Pack text is a raw abstract: it carries HTML tags, "OBJECTIVE:" and
// "<h4>Background</h4>" prefixes, and cuts off mid-word when truncated. Shown
// verbatim on a card it reads as broken scraping, so it is cleaned to one
// readable sentence or dropped.
const readableFinding = (value) => {
  let text = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/^\s*(?:editor'?s summary|background|objective|purpose|aim|methods?|results?|conclusions?)\s*[:.\u2014-]?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  // Keep whole sentences only — a fragment ending mid-word looks like a bug.
  const sentences = text.match(/[^.!?]+[.!?]/g) || [];
  const whole = sentences.slice(0, 2).join(' ').trim();
  if (whole.length >= 40) return whole.slice(0, 300);
  return text.length <= 220 ? text : '';
};

// "docosahexaenoic acid" and "Tauroursodeoxycholic Acid" are how a title spells
// an agent, not how a patient says it.
const READABLE_AGENT_NAMES = [
  [/^tauroursodeoxycholic acid$/i, 'TUDCA (tauroursodeoxycholic acid)'],
  [/^docosahexaenoic acid$/i, 'DHA (omega-3 fatty acid)'],
  [/^n-?acetylcysteine$/i, 'N-acetylcysteine (NAC)'],
  [/^n-?acetylcysteine amide$/i, 'N-acetylcysteine amide (NACA)'],
  [/^antioxidants?$/i, ''],
  [/^vitamin a$/i, 'Vitamin A palmitate']
];
const readableAgentName = (name) => {
  const raw = String(name || '').trim();
  for (const [pattern, replacement] of READABLE_AGENT_NAMES) {
    if (pattern.test(raw)) return replacement;
  }
  return raw;
};

// The label a reader actually sees on a citation. Two things were wrong with
// what this replaces: the supporting-evidence link was hardcoded to the word
// "source", which tells a reader nothing when the title is sitting right
// there; and the references link took a raw 90-char slice that cut real
// titles mid-word. Deliberately no ellipsis marker — this text is later run
// through finalizeReportText, whose NFKC pass rewrites "…" into three ASCII
// periods and lets the claim-sentence splitter cut the markdown link in half.
const linkLabel = (s) => {
  const raw = String(s?.title || '').replace(/\s+/g, ' ').trim() ||
    String(s?.name || '').trim();
  if (raw.length <= 90) return raw;
  const cut = raw.slice(0, 90);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '');
};

const ITEM_KIND_FOR = (name) =>
  /\b(?:vitamin|supplement|omega|acid|oil|berr|extract|taurine|lutein|zeaxanthin|coq10|creatine|curcumin|saffron)\b/i
    .test(String(name || '')) ? 'SUPPLEMENT' : 'MEDICATION';

/**
 * Render the researched-agent candidates directly.
 *
 * Asking the model to echo an agent name, its evidence tier and a link we
 * already hold cost an API call and lost most of them anyway: it dropped the
 * supplied URL on five of seven cards, and a card without a URL is discarded
 * downstream. Every field here is already known, so rendering it is both
 * exact and free. Discovery stays non-deterministic — the seeds come from a
 * live web search, the trial registry and curated references — but once an
 * agent and its citation are known, reproducing them is not a task for a
 * language model.
 */
export const renderResearchedCandidateBlocks = (seeds = []) => seeds
  .map((s) => ({ ...s, name: readableAgentName(s?.name) }))
  // A seed whose name reduces to nothing ("Antioxidants") names no agent a
  // reader could act on, so it is dropped rather than shown.
  .filter((s) => s && s.name && /^https?:\/\//i.test(String(s.url || '')))
  .map((s) => {
    const strength = s.strength || (s.category === 'trial'
      ? 'OBSERVATIONAL'
      : (TIER_WORDS[String(s.category).toLowerCase()] || 'PRECLINICAL'));
    const finding = readableFinding(s.summary) || readableFinding(s.title)
      || 'Studied for this condition; see the linked source for what it reported.';
    return [
      `CANDIDATE: ${s.name}`,
      `ITEM_KIND: ${ITEM_KIND_FOR(s.name)}`,
      'REPURPOSE_SECTION: researched-not-approved',
      `EVIDENCE_STRENGTH: ${strength}`,
      `WHY_FOR_THIS_CONDITION: ${finding}`,
      `SUPPORTING_EVIDENCE: ${finding} ([${linkLabel(s)}](${s.url}))`,
      `REFERENCES: [${linkLabel(s)}](${s.url})`,
      ''
    ].join('\n');
  })
  .join('\n');

/** The seed list a caller can hand straight to renderResearchedCandidateBlocks. */
export const researchedAgentSeedList = (
  kbItems = [], excludedAgents = [], trialStudies = [], approvedNames = [], webSeeds = []
) => {
  const curated = researchedAgentSeeds(kbItems, excludedAgents, approvedNames);
  const taken = new Set(curated.map((c) => normKey(c.name)));
  const fromTrials = trialAgentSeeds(trialStudies, { approvedNames, excludedAgents })
    .filter((t) => !taken.has(normKey(t.name)));
  fromTrials.forEach((t) => taken.add(normKey(t.name)));
  const blocked = [...(approvedNames || []),
    ...(excludedAgents || []).map((a) => (typeof a === 'string' ? a : a?.name))]
    .map(normKey).filter(Boolean);
  const fromWeb = (webSeeds || []).filter((w) => {
    const key = normKey(w?.name);
    if (!key || taken.has(key)) return false;
    if (blocked.some((b) => b.includes(key) || key.includes(b))) return false;
    if (NOVEL_PROGRAMME.test(w.name) || PROGRAMME_CODE.test(w.name)) return false;
    taken.add(key);
    return true;
  });
  // Headroom above the ten-slot section: seeds are still dropped downstream
  // for naming no real agent ("Antioxidants") or for duplicating an entry in
  // the other section, and trimming to exactly ten left seven on the page.
  return [...curated, ...fromWeb, ...fromTrials].slice(0, 16);
};

/**
 * Render the mechanistic (not-yet-studied) candidates directly, for the same
 * reason the researched ones are rendered: the agent, its usual use, the
 * mechanism sentence and the supporting link are all already known, and asking
 * a model to retype them loses the link. Every card carries the honest
 * disclaimer that no study in this condition was found.
 */
export const renderMechanisticCandidateBlocks = (agents = []) => (agents || [])
  .filter((a) => a && a.name && a.mechanism)
  .map((a) => {
    const rationale = String(a.mechanism).replace(/\s+/g, ' ').trim();
    const usual = String(a.usualUse || '').replace(/\s+/g, ' ').trim();
    return [
      `CANDIDATE: ${a.name}`,
      `ITEM_KIND: ${ITEM_KIND_FOR(a.name)}`,
      ...(usual ? [`APPROVED_FOR: ${usual}`] : []),
      'REPURPOSE_SECTION: no-condition-study-identified',
      'EVIDENCE_STRENGTH: MECHANISTIC_ONLY',
      `MECHANISM_TARGET: ${rationale}`,
      `WHY_FOR_THIS_CONDITION: No condition-specific study was identified in this search. ${rationale}`,
      ...(a.url ? [`REFERENCES: [How it works / usual use](${a.url})`] : []),
      ''
    ].join('\n');
  })
  .join('\n');
