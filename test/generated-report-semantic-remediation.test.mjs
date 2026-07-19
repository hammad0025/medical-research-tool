import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applyPatientPromiseAdjustment,
  assessTrialEligibility
} from '../api/trials.js';
import {
  formatSafetyLine,
  scoreSafety
} from '../lib/safety-score.js';
import { polishReportForDisplay } from '../lib/report-polish.js';
import { countryAdjustment } from '../lib/evidence.js';
import { loadProductionReportParsers } from '../scripts/test-helpers/production-report-parsers.mjs';

const [appSource, researchSource] = await Promise.all([
  readFile(new URL('../src/app.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../api/research.js', import.meta.url), 'utf8')
]);

test('unknown eligibility facts do not lower ordering or become stopped evidence', () => {
  const study = {
    status: 'RECRUITING',
    eligibilityCriteria: 'Inclusion Criteria:\n- FVC >= 50% predicted\n\nExclusion Criteria:'
  };
  const eligibility = assessTrialEligibility(study, { patient: {} });
  assert.equal(eligibility.status, 'unknown');
  assert.equal(eligibility.penalty, 0);

  const adjusted = applyPatientPromiseAdjustment(40, study, { patient: {} });
  assert.equal(adjusted.score, 40);
  assert.equal(adjusted.stoppedNegative, false);
  assert.equal(adjusted.caution, null);
  assert.match(adjusted.eligibilityCaution, /not provided/i);
});

test('generic caution never maps to stopped or negative study state', () => {
  const adjusted = applyPatientPromiseAdjustment(25, {
    status: 'RECRUITING',
    briefTitle: 'Study of adverse event monitoring',
    eligibilityCriteria: ''
  });
  assert.equal(adjusted.stoppedNegative, false);
  assert.equal(adjusted.caution, null);
  assert.match(appSource, /s\.stoppedNegative && s\.caution/);
});

test('country, nationality, region, and hospital reputation do not affect quality ordering', () => {
  for (const country of ['US', 'CN', 'IN', 'MX', 'VN']) {
    assert.equal(countryAdjustment({ firstAuthorCountry: country }), 0);
  }
  assert.doesNotMatch(
    researchSource.slice(researchSource.indexOf('studies.forEach((s) => {'), researchSource.indexOf('// Demographic HARD-GATE')),
    /WESTERN|CHINA_LIKE|westernHit|chinaHit|topCenterScore/
  );
});

test('patient UI exposes ordering attributes, not a numeric promise or benefit score', () => {
  const trialUi = appSource.slice(
    appSource.indexOf('const trialOrderingBreakdown ='),
    appSource.indexOf('const RankedTrialsForPatient =')
  );
  assert.match(trialUi, /do not predict treatment benefit or personal eligibility/);
  assert.doesNotMatch(trialUi, /\/100|promise score|strongest evidence that the drug works/i);
  assert.match(trialUi, /Later-stage study|Mid-stage study|Early-stage study/);
});

test('safety concern direction is explicit and spontaneous reports do not grade it', () => {
  const label = {
    url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=semantic',
    genericName: ['Exampledrug'],
    warnings: 'No warnings identified.',
    contraindications: 'None known.',
    drugInteractions: 'No known interactions.'
  };
  const context = {
    allergies: 'No known drug allergies',
    pregnancyStatus: 'not pregnant',
    renalFunction: 'normal',
    hepaticFunction: 'normal',
    medicationHistory: 'No prior treatment',
    labWork: 'Relevant labs reviewed'
  };
  const low = scoreSafety({
    drugName: 'Exampledrug',
    patientContext: context,
    fdaLabel: label,
    faers: [{ reaction: 'cardiac arrest', reports: 999999 }]
  });
  assert.equal(low.band, 'Low');
  assert.match(low.factors.at(-1).text, /not incidence rates.*do not prove causation/i);

  const high = scoreSafety({
    drugName: 'Exampledrug',
    patientContext: context,
    fdaLabel: { ...label, boxedWarning: 'Serious liver injury.' }
  });
  assert.equal(high.band, 'High');
  assert.match(formatSafetyLine(high), /^SAFETY: Safety concern: High/);
});

test('uncertain research status, supportive care, and exact-combination evidence use separate lanes', () => {
  const {
    parseCombos,
    resolveItemKind,
    resolveRepurposeSection,
    partitionCandidates
  } = loadProductionReportParsers();

  assert.equal(resolveRepurposeSection({}), 'study-status-unclear');
  assert.equal(resolveItemKind({ candidate: 'Pulmonary rehabilitation' }), 'SUPPORTIVE_CARE');
  assert.equal(partitionCandidates([{ candidate: 'Unknown item' }]).evidenceStatusUnknown.length, 1);

  const speculative = parseCombos([
    'COMBO: A + B',
    'SUPPORTING_EVIDENCE: Mechanistic hypothesis only — no human combo data yet',
    'REFERENCES: [A paper](https://example.org/a)',
    'PATIENT_SPECIFIC_RISKS: No interaction was identified in the reviewed information.'
  ].join('\n'));
  assert.equal(speculative.length, 0);

  const studied = parseCombos([
    'COMBO: A + B',
    'SUPPORTING_EVIDENCE: A randomized trial studied the exact A + B combination. [Trial](https://example.org/trial)',
    'REFERENCES: [Trial](https://example.org/trial)',
    'PATIENT_SPECIFIC_RISKS: A pharmacist should review the complete list.'
  ].join('\n'));
  assert.equal(studied.length, 1);
});

test('patient language sanitizer removes dangerous certainty and raw enums', () => {
  const polished = polishReportForDisplay([
    'INTERACTIONS: None identified',
    'There is no research on this specific drug for Example disease.',
    'However, our research suggests it may help, and here is why.',
    'STATUS: ACTIVE_NOT_RECRUITING',
    'PHASE: PHASE3'
  ].join('\n'));
  assert.match(polished, /No interaction was identified.*pharmacist or clinician/i);
  assert.match(polished, /No condition-specific study identified in this search/i);
  assert.match(polished, /does not imply benefit/i);
  assert.doesNotMatch(polished, /None identified|never researched|may help|ACTIVE_NOT_RECRUITING|PHASE3/);
});

test('prompts prohibit combination quotas, failed-agent revival, and geographic penalties', () => {
  const comboPrompt = researchSource.slice(
    researchSource.indexOf('const REPURPOSE_COMBO_AND_SUMMARY ='),
    researchSource.indexOf('const REPURPOSE_PROMPT_FRONT_STATIC =')
  );
  assert.match(comboPrompt, /ONLY when a cited condition-specific source studied that exact combination/);
  assert.match(comboPrompt, /Speculative rationale cannot revive a failed agent/);
  assert.doesNotMatch(comboPrompt, /Produce \*\*3-4\*\*|One 3-drug combo|Mechanistic hypothesis only/);
  assert.match(researchSource, /Country, nationality, region, hospital reputation/);
});
