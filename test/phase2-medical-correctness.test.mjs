import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, parseExplicitBoolean, parsePageSize } from '../lib/normalize.js';
import { matchOntology } from '../lib/condition-ontology.js';
import { classifyGeneticResult, geneticSnapshotRow } from '../lib/genetics.js';
import { extractMedicationFacts, parsePatientMessage } from '../lib/patient-intake.js';
import { findingIsDemographicMismatch, stripDemographicMismatchLines } from '../lib/demographic-gate.js';
import { scoreSafety } from '../lib/safety-score.js';
import { selectBestLabel } from '../lib/openfda.js';
import { registryApprovalState } from '../lib/drug-registry.js';
import {
  buildRegistryFillCandidate,
  needsBackfill,
  REPURPOSE_TARGET_TOTAL
} from '../lib/repurpose-quality.js';
import { parsePubmedArticleXml } from '../lib/pubmed.js';
import { europePmcRecordIsRetracted, isValidArticleXml, stripXml } from '../lib/europe-pmc.js';
import {
  classifyTrial,
  parseApprovalStatus,
  parseEligibilityCriteria
} from '../api/trials.js';

test('explicit booleans and bounded page sizes do not use truthiness', () => {
  assert.equal(parseExplicitBoolean('false', true), false);
  assert.equal(parseExplicitBoolean('0', true), false);
  assert.equal(parseExplicitBoolean('yes', false), true);
  assert.equal(parseExplicitBoolean('not-a-boolean', true), true);
  assert.equal(parsePageSize('-4', { fallback: 10, max: 25 }), 10);
  assert.equal(parsePageSize('999', { fallback: 10, max: 25 }), 25);
  assert.equal(parsePageSize('2.5', { fallback: 10, max: 25 }), 10);
});

test('Unicode condition normalization preserves decimal subtypes', () => {
  assert.equal(normalize('Diabètes type 1.5'), 'diabetes type 1.5');
  assert.equal(matchOntology('diabetes type 1.5')?.id, 'lada');
});

test('trial criteria retain complete inclusion and exclusion text', () => {
  const raw = 'Inclusion Criteria:\n- Age 18+\n- Confirmed disease\n\nExclusion Criteria:\n- Severe renal disease\n- Pregnancy';
  const parsed = parseEligibilityCriteria(raw);
  assert.equal(parsed.fullText, raw);
  assert.match(parsed.inclusion, /Confirmed disease/);
  assert.match(parsed.exclusion, /Pregnancy/);
  assert.equal(parsed.reviewStatus, 'unchecked');

  const trial = classifyTrial({
    protocolSection: {
      identificationModule: { nctId: 'NCT12345678', briefTitle: 'Example' },
      designModule: { studyType: 'INTERVENTIONAL' },
      eligibilityModule: { eligibilityCriteria: raw },
      armsInterventionsModule: {},
      statusModule: {},
      contactsLocationsModule: {}
    }
  }, () => false);
  assert.equal(trial.eligibilityCriteria, raw);
  assert.match(trial.eligibilityCaution, /not been checked/i);
});

test('approval parsing distinguishes negation and other indications', () => {
  assert.equal(parseApprovalStatus('not FDA approved'), 'not-approved');
  assert.equal(parseApprovalStatus('FDA approved for another indication'), 'approved-other-indication');
  assert.equal(parseApprovalStatus('FDA-approved'), 'approved');
  assert.equal(registryApprovalState({ approvedUsa: 'false', status: 'not approved' }), 'not-approved');
  assert.equal(registryApprovalState({ approvedUsa: true }), 'approved-other-indication');
});

test('safety remains unknown without safety evidence or matching formulation', () => {
  const base = { url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x' };
  assert.equal(scoreSafety({ drugName: 'drug', fdaLabel: base }).band, 'Unknown');
  assert.equal(scoreSafety({ drugName: 'drug', fdaLabel: { ...base, warnings: 'Use caution.' } }).band, 'Unknown');
  assert.equal(scoreSafety({
    drugName: 'topical drug',
    fdaLabel: { ...base, route: ['ORAL'], warnings: 'May cause dizziness.' }
  }).band, 'Unknown');
  assert.equal(scoreSafety({
    drugName: 'topical drug',
    fdaLabel: {
      ...base,
      route: ['TOPICAL'],
      warnings: 'May cause irritation.',
      contraindications: 'None known.',
      drugInteractions: 'No known interactions.'
    }
  }).band, 'High');
});

test('openFDA label selection rejects route mismatches', () => {
  const oral = { openfda: { generic_name: ['Example'], route: ['ORAL'], dosage_form: ['TABLET'] } };
  const topical = { openfda: { generic_name: ['Example'], route: ['TOPICAL'], dosage_form: ['CREAM'] } };
  assert.equal(selectBestLabel([oral, topical], { drug: 'Example', route: 'topical' }), topical);
  assert.equal(selectBestLabel([oral], { drug: 'Example', route: 'topical' }), null);
});

test('demographic validator does not delete an unverified study finding', () => {
  assert.equal(findingIsDemographicMismatch('A randomized study enrolled 40 adults.', { gender: 'Male', age: 50 }), false);
  assert.equal(findingIsDemographicMismatch('A women-only trial enrolled participants.', { gender: 'Male' }), true);
  const result = stripDemographicMismatchLines(
    'A study in women reported symptom improvement.\nA women-only trial is recruiting.',
    { gender: 'Male' }
  );
  assert.match(result.text, /study in women/);
  assert.doesNotMatch(result.text, /women-only trial/);
});

test('medication parsing separates current, negated, historical, and allergy facts', () => {
  const facts = extractMedicationFacts(
    'She takes metformin 500 mg and insulin twice a day, is not taking aspirin, used to take lisinopril, and is allergic to penicillin.'
  );
  assert.deepEqual(facts.current, ['metformin', 'insulin']);
  assert.deepEqual(facts.history, ['lisinopril']);
  assert.deepEqual(facts.allergies, ['penicillin']);
  const parsed = parsePatientMessage('She is not taking aspirin and is allergic to penicillin.');
  assert.equal(parsed.updates.medications, undefined);
  assert.equal(parsed.updates.allergies, 'penicillin');
});

test('mixed genetic results are not collapsed to globally negative', () => {
  const text = 'BRCA1 negative, but TERT pathogenic variant detected';
  assert.equal(classifyGeneticResult(text), 'mixed');
  assert.match(geneticSnapshotRow(text)[0], /mixed positive and negative/i);
  assert.equal(classifyGeneticResult('No BRCA1 or BRCA2 pathogenic variants detected'), 'negative');
});

test('quota filler cannot invent pathway relevance', () => {
  assert.equal(REPURPOSE_TARGET_TOTAL, 0);
  assert.equal(needsBackfill(3), false);
  assert.equal(buildRegistryFillCandidate({ name: 'Example drug' }, {
    condition: 'Example disease',
    labelUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x'
  }), '');
});

test('PubMed XML preserves entities and detects retraction metadata', () => {
  const parsed = parsePubmedArticleXml(`
    <PubmedArticle>
      <AbstractText Label="BACKGROUND">A &amp; B <i>result</i>.</AbstractText>
      <PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList>
      <CommentsCorrections RefType="RetractionIn"><RefSource>Notice</RefSource></CommentsCorrections>
      <AffiliationInfo><Affiliation>Montréal, Canada</Affiliation></AffiliationInfo>
    </PubmedArticle>
  `);
  assert.equal(parsed.abstract, 'A & B result .');
  assert.equal(parsed.isRetracted, true);
  assert.equal(parsed.firstAuthorCountry, 'CA');
});

test('Europe PMC rejects retractions and non-article full-text payloads', () => {
  assert.equal(europePmcRecordIsRetracted({ pubTypeList: { pubType: ['Retracted Publication'] } }), true);
  assert.equal(isValidArticleXml('<html>Error</html>'), false);
  assert.equal(isValidArticleXml('<?xml version="1.0"?><article><body>Text</body></article>'), true);
  assert.equal(stripXml('<article><body>A &amp; B</body></article>'), 'A & B');
});
