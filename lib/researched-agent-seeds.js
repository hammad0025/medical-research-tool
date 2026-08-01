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

export const researchedAgentSeeds = (kbItems = [], excludedAgents = []) => {
  // Agents the knowledge base rules out (vitamin E accelerated decline in the
  // Berson trial) must not be proposed at all — seeding them only to have a
  // downstream filter delete the card wastes a slot and risks the exclusion
  // reason never reaching the reader.
  const excluded = (excludedAgents || [])
    .map((a) => normKey(typeof a === 'string' ? a : a?.name))
    .filter(Boolean);
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

export const buildResearchedAgentBlock = (kbItems = [], excludedAgents = [], trialStudies = [], approvedNames = []) => {
  const curated = researchedAgentSeeds(kbItems, excludedAgents);
  const fromTrials = trialAgentSeeds(trialStudies, { approvedNames, excludedAgents })
    .filter((t) => !curated.some((c) => normKey(c.name) === normKey(t.name)));
  // Bounded: 12 seeds with full summaries made the lane's prompt long enough
  // to blow the provider timeout, and a timed-out lane returns nothing at all.
  // Curated references come first so they are never the ones dropped.
  const seeds = [...curated, ...fromTrials].slice(0, 8);
  if (!seeds.length) return '';
  const lines = seeds.map((s) => {
    const strength = s.category === 'trial'
      ? 'OBSERVATIONAL'
      : (TIER_WORDS[String(s.category).toLowerCase()] || 'PRECLINICAL');
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
const NON_AGENT_INTERVENTION = /\b(?:placebo|sham|mock|vehicle|questionnaire|survey|observation|imaging|oct\b|electroretin|counsel|education|exercise|rehabilit|device|implant|prosthes|stimulat|surgery|vitrectomy)\b/i;

// A novel gene or cell therapy is a pipeline programme, not something a patient
// can raise as an existing option — those already have their own section of the
// report, and repeating them here is noise rather than an idea.
const NOVEL_PROGRAMME = /\b(?:aav\d*|crispr|cas9|gene therapy|gene[- ]edit|stem cell|progenitor|optogenetic|hesc|ipsc|allorx|umsc|msc|antisense oligonucleotide|[a-z]+vec)\b/i;
// Sponsor programme codes (OCU400, KIO-301, ADX-2191) are the same story.
const PROGRAMME_CODE = /^[A-Z]{2,5}[-\s]?\d{2,4}\b|^[A-Z]{2,4}\d{3,}/;

// "OCU400 Low Dose" / "Second Eye Dosing" are arms of one agent, not six agents.
const baseAgentName = (name) => String(name || '')
  .replace(/^(?:drug|biological|genetic|dietary supplement|combination product)\s*:\s*/i, '')
  // Registry names carry the dose in front of the agent ("100 ug KIO-301"),
  // which would otherwise register each dose arm as its own agent.
  .replace(/^\s*\d+(?:\.\d+)?\s*(?:mg|mcg|ug|\u00b5g|g|iu|ml|%)\b\s*/i, '')
  .replace(/\b(?:low|medium|med|high|first|second)\s+(?:dose|eye)\b.*$/i, '')
  .replace(/\b(?:dose|dosing|arm|group|cohort)\b.*$/i, '')
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
