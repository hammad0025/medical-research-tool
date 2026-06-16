// Lay-language + ambiguous-acronym rules. Runs BEFORE KB/registry fuzzy match.
// Psychiatry: patients say "bpd type 1" meaning bipolar I, not borderline or pulmonary BPD.

import { repairConditionText, extractMedicalCore } from './condition-typo.js';
import { normalize } from './normalize.js';

const pulmonaryContext = (n) =>
  /\b(prematur|neonat|neonatal|infant|ventilat|lung|nicu|broncho|pulmonary|newborn|preterm)\b/.test(n);

const bipolarTypeOne = (n) =>
  /\bbpd\s*(?:type\s*)?1\b/.test(n) ||
  /\bbpd\s*(?:type\s*)?i\b/.test(n) ||
  /\bbipolar\s+(?:disorder\s+)?type\s*1\b/.test(n) ||
  /\bbipolar\s*1\b/.test(n) ||
  /\bbp\s*1\b/.test(n) ||
  /\bbd\s*1\b/.test(n) ||
  /\bbpad\s*1\b/.test(n) ||
  /\bbipolar\s+i(?:\s+disorder)?\b/.test(n);

const bipolarTypeTwo = (n) =>
  /\bbpd\s*(?:type\s*)?2\b/.test(n) ||
  /\bbpd\s*(?:type\s*)?ii\b/.test(n) ||
  /\bbipolar\s+(?:disorder\s+)?type\s*2\b/.test(n) ||
  /\bbipolar\s*2\b/.test(n) ||
  /\bbp\s*2\b/.test(n) ||
  /\bbd\s*2\b/.test(n) ||
  /\bbpad\s*2\b/.test(n) ||
  /\bbipolar\s+ii(?:\s+disorder)?\b/.test(n);

const RULES = [
  {
    id: 'bipolar-i',
    test: (n, raw) => bipolarTypeOne(n),
    resolved: 'Bipolar I Disorder',
    registrySlug: 'bipolar-i-disorder',
    kbSlug: 'bipolar-disorder',
    subtype: 'Bipolar I',
    score: 100
  },
  {
    id: 'bipolar-ii',
    test: (n, raw) => bipolarTypeTwo(n),
    resolved: 'Bipolar II Disorder',
    registrySlug: 'bipolar-ii-disorder',
    kbSlug: 'bipolar-disorder',
    subtype: 'Bipolar II',
    score: 100
  },
  {
    id: 'bipolar-manic-cluster',
    test: (n) => {
      const hasBipolar =
        /\bbipolar\b/.test(n) ||
        /\bbpad\b/.test(n) ||
        /\bbpc\b/.test(n) ||
        /\bbp\b/.test(n);
      const hasManic = /\b(manic|mania|hypomanic|depress)\b/.test(n);
      const hasBorderline = /\bborderline\b/.test(n) || /\bpersonality\b/.test(n);
      const bpdWithMood =
        /\bbpd\b/.test(n) && hasManic && !hasBorderline && !pulmonaryContext(n);
      return (hasBipolar && hasManic && !hasBorderline) || bpdWithMood;
    },
    resolved: 'Bipolar Disorder',
    kbSlug: 'bipolar-disorder',
    subtype: 'manic / mood episode (lay phrasing)',
    score: 93
  },
  {
    id: 'manic-depression',
    test: (n) => /\bmanic\s+depress/.test(n),
    resolved: 'Bipolar Disorder',
    kbSlug: 'bipolar-disorder',
    subtype: 'manic-depression (lay term)',
    score: 95
  },
  {
    id: 'borderline-explicit',
    test: (n) => /\bborderline\b/.test(n) && /\b(personality|pd)\b/.test(n),
    resolved: 'Borderline personality disorder',
    registrySlug: 'borderline-personality-disorder',
    score: 100
  },
  {
    id: 'bpd-pulmonary',
    test: (n, raw) => /\bbpd\b/.test(n) && pulmonaryContext(n),
    resolved: 'Bronchopulmonary dysplasia',
    registrySlug: 'bronchopulmonary-dysplasia',
    score: 100
  },
  {
    id: 'bpd-psych-default',
    test: (n, raw) =>
      /^bpd$/i.test(String(raw || '').trim()) ||
      (/\bbpd\b/.test(n) &&
        !pulmonaryContext(n) &&
        !bipolarTypeOne(n) &&
        !bipolarTypeTwo(n) &&
        !/\b(manic|mania|hypomanic|depress|bipolar|bpc|bpad)\b/.test(n)),
    resolved: 'Borderline personality disorder',
    registrySlug: 'borderline-personality-disorder',
    subtype: 'BPD (psychiatry default)',
    score: 92
  },
  {
    id: 'bipolar-generic',
    test: (n) => /\bbipolar\b/.test(n),
    resolved: 'Bipolar Disorder',
    kbSlug: 'bipolar-disorder',
    score: 90
  },
  {
    id: 'lada',
    test: (n) => /\blada\b/.test(n) || /\btype\s*1\.5\s*diabetes\b/.test(n),
    resolved: 'Latent Autoimmune Diabetes in Adults',
    registrySlug: 'latent-autoimmune-diabetes-in-adults',
    score: 100
  }
];

/** @returns {object | null} */
export function matchOntology(input) {
  const raw = String(input || '').trim();
  const n = normalize(input);
  if (!n) return null;

  const repaired = repairConditionText(input);
  const core = extractMedicalCore(input);
  const candidates = [...new Set([repaired, core, n].filter(Boolean))];

  for (const candidate of candidates) {
    for (const rule of RULES) {
      if (!rule.test(candidate, raw)) continue;
      const nextBrainLayer = rule.kbSlug
        ? 'curated-kb'
        : rule.registrySlug
          ? 'disease-registry'
          : 'dossier-llm';
      const resolutionPath =
        candidate !== n
          ? `typo-repair→ontology→${nextBrainLayer}`
          : rule.kbSlug || rule.registrySlug
            ? `ontology→${nextBrainLayer}`
            : 'ontology→dossier-llm';

      return {
        ...rule,
        userInput: raw,
        repairedInput: candidate !== n ? candidate : null,
        source: 'ontology',
        nextBrainLayer,
        resolutionPath
      };
    }
  }
  return null;
}

export function describeBrainFallback(source, matchScore = 0) {
  if (source === 'curated-kb' || source === 'ontology') {
    return { layer: 'curated-kb', label: 'curated knowledge base' };
  }
  if (source === 'disease-registry') {
    return { layer: 'disease-registry', label: 'disease registry (~19k conditions)' };
  }
  if (matchScore > 0) {
    return { layer: 'dossier-llm', label: 'disease dossier (AI intake)' };
  }
  return {
    layer: 'dossier-llm→dynamic-brain',
    label: 'AI dossier, then building a persistent brain entry'
  };
}
