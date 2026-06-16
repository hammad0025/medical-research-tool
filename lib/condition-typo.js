// Patient typo repair — "BPC mnc disordr" → "bipolar manic disorder".
// Runs before ontology/KB matching. No external deps.

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const levenshtein = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, row[j - 1], row[j]);
      prev = tmp;
    }
  }
  return row[b.length];
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'his', 'her', 'their', 'your',
  'mom', 'dad', 'mother', 'father', 'parent', 'child', 'son', 'daughter',
  'has', 'have', 'had', 'is', 'are', 'was', 'with', 'and', 'or', 'for',
  'who', 'takes', 'take', 'on', 'in', 'at', 'to', 'of', 'about'
]);

const EXPLICIT = {
  bpc: 'bipolar',
  bipolr: 'bipolar',
  bpolar: 'bipolar',
  biploar: 'bipolar',
  bipolare: 'bipolar',
  bpd: 'bpd',
  mnc: 'manic',
  manc: 'manic',
  maniac: 'manic',
  manicc: 'manic',
  disordr: 'disorder',
  disoder: 'disorder',
  disorde: 'disorder',
  dsorder: 'disorder',
  disord: 'disorder',
  depressn: 'depression',
  depresson: 'depression',
  depresion: 'depression',
  alzeimers: 'alzheimer',
  alzimers: 'alzheimer',
  alzeimer: 'alzheimer',
  demencha: 'dementia',
  schizofrenia: 'schizophrenia',
  schitzophrenia: 'schizophrenia',
  diabets: 'diabetes',
  diabeetus: 'diabetes',
  fibro: 'fibromyalgia',
  fibromyalga: 'fibromyalgia',
  parkinsons: 'parkinson',
  arthitis: 'arthritis',
  astma: 'asthma',
  epilespy: 'epilepsy',
  migrane: 'migraine',
  hypothroid: 'hypothyroid',
  hyperthroid: 'hyperthyroid',
  ladaa: 'lada',
  ideopathic: 'idiopathic',
  idiopathic: 'idiopathic',
  ipff: 'ipf',
  pulmonry: 'pulmonary',
  pulmonar: 'pulmonary',
  fibroses: 'fibrosis',
  fibrosi: 'fibrosis'
};

const KEYWORDS = [
  'bipolar',
  'manic',
  'mania',
  'hypomanic',
  'depression',
  'depressive',
  'borderline',
  'personality',
  'disorder',
  'syndrome',
  'diabetes',
  'alzheimer',
  'dementia',
  'parkinson',
  'schizophrenia',
  'fibromyalgia',
  'epilepsy',
  'migraine',
  'asthma',
  'arthritis',
  'lada',
  'psoriasis',
  'sclerosis',
  'cancer',
  'lupus',
  'idiopathic',
  'pulmonary',
  'fibrosis',
  'ipf'
];

const maxDistance = (word, keyword) => {
  if (word === keyword) return 0;
  if (word.length <= 3) return 99;
  if (word.length <= 5) return 1;
  return 2;
};

const repairToken = (token) => {
  if (!token || token.length < 2) return token;
  if (STOPWORDS.has(token)) return token;
  if (EXPLICIT[token]) return EXPLICIT[token];
  if (token.length <= 3) return token;

  let best = token;
  let bestDist = 99;
  for (const kw of KEYWORDS) {
    const d = levenshtein(token, kw);
    const allowed = maxDistance(token, kw);
    if (d <= allowed && d < bestDist) {
      bestDist = d;
      best = kw;
    }
  }
  return best;
};

/** Repair a free-text condition string token-by-token. */
export function repairConditionText(input) {
  const n = normalize(input);
  if (!n) return '';
  return n
    .split(' ')
    .map(repairToken)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when repair materially changed the string. */
export function wasRepaired(input) {
  const n = normalize(input);
  const r = repairConditionText(input);
  return !!n && r !== n;
}

/** Extract the medical core from a conversational sentence. */
export function extractMedicalCore(input) {
  const repaired = repairConditionText(input);
  const tokens = repaired.split(' ').filter(Boolean);
  const medical = tokens.filter((t) => !STOPWORDS.has(t));
  return medical.join(' ').trim() || repaired;
}
