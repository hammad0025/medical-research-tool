import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAERS_SERIOUS_MIN_REPORTS,
  SAFETY_LEVELS,
  labelMatchesDrugContext,
  normalizePatientMeds,
  scoreSafety
} from '../lib/safety-score.js';
import {
  finalizeReportText,
  stripUnsupportedEligibilityClaims
} from '../lib/report-polish.js';

const labelUrl = 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=assurance';
const patientContext = {
  allergies: 'No known drug allergies',
  pregnancyStatus: 'not pregnant',
  renalFunction: 'normal',
  hepaticFunction: 'normal',
  medicationHistory: 'No prior treatment',
  labWork: 'Relevant labs reviewed'
};
const cleanLabel = {
  url: labelUrl,
  genericName: ['Assuramed'],
  route: ['ORAL'],
  dosageForm: ['TABLET'],
  activeIngredient: ['Assuramed 10 mg'],
  warnings: 'No warnings identified in the captured label section.',
  contraindications: 'None known.',
  drugInteractions: 'None known.'
};

const score = (overrides = {}) => scoreSafety({
  drugName: 'Assuramed 10 mg oral tablet',
  patientContext,
  fdaLabel: cleanLabel,
  faers: [],
  ...overrides
});

test('safety is monotonic: adding independent hazards can never improve the band', () => {
  const scenarios = [
    {},
    { fdaLabel: { ...cleanLabel, boxedWarning: 'Serious hepatotoxicity.' } },
    { patientMeds: 'warfarin', fdaLabel: { ...cleanLabel, drugInteractions: 'Avoid warfarin.' } },
    {
      patientMeds: 'warfarin',
      fdaLabel: {
        ...cleanLabel,
        boxedWarning: 'Serious hepatotoxicity.',
        drugInteractions: 'Avoid warfarin.'
      }
    }
  ];
  const levels = scenarios.map((scenario) => score(scenario).level);
  assert.deepEqual(levels, [
    SAFETY_LEVELS.Low,
    SAFETY_LEVELS.High,
    SAFETY_LEVELS.High,
    SAFETY_LEVELS.High
  ]);
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i] >= levels[i - 1], `${levels[i - 1]} -> ${levels[i]} decreased after hazard`);
  }
});

test('spontaneous report counts never determine the safety-concern band', () => {
  const below = score({
    faers: [{ reaction: 'acute kidney injury', reports: FAERS_SERIOUS_MIN_REPORTS - 1 }]
  });
  const at = score({
    faers: [{ reaction: 'acute kidney injury', reports: FAERS_SERIOUS_MIN_REPORTS }]
  });
  const three = score({
    faers: [
      { reaction: 'acute kidney injury', reports: FAERS_SERIOUS_MIN_REPORTS },
      { reaction: 'cardiac arrest', reports: FAERS_SERIOUS_MIN_REPORTS + 1 },
      { reaction: 'anaphylaxis', reports: FAERS_SERIOUS_MIN_REPORTS + 2 }
    ]
  });
  assert.equal(below.band, 'Low');
  assert.equal(at.band, 'Low');
  assert.equal(three.band, 'Low');
  assert.match(at.factors.at(-1).text, /not incidence rates.*do not prove causation/i);
});

test('medication interaction matching uses whole drugs and deduplicates case variants', () => {
  assert.deepEqual(
    normalizePatientMeds('Warfarin 5 mg; warfarin 2 mg\nAspirin 81 mg'),
    ['Warfarin', 'Aspirin']
  );
  assert.equal(score({
    patientMeds: 'war',
    fdaLabel: { ...cleanLabel, drugInteractions: 'Avoid warfarin.' }
  }).band, 'Low', 'substring must not count as an interaction');
  assert.equal(score({
    patientMeds: 'warfarin 5 mg',
    fdaLabel: { ...cleanLabel, drugInteractions: 'Avoid warfarin.' }
  }).band, 'High');
});

test('label identity rejects seeded route, form, strength, and drug mutations', () => {
  assert.equal(labelMatchesDrugContext('Assuramed 10 mg oral tablet', cleanLabel), true);
  for (const mutation of [
    'Otherdrug 10 mg oral tablet',
    'Assuramed 11 mg oral tablet',
    'Assuramed 10 mg oral capsule',
    'Assuramed 10 mg topical tablet'
  ]) {
    assert.equal(labelMatchesDrugContext(mutation, cleanLabel), false, mutation);
    assert.equal(score({ drugName: mutation }).band, 'Unknown');
  }
});

test('low safety concern fails closed for each missing label section and patient context', () => {
  for (const field of ['warnings', 'contraindications', 'drugInteractions']) {
    const fdaLabel = { ...cleanLabel };
    delete fdaLabel[field];
    assert.equal(score({ fdaLabel }).band, 'Unknown', `missing ${field}`);
  }
  for (const field of [
    'allergies',
    'pregnancyStatus',
    'renalFunction',
    'hepaticFunction',
    'medicationHistory',
    'labWork'
  ]) {
    const context = { ...patientContext };
    delete context[field];
    assert.equal(score({ patientContext: context }).band, 'Unknown', `missing ${field}`);
  }
  assert.equal(score({ fdaLabel: null }).band, 'Unknown');
});

test('eligibility grounding requires gene and eligibility language in the same source', () => {
  const claim = 'The measured retinal response improved. Gene-agnostic — CERKL-eligible.';
  const splitEvidence = {
    groundedForPrompt: [
      { summary: 'CERKL-associated retinal disease was studied.' },
      { summary: 'Other genotypes were eligible for treatment.' }
    ]
  };
  const split = stripUnsupportedEligibilityClaims(claim, splitEvidence);
  assert.match(split.text, /measured retinal response improved/i);
  assert.doesNotMatch(split.text, /gene-agnostic|CERKL-eligible/i);
  assert.ok(split.stripped.length > 0);

  const supportedEvidence = {
    groundedForPrompt: [{
      summary: 'Patients with CERKL variants were eligible for treatment; benefit was gene-agnostic.'
    }]
  };
  assert.equal(stripUnsupportedEligibilityClaims(claim, supportedEvidence).text, claim);
});

test('eligibility sanitizer is idempotent and preserves condition acronyms and real content', () => {
  const input = [
    'NCT12345678 is recruiting — relevant to CERKL patients.',
    'This finding applies to IPF patients.',
    'Measured response improved [#1]; CERKL-eligible.'
  ].join('\n');
  const once = stripUnsupportedEligibilityClaims(input, {}).text;
  const twice = stripUnsupportedEligibilityClaims(once, {}).text;
  assert.equal(twice, once);
  assert.match(once, /NCT12345678/);
  assert.match(once, /applies to IPF patients/);
  assert.match(once, /\[#1\]/);
  assert.doesNotMatch(once, /CERKL|relevant to CERKL/i);
});

test('finalization composes citation, disease, demographic, and eligibility gates', () => {
  const evidence = {
    condition: 'Parkinson disease',
    groundedForPrompt: [{
      title: 'Parkinson treatment study',
      summary: 'Assuramed treatment was studied in Parkinson disease.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
    }]
  };
  const input = [
    'CANDIDATE: Assuramed',
    'RATIONALE: Assuramed treatment was studied in Parkinson disease. [#1]',
    'Gene-agnostic — CERKL-eligible.',
    'A women-only randomized trial is recruiting.',
    'Sickle cell disease showed a response.',
    '[search](https://google.com/search?q=assuramed)'
  ].join('\n');
  const finalized = finalizeReportText(input, {
    evidence,
    patient: { condition: 'Parkinson disease', gender: 'male', age: 50 }
  });
  assert.match(finalized, /Drug or supplement idea: Assuramed/);
  assert.doesNotMatch(finalized, /CERKL|women-only|Sickle cell|google\.com/i);
  assert.doesNotMatch(finalized, /\[#1\]/);
  assert.match(finalized, /pubmed\.ncbi\.nlm\.nih\.gov\/12345678/);
  assert.equal(finalizeReportText(finalized, {
    evidence,
    patient: { condition: 'Parkinson disease', gender: 'male', age: 50 }
  }), finalized);
});
