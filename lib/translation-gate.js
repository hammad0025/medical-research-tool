// Deterministic trust boundary for model-generated translations. The source
// report has already passed report/citation/medical gates; translation may
// change prose, but it must not change any safety-bearing atom or structure.

const PLACEHOLDER_RE = /⟦MRT-(\d+)⟧/g;

const SAFETY_ATOM_RE =
  /https?:\/\/[^\s)\]"'<>]+|\[#\d+\]|\bNCT\d{8}\b|\b\d+(?:[.,]\d+)?\s*(?:%|mg|mcg|µg|g|kg|mL|ml|L|units?)(?:\s*\/\s*(?:day|week|month|year|yr))?\b|\b(?:not|no|never|without|contraindicated|contraindication|approved|unapproved|investigational|experimental|recruiting|enrolling|terminated|withdrawn|suspended|placebo|control)\b/gi;

const ENTITY_FIELD_RE =
  /^(?:\s*[-*]\s*)?(?:TREATMENT|CANDIDATE|DRUG(?: OR SUPPLEMENT)? IDEA|CONDITION|DISEASE|GENE|INTERVENTION|COMPARATOR|OUTCOME|MECHANISM_TARGET|PROVIDER)\s*:\s*(.+)$/gim;
const BIOMEDICAL_NAME_RE =
  /\b(?:[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*|[A-Z]\d[A-Z0-9-]{1,}|[A-Z]{2,6}|[A-Za-z][A-Za-z-]*(?:mab|nib|vir|statin|pril|sartan|olol|formin|gliflozin|glutide|cillin|cycline|azole|caine|parin|platin|taxel))\b/g;
const NAMED_CLINICAL_PHRASE_RE =
  /\b[A-Z][A-Za-z'-]*(?:\s+[a-z][A-Za-z'-]*){0,5}\s+(?:disease|disorder|syndrome|cancer|carcinoma|leukemia|lymphoma|fibrosis|hypertension|diabetes|arthritis|sclerosis|dystrophy|pneumonia|stroke)\b/g;

const normalizeAtom = (value) => String(value || '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, '');

const multiset = (values) => {
  const out = new Map();
  for (const value of values) {
    const key = normalizeAtom(value);
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
};

const sameMultiset = (a, b) =>
  a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);

const protectedSpans = (text) => {
  const source = String(text || '');
  const spans = [];
  const collect = (re, group = 0) => {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const value = match[group];
      if (!value) continue;
      const offset = group === 0 ? 0 : match[0].lastIndexOf(value);
      spans.push({ start: match.index + offset, end: match.index + offset + value.length });
    }
  };
  collect(SAFETY_ATOM_RE);
  collect(ENTITY_FIELD_RE, 1);
  collect(BIOMEDICAL_NAME_RE);
  collect(NAMED_CLINICAL_PHRASE_RE);
  return spans
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce((merged, span) => {
      const previous = merged[merged.length - 1];
      if (previous && span.start < previous.end) {
        previous.end = Math.max(previous.end, span.end);
      } else {
        merged.push({ ...span });
      }
      return merged;
    }, []);
};

const protectedValues = (text) =>
  protectedSpans(text).map(({ start, end }) => String(text || '').slice(start, end));

const safetyAtomValues = (text) => {
  SAFETY_ATOM_RE.lastIndex = 0;
  return [...String(text || '').matchAll(SAFETY_ATOM_RE)].map((match) => match[0]);
};

const markdownShape = (text) => String(text || '').split(/\r?\n/).map((line) => {
  const trimmed = line.trim();
  if (!trimmed) return 'blank';
  if (/^#{1,6}\s/.test(trimmed)) return `h${trimmed.match(/^#+/)[0].length}`;
  if (/^(?:[-*+]|\d+\.)\s/.test(trimmed)) return 'list';
  if (/^\|.*\|$/.test(trimmed)) return 'table';
  if (/^\p{Lu}[\p{Lu}\p{N}_ /-]{2,}:/u.test(trimmed)) return 'field';
  return 'prose';
});

const sentenceCount = (text) => (String(text || '').match(/[.!?。！？]+(?:\s|$)/g) || []).length;

export const sealTranslationSource = (sourceText) => {
  const source = String(sourceText || '');
  const atoms = [];
  let cursor = 0;
  let sealedText = '';
  for (const { start, end } of protectedSpans(source)) {
    sealedText += source.slice(cursor, start);
    const index = atoms.push(source.slice(start, end)) - 1;
    sealedText += `⟦MRT-${index}⟧`;
    cursor = end;
  }
  sealedText += source.slice(cursor);
  return { sealedText, atoms };
};

const restoreSealedTranslation = (translatedText, atoms = []) => {
  const seen = new Array(atoms.length).fill(0);
  const restoredText = String(translatedText || '').replace(PLACEHOLDER_RE, (token, rawIndex) => {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= atoms.length) return token;
    seen[index] += 1;
    return atoms[index];
  });
  const valid = seen.every((count) => count === 1) &&
    !/⟦MRT-\d+⟧/.test(restoredText);
  return {
    valid,
    text: valid ? restoredText : '',
    reasons: valid ? [] : ['protected medical atoms were removed, duplicated, or changed']
  };
};

export const validateTranslatedOutput = (sourceText, translatedText, { entitiesSealed = false } = {}) => {
  const source = String(sourceText || '').trim();
  const translated = String(translatedText || '').trim();
  const reasons = [];
  if (!source || !translated) reasons.push('source or translated text is empty');

  const sourceAtoms = entitiesSealed ? safetyAtomValues(source) : protectedValues(source);
  const translatedAtoms = entitiesSealed ? safetyAtomValues(translated) : protectedValues(translated);
  if (!sameMultiset(multiset(sourceAtoms), multiset(translatedAtoms))) {
    reasons.push('protected clinical entities, numbers, citations, negation, or status changed');
  }

  const sourceShape = markdownShape(source);
  const translatedShape = markdownShape(translated);
  if (sourceShape.length !== translatedShape.length ||
      sourceShape.some((shape, index) => shape !== translatedShape[index])) {
    reasons.push('markdown claim structure changed');
  }

  const sourceSentences = sentenceCount(source);
  const translatedSentences = sentenceCount(translated);
  if (sourceSentences !== translatedSentences) reasons.push('claim sentence count changed');

  // This catches appended/replaced unsupported prose while allowing normal
  // expansion in languages that need more words than English.
  const ratio = translated.length / Math.max(1, source.length);
  if (ratio < 0.45 || ratio > 2.2) reasons.push('translation length is inconsistent with the source');

  return { ok: reasons.length === 0, reasons };
};

export const validateSealedTranslation = (sourceText, modelText, atoms) => {
  const restored = restoreSealedTranslation(modelText, atoms);
  if (!restored.valid) return { ok: false, text: '', reasons: restored.reasons };
  const validation = validateTranslatedOutput(sourceText, restored.text, { entitiesSealed: true });
  return { ...validation, text: validation.ok ? restored.text : '' };
};
