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

const words = (value) =>
  normalize(value).match(/[a-z][a-z0-9-]{3,}/g)?.filter((word) => !STOP.has(word)) || [];

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

const hasResolvableSource = (item) => {
  if (!item || String(item.accessLevel || '').toLowerCase() === 'dossier') return false;
  if (item.pmid || item.doi) return true;
  const url = canonicalizeCitationUrl(item.url);
  return /^https?:\/\/[^/]+\/\S+/i.test(url);
};

const subjectWords = (claim) => {
  const text = normalize(claim);
  const action = text.match(RESULT_VERB);
  if (!action) return [];
  return words(text.slice(0, action.index)).filter((word) =>
    word.length >= 5 && !GENERIC_SUBJECT.has(word)
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
    !GENERIC_SUBJECT.has(word) && !['adjusted', 'approximately', 'significantly'].includes(word)
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
      outcomes: words(tail).filter((word) => !GENERIC_SUBJECT.has(word))
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

const populationPhrase = (value) => {
  const matches = [...normalize(value).matchAll(
    /\b(?:in|among)\s+(?:(?:adults?|patients?|people|participants|children)\s+(?:with\s+)?)?([a-z][a-z0-9 -]{2,60})(?=[.;,]|$)/g
  )];
  const phrase = matches.at(-1)?.[1]?.trim() || '';
  if (/^(?:the\s+)?(?:group|arm|proportion|rate|analysis)\b/.test(phrase)) return '';
  return phrase.split(/\s+/).slice(0, 8).join(' ');
};

export const claimSupportedBySource = (claimText, item, { condition = '' } = {}) => {
  const claim = String(claimText || '').trim();
  if (!claim || !hasResolvableSource(item)) {
    return { ok: false, reason: !claim ? 'EMPTY_CLAIM' : 'UNVERIFIABLE_SOURCE' };
  }
  const source = sourceText(item);
  if (!source.trim()) return { ok: false, reason: 'EMPTY_SOURCE_TEXT' };
  const sourceNormalized = normalize(source);
  const claimNumbers = numericTokens(claim);
  const sourceNumbers = numericTokens(source);
  const missingNumbers = [...claimNumbers].filter((token) => !sourceNumbers.has(token));
  if (missingNumbers.length) return { ok: false, reason: 'NUMBER_MISMATCH', missingNumbers };

  const comparator = comparatorPhrase(claim);
  if (comparator && !sourceNormalized.includes(comparator)) {
    return { ok: false, reason: 'COMPARATOR_MISMATCH', comparator };
  }

  const population = populationPhrase(claim);
  if (population && !sourceNormalized.includes(population)) {
    return { ok: false, reason: 'POPULATION_MISMATCH', population };
  }

  const identities = [...new Set(subjectWords(claim))];
  const missingIdentities = identities.filter((identity) => !sourceNormalized.includes(identity));
  if (identities.length && missingIdentities.length) {
    return { ok: false, reason: 'INTERVENTION_MISMATCH', missingIdentities };
  }

  const outcomes = outcomeWords(claim);
  if (outcomes.length && !outcomes.some((outcome) => sourceNormalized.includes(outcome))) {
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
  const sourceWordSet = new Set(words(source));
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
