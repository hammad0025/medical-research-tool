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
  enforceConditionCitationRelevance,
  sanitizeMarkdownLinks
} from '../lib/report-polish.js';
import { dedupeArticles } from '../lib/evidence.js';

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

test('identifier-less evidence records do not collapse into one row', () => {
  const rows = dedupeArticles([
    { source: 'OpenAlex', title: 'First distinct paper' },
    { source: 'OpenAlex', title: 'Second distinct paper' },
    { source: 'EuropePMC', title: 'First distinct paper' }
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.title === 'First distinct paper').sources, ['OpenAlex', 'EuropePMC']);
});
