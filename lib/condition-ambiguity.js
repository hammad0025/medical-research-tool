import { normalize } from './normalize.js';

// Short condition names that can refer to meaningfully different diagnoses.
// Only exact normalized matches are blocked; explicit surrounding context can
// still be handled by the condition ontology.
const BPD_AMBIGUITY = {
  alternatives: [
    'Bipolar disorder',
    'Borderline personality disorder',
    'Bronchopulmonary dysplasia'
  ]
};

const MS_AMBIGUITY = {
  alternatives: [
    'Multiple sclerosis',
    'Mitral stenosis',
    'Metabolic syndrome'
  ]
};

const AD_AMBIGUITY = {
  alternatives: ['Alzheimer disease', 'Atopic dermatitis']
};
const ASD_AMBIGUITY = {
  alternatives: ['Autism spectrum disorder', 'Atrial septal defect']
};
const MD_AMBIGUITY = {
  alternatives: ['Muscular dystrophy', 'Major depressive disorder']
};
const PD_AMBIGUITY = {
  alternatives: ['Parkinson disease', 'Personality disorder']
};

const CONDITION_AMBIGUITIES = new Map([
  ['bpd', BPD_AMBIGUITY],
  ['b p d', BPD_AMBIGUITY],
  ['ms', MS_AMBIGUITY],
  ['m s', MS_AMBIGUITY],
  ['ad', AD_AMBIGUITY],
  ['a d', AD_AMBIGUITY],
  ['asd', ASD_AMBIGUITY],
  ['a s d', ASD_AMBIGUITY],
  ['md', MD_AMBIGUITY],
  ['m d', MD_AMBIGUITY],
  ['pd', PD_AMBIGUITY],
  ['p d', PD_AMBIGUITY]
]);

export function findConditionAmbiguity(input) {
  const userInput = String(input || '').trim();
  const normalized = normalize(userInput);
  const ambiguity = CONDITION_AMBIGUITIES.get(normalized) ||
    (
      /\btype\s*(?:1|one|i)\b/.test(normalized) &&
      /\bdiabetes\s+insipidus\b/.test(normalized)
        ? {
            alternatives: [
              'Type 1 diabetes mellitus',
              'Diabetes insipidus'
            ]
          }
        : null
    );
  if (!ambiguity) return null;

  return {
    ok: false,
    userInput,
    resolved: null,
    resolvedSlug: null,
    source: 'user-input',
    matchScore: 0,
    needsConfirmation: true,
    confident: false,
    autoCanonicalize: false,
    alternatives: [...ambiguity.alternatives],
    issues: [],
    message: `“${userInput}” can mean more than one condition. Please enter or select the full condition name: ${ambiguity.alternatives.join(', ')}.`
  };
}
