// Resolve free-text conditions to a canonical name. Never blocks the user —
// infer smartly and proceed (ChatGPT-style).

import { matchKb } from './kb.js';
import { lookupDisease } from './disease-registry.js';

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const namesAlign = (a, b) => {
  if (!a || !b) return false;
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
    return n && (n === inputNorm || n.includes(inputNorm) || inputNorm.includes(n));
  });

/** Build phrases to try when the full string is messy ("Bipolar Disorder Manic Depression"). */
const phraseCandidates = (input) => {
  const raw = String(input || '').trim();
  const inputNorm = normalize(raw);
  const out = new Set();
  if (raw) out.add(raw);

  // Lay-language combos people actually type
  const patterns = [
    /\bmanic[- ]?depress(?:ion|ive)?\b/i,
    /\bbipolar\b/i,
    /\btype\s*1\s*diabetes\b/i,
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

  const tries = phraseCandidates(input);
  const kbRows = [];
  const regRows = [];

  for (const phrase of tries) {
    const [kbMatch, regMatch] = await Promise.all([matchKb(phrase), lookupDisease(phrase)]);
    if (kbMatch?.kb && kbMatch.score >= 40) {
      kbRows.push({
        resolved: kbMatch.kb.condition,
        slug: kbMatch.kb.slug,
        score: kbMatch.score,
        source: 'curated-kb',
        kbMatch,
        phrase
      });
      for (const alias of kbMatch.kb.aliases || []) {
        if (inputNorm.includes(normalize(alias)) && alias.length >= 4) {
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
    if (regMatch?.entry && regMatch.score >= 40) {
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

  if (score >= 50 && conditionDisputes.length === 0) return null;

  const headline =
    score < 45
      ? 'The second AI thinks this report may be about the wrong condition.'
      : 'The second AI flagged possible confusion about which condition this report covers.';

  return {
    severity: score < 45 ? 'high' : 'moderate',
    overallScore: score,
    headline,
    summary: p.overall || headline,
    disputes: conditionDisputes.slice(0, 6),
    userCondition: String(userCondition || '').trim(),
    suggestedAction: 'Update your condition in Profile if we got it wrong, then run the report again.'
  };
}
