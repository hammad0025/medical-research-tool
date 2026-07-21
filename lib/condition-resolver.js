// Resolve free-text conditions to a canonical name. Clinically consequential
// ambiguous acronyms require the user to provide the full condition name.

import { matchKb } from './kb.js';
import { lookupDisease } from './disease-registry.js';
import { findConditionAmbiguity } from './condition-ambiguity.js';
import { matchOntology, describeBrainFallback } from './condition-ontology.js';
import { matchGeneNotation } from './condition-gene-notation.js';
import { repairConditionText, wasRepaired, extractMedicalCore } from './condition-typo.js';
import { isConditionInferenceEnabled } from './condition-intake-flags.js';
import { normalize } from './normalize.js';

const conditionDefiningConflict = (input, candidate) => {
  const a = normalize(input);
  const b = normalize(candidate);
  if (!a || !b) return false;

  const has = (text, token) => new RegExp(`\\b${token}\\b`).test(text);
  if (has(a, 'insipidus') !== has(b, 'insipidus')) return true;
  if (has(a, 'mellitus') !== has(b, 'mellitus') &&
      (has(a, 'insipidus') || has(b, 'insipidus'))) return true;
  if (/\btype\s*1\b/.test(a) && /\btype\s*2\b/.test(b)) return true;
  if (/\btype\s*2\b/.test(a) && /\btype\s*1\b/.test(b)) return true;
  if (/\bpulmonary\s+hypertension\b/.test(a) &&
      !/\b(?:idiopathic|primary|arterial)\b/.test(a) &&
      /\b(?:idiopathic|primary|arterial)\b/.test(b)) return true;
  if (/\bpulmonary\s+fibrosis\b/.test(a) && /\bpulmonary\s+hypertension\b/.test(b)) return true;
  if (/\bpulmonary\s+hypertension\b/.test(a) && /\bpulmonary\s+fibrosis\b/.test(b)) return true;

  // General-vs-specific guard. A GENERAL query (`input`, first arg) must not
  // bind to a MORE-SPECIFIC candidate — a subtype ("diabetes" vs "type 1
  // diabetes"), a site/qualifier variant ("tuberculosis" vs "oral
  // tuberculosis"), or an adjacent morphological sibling ("tuberculosis" vs
  // "silicotuberculosis", "diabetes" vs "prediabetes"). The registry was built
  // from Mondo LEAF nodes with no umbrella/parent entries, so a general term has
  // no correct entry and the fuzzy scorer otherwise grabs an arbitrary child.
  // Treating these as different diseases makes the query fall through to the LLM
  // dossier, which researches the general disease correctly. This is asymmetric
  // (only when the candidate is narrower than the query — every caller passes
  // (userInput, matchedEntry)) so a user who typed the MORE specific term still
  // matches a broader entry. Purely formal expansions ("crohn" -> "crohn
  // disease") are NOT a conflict.
  if (a !== b) {
    const FORMAL = new Set(['disease', 'diseases', 'syndrome', 'syndromes',
      'disorder', 'disorders', 'condition', 'conditions']);
    const core = (s) => s.split(/\s+/).filter((t) => t && !FORMAL.has(t));
    const aCore = core(a);
    const bCore = core(b);
    if (aCore.length && bCore.length) {
      const bSet = new Set(bCore);
      const everyInputTokenInCandidate = aCore.every((t) => bSet.has(t));
      // Candidate keeps all of the query's words and adds specificity words.
      if (everyInputTokenInCandidate && bCore.length > aCore.length) return true;
      // A query word survives only as the SUFFIX of a longer candidate word,
      // i.e. the candidate is the query with a specificity PREFIX glued on
      // (prediabetes = pre+diabetes, silicotuberculosis = silico+tuberculosis).
      // endsWith (not includes) is deliberate: it must NOT fire when the query
      // is a PREFIX/abbreviation of the candidate ("schizo" -> "schizophrenia",
      // "hypo" -> "hypothyroidism"), which is the SAME disease.
      if (!everyInputTokenInCandidate) {
        for (const t of aCore) {
          if (t.length >= 5 && bCore.some((bt) => bt !== t && bt.endsWith(t))) return true;
        }
      }
    }
  }
  return false;
};

const namesAlign = (a, b) => {
  if (!a || !b) return false;
  if (conditionDefiningConflict(a, b)) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aWords = a.split(' ').filter((w) => w.length > 3);
  const bWords = new Set(b.split(' ').filter((w) => w.length > 3));
  let overlap = 0;
  for (const w of aWords) if (bWords.has(w)) overlap++;
  if (overlap >= 2) return true;
  if (overlap >= 1 && aWords.length >= 2) return true;
  return false;
};

const aliasHit = (inputNorm, aliases = []) =>
  aliases.some((a) => {
    const n = normalize(a);
    return n &&
      !conditionDefiningConflict(inputNorm, n) &&
      (n === inputNorm || n.includes(inputNorm) || inputNorm.includes(n));
  });

/** Build phrases to try when the full string is messy ("Bipolar Disorder Manic Depression"). */
const phraseCandidates = (input) => {
  const raw = String(input || '').trim();
  const inputNorm = normalize(raw);
  const repairedNorm = repairConditionText(raw);
  const coreNorm = extractMedicalCore(raw);
  const out = new Set();
  if (raw) out.add(raw);
  if (repairedNorm && repairedNorm !== inputNorm) out.add(repairedNorm);
  if (coreNorm && coreNorm !== inputNorm && coreNorm !== repairedNorm) out.add(coreNorm);

  // Lay-language combos people actually type
  const patterns = [
    /\bmanic[- ]?depress(?:ion|ive)?\b/i,
    /\bbipolar\b/i,
    /\btype\s*1\s*diabetes(?!\s+insipidus)\b/i,
    /\blada\b/i,
    /\bipf\b/i,
    /\bals\b/i,
    /\brp\b/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) out.add(m[0].trim());
  }

  if (/manic/.test(inputNorm) && /depress/.test(inputNorm)) {
    out.add('manic depression');
    out.add('bipolar disorder');
  }
  if (/\bbipolar\b/.test(inputNorm)) out.add('bipolar disorder');

  // Strip filler words, keep medical core
  const stripped = inputNorm
    .replace(/\b(disorder|disease|syndrome|condition|type|form)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped !== inputNorm) out.add(stripped);

  // Comma / "and" separated chunks
  for (const part of raw.split(/\s+and\s+|,/i)) {
    const p = part.trim();
    if (p.length >= 2) out.add(p);
  }

  return [...out].filter(Boolean);
};

const pickBest = (rows) =>
  rows
    .filter((r) => r && r.score >= 40 && r.resolved)
    .sort((a, b) => b.score - a.score)[0] || null;

const preserveExactCondition = (input, resolved) => ({
  ok: true,
  userInput: input,
  resolved,
  resolvedSlug: null,
  source: 'user-input',
  matchScore: 100,
  needsConfirmation: false,
  confident: true,
  autoCanonicalize: false,
  issues: [],
  subtype: null,
  phenotype: null,
  gene: null,
  kbSlug: null,
  repairedInput: null,
  resolutionPath: 'exact-safe-condition',
  nextBrainLayer: 'dossier-llm→dynamic-brain',
  brainFallback: describeBrainFallback('user-input', 100),
  subspecialty: '',
  kbMatch: null,
  registryMatch: null
});

const buildStructuredResolution = async (input, hit) => {
  const inputNorm = normalize(input);
  const kbMatch = hit.kbSlug ? await matchKb(hit.kbSlug) || await matchKb(hit.resolved) : null;
  const regMatch = hit.registrySlug
    ? await lookupDisease(hit.registrySlug.replace(/-/g, ' '))
    : null;
  const resolved = hit.resolved;
  const brainSource = hit.kbSlug ? 'curated-kb' : hit.registrySlug ? 'disease-registry' : 'user-input';

  return {
    ok: true,
    userInput: input,
    resolved,
    resolvedSlug: hit.registrySlug || hit.kbSlug || null,
    source: hit.source || 'ontology',
    matchScore: hit.score,
    needsConfirmation: false,
    confident: true,
    autoCanonicalize: normalize(resolved) !== inputNorm,
    issues: [],
    subtype: hit.subtype || null,
    phenotype: hit.phenotype || null,
    gene: hit.gene || null,
    kbSlug: hit.kbSlug || null,
    ontologyId: hit.id || null,
    repairedInput: hit.repairedInput || null,
    resolutionPath: hit.resolutionPath || hit.source,
    nextBrainLayer: hit.nextBrainLayer || describeBrainFallback(brainSource, hit.score).layer,
    brainFallback: describeBrainFallback(brainSource, hit.score),
    subspecialty:
      regMatch?.entry?.specialty ||
      kbMatch?.kb?.subspecialty ||
      '',
    kbMatch: kbMatch?.kb
      ? {
          condition: kbMatch.kb.condition,
          score: kbMatch.score,
          slug: kbMatch.kb.slug,
          matchedOn: kbMatch.matchedOn
        }
      : null,
    registryMatch: regMatch?.entry
      ? {
          condition: regMatch.entry.name,
          score: regMatch.score,
          slug: regMatch.entry.slug,
          matchedOn: regMatch.matchedOn
        }
      : hit.registrySlug
        ? { condition: resolved, score: hit.score, slug: hit.registrySlug, matchedOn: hit.id }
        : null
  };
};

export async function resolveCondition(userInput) {
  const input = String(userInput || '').trim();
  const inputNorm = normalize(input);
  if (!inputNorm) {
    return {
      ok: false,
      error: 'empty',
      userInput: input,
      resolved: null,
      needsConfirmation: false,
      confident: false,
      autoCanonicalize: false,
      issues: []
    };
  }

  const ambiguity = findConditionAmbiguity(input);
  if (ambiguity) return ambiguity;

  // This is a valid umbrella diagnosis. A fuzzy registry hit must not silently
  // narrow it to idiopathic pulmonary arterial hypertension.
  if (inputNorm === 'pulmonary hypertension') {
    return preserveExactCondition(input, 'Pulmonary hypertension');
  }

  if (!isConditionInferenceEnabled()) {
    return {
      ok: true,
      userInput: input,
      resolved: input,
      resolvedSlug: null,
      source: 'user-input',
      matchScore: 0,
      needsConfirmation: false,
      confident: false,
      autoCanonicalize: false,
      inferenceDisabled: true,
      issues: [],
      subtype: null,
      phenotype: null,
      gene: null,
      kbSlug: null,
      repairedInput: null,
      resolutionPath: 'user-input (inference disabled)',
      nextBrainLayer: 'dossier-llm→dynamic-brain',
      brainFallback: describeBrainFallback('user-input', 0),
      subspecialty: '',
      kbMatch: null,
      registryMatch: null
    };
  }

  const coreNorm = extractMedicalCore(input);
  const geneHit =
    (await matchGeneNotation(input)) ||
    (coreNorm !== inputNorm ? await matchGeneNotation(coreNorm) : null);
  if (geneHit) return buildStructuredResolution(input, geneHit);

  const ontology =
    matchOntology(input) ||
    (coreNorm !== inputNorm ? matchOntology(coreNorm) : null);
  if (ontology) return buildStructuredResolution(input, { ...ontology, source: 'ontology' });

  const tries = phraseCandidates(input);
  const kbRows = [];
  const regRows = [];

  for (const phrase of tries) {
    const [kbMatch, regMatch] = await Promise.all([matchKb(phrase), lookupDisease(phrase)]);
    if (kbMatch?.kb && kbMatch.score >= 40 &&
        !conditionDefiningConflict(inputNorm, kbMatch.kb.condition)) {
      kbRows.push({
        resolved: kbMatch.kb.condition,
        slug: kbMatch.kb.slug,
        score: kbMatch.score,
        source: 'curated-kb',
        kbMatch,
        phrase
      });
      for (const alias of kbMatch.kb.aliases || []) {
        if (inputNorm.includes(normalize(alias)) && alias.length >= 4 &&
            !conditionDefiningConflict(inputNorm, kbMatch.kb.condition) &&
            !conditionDefiningConflict(inputNorm, alias)) {
          kbRows.push({
            resolved: kbMatch.kb.condition,
            slug: kbMatch.kb.slug,
            score: Math.min(100, kbMatch.score + 15),
            source: 'curated-kb',
            kbMatch,
            phrase: alias
          });
        }
      }
    }
    if (regMatch?.entry && regMatch.score >= 40 &&
        !conditionDefiningConflict(inputNorm, regMatch.entry.name)) {
      regRows.push({
        resolved: regMatch.entry.name,
        slug: regMatch.entry.slug,
        score: regMatch.score,
        source: 'disease-registry',
        regMatch,
        phrase
      });
    }
  }

  const best = pickBest([...kbRows, ...regRows]);

  let resolved = best?.resolved || null;
  let source = best?.source || null;
  let matchScore = best ? Math.round(best.score) : 0;
  let resolvedSlug = best?.slug || null;
  const kbMatch = best?.kbMatch || (kbRows[0]?.kbMatch ?? null);
  const regMatch = best?.regMatch || (regRows[0]?.regMatch ?? null);

  // No match — still proceed with what they typed (dossier agent will interpret).
  if (!resolved) {
    resolved = input;
    source = 'user-input';
    matchScore = 0;
  }

  const kbCanonical = kbMatch?.kb?.condition || null;
  const regCanonical = regMatch?.entry?.name || null;
  const kbAliases = kbMatch?.kb?.aliases || [];
  const regAliases = regMatch?.entry?.synonyms || [];
  const resolvedNorm = normalize(resolved);

  const inputMatchesResolved =
    namesAlign(inputNorm, resolvedNorm) ||
    aliasHit(inputNorm, kbAliases) ||
    aliasHit(inputNorm, regAliases) ||
    aliasHit(inputNorm, [resolved]) ||
    matchScore >= 55;

  const confident = matchScore >= 40 || inputMatchesResolved || source === 'user-input';
  const autoCanonicalize =
    source !== 'user-input' &&
    normalize(resolved) !== inputNorm &&
    matchScore >= 40;

  return {
    ok: true,
    userInput: input,
    resolved,
    resolvedSlug,
    source,
    matchScore,
    needsConfirmation: false,
    confident,
    autoCanonicalize,
    issues: [],
    subtype: null,
    phenotype: null,
    kbSlug: kbMatch?.kb?.slug || null,
    gene: null,
    repairedInput: wasRepaired(input) ? repairConditionText(input) : null,
    resolutionPath: source,
    nextBrainLayer: describeBrainFallback(source, matchScore).layer,
    brainFallback: describeBrainFallback(source, matchScore),
    subspecialty:
      regMatch?.entry?.specialty ||
      kbMatch?.kb?.subspecialty ||
      '',
    kbMatch: kbMatch
      ? {
          condition: kbCanonical,
          score: kbMatch.score,
          slug: kbMatch.kb.slug,
          matchedOn: kbMatch.matchedOn
        }
      : null,
    registryMatch: regMatch
      ? {
          condition: regCanonical,
          score: regMatch.score,
          slug: regMatch.entry.slug,
          matchedOn: regMatch.matchedOn
        }
      : null
  };
}

const resolvedConditionIdentity = (resolution) => {
  if (
    !resolution?.ok ||
    resolution.needsConfirmation ||
    !resolution.resolved
  ) return '';
  const canonicalId =
    resolution.resolvedSlug ||
    resolution.kbSlug ||
    resolution.registryMatch?.slug;
  return canonicalId
    ? `id:${normalize(canonicalId)}`
    : `name:${normalize(resolution.resolved)}`;
};

export async function conditionsResolveToSameIdentity(left, right) {
  const [leftResolution, rightResolution] = await Promise.all([
    resolveCondition(left),
    resolveCondition(right)
  ]);
  const leftIdentity = resolvedConditionIdentity(leftResolution);
  const rightIdentity = resolvedConditionIdentity(rightResolution);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

const MISMATCH_RE =
  /wrong condition|condition mismatch|answers the wrong|different condition|not (about|for) (this|the)|does not match|mismatch|incorrect condition|wrong disease|Alzheimer.*LADA|LADA.*Alzheimer/i;

export function detectValidationMismatch(validation, userCondition = '') {
  if (!validation?.primary) return null;
  const p = validation.primary;
  const score = typeof p.overallScore === 'number' ? p.overallScore : 100;
  const rows = [...(p.disputed || []), ...(p.unsupported || [])];
  const conditionDisputes = rows.filter((d) => {
    const blob = `${d.claim || ''} ${d.reason || ''} ${d.correction || ''}`;
    return MISMATCH_RE.test(blob);
  });

  // The banner is specifically about "this report may be about the WRONG
  // condition." A low overall score means "many claims are ungrounded," which
  // is a different problem and must NOT trigger the wrong-condition banner
  // (that was a false alarm on correct-but-ungrounded reports). Only fire when
  // a dispute actually names a condition mismatch.
  if (conditionDisputes.length === 0) return null;

  return {
    severity: score < 45 ? 'high' : 'moderate',
    overallScore: score,
    headline: 'The independent reviewer thinks this report may be about the wrong condition.',
    summary: p.overall || 'The independent reviewer flagged possible confusion about which condition this report covers.',
    disputes: conditionDisputes.slice(0, 6),
    userCondition: String(userCondition || '').trim(),
    suggestedAction: 'Update your condition in Profile if we got it wrong, then run the report again.'
  };
}
