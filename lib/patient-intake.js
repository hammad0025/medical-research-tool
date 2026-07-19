// Parse free-text patient descriptions ("my mom has LADA and takes insulin
// twice a day") into structured profile fields. No LLM — fast regex/heuristics.

const RELATIONSHIP_RE =
  /\b(?:my|our)\s+(mom|mother|mum|dad|father|wife|husband|son|daughter|child|partner|spouse|sister|brother|parent|patient)\b/i;
const PRONOUN_GENDER = [
  [/\b(she|her|mom|mother|mum|wife|daughter|sister)\b/i, 'Female'],
  [/\b(he|him|dad|father|husband|son|brother)\b/i, 'Male']
];

const CONDITION_PATTERNS = [
  /\b(?:has|have|had|diagnosed with|living with|suffering from|battling|dealing with)\s+([^.!?\n,;]{2,80}?)(?:\s+and\b|[,.!?]|$)/i,
  /\b(?:condition|disease|diagnosis)\s+(?:is|was)\s+([^.!?\n,;]{2,80}?)(?:\s+and\b|[,.!?]|$)/i,
  /\b(?:researching|learning about|ask about|tell me about|info on|information on)\s+([^.!?\n,;]{2,60}?)(?:\s+and\b|[,.!?]|$)/i
];

const CURRENT_MED_TRIGGER = /\b(takes?|taking|currently on|(?:is|are|'s)\s+on|uses?|using|prescribed)\s+([^.!?\n]{2,160})/gi;
const HISTORY_MED_TRIGGER = /\b(?:used to take|previously took|formerly took|stopped|discontinued)\s+([^.!?\n]{2,120})/gi;
const ALLERGY_TRIGGER = /\b(?:allergic to|allergy to|cannot tolerate|reaction to)\s+([^.!?\n]{2,120})/gi;

const AGE_PATTERNS = [
  /\b(\d{1,3})\s*[- ]?year[s]?[- ]?old\b/i,
  /\bage[d]?\s+(\d{1,3})\b/i,
  /\b(?:she|he|they)(?:'s| is)\s+(\d{1,3})\b/i
];

const SYMPTOM_HINT =
  /\b(?:symptoms?|feeling|complains? of|struggling with)\s+(?:include|are|is|with)?\s*([^.!?\n]{3,120}?)(?:\s+and\b|[,.!?]|$)/i;

const COMORBIDITY_HINT =
  /\b(?:also has|also have|other conditions?|comorbidit(?:y|ies)|history of)\s+([^.!?\n]{3,120}?)(?:\s+and\b|[,.!?]|$)/i;

const STAGE_HINT =
  /\b(?:stage|class)\s+([IVX0-9]+|[a-z][^.!?\n,]{0,40}?)(?:\s+and\b|[,.!?]|$)/i;

const NEGATED_CONDITION_HINT =
  /\b((?:does not|doesn'?t|do not|don'?t|has no|have no|without|denies|negative for)\s+(?:have\s+)?[^.!?\n;]{2,100})/gi;

const LAB_TOKEN =
  /\b(?:fvc|dlco|fev1|egfr|e-?gfr|creatinine(?: clearance)?|crcl|bilirubin|platelets?|absolute neutrophil count|anc|ha?emoglobin|hgb|ast|alt|lvef|ejection fraction|spo2|oxygen saturation|a1c|hba1c|c-peptide)\b/i;

const PREGNANCY_HINT =
  /\b(?:not pregnant|pregnan(?:t|cy)|pregnancy test(?:ed)? (?:positive|negative)|positive pregnancy test|negative pregnancy test|breastfeeding|not breastfeeding|nursing|not nursing)\b/i;

const GENETIC_HINT =
  /\b(?:genetic (?:test|testing|result)|pathogenic (?:variant|mutation)|likely pathogenic|(?:variant|mutation) (?:detected|identified|found|negative|positive)|tested negative)\b/i;

const matchingClauses = (msg, predicate) =>
  String(msg || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim().replace(/[.!?]+$/, ''))
    .filter((clause) => predicate.test(clause));

const cleanPhrase = (s) =>
  String(s || '')
    .replace(/\b(my|our|the|a|an)\s+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:with|of)\s+/i, '')
    .replace(/\s+(?:who|that|which)\b.*$/i, '');

const mergeText = (existing, addition) => {
  const a = String(existing || '').trim();
  const b = String(addition || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  if (b.toLowerCase().includes(a.toLowerCase())) return b;
  return `${a}; ${b}`;
};

const extractCondition = (msg) => {
  for (const re of CONDITION_PATTERNS) {
    const m = msg.match(re);
    if (m?.[1]) {
      const raw = cleanPhrase(m[1]);
      if (raw.length >= 2 && raw.length <= 80) return raw;
    }
  }
  // Standalone disease acronym at start: "LADA — what treatments..."
  const acronym = msg.match(/^([A-Z]{2,8})\b/);
  if (acronym) return acronym[1];
  // Short message that looks like a disease name only
  if (msg.length <= 60 && !/[?]/.test(msg) && !/\b(why|how|what|when|where|should|can)\b/i.test(msg)) {
    const stripped = msg
      .replace(/^(ok|hey|hi|hello|please|tell me about|give me info on|what is|info on)\s+/i, '')
      .trim();
    if (stripped.length >= 2 && stripped.length <= 60) return stripped;
  }
  return '';
};

const splitMedicationList = (raw) =>
  String(raw || '')
    .split(/\s*(?:,|;|\band\b|\bplus\b|&)\s*/i)
    .map((item) => cleanPhrase(item)
      .replace(/\b(?:once|twice|three times)\s+(?:(?:a|per)\s+)?day\b.*$/i, '')
      .replace(/\b(?:daily|nightly|weekly|as needed)\b.*$/i, '')
      .replace(/\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?)\b.*$/i, '')
      .trim())
    .filter((item) =>
      item.length >= 2 &&
      !/^(?:has|have|had|is|was|diagnosed|allergic|not taking|no longer|never|used to|previously|formerly|stopped|discontinued|none)\b/i.test(item)
    );

const collectMedicationClauses = (msg, re, group = 1) => {
  const found = [];
  const matcher = new RegExp(re.source, re.flags);
  let match;
  while ((match = matcher.exec(msg)) !== null) {
    const tail = String(match[group] || '')
      .split(/\s+\b(?:but|however|who|which|that|because|with a history of|and (?:has|had|is|was|does|takes?|taking|uses?|using|stopped|discontinued|is allergic))\b/i)[0];
    found.push(...splitMedicationList(tail));
  }
  return found;
};

export const extractMedicationFacts = (msg) => {
  const text = String(msg || '');
  const history = collectMedicationClauses(text, HISTORY_MED_TRIGGER);
  const allergies = collectMedicationClauses(text, ALLERGY_TRIGGER);
  const current = [];
  const matcher = new RegExp(CURRENT_MED_TRIGGER.source, CURRENT_MED_TRIGGER.flags);
  let match;
  while ((match = matcher.exec(text)) !== null) {
    const prefix = text.slice(Math.max(0, match.index - 20), match.index);
    if (/\b(?:not|isn'?t|wasn'?t|no longer|never|stopped|used to)\s*$/i.test(prefix)) continue;
    const tail = String(match[2] || '')
      .split(/\s+\b(?:but|however|who|which|that|because|with a history of|and (?:has|had|is|was|does|takes?|taking|uses?|using|stopped|discontinued|is allergic))\b/i)[0];
    current.push(...splitMedicationList(tail));
  }
  const unique = (items) => [...new Set(items.map((x) => x.toLowerCase()))]
    .map((key) => items.find((x) => x.toLowerCase() === key));
  return { current: unique(current), history: unique(history), allergies: unique(allergies) };
};

const extractAge = (msg) => {
  for (const re of AGE_PATTERNS) {
    const m = msg.match(re);
    const n = parseInt(m?.[1], 10);
    if (n >= 1 && n <= 120) return String(n);
  }
  return '';
};

const extractGender = (msg, relationship) => {
  for (const [re, g] of PRONOUN_GENDER) {
    if (re.test(msg)) return g;
  }
  const rel = String(relationship || '').toLowerCase();
  if (/mother|mom|mum|wife|daughter|sister/.test(rel)) return 'Female';
  if (/father|dad|husband|son|brother/.test(rel)) return 'Male';
  return '';
};

/** @returns {{ updates: Record<string,string>, fieldsUpdated: string[], aboutWhom: string|null, conditionRaw: string }} */
export function parsePatientMessage(text) {
  const msg = String(text || '').trim();
  const updates = {};
  const fieldsUpdated = [];

  if (!msg) {
    return { updates, fieldsUpdated, aboutWhom: null, conditionRaw: '' };
  }

  const relMatch = msg.match(RELATIONSHIP_RE);
  const aboutWhom = relMatch ? relMatch[1].toLowerCase() : null;

  const conditionRaw = extractCondition(msg);
  if (conditionRaw) {
    updates.condition = conditionRaw;
    fieldsUpdated.push('condition');
  }

  const medicationFacts = extractMedicationFacts(msg);
  if (medicationFacts.current.length) {
    updates.medications = medicationFacts.current.join('; ');
    fieldsUpdated.push('medications');
  }
  if (medicationFacts.history.length) {
    updates.medicationHistory = medicationFacts.history.join('; ');
    fieldsUpdated.push('medicationHistory');
  }
  if (medicationFacts.allergies.length) {
    updates.allergies = medicationFacts.allergies.join('; ');
    fieldsUpdated.push('allergies');
  }

  const age = extractAge(msg);
  if (age) {
    updates.age = age;
    fieldsUpdated.push('age');
  }

  const gender = extractGender(msg, aboutWhom);
  if (gender) {
    updates.gender = gender;
    fieldsUpdated.push('gender');
  }

  const sym = msg.match(SYMPTOM_HINT);
  if (sym?.[1]) {
    updates.symptoms = cleanPhrase(sym[1]);
    fieldsUpdated.push('symptoms');
  }

  const com = msg.match(COMORBIDITY_HINT);
  if (com?.[1]) {
    updates.diagnoses = cleanPhrase(com[1]);
    fieldsUpdated.push('diagnoses');
  }
  const negatedConditions = [...msg.matchAll(NEGATED_CONDITION_HINT)]
    .map((match) => cleanPhrase(match[1]))
    .filter(Boolean);
  if (negatedConditions.length) {
    updates.diagnoses = mergeText(updates.diagnoses, negatedConditions.join('; '));
    if (!fieldsUpdated.includes('diagnoses')) fieldsUpdated.push('diagnoses');
  }

  const labClauses = matchingClauses(msg, LAB_TOKEN)
    .filter((clause) => /\d/.test(clause));
  if (labClauses.length) {
    updates.labWork = labClauses.join('; ');
    fieldsUpdated.push('labWork');
  }

  const geneticClauses = matchingClauses(msg, GENETIC_HINT);
  if (geneticClauses.length) {
    updates.geneticVariant = geneticClauses.join('; ');
    fieldsUpdated.push('geneticVariant');
  }

  const pregnancyClauses = matchingClauses(msg, PREGNANCY_HINT);
  if (pregnancyClauses.length) {
    updates.pregnancyStatus = pregnancyClauses.join('; ');
    fieldsUpdated.push('pregnancyStatus');
  }

  const stage = msg.match(STAGE_HINT);
  if (stage?.[1]) {
    updates.stage = cleanPhrase(stage[1]);
    fieldsUpdated.push('stage');
  }

  if (aboutWhom) {
    updates.caregiverContext = `Researching for my ${aboutWhom}`;
    fieldsUpdated.push('caregiverContext');
  }

  return { updates, fieldsUpdated, aboutWhom, conditionRaw };
}

/**
 * Merge parsed chat fields into an existing patient object.
 * Newer explicit values win; medications/diagnoses append when distinct.
 */
export function mergePatientFromMessage(patient = {}, parsed) {
  const { updates = {}, fieldsUpdated = [] } = parsed || {};
  if (!fieldsUpdated.length) return { patient, merged: false, fieldsUpdated: [] };

  const next = { ...patient };
  for (const key of fieldsUpdated) {
    const val = updates[key];
    if (!val) continue;
    if (key === 'medications' || key === 'medicationHistory' || key === 'allergies' || key === 'diagnoses' || key === 'symptoms' || key === 'labWork' || key === 'geneticVariant' || key === 'pregnancyStatus') {
      next[key] = mergeText(patient[key], val);
    } else if (key === 'caregiverContext') {
      next[key] = val;
    } else {
      next[key] = val;
    }
  }
  return { patient: next, merged: true, fieldsUpdated };
}

/** Improved condition extraction for long conversational messages (server chat). */
export function extractConditionFromMessage(msg) {
  const parsed = parsePatientMessage(msg);
  if (parsed.conditionRaw) return parsed.conditionRaw;
  if (!msg) return '';
  const clean = msg.replace(/["?.,!]+/g, ' ').trim();
  if (clean.length < 60) return clean;
  const m = clean.match(/\b([A-Z]{2,6})\b/);
  if (m?.[1]) return m[1];
  return clean.slice(0, 60);
}
