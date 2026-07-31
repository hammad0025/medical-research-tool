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
const normKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "Neuroprotective Effect of Tauroursodeoxycholic Acid (TUDCA) on ..." and
// "TUDCA Slows Retinal Degeneration ..." are the same agent. Registering the
// parenthetical alias alongside the full name stops it appearing twice.
const titleAliases = (title) =>
  [...String(title || '').matchAll(/\(([A-Za-z][A-Za-z0-9-]{1,20})\)/g)].map((m) => m[1]);

export const researchedAgentSeeds = (kbItems = []) => {
  const seen = new Set();
  const seeds = [];
  for (const item of kbItems) {
    if (!item || item.quarantined) continue;
    const category = String(item.category || item.kbCategory || '').toLowerCase();
    if (!RESEARCHED_CATEGORIES.has(category)) continue;
    if (NOT_AN_IDEA.test(String(item.title || ''))) continue;
    const name = agentNameFromTitle(item.title);
    if (!name) continue;
    const keys = [normKey(name), ...titleAliases(item.title).map(normKey)].filter(Boolean);
    if (!keys.length || keys.some((k) => seen.has(k))) continue;
    const url = item.url || (item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/` : '');
    if (!url) continue;
    keys.forEach((k) => seen.add(k));
    seeds.push({
      name,
      url,
      year: item.year || null,
      category,
      title: item.title,
      summary: String(item.summary || item.text || '').slice(0, 320)
    });
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

export const buildResearchedAgentBlock = (kbItems = []) => {
  const seeds = researchedAgentSeeds(kbItems);
  if (!seeds.length) return '';
  const lines = seeds.map((s) => {
    const strength = TIER_WORDS[String(s.category).toLowerCase()] || 'PRECLINICAL';
    const yr = s.year ? ` (${s.year})` : '';
    return `- ${s.name} — EVIDENCE_STRENGTH: ${strength} — ${s.url}\n  Study${yr}: ${s.title}\n  ${s.summary}`;
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
