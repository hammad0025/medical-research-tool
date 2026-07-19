import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessDetailedEligibility,
  assessTrialEligibility
} from '../api/trials.js';
import {
  mergePatientFromMessage,
  parsePatientMessage
} from '../lib/patient-intake.js';
import { buildPatientContext } from '../api/research.js';

const study = (inclusion = '', exclusion = '') => ({
  eligibilityCriteria: [
    'Inclusion Criteria:',
    inclusion,
    '',
    'Exclusion Criteria:',
    exclusion
  ].join('\n')
});

test('required organ-function facts fail closed and numeric labs are compared', () => {
  const trial = study('- FVC >= 50% predicted', '');

  const missing = assessDetailedEligibility(trial, {});
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.eligible, false);
  assert.equal(missing.unknown[0].dimension, 'organ-function');

  const incompatible = assessDetailedEligibility(trial, { labWork: 'FVC 42% predicted' });
  assert.equal(incompatible.status, 'hard-mismatch');
  assert.match(incompatible.incompatible[0].reason, /conflicts/i);

  const compatible = assessDetailedEligibility(trial, { labWork: 'FVC 61% predicted' });
  assert.equal(compatible.status, 'no-hard-mismatch');
  assert.equal(compatible.checks[0].status, 'compatible');

  const exclusion = study('', '- Creatinine > 2.0');
  assert.equal(
    assessDetailedEligibility(exclusion, { labWork: 'Creatinine 2.6 mg/dL' }).status,
    'hard-mismatch'
  );
});

test('required genotype is unknown when absent and rejected when incompatible', () => {
  const trial = study('- Pathogenic EGFR mutation required', '');

  assert.equal(assessDetailedEligibility(trial, {}).status, 'unknown');
  assert.equal(
    assessDetailedEligibility(trial, { geneticVariant: 'ALK pathogenic variant detected' }).status,
    'hard-mismatch'
  );
  assert.equal(
    assessDetailedEligibility(trial, { geneticVariant: 'EGFR pathogenic variant detected' }).status,
    'no-hard-mismatch'
  );
});

test('pregnancy and prior-treatment criteria never default to eligible', () => {
  const pregnancyTrial = study('', '- Pregnant or breastfeeding patients');
  assert.equal(assessDetailedEligibility(pregnancyTrial, { gender: 'Female' }).status, 'unknown');
  assert.equal(
    assessDetailedEligibility(pregnancyTrial, { pregnancyStatus: 'Currently pregnant' }).status,
    'hard-mismatch'
  );
  assert.equal(
    assessDetailedEligibility(pregnancyTrial, { pregnancyStatus: 'Not pregnant' }).status,
    'no-hard-mismatch'
  );

  const priorTrial = study('- Must have previously received platinum chemotherapy', '');
  assert.equal(assessDetailedEligibility(priorTrial, {}).status, 'unknown');
  assert.equal(
    assessDetailedEligibility(priorTrial, { medicationHistory: 'Previously received platinum chemotherapy' }).status,
    'no-hard-mismatch'
  );

  const excludedPrior = study('', '- Prior treatment with osimertinib');
  assert.equal(
    assessDetailedEligibility(excludedPrior, { medicationHistory: 'Previously took osimertinib' }).status,
    'hard-mismatch'
  );
});

test('unresolved detailed criteria produce unknown eligibility, never eligible', () => {
  const result = assessTrialEligibility(study('- Platelets >= 100', ''), {
    patient: {}
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.detailed.eligible, false);
  assert.equal(result.flags[0].status, 'unknown');
});

test('patient normalization preserves negations and numeric lab values', () => {
  const message = [
    'She does not have diabetes.',
    'Her FVC is 47% predicted and DLCO is 31%.',
    'Genetic testing done — no known pathogenic variant found.',
    'She is not pregnant.'
  ].join(' ');
  const parsed = parsePatientMessage(message);

  assert.match(parsed.updates.diagnoses, /does not have diabetes/i);
  assert.match(parsed.updates.labWork, /FVC is 47% predicted and DLCO is 31%/i);
  assert.match(parsed.updates.geneticVariant, /no known pathogenic variant found/i);
  assert.match(parsed.updates.pregnancyStatus, /not pregnant/i);

  const merged = mergePatientFromMessage({}, parsed).patient;
  const context = buildPatientContext(merged);
  assert.match(context, /does not have diabetes/i);
  assert.match(context, /FVC is 47% predicted and DLCO is 31%/i);
  assert.match(context, /PROVIDED NEGATIVE/i);
  assert.match(context, /Pregnancy \/ breastfeeding status: She is not pregnant/i);
});

test('generator context carries every material treatment-safety fact', () => {
  const context = buildPatientContext({
    condition: 'Example condition',
    allergies: 'Exampledrug',
    medicationHistory: 'Prior therapy stopped for toxicity',
    labWork: 'eGFR 38; ALT 72',
    pregnancyStatus: 'Unknown',
    renalFunction: 'CKD stage 3b',
    hepaticFunction: 'Elevated transaminases'
  });
  assert.match(context, /Recorded allergies.*Exampledrug/i);
  assert.match(context, /Prior treatments.*stopped for toxicity/i);
  assert.match(context, /Lab work.*eGFR 38; ALT 72/i);
  assert.match(context, /Pregnancy.*Unknown/i);
  assert.match(context, /Kidney.*CKD stage 3b/i);
  assert.match(context, /Liver.*Elevated transaminases/i);
});
