import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dailyMedLabelUrl,
  enforceFdaLabelNarrative,
  sealFdaLabel,
  validateLabelIdentity,
  verifyFdaLabel
} from '../lib/fda-label-gate.js';
import { finalizeReportText } from '../lib/report-polish.js';

const now = 1_780_000_000_000;
const secret = 'deterministic-fda-label-test-secret';
const exampleSetId = '2e8c3537-36d7-4de5-9b5c-7a624b9a9e6e';
const otherSetId = '47b4b284-1234-4abc-8def-1234567890ab';

const makeLabel = ({
  requestedDrug = 'Exampledrug',
  setId = exampleSetId,
  genericName = ['Exampledrug'],
  brandName = ['Examplebrand'],
  activeIngredient = ['Exampledrug']
} = {}) => {
  const label = {
    requestedDrug,
    splSetId: setId,
    splIds: ['8b5dbed2-6abc-4def-9abc-1234567890ab'],
    applicationNumbers: ['NDA123456'],
    productNdc: ['12345-678'],
    genericName,
    brandName,
    activeIngredient,
    manufacturer: ['Example Pharma'],
    route: ['ORAL'],
    dosageForm: ['TABLET'],
    productType: ['HUMAN PRESCRIPTION DRUG'],
    indications: 'Exampledrug is indicated for pulmonary arterial hypertension.',
    dosage: 'Take 10 mg orally once daily.',
    contraindications: 'Contraindicated with strong CYP3A inhibitors.',
    boxedWarning: 'WARNING: Exampledrug can cause severe liver injury.',
    warnings: 'Monitor liver function during treatment.',
    adverseReactions: 'The most common adverse reactions are nausea and headache.',
    drugInteractions: 'Avoid strong CYP3A inhibitors.',
    dailyMedUrl: dailyMedLabelUrl(setId),
    url: dailyMedLabelUrl(setId)
  };
  label.labelSeal = sealFdaLabel(label, { secret, now });
  return label;
};

const entry = (label = makeLabel()) => ({ drug: label.requestedDrug, label });
const options = { secret, now };

test('exact sealed FDA/DailyMed product identity is accepted', () => {
  const label = makeLabel();
  assert.deepEqual(validateLabelIdentity(label), []);
  assert.equal(verifyFdaLabel(label, options).ok, true);
  const text = `CANDIDATE: Exampledrug
FDA_STATUS: FDA-approved for pulmonary arterial hypertension. ([DailyMed label](${label.url}))
DOSAGE: The label dose is 10 mg once daily. ([DailyMed label](${label.url}))`;
  const result = enforceFdaLabelNarrative(text, [entry(label)], options);
  assert.equal(result.removed.length, 0);
  assert.match(result.text, /10 mg once daily/);
});

test('swapped related-product label is rejected', () => {
  const other = makeLabel({
    requestedDrug: 'Otherdrug',
    setId: otherSetId,
    genericName: ['Otherdrug'],
    brandName: ['Otherbrand'],
    activeIngredient: ['Otherdrug']
  });
  const text = `CANDIDATE: Exampledrug
FDA_STATUS: FDA-approved for pulmonary arterial hypertension. ([DailyMed label](${other.url}))`;
  const result = enforceFdaLabelNarrative(text, [entry(other)], options);
  assert.equal(result.text, `CANDIDATE: Exampledrug
FDA_STATUS: Unknown — insufficient verified FDA/DailyMed label evidence.`);
  assert.ok(result.issues.includes('LABEL_CLAIM_UNSUPPORTED'));
});

test('wrong dose value or unit is rejected', () => {
  const label = makeLabel();
  const result = enforceFdaLabelNarrative(
    `CANDIDATE: Exampledrug
DOSAGE: The label dose is 10 mcg once daily. ([DailyMed label](${label.url}))`,
    [entry(label)],
    options
  );
  assert.equal(result.text, 'CANDIDATE: Exampledrug');
});

test('wrong indication is rejected', () => {
  const label = makeLabel();
  const result = enforceFdaLabelNarrative(
    `CANDIDATE: Exampledrug
FDA_STATUS: FDA-approved to treat breast cancer. ([DailyMed label](${label.url}))`,
    [entry(label)],
    options
  );
  assert.doesNotMatch(result.text, /breast cancer/i);
  assert.match(result.text, /FDA_STATUS: Unknown/);
});

test('wrong boxed-warning text is rejected', () => {
  const label = makeLabel();
  const result = enforceFdaLabelNarrative(
    `CANDIDATE: Exampledrug
RISKS: The FDA boxed warning says this drug causes blindness. ([DailyMed label](${label.url}))`,
    [entry(label)],
    options
  );
  assert.equal(result.text, 'CANDIDATE: Exampledrug');
});

test('malformed set or application identifiers fail closed', () => {
  const malformedSet = { ...makeLabel(), splSetId: 'not-a-set-id' };
  assert.ok(validateLabelIdentity(malformedSet).includes('LABEL_SET_ID_INVALID'));
  const malformedApplication = {
    ...makeLabel(),
    applicationNumbers: ['NDA12<script>']
  };
  assert.ok(validateLabelIdentity(malformedApplication).includes('LABEL_APPLICATION_ID_INVALID'));
});

test('tampered structured label payload invalidates its seal', () => {
  const label = makeLabel();
  const tampered = structuredClone(label);
  tampered.dosage = 'Take 100 mg four times daily.';
  assert.equal(verifyFdaLabel(tampered, options).ok, false);
  const result = enforceFdaLabelNarrative(
    `CANDIDATE: Exampledrug
DOSAGE: Take 100 mg four times daily. ([DailyMed label](${label.url}))`,
    [entry(tampered)],
    options
  );
  assert.equal(result.text, 'CANDIDATE: Exampledrug');
  assert.ok(result.issues.includes('GATHER_SEAL_INVALID'));
});

test('stale structured label payload is rejected', () => {
  const label = makeLabel();
  const stale = verifyFdaLabel(label, {
    secret,
    now: now + (31 * 60 * 1000)
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'GATHER_SEAL_EXPIRED');
});

test('reader-facing finalization replaces unverified label status with Unknown', () => {
  const tampered = makeLabel();
  tampered.indications = 'Tampered indication for breast cancer.';
  const output = finalizeReportText(
    `CANDIDATE: Exampledrug
FDA_STATUS: FDA-approved to treat breast cancer. ([DailyMed label](${tampered.url}))`,
    {
      evidence: { fdaLabels: [entry(tampered)] },
      trials: {},
      patient: { condition: 'breast cancer' }
    }
  );
  assert.match(output, /Unknown — insufficient verified FDA\/DailyMed label evidence/i);
  assert.doesNotMatch(output, /FDA-approved to treat breast cancer/i);
});
