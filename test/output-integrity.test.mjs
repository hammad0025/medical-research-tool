import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroundingIndex,
  isClaimGrounded,
  sourceMentionsCondition
} from '../lib/grounding-gate.js';
import {
  filterEvidencePackByCondition,
  stripForeignDiseaseContamination
} from '../lib/disease-contamination.js';
import {
  canonicalizeCitationUrl,
  rewriteMarkdownLinks
} from '../lib/citation-gate.js';
import {
  attachMissingClaimCitations,
  enforceConditionCitationRelevance,
  resolveInlineReferenceMarkers,
  sanitizeMarkdownLinks
} from '../lib/report-polish.js';
import { buildPromptPackBreakdown, dedupeArticles } from '../lib/evidence.js';

test('condition relevance requires the exact canonical condition, not a generic token', () => {
  assert.equal(
    sourceMentionsCondition('A review of Alzheimer disease progression.', 'Parkinson disease'),
    false
  );
  assert.equal(
    sourceMentionsCondition('A review of Parkinson disease progression.', 'Parkinson disease'),
    true
  );
  const filtered = filterEvidencePackByCondition([
    { title: 'IPF treatment trial', abstract: 'Adults with IPF were enrolled.' },
    { title: 'Other fibrosis trial', abstract: 'Adults with cystic fibrosis were enrolled.' }
  ], ['idiopathic pulmonary fibrosis', 'IPF']);
  assert.deepEqual(filtered.map((item) => item.title), ['IPF treatment trial']);
});

test('source breakdown is recomputed from the contamination-filtered pack', () => {
  const filtered = filterEvidencePackByCondition([
    {
      title: 'IPF curated evidence',
      abstract: 'Adults with idiopathic pulmonary fibrosis were enrolled.',
      isCuratedKB: true,
      kbCondition: 'Idiopathic pulmonary fibrosis'
    },
    {
      title: 'IPF live evidence',
      abstract: 'Adults with idiopathic pulmonary fibrosis were enrolled.',
      isCuratedKB: false
    },
    {
      title: 'Foreign live evidence',
      abstract: 'Adults with sickle cell disease were enrolled.',
      isCuratedKB: false
    }
  ], 'Idiopathic pulmonary fibrosis');
  const breakdown = buildPromptPackBreakdown(filtered);
  assert.deepEqual(breakdown, { total: 2, curatedKB: 1, liveFetched: 1 });
  assert.equal(breakdown.curatedKB + breakdown.liveFetched, breakdown.total);
});

test('curated evidence requires matching condition provenance', () => {
  const filtered = filterEvidencePackByCondition([
    {
      title: 'Disease-specific landmark',
      summary: 'A treatment result without the condition in the title.',
      isCuratedKB: true,
      kbCondition: 'Idiopathic pulmonary fibrosis'
    },
    {
      title: 'Wrong curated landmark',
      summary: 'A result imported from another knowledge base.',
      isCuratedKB: true,
      kbCondition: 'Chronic kidney disease'
    },
    {
      title: 'Missing provenance',
      isCuratedKB: true
    }
  ], ['idiopathic pulmonary fibrosis', 'IPF']);

  assert.deepEqual(filtered.map((item) => item.title), ['Disease-specific landmark']);
});

test('foreign-disease rows are removed from markdown tables and structured output', () => {
  const input = [
    '| Trial | Condition |',
    '|---|---|',
    '| SAFE-IPF | Idiopathic pulmonary fibrosis |',
    '| OTHER | Sickle cell disease |',
    'SUMMARY: Parkinson disease results should not appear.'
  ].join('\n');
  const result = stripForeignDiseaseContamination(input, 'idiopathic pulmonary fibrosis');
  assert.match(result.text, /SAFE-IPF/);
  assert.doesNotMatch(result.text, /Sickle cell|Parkinson/i);
  assert.equal(result.stripped.length, 2);
});

test('grounding preserves decimal and unit identity', () => {
  const index = buildGroundingIndex({
    canonicalFacts: ['Treatment slowed decline by 12.5 mL/year.']
  });
  assert.equal(isClaimGrounded('Treatment slowed decline by 12.5 mL/year.', index), true);
  assert.equal(isClaimGrounded('Treatment slowed decline by 12.5 mg/year.', index), false);
  assert.equal(isClaimGrounded('Treatment slowed decline by 12.8 mL/year.', index), false);
});

test('URL canonicalization preserves path case and balanced parentheses', () => {
  const url = 'HTTPS://EXAMPLE.COM/Article/Drug_(Medicine).';
  assert.equal(
    canonicalizeCitationUrl(url),
    'https://example.com/Article/Drug_(Medicine)'
  );
  const markdown = `[paper](${url.slice(0, -1)})`;
  assert.equal(
    rewriteMarkdownLinks(markdown, (_m, label, href) => `${label}:${href}`),
    `paper:${url.slice(0, -1)}`
  );
});

test('citation allowlist uses exact canonical URLs without prefix overmatching', () => {
  const allowed = new Set(['https://example.com/Article/CaseSensitive']);
  const input = [
    '[exact](https://example.com/Article/CaseSensitive)',
    '[child](https://example.com/Article/CaseSensitive/foreign)',
    '[wrong-case](https://example.com/article/CaseSensitive)'
  ].join(' ');
  const output = sanitizeMarkdownLinks(input, allowed);
  assert.match(output, /\[exact\]\(https:\/\/example\.com\/Article\/CaseSensitive\)/);
  assert.doesNotMatch(output, /\[child\]\(/);
  assert.doesNotMatch(output, /\[wrong-case\]\(/);
});

test('document citations fail closed when evidence text is unavailable', () => {
  const input = 'Claim ([source ↗](https://pubmed.ncbi.nlm.nih.gov/12345678/)).';
  const result = enforceConditionCitationRelevance(input, {}, { condition: 'Parkinson disease' });
  assert.doesNotMatch(result.text, /https?:\/\//);
});

test('hard claims fail closed when the evidence pack is empty', () => {
  const result = attachMissingClaimCitations(
    'Treatment reduced mortality by 48% in 500 patients.',
    {}
  );
  assert.equal(result.text, '');
  assert.equal(result.stripped, 1);
});

test('structured card and table claims receive adjacent title-labeled citations', () => {
  const evidence = {
    groundedForPrompt: [{
      title: 'Mortality Reduction Randomized Trial',
      summary: 'Treatment reduced mortality by 48% in 500 patients.',
      url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
    }]
  };
  const input = [
    'CANDIDATE: Example treatment',
    'EFFICACY_HYPOTHESIS: Treatment reduced mortality by 48% in 500 patients.',
    '| Treatment | Result |',
    '|---|---|',
    '| Example treatment | Reduced mortality by 48% in 500 patients. |'
  ].join('\n');
  const result = attachMissingClaimCitations(input, evidence);
  assert.equal(result.attached, 2);
  assert.match(result.text, /EFFICACY_HYPOTHESIS:.*\[Mortality Reduction Randomized Trial ↗\]/);
  assert.match(result.text, /\| Example treatment \| Reduced mortality.*\[Mortality Reduction Randomized Trial ↗\].*\|/);
});

test('numeric reference markers use the source title as their link label', () => {
  const output = resolveInlineReferenceMarkers('A measured claim [#1].', {
    groundedForPrompt: [{
      title: 'Named Clinical Study',
      url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
    }]
  });
  assert.match(output, /\[Named Clinical Study ↗\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345678\/?\)/);
  assert.doesNotMatch(output, /\[source ↗\]/i);
});

test('already-formatted generic source links use the matching source title', () => {
  const output = resolveInlineReferenceMarkers(
    'A measured claim ([source ↗](https://pubmed.ncbi.nlm.nih.gov/12345678/)).',
    {
      groundedForPrompt: [{
        title: 'Named Clinical Study',
        url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
      }]
    }
  );
  assert.match(output, /\[Named Clinical Study ↗\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345678\/\)/);
  assert.doesNotMatch(output, /\[(?:source|citation|reference|link)\s*↗?\]/i);
});

test('generic links without matching metadata use the source hostname', () => {
  const output = resolveInlineReferenceMarkers(
    'Background ([SOURCE](https://www.fda.gov/example)).',
    {}
  );
  assert.match(output, /\[fda\.gov ↗\]\(https:\/\/www\.fda\.gov\/example\)/);
  assert.doesNotMatch(output, /\[source\]/i);
});

test('identifier-less evidence records do not collapse into one row', () => {
  const rows = dedupeArticles([
    { source: 'OpenAlex', title: 'First distinct paper' },
    { source: 'OpenAlex', title: 'Second distinct paper' },
    { source: 'EuropePMC', title: 'First distinct paper' }
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.title === 'First distinct paper').sources, ['OpenAlex', 'EuropePMC']);
});
