import assert from 'node:assert/strict';
import test from 'node:test';

import {
  profileClinicalPlaceholders,
  profileSafetyFields
} from '../lib/profile-field-config.js';

test('Parkinson profile does not show pulmonary examples', () => {
  const fields = profileClinicalPlaceholders({
    condition: 'Parkinsons Disease',
    gender: 'Male'
  });

  assert.match(fields.stage, /Hoehn and Yahr/i);
  assert.match(fields.labWork, /neurological|movement/i);
  assert.match(fields.scans, /brain MRI|DaTscan/i);
  assert.doesNotMatch(Object.values(fields).join(' '), /FVC|DLCO|6-minute walk|HRCT|UIP/i);
});

test('male Parkinson profile with no medicines does not render organ safety fields', () => {
  assert.deepEqual(
    profileSafetyFields({
      condition: 'Parkinsons Disease',
      gender: 'Male',
      medications: '',
      diagnoses: ''
    }),
    []
  );
});

test('medicine context reveals optional organ safety fields without making them research topics', () => {
  const fields = profileSafetyFields({
    condition: 'Parkinsons Disease',
    gender: 'Male',
    medications: 'Amantadine'
  });

  assert.deepEqual(fields.map(({ k }) => k), ['renalFunction', 'hepaticFunction']);
  assert.ok(fields.every(({ ph }) => /medicine safety and dosing/i.test(ph)));
});

test('pregnancy field is hidden for male profiles unless a value already exists', () => {
  assert.equal(
    profileSafetyFields({ gender: 'Male', pregnancyStatus: '' })
      .some(({ k }) => k === 'pregnancyStatus'),
    false
  );
  assert.equal(
    profileSafetyFields({ gender: 'Male', pregnancyStatus: 'not applicable' })
      .some(({ k }) => k === 'pregnancyStatus'),
    true
  );
});
