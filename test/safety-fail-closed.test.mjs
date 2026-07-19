import test from 'node:test';
import assert from 'node:assert/strict';

import {
  injectSafetyBands,
  labelMatchesDrugContext,
  missingMaterialPatientContexts,
  scoreSafety
} from '../lib/safety-score.js';

const url = 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=safety-test';
const completeContext = {
  allergies: 'No known drug allergies',
  pregnancyStatus: 'not pregnant',
  renalFunction: 'normal',
  hepaticFunction: 'normal',
  medicationHistory: 'No prior treatment',
  labWork: 'Relevant labs reviewed'
};
const matchingLabel = {
  url,
  genericName: ['Exampledrug'],
  route: ['ORAL'],
  dosageForm: ['TABLET'],
  activeIngredient: ['Exampledrug 10 mg'],
  warnings: 'No warnings identified in the captured label section.',
  contraindications: 'None known.',
  drugInteractions: 'No known interactions.'
};

test('Low safety concern requires every material patient context', () => {
  for (const missing of [
    'allergies',
    'pregnancyStatus',
    'renalFunction',
    'hepaticFunction',
    'medicationHistory',
    'labWork'
  ]) {
    const patientContext = { ...completeContext };
    delete patientContext[missing];
    const scored = scoreSafety({
      drugName: 'Exampledrug 10 mg oral tablet',
      patientContext,
      fdaLabel: matchingLabel,
      faers: []
    });
    assert.equal(scored.band, 'Unknown', `missing ${missing} must fail closed`);
    assert.match(scored.factors[0].text, /context is missing/i);
  }

  assert.deepEqual(missingMaterialPatientContexts(completeContext), []);
  assert.equal(scoreSafety({
    drugName: 'Exampledrug 10 mg oral tablet',
    patientContext: completeContext,
    fdaLabel: matchingLabel,
    faers: []
  }).band, 'Low');
});

test('a candidate matching a recorded allergy cannot receive low concern', () => {
  const scored = scoreSafety({
    drugName: 'Exampledrug 10 mg oral tablet',
    patientContext: { ...completeContext, allergies: 'Latex; Exampledrug' },
    fdaLabel: matchingLabel,
    faers: []
  });
  assert.equal(scored.band, 'High');
  assert.match(scored.factors[0].text, /recorded Exampledrug allergy/i);
});

test('FDA label identity, strength, and formulation must match the candidate', () => {
  assert.equal(labelMatchesDrugContext(
    'Exampledrug 10 mg oral tablet',
    matchingLabel
  ), true);

  for (const drugName of [
    'Differentdrug 10 mg oral tablet',
    'Exampledrug 20 mg oral tablet',
    'Exampledrug 10 mg oral capsule'
  ]) {
    const scored = scoreSafety({
      drugName,
      patientContext: completeContext,
      fdaLabel: matchingLabel,
      faers: []
    });
    assert.equal(scored.band, 'Unknown', `${drugName} must not use the mismatched label`);
    assert.match(scored.factors[0].text, /identity, strength, route, or formulation/i);
  }

  assert.equal(scoreSafety({
    drugName: 'Exampledrug 10 mg oral tablet',
    patientContext: completeContext,
    fdaLabel: { ...matchingLabel, activeIngredient: undefined, dosage: undefined },
    faers: []
  }).band, 'Unknown', 'missing label strength must fail closed');
});

test('independent FDA hazards retain their deterministic higher concern band', () => {
  const args = {
    drugName: 'Exampledrug',
    patientContext: completeContext,
    fdaLabel: {
      url,
      genericName: ['Exampledrug'],
      boxedWarning: 'Serious liver injury can occur.'
    },
    faers: []
  };
  assert.equal(scoreSafety(args).band, 'High');
  assert.deepEqual(scoreSafety(args), scoreSafety(args));
});

test('card injection validates the full candidate rather than its stripped key', () => {
  const text = [
    'CANDIDATE: Exampledrug 20 mg oral tablet',
    'SAFETY: High'
  ].join('\n');
  const output = injectSafetyBands(text, {
    patientContext: completeContext,
    fdaLabels: [{
      drug: 'Exampledrug',
      label: matchingLabel,
      topAdverseEvents: []
    }]
  });
  assert.match(output, /SAFETY: Safety concern: Unknown/);
  assert.match(output, /strength/);
});
