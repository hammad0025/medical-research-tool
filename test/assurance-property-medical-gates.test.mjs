import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvidenceUrlIndex,
  buildGroundingIndex,
  citationRelevantToCondition,
  citationRelevantToSubject,
  isClaimGrounded,
  sourceMentionsCondition
} from '../lib/grounding-gate.js';
import {
  canonicalizeCitationUrl,
  demoteBannedClaimCitations,
  demoteUnverifiedDocumentCitations,
  isBannedClaimCitation
} from '../lib/citation-gate.js';
import {
  blobMentionsForeignDisease,
  conditionCiteAllowed,
  filterEvidencePackByCondition,
  stripForeignDiseaseContamination
} from '../lib/disease-contamination.js';
import {
  textOppositeSexOnly,
  textWrongAgeBand
} from '../lib/demographic-gate.js';

const seeded = (seed = 0xc17e) => () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 0x100000000;
};

test('grounding kills seeded value, unit, period, and comparator mutations', () => {
  const random = seeded();
  const units = ['mg/day', 'mcg/week', 'mL/year', 'units/month'];
  for (let i = 0; i < 60; i += 1) {
    const value = 10 + Math.floor(random() * 900);
    const unit = units[Math.floor(random() * units.length)];
    const fact = `Nintedanib reduced pulmonary decline by ${value} ${unit} compared with placebo.`;
    const index = buildGroundingIndex({ canonicalFacts: [fact] });
    assert.equal(isClaimGrounded(fact, index), true);

    const mutations = [
      fact.replace(String(value), String(value + 1)),
      fact.replace(unit, unit === 'mg/day' ? 'mg/week' : 'mg/day'),
      fact.replace('placebo', 'active control')
    ];
    for (const mutation of mutations) {
      assert.equal(isClaimGrounded(mutation, index), false, `accepted mutation: ${mutation}`);
    }
  }
});

test('grounding rejects intervention swaps even when the numeric outcome matches', () => {
  const fact = 'Nintedanib reduced pulmonary decline by 800 mg/day compared with placebo.';
  const index = buildGroundingIndex({ canonicalFacts: [fact] });
  for (const swapped of [
    'Metformin reduced pulmonary decline by 800 mg/day compared with placebo.',
    'Pirfenidone reduced pulmonary decline by 800 mg/day compared with placebo.',
    'Treatment with metformin reduced pulmonary decline by 800 mg/day compared with placebo.',
    'Participants receiving metformin reduced pulmonary decline by 800 mg/day compared with placebo.'
  ]) {
    assert.equal(isClaimGrounded(swapped, index), false, `accepted entity swap: ${swapped}`);
  }
});

test('grounding keeps same-intervention paraphrases and non-treatment disease statistics', () => {
  const treatment = buildGroundingIndex({
    canonicalFacts: ['Participants receiving nintedanib had decline reduced by 120 mL/year.']
  });
  assert.equal(
    isClaimGrounded('Nintedanib slowed decline by 120 mL/year.', treatment),
    true
  );
  assert.equal(
    isClaimGrounded('Treatment slowed decline by 120 mL/year.', treatment),
    true,
    'a generic treatment paraphrase must not invent a conflicting intervention'
  );

  const diseaseStatistic = buildGroundingIndex({
    canonicalFacts: ['About 87% of patients with IPF have abnormal acid reflux (GERD).']
  });
  assert.equal(
    isClaimGrounded('GERD and acid reflux occur in approximately 87% of IPF patients.', diseaseStatistic),
    true
  );
});

test('quantitative grounding requires facts to co-occur in one source item', () => {
  const split = buildGroundingIndex({
    canonicalFacts: [
      'Nintedanib is an antifibrotic treatment.',
      'Unrelated spirometry changed by 120 mL/year.'
    ]
  });
  assert.equal(isClaimGrounded('Nintedanib reduced decline by 120 mL/year.', split), false);

  const together = buildGroundingIndex({
    canonicalFacts: ['Nintedanib reduced decline by 120 mL/year.']
  });
  assert.equal(isClaimGrounded('Nintedanib slowed decline by 120 mL/year.', together), true);
});

test('citation relevance is exact, tri-state, and fail-closed for unknown papers', () => {
  const evidence = {
    groundedForPrompt: [{
      title: 'Nintedanib in idiopathic pulmonary fibrosis',
      summary: 'Nintedanib treatment was studied in idiopathic pulmonary fibrosis.',
      pmid: '12345678'
    }]
  };
  const index = buildEvidenceUrlIndex(evidence);
  const known = 'https://pubmed.ncbi.nlm.nih.gov/12345678/';
  assert.equal(citationRelevantToSubject(known, 'Nintedanib', index), true);
  assert.equal(citationRelevantToSubject(known, 'Metformin', index), false);
  assert.equal(citationRelevantToCondition(known, 'idiopathic pulmonary fibrosis', index), true);
  assert.equal(citationRelevantToCondition(known, 'cystic fibrosis', index), false);
  assert.equal(citationRelevantToSubject('https://pubmed.ncbi.nlm.nih.gov/87654321/', 'Nintedanib', index), false);
  assert.equal(citationRelevantToSubject('https://clinicaltrials.gov/study/NCT12345678', 'Nintedanib', index), null);
});

test('citation canonicalization is idempotent without path-case or balanced-parenthesis loss', () => {
  const random = seeded(0xabad1dea);
  for (let i = 0; i < 50; i += 1) {
    const suffix = Math.floor(random() * 1e8);
    const raw = ` HTTPS://EXAMPLE.COM/Article/Drug_${suffix}_(Medicine). `;
    const canonical = canonicalizeCitationUrl(raw);
    assert.equal(canonicalizeCitationUrl(canonical), canonical);
    assert.match(canonical, new RegExp(`/Article/Drug_${suffix}_\\(Medicine\\)$`));
  }
  assert.equal(canonicalizeCitationUrl('javascript:alert(1)'), '');
  assert.equal(canonicalizeCitationUrl('https://example.com/a#invented-fragment'), 'https://example.com/a');
});

test('search placeholders and unverifiable papers are demoted but registry records survive', () => {
  const banned = [
    'https://google.com/search?q=trial',
    'https://pubmed.ncbi.nlm.nih.gov/?term=drug',
    'https://clinicaltrials.gov/search?cond=IPF',
    'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=drug'
  ];
  for (const url of banned) {
    assert.equal(isBannedClaimCitation(url), true);
    const output = demoteBannedClaimCitations(`[label](${url})`);
    assert.equal(output, 'label');
  }
  assert.equal(
    demoteUnverifiedDocumentCitations(
      '[paper](https://pubmed.ncbi.nlm.nih.gov/12345678/) [trial](https://clinicaltrials.gov/study/NCT12345678)'
    ),
    'paper [trial](https://clinicaltrials.gov/study/NCT12345678)'
  );
});

test('foreign disease filtering is self-exempt and monotonic across report surfaces', () => {
  const fixtures = [
    ['idiopathic pulmonary fibrosis', 'Parkinson disease'],
    ['Parkinson disease', 'Sickle cell disease'],
    ['type 1 diabetes', 'Alzheimer disease']
  ];
  for (const [patientCondition, foreign] of fixtures) {
    assert.equal(blobMentionsForeignDisease(foreign, patientCondition), true);
    assert.equal(blobMentionsForeignDisease(patientCondition, patientCondition), false);
    const input = `Safe sentence about ${patientCondition}.\n| Trial | ${foreign} |\nA study in ${foreign} was positive.`;
    const result = stripForeignDiseaseContamination(input, patientCondition);
    assert.match(result.text, new RegExp(patientCondition, 'i'));
    assert.doesNotMatch(result.text, new RegExp(foreign, 'i'));
    assert.equal(result.stripped.length, 2);
    assert.deepEqual(stripForeignDiseaseContamination(result.text, patientCondition).stripped, []);
  }
});

test('evidence provenance and document uncertainty fail closed', () => {
  const records = [
    { title: 'Matching curated', isCuratedKB: true, kbCondition: 'Parkinson disease' },
    { title: 'Missing provenance', isCuratedKB: true },
    { title: '', url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/' },
    { title: '', url: 'https://clinicaltrials.gov/study/NCT12345678' }
  ];
  assert.deepEqual(
    filterEvidencePackByCondition(records, 'Parkinson disease').map((record) => record.title),
    ['Matching curated', '']
  );
  assert.equal(conditionCiteAllowed(null, 'https://pubmed.ncbi.nlm.nih.gov/12345678/'), false);
  assert.equal(conditionCiteAllowed(null, 'https://clinicaltrials.gov/study/NCT12345678'), true);
  assert.equal(sourceMentionsCondition('Parkinsonism review', 'Parkinson disease'), false);
});

test('trial demographic gates hold exact age-18 and mixed-sex boundaries', () => {
  assert.equal(textWrongAgeBand('A pediatric-only trial is recruiting.', 17.999), false);
  assert.equal(textWrongAgeBand('A pediatric-only trial is recruiting.', 18), true);
  assert.equal(textWrongAgeBand('An adults-only trial is recruiting.', 17.999), true);
  assert.equal(textWrongAgeBand('An adults-only trial is recruiting.', 18), false);
  assert.equal(textWrongAgeBand('Ages 12 through 65 may enroll.', 70), false, 'gate only explicit bands');

  for (const sex of ['male', 'Male', 'MAN']) {
    assert.equal(textOppositeSexOnly('Women-only randomized trial', sex), true);
    assert.equal(textOppositeSexOnly('Men and women randomized trial', sex), false);
  }
  assert.equal(textOppositeSexOnly('Men-only randomized trial', 'female'), true);
  assert.equal(textOppositeSexOnly('Men-only randomized trial', 'nonbinary'), false);
});
