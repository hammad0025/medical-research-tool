import { canonicalizeCitationUrl } from './citation-gate.js';

const STOP = new Set([
  'about', 'after', 'also', 'among', 'before', 'being', 'between', 'both',
  'could', 'from', 'have', 'into', 'more', 'most', 'other', 'over', 'patient',
  'patients', 'people', 'reported', 'result', 'results', 'study', 'than', 'that',
  'their', 'these', 'this', 'those', 'treatment', 'trial', 'using', 'versus',
  'were', 'with', 'would', 'year', 'years'
]);
const GENERIC_SUBJECT = new Set([
  'adjusted', 'annual', 'clinical', 'daily', 'disease', 'group', 'mean',
  'medicine', 'oral', 'phase', 'placebo', 'rate', 'relative', 'research',
  'benefit', 'found', 'showed', 'shows', 'studies', 'suggests', 'therapy',
  'theoretical', 'what', 'weekly'
]);
const RESULT_VERB =
  /\b(?:reduc(?:e[ds]?|ing)|slow(?:s|ed|ing)?|decreas(?:e[ds]?|ing)|improv(?:e[ds]?|ing)|increas(?:e[ds]?|ing)|lower(?:s|ed|ing)?|prevent(?:s|ed|ing)?|provide[ds]?)\b/i;
const DIRECTIONAL_VERB =
  /\b(reduc(?:e[ds]?|ing)|decreas(?:e[ds]?|ing)|lower(?:s|ed|ing)?|increas(?:e[ds]?|ing))\b/gi;

const normalize = (value) =>
  String(value || '').toLowerCase().replace(/[^\p{L}\p{N}%/.-]+/gu, ' ').replace(/\s+/g, ' ').trim();

// Function words carry no evidence: counting "which" or "often" as a content
// word that must appear in the source made true sentences fail the hit count.
const FUNCTION_WORD = new Set([
  'which', 'when', 'where', 'while', 'because', 'during', 'through', 'without',
  'within', 'whether', 'again', 'often', 'usually', 'typically', 'generally',
  'commonly', 'sometimes', 'always', 'never', 'still', 'such', 'like', 'much',
  'many', 'some', 'each', 'every', 'into', 'onto', 'upon', 'they', 'them'
]);

// Match a word to its own morphological variants. Requiring verbatim forms meant
// a claim saying "patients describe" was unsupported by a source saying
// "described by patients" — the same word, rejected on a suffix.
const stem = (word) =>
  String(word)
    .replace(/(?:ies)$/, 'y')
    .replace(/(?:ations|ation)$/, 'ate')
    .replace(/(?:ing|ed|es|s)$/, '')
    .replace(/(?:e)$/, '');

// Every word list in this file is compared against the OUTPUT of words(), which
// is stemmed. Holding the lists in their written form meant "suggests" stemmed
// to "suggest", missed GENERIC_SUBJECT, and became an intervention the source
// had to name — so "Research suggests X improved Y" was unsourceable against
// the very paper it paraphrased. Stem the lists once, at the same time.
const stems = (list) => new Set([...list].map(stem));
const STOP_STEMS = stems(STOP);
const FUNCTION_WORD_STEMS = stems(FUNCTION_WORD);
const GENERIC_SUBJECT_STEMS = stems(GENERIC_SUBJECT);
const GENERIC_OUTCOME_STEMS = stems(['adjusted', 'approximately', 'significantly']);

const words = (value) =>
  normalize(value).match(/[a-z][a-z0-9-]{3,}/g)
    ?.map(stem)
    .filter((word) => !STOP_STEMS.has(word) && !FUNCTION_WORD_STEMS.has(word)) || [];

// A stemmed claim token against raw source prose is a mismatch of alphabets: a
// claim saying "therapies" stems to "therapy", which is not a substring of the
// source's "therapies". Check the source's stemmed vocabulary first, and keep
// the substring test for hyphenated and multi-word phrases.
const sourceHasToken = (token, sourceNormalized, sourceWordSet) =>
  sourceWordSet.has(token) || sourceNormalized.includes(token);

const numericTokens = (value) => {
  const out = new Set();
  const text = String(value || '');
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\s*%/g)) {
    out.add(match[0].replace(/\s+/g, '').replace(',', '.').toLowerCase());
  }
  for (const match of text.matchAll(
    /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|kg|mL|ml|L|units?|hours?|metres?|meters?)(?:\s*\/\s*(?:day|week|month|year|yr))?\b/gi
  )) {
    out.add(match[0].replace(/\s+/g, '').replace(',', '.').toLowerCase());
  }
  for (const match of text.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
    const token = match[0].replace(/,/g, '');
    if (token.replace(/\D/g, '').length >= 2) out.add(token);
  }
  return out;
};

const sourceText = (item) => [
  item?.title,
  item?.journal,
  item?.year,
  item?.summary,
  item?.abstract,
  item?.text,
  item?.fullText,
  item?.dosageAndAdministration,
  item?.indicationsAndUsage,
  item?.warnings,
  item?.adverseReactions,
  ...(Array.isArray(item?.genericName) ? item.genericName : [item?.genericName]),
  ...(Array.isArray(item?.brandName) ? item.brandName : [item?.brandName]),
  ...(Array.isArray(item?.keyPassages)
    ? item.keyPassages.map((passage) => typeof passage === 'string' ? passage : passage?.quote)
    : [])
].filter(Boolean).join(' ');

// A dossier item is model-inferred disease framing with no document behind it,
// so it cannot prove a claim. A CURATED knowledge-base item is different: it
// carries a real pinned reference (pmid/doi/url) reviewed by a clinician.
// Lumping the two together meant every curated safety flag was unciteable and
// the whole safety section was deleted for want of a source it already had.
const hasResolvableSource = (item) => {
  if (!item) return false;
  const access = String(item.accessLevel || '').toLowerCase();
  // `isCuratedKB` is the flag the evidence pack actually sets (lib/evidence.js);
  // the others are older/alternate spellings kept so this can't miss again.
  const curated =
    item.isCuratedKB === true ||
    item.curated === true ||
    access === 'kb' ||
    !!item.kbCategory;
  if (access === 'dossier' && !curated) return false;
  if (item.pmid || item.doi) return true;
  const url = canonicalizeCitationUrl(item.url);
  return /^https?:\/\/[^/]+\/\S+/i.test(url);
};

const subjectWords = (claim) => {
  const text = normalize(claim);
  const action = text.match(RESULT_VERB);
  if (!action) return [];
  return words(text.slice(0, action.index)).filter((word) =>
    word.length >= 5 && !GENERIC_SUBJECT_STEMS.has(word)
  );
};

const outcomeWords = (value) => {
  const text = normalize(value);
  const action = text.match(RESULT_VERB);
  if (!action) return [];
  const tail = text
    .slice(action.index + action[0].length)
    .split(/\b(?:versus|compared with|compared to|vs)\b/i)[0];
  const out = words(tail).filter((word) =>
    !GENERIC_SUBJECT_STEMS.has(word) && !GENERIC_OUTCOME_STEMS.has(word)
  );
  for (const match of tail.matchAll(/\b(?:fvc|fev1|dlco|hba1c|ldl|hdl)\b/g)) out.push(match[0]);
  return [...new Set(out)];
};

const directionalOutcomes = (value) => {
  const text = normalize(value);
  const pairs = [];
  DIRECTIONAL_VERB.lastIndex = 0;
  for (const match of text.matchAll(DIRECTIONAL_VERB)) {
    const prefix = text.slice(0, match.index);
    const nestedRiskDirection =
      /\b(?:reduc(?:e[ds]?|ing)|decreas(?:e[ds]?|ing)|lower(?:s|ed|ing)?)\b[^.;]{0,60}\brisk\s+of\s*$/.test(prefix);
    if (nestedRiskDirection) continue;
    const direction = /^(?:increas)/.test(match[1]) ? 'up' : 'down';
    const tail = text.slice(match.index + match[0].length)
      .split(/\b(?:but|however|whereas|while|although)\b/)[0]
      .split(/[.;]/)[0]
      .split(/\s+/)
      .slice(0, 12)
      .join(' ');
    pairs.push({
      direction,
      outcomes: words(tail).filter((word) => !GENERIC_SUBJECT_STEMS.has(word))
    });
  }
  return pairs;
};

const comparatorPhrase = (value) => {
  const match = normalize(value).match(
    /\b(?:versus|compared with|compared to|vs)\s+(active control|placebo|usual care|standard care|control)\b/
  );
  return match?.[1] || '';
};

/**
 * The population a claim is about: "in patients with X", or a bare trailing
 * "in <condition>". Both must be checked — dropping the bare form let a claim
 * swap its disease ("...versus placebo in lung cancer") past the gate.
 *
 * But a bare "in ..." is only a population when it reads like the NAME of one.
 * "cells in the retina to break down" is ordinary prose, and treating it as a
 * cohort meant every content word had to appear in the source, which rejected
 * essentially all descriptive text against every source in the pack.
 */
const COHORT_NOUN = '(?:adults?|patients?|people|participants|children|subjects?|men|women|infants?)';

const namesAPopulation = (phrase) => {
  const words = phrase.split(/\s+/).filter(Boolean);
  // Condition names are short noun phrases. An infinitive or a long tail means
  // we captured a clause, not a cohort.
  if (!words.length || words.length > 4) return false;
  return !/\b(?:to|that|which|and|or|from|into|causing|caused)\b/.test(phrase);
};

const populationPhrase = (value) => {
  const text = normalize(value);
  const explicit = [...text.matchAll(
    new RegExp(`\\b(?:in|among)\\s+${COHORT_NOUN}\\s+(?:with\\s+)?([a-z][a-z0-9 -]{2,60})(?=[.;,]|$)`, 'g')
  )];
  let phrase = explicit.at(-1)?.[1]?.trim() || '';
  if (!phrase) {
    const bare = [...text.matchAll(/\b(?:in|among)\s+([a-z][a-z0-9 -]{2,60})(?=[.;,]|$)/g)];
    const candidate = bare.at(-1)?.[1]?.trim() || '';
    phrase = namesAPopulation(candidate) ? candidate : '';
  }
  if (/^(?:the\s+)?(?:group|arm|proportion|rate|analysis)\b/.test(phrase)) return '';
  return phrase.split(/\s+/).slice(0, 8).join(' ');
};

/**
 * A population phrase is supported when the source describes the same
 * population — not when it repeats the wording verbatim. The claim is written
 * in plain English on purpose, so an exact substring test rejected sourced
 * claims over a single inserted adjective ("two mouse models" vs the source's
 * "two different mouse models"). Every content word must still be present, so
 * a claim about a different population is still caught.
 */
const populationSupported = (phrase, sourceNormalized, sourceWordSet) => {
  if (sourceNormalized.includes(phrase)) return true;
  const tokens = words(phrase);
  if (!tokens.length) return true;
  return tokens.every((token) => sourceHasToken(token, sourceNormalized, sourceWordSet));
};

export const claimSupportedBySource = (claimText, item, { condition = '' } = {}) => {
  const claim = String(claimText || '').trim();
  if (!claim || !hasResolvableSource(item)) {
    return { ok: false, reason: !claim ? 'EMPTY_CLAIM' : 'UNVERIFIABLE_SOURCE' };
  }
  const source = sourceText(item);
  if (!source.trim()) return { ok: false, reason: 'EMPTY_SOURCE_TEXT' };
  const sourceNormalized = normalize(source);
  const sourceWordSet = new Set(words(source));
  const claimNumbers = numericTokens(claim);
  const sourceNumbers = numericTokens(source);
  const missingNumbers = [...claimNumbers].filter((token) => !sourceNumbers.has(token));
  if (missingNumbers.length) return { ok: false, reason: 'NUMBER_MISMATCH', missingNumbers };

  const comparator = comparatorPhrase(claim);
  if (comparator && !sourceNormalized.includes(comparator)) {
    return { ok: false, reason: 'COMPARATOR_MISMATCH', comparator };
  }

  const population = populationPhrase(claim);
  if (population && !populationSupported(population, sourceNormalized, sourceWordSet)) {
    return { ok: false, reason: 'POPULATION_MISMATCH', population };
  }

  const identities = [...new Set(subjectWords(claim))];
  const missingIdentities = identities.filter(
    (identity) => !sourceHasToken(identity, sourceNormalized, sourceWordSet)
  );
  if (identities.length && missingIdentities.length) {
    return { ok: false, reason: 'INTERVENTION_MISMATCH', missingIdentities };
  }

  const outcomes = outcomeWords(claim);
  if (
    outcomes.length &&
    !outcomes.some((outcome) => sourceHasToken(outcome, sourceNormalized, sourceWordSet))
  ) {
    return { ok: false, reason: 'OUTCOME_MISMATCH', outcomes };
  }
  const claimDirections = directionalOutcomes(claim);
  const sourceDirections = directionalOutcomes(source);
  for (const claimDirection of claimDirections) {
    const relevant = sourceDirections.filter((sourceDirection) =>
      claimDirection.outcomes.some((outcome) => sourceDirection.outcomes.includes(outcome))
    );
    if (
      relevant.length > 0 &&
      !relevant.some((sourceDirection) => sourceDirection.direction === claimDirection.direction)
    ) {
      return {
        ok: false,
        reason: 'OUTCOME_DIRECTION_MISMATCH',
        direction: claimDirection.direction
      };
    }
  }

  const claimWords = [...new Set(words(claim))];
  const hits = claimWords.filter((word) => sourceWordSet.has(word));
  const minimumHits = claimNumbers.size ? 2 : 4;
  const minimumCoverage = claimNumbers.size ? 0.3 : 0.55;
  if (hits.length < Math.min(minimumHits, claimWords.length) ||
      (claimWords.length && hits.length / claimWords.length < minimumCoverage)) {
    return { ok: false, reason: 'INSUFFICIENT_TEXT_MATCH', hits, claimWords };
  }

  const conditionWords = words(condition).filter((word) => word.length >= 5);
  const claimWordSet = new Set(claimWords);
  const claimNamesCondition = conditionWords.some((word) => claimWordSet.has(word));
  if (
    claimNamesCondition &&
    !conditionWords.some((word) => sourceWordSet.has(word))
  ) {
    return { ok: false, reason: 'CONDITION_MISMATCH' };
  }
  return { ok: true, reason: '', excerpt: source.slice(0, 500) };
};

export const sourceCanSupportPatientClaim = (claimText, item, options = {}) =>
  claimSupportedBySource(claimText, item, options).ok;
