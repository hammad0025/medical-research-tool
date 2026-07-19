import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { assessDetailedEligibility } from '../api/trials.js';
import {
  assessReportCompletion,
  sealReportCompletion,
  verifyReportCompletionSeal
} from '../lib/report-completion.js';
import {
  probeAnthropicModel,
  probePublicMedicalProviders
} from '../lib/demo-readiness.js';
import {
  finalizeReportText,
  polishReportForDisplay
} from '../lib/report-polish.js';
import { normalizeTrialCoverage, trialCoverageMessage } from '../lib/trial-coverage.js';
import { TERMS_VERSION } from '../lib/terms-consent.js';
import { loadProductionReportParsers } from '../scripts/test-helpers/production-report-parsers.mjs';

const [profiles, saved, appSource, smokeSource, runbook] = await Promise.all([
  readFile(new URL('../data/demo/golden-profiles.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../data/demo/saved-verified-report.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/app.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/demo-smoke.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../docs/DEMO_RUNBOOK.md', import.meta.url), 'utf8')
]);

const joined = (...parts) => parts.join(' ');
const INTERNAL_TERMS = new RegExp([
  `evidence[- ]${'pack'}`,
  `K-?${'8'}`,
  `diligence ${'packet'}`,
  `demo ${'rehearsal'}`,
  `challenge ${'suite'}`
].join('|'), 'i');
const assertNaturalLanguage = (value, surface) => {
  const visit = (entry, path) => {
    if (typeof entry === 'string') {
      assert.doesNotMatch(entry, INTERNAL_TERMS, `${surface}${path} leaks internal terminology`);
    } else if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (entry && typeof entry === 'object') {
      Object.entries(entry).forEach(([key, item]) => visit(item, `${path}.${key}`));
    }
  };
  visit(value, '');
};

const passingValidation = () => ({
  primary: {
    overallScore: 100,
    agreement: 'high',
    confirmed: [],
    disputed: [],
    unsupported: [],
    hallucinatedCitations: [],
    demographicMismatches: [],
    missingPerspectives: [],
    overall: 'Fixture validation passed.'
  }
});

const validCompletionInput = (profileKey = 'demo-profile') => ({
  profileKey,
  termsVersion: TERMS_VERSION,
  sections: {
    research: { text: saved.researchText, profileKey },
    repurpose: { text: saved.repurposeText, profileKey }
  },
  trials: { status: 'complete', profileKey },
  audits: {
    ...saved.audits,
    validation: {
      research: passingValidation(),
      repurpose: passingValidation()
    }
  }
});

test('all three reviewed profiles have physician-reviewable condition and safety contracts', () => {
  assert.deepEqual(
    profiles.profiles.map((profile) => profile.id),
    ['ipf-moderate', 'rp-ush2a', 't2d-ckd']
  );
  for (const profile of profiles.profiles) {
    assert.ok(profile.label && profile.patient.condition);
    assert.ok(profile.patient.age && profile.patient.gender);
    assert.ok(profile.patient.medications);
    assert.ok(profile.invariants.requiredTreatmentTerms.length >= 2);
    assert.ok(profile.invariants.forbiddenClaims.includes('cure'));
    assert.equal(profile.invariants.requireCitations, true);
    assert.equal(profile.invariants.requireTrialUrls, true);
    assert.equal(profile.invariants.requireExportSeal, true);
  }
  assert.match(profiles.profiles[0].patient.labWork, /FVC 68%|DLCO 48%/);
  assert.match(profiles.profiles[1].patient.geneticVariant, /USH2A/i);
  assert.match(profiles.profiles[2].patient.labWork, /eGFR 38/i);
});

test('reset, no-spend preflight, and saved-demo provenance are explicit', () => {
  assert.match(appSource, /title="Reset demo\/browser data"/);
  assert.match(appSource, /fetch\('\/api\/terms-consent', \{ method: 'DELETE' \}\)/);
  assert.match(appSource, /fetch\('\/api\/access-session', \{ method: 'DELETE' \}\)/);
  assert.match(appSource, /Load saved demo \(not live\)/);
  assert.equal(saved.label, 'Saved demo — not live');
  assert.match(saved.researchText, /^# Saved demo — not live/);
  assert.match(saved.reviewedGitSha, /^[a-f0-9]{40}$/);
  assert.match(smokeSource, /Without both switches|allowPaidProductionRun|preflightOnly/);
  assert.match(runbook, /does not generate a report|no network, credentials, or paid model calls/i);
});

test('local demo smoke accepts the patient-visible saved-demo label', () => {
  const result = spawnSync(process.execPath, ['scripts/demo-smoke.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      ALLOW_PAID_CALLS: '0',
      MRT_DEMO_ALLOW_PAID: '0',
      MRT_DEMO_PRODUCTION: '0'
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /deterministic local\/mock mode/i);
});

test('saved API payload, labels, report copy, and export inputs use natural language', () => {
  assertNaturalLanguage(saved, 'saved-report API response');
  const contract = assessReportCompletion(validCompletionInput(), { termsAccepted: true });
  assertNaturalLanguage(contract, 'completion API response');
  assertNaturalLanguage({
    report: polishReportForDisplay(saved.researchText),
    repurpose: polishReportForDisplay(saved.repurposeText),
    exportHeader: `${contract.label}\n${contract.coverageMessages.join(' ')}`
  }, 'saved report and export');
});

test('static website labels exercised by the demo use natural language', () => {
  const exercisedLabels = [
    'Load saved demo (not live)',
    'Reset demo/browser data',
    'Sources & exports',
    'FDA-approved treatments for this condition',
    'Questions to ask your doctor',
    'Incomplete trial coverage:',
    'Open on ClinicalTrials.gov ↗',
    'Retry report (skip search)'
  ];
  for (const label of exercisedLabels) {
    assert.ok(appSource.includes(label), `missing website label: ${label}`);
  }
  assertNaturalLanguage(exercisedLabels, 'website UI string');
});

test('saved-demo sources are openable, allowlisted, and isolated from opener control', () => {
  const allowed = new Set([
    ...saved['evidence' + 'Pack'].map((item) => item.pubmedUrl || item.url),
    ...saved.trials.studies.map((study) => study.url)
  ]);
  const authored = [
    ...saved.researchText.matchAll(/\[[^\]]+\]\((https:\/\/[^)]+)\)/g),
    ...saved.repurposeText.matchAll(/\[[^\]]+\]\((https:\/\/[^)]+)\)/g)
  ].map((match) => match[1]);
  assert.ok(authored.length >= 5);
  assert.ok(authored.every((url) => allowed.has(url)));
  assert.equal(saved.trials.studies.length, 0);
  assert.match(saved.trials.note, /does not claim a specific supported trial record/i);
  assert.doesNotMatch(JSON.stringify(saved), /clinicaltrials\.gov\/search/i);
  assert.ok(saved.trials.studies.every((study) =>
    /^https:\/\/clinicaltrials\.gov\//.test(study.url)
  ));
  assert.match(appSource, /target="_blank" rel="noopener noreferrer"/);
  assert.match(appSource, /Open on ClinicalTrials\.gov ↗/);
});

test('complete, degraded, and blocked labels fail closed', () => {
  const full = assessReportCompletion(validCompletionInput(), { termsAccepted: true });
  assert.equal(full.label, 'Complete report');

  const degradedInput = validCompletionInput();
  degradedInput.trials.status = 'degraded';
  const degraded = assessReportCompletion(degradedInput, { termsAccepted: true });
  assert.equal(degraded.eligible, true);
  assert.equal(degraded.label, 'Report with partial source coverage');
  assert.deepEqual(degraded.degraded, ['trials:degraded']);

  const blockedInput = validCompletionInput();
  blockedInput.sections.repurpose.text = '';
  const blocked = assessReportCompletion(blockedInput, { termsAccepted: true });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.label, 'Report not ready to export');
});

test('approved treatment and repurpose content stay in distinct parsers and UI lanes', () => {
  const { parseTreatments, parseCandidates } = loadProductionReportParsers();
  const treatments = parseTreatments(saved.researchText);
  const candidates = parseCandidates(saved.repurposeText);
  assert.equal(treatments.map((item) => item.treatment).join('|'), 'Pirfenidone|Nintedanib');
  assert.equal(candidates.map((item) => item.candidate).join('|'), 'Pulmonary rehabilitation');
  assert.ok(treatments.every((item) => !item.candidate));
  assert.ok(candidates.every((item) => !item.treatment));
  assert.match(appSource, /FDA-approved treatments for this condition/);
  assert.match(appSource, /Researched, Not Yet FDA-Approved/);
  assert.match(appSource, /Already-approved treatments appear only under Approved Treatments/);
});

test('missing trial facts remain unknown and provider degradation stays visible', () => {
  const assessment = assessDetailedEligibility({
    eligibilityCriteria: 'Inclusion Criteria:\n- FVC >= 50% predicted\n- Pathogenic USH2A variant required\n\nExclusion Criteria:'
  }, {});
  assert.equal(assessment.status, 'unknown');
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.unknown.length >= 2);

  const trials = {
    studies: [{ nctId: 'NCT00000000' }],
    providerErrors: [{ provider: 'ClinicalTrials.gov', query: 'IPF', reason: 'timeout' }]
  };
  assert.equal(normalizeTrialCoverage(trials).degraded, true);
  assert.match(trialCoverageMessage(trials), /coverage is incomplete/i);
  assert.match(appSource, /Incomplete trial coverage:/);
});

test('safety context and what-to-ask-doctor content survive the saved path', () => {
  assert.match(saved.researchText, /Safety concern: Moderate/);
  assert.match(saved.researchText, /liver|bleeding|photosensitivity/i);
  assert.match(saved.researchText, /Medication interactions:/);
  assert.match(saved.repurposeText, /Risks for this patient:/);
  assert.match(saved.repurposeText, /Questions for your doctor:/);
  assert.match(appSource, /Questions to ask your doctor/);
  assert.match(appSource, /Medication interactions/);
});

test('all export paths require a valid server completion seal', () => {
  process.env.NODE_ENV = 'test';
  const contract = assessReportCompletion(validCompletionInput(), { termsAccepted: true });
  const now = Date.parse(saved.generatedAt);
  const seal = sealReportCompletion(contract, {
    now,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA'
  });
  assert.equal(verifyReportCompletionSeal({ contract, seal, now }).ok, true);
  for (const label of ['Export Word', 'Export Text', 'Save as PDF', 'This report is not ready to export']) {
    assert.ok(appSource.includes(label), `missing export control: ${label}`);
  }
  assert.match(appSource, /getCompletionContract/);
});

test('skeptical follow-ups challenge ranking, omissions, interactions, and urgent harms', () => {
  for (const challenge of [
    /Why did you rank the top treatment #1 over the others/,
    /Check every treatment you recommended against my current medications/,
    /What side effects should make me call my doctor right away/,
    /Prepare a doctor-discussion question/,
    /what questions I should bring to my appointment/
  ]) {
    assert.match(appSource, challenge);
  }
});

test('provider failures are deterministic, no-spend, and route to recovery', async () => {
  let modelCalls = 0;
  const model = await probeAnthropicModel({
    apiKey: 'mock-key',
    model: 'mock-model',
    fetchImpl: async () => {
      modelCalls += 1;
      return { ok: false, status: 503 };
    }
  });
  assert.deepEqual(model, { ok: false, state: 'http-503', model: 'mock-model' });
  assert.equal(modelCalls, 1);

  let publicCalls = 0;
  const providers = await probePublicMedicalProviders({
    fetchImpl: async () => {
      publicCalls += 1;
      throw new Error('mock provider outage');
    }
  });
  assert.equal(publicCalls, 5);
  assert.equal(providers.ok, false);
  assert.ok(Object.values(providers.providers).every((provider) => provider.state === 'unreachable'));
  assert.match(appSource, /Retry report \(skip search\)/);
  assert.match(appSource, /Loaded the clearly labeled saved demo\. No live research call was made\./);
  assert.match(runbook, /Provider, model, Upstash, seal, Terms, access, or SHA failure/);
});

test('generated answer, API, report, and export sanitizers reject every internal term', () => {
  const adversarial = [
    `The ${joined('evidence', 'pack')} supports this claim.`,
    `${'K' + '8'} and ${'K-' + '8'} both passed.`,
    `Include this in the ${joined('diligence', 'packet')}.`,
    `The ${joined('demo', 'rehearsal')} passed.`,
    `The ${joined('challenge', 'suite')} found no issue.`
  ].join('\n');
  assertNaturalLanguage(
    finalizeReportText(adversarial, { evidence: {}, trials: null }),
    'generated API report'
  );
  assertNaturalLanguage(polishReportForDisplay(adversarial), 'server report and export');
  const clientPolisherSource = appSource.slice(
    appSource.indexOf('const polishReportForDisplay ='),
    appSource.indexOf('// Keep a "## 3. Approved Treatments"')
  );
  const clientPolisher = Function(`${clientPolisherSource}; return polishReportForDisplay;`)();
  assertNaturalLanguage(clientPolisher(adversarial), 'website report and export');
});

test('UI demo presets exactly expose all three reviewed profiles', () => {
  const sampleBlock = appSource.slice(
    appSource.indexOf('const SAMPLE_PATIENTS ='),
    appSource.indexOf('const PROFILE_DESCRIBE_EXAMPLES')
  );
  const objectSource = sampleBlock
    .slice(sampleBlock.indexOf('=') + 1, sampleBlock.lastIndexOf(';'))
    .trim();
  const samples = Function(`"use strict"; return (${objectSource});`)();
  assert.deepEqual(samples.ipf.data, profiles.profiles[0].patient);
  assert.deepEqual(samples.rpUsher.data, profiles.profiles[1].patient);
  assert.deepEqual(samples.t2dCkd.data, profiles.profiles[2].patient);
});

test('trial table renders eligibility status, missing facts, and a personal-eligibility warning', () => {
  const tableBlock = appSource.slice(
    appSource.indexOf('const TrialsTable ='),
    appSource.indexOf('const CandidateCard =')
  );
  assert.match(tableBlock, /eligibilityAssessment/);
  assert.match(tableBlock, /Unknown or missing facts:/);
  assert.match(tableBlock, /does not mean you are personally eligible/);
});

test('saved fallback never labels its trial content as live', () => {
  const researchBlock = appSource.slice(
    appSource.indexOf('const ResearchTab ='),
    appSource.indexOf('const trialPromiseBreakdown =')
  );
  assert.doesNotMatch(researchBlock, />\s*Live clinical trials/);
  assert.match(researchBlock, /savedDemo.*Saved demo — not live/s);
  assert.doesNotMatch(appSource, /<h[23][^>]*>\s*Live Clinical Trials/i);
  assert.match(appSource, /trialsData\?\.savedDemo[\s\S]*Saved demo — not live trial list/);
});
