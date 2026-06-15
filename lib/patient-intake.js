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

const MED_PATTERNS = [
  /\b(?:takes?|taking|on|uses?|using|prescribed)\s+([^.!?\n]{3,120}?)(?:\s+and\b|[,.!?]|$)/gi,
  /\b(?:insulin|metformin|ozempic|wegovy|lantus|humalog|novolog|jardiance|farxiga|empagliflozin)\b[^.!?\n]*/gi
];

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

const extractMedications = (msg) => {
  const found = [];
  for (const re of MED_PATTERNS) {
    const flags = re.flags.includes('g') ? re : new RegExp(re.source, re.flags + 'g');
    let m;
    while ((m = flags.exec(msg)) !== null) {
      const chunk = cleanPhrase(m[1] || m[0]);
      if (chunk.length >= 3 && chunk.length <= 140) found.push(chunk);
    }
  }
  return [...new Set(found)];
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

  const meds = extractMedications(msg);
  if (meds.length) {
    updates.medications = meds.join('; ');
    fieldsUpdated.push('medications');
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
    if (key === 'medications' || key === 'diagnoses' || key === 'symptoms') {
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
