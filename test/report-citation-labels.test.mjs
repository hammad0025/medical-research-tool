// Regression tests for citation labels and card identity on the finished page.
//
// Every fixture below is text this product actually rendered for a Retinitis
// Pigmentosa report. These defects shipped together because each was checked
// at the layer it touched: the label truncator looked fine in isolation, the
// seed renderer looked fine in isolation, and the dedup key looked fine in
// isolation. They only misbehave in composition.

import test from 'node:test';
import assert from 'node:assert/strict';

import { citationAnchorLabel } from '../lib/report-polish.js';
import { renderResearchedCandidateBlocks } from '../lib/researched-agent-seeds.js';
import { clampToWord } from '../lib/researched-agent-search.js';
import { agentDedupKeys, declaresNotApproved } from '../lib/card-identity.js';

const LONG_TITLE =
  'Preclinical biodistribution and toxicology assessment of an AAV5-based ' +
  'subretinal modifier gene therapy for inherited retinal disease';
const URL = 'https://pubmed.ncbi.nlm.nih.gov/33333333';

test('a truncated citation label survives NFKC without becoming sentence punctuation', () => {
  // Shipped as "…subretinal modifier ge…". sanitizePublicText NFKC-normalizes
  // "…" into three ASCII periods, so the claim-sentence splitter then cut the
  // markdown link in half, failed to find a URL in the first half, and
  // re-cited it — rendering the title twice with unbalanced parentheses.
  const label = citationAnchorLabel({ title: LONG_TITLE }, URL);

  assert.ok(!/…/.test(label), `no ellipsis may appear in a link label: ${label}`);
  assert.ok(
    !/\./.test(label.normalize('NFKC')),
    'NFKC must not turn the label into something the sentence splitter can cut'
  );
  assert.equal(label, label.normalize('NFKC'), 'the label must be NFKC-stable');
  // Cutting mid-word is what made "modifier ge" read as a scraping bug.
  assert.ok(LONG_TITLE.startsWith(label), 'the label must be a prefix of the title');
  assert.equal(LONG_TITLE[label.length], ' ', `label ends mid-word: ${label}`);
});

test('a short citation label is left exactly as-is', () => {
  assert.equal(citationAnchorLabel({ title: 'Retinitis pigmentosa' }, URL), 'Retinitis pigmentosa');
});

test('a researched-agent citation is labelled with its study, never the word "source"', () => {
  // Shipped as "(source ↗)" on the NAC, DHA, vitamin A and goji cards, while
  // the real title sat one line below in the REFERENCES field.
  const block = renderResearchedCandidateBlocks([{
    name: 'Vitamin A',
    url: URL,
    category: 'rct',
    title: 'A randomized trial of vitamin A and vitamin E supplementation for retinitis pigmentosa',
    summary: 'Vitamin A palmitate 15,000 IU/day slowed the decline in cone flicker amplitude.'
  }]);

  assert.ok(!/\[source\]/i.test(block), 'the generic "source" label must not be emitted');
  assert.ok(
    block.includes('[A randomized trial of vitamin A and vitamin E supplementation for retinitis'),
    'the citation must carry the study title'
  );
});

test('a citation label falls back to the agent name rather than a rationale sentence', () => {
  // The web lane assigned its one-sentence "finding" to `title`, so a whole
  // sentence rendered as the link text, hard-cut at 90 characters mid-word.
  const block = renderResearchedCandidateBlocks([{
    name: 'Minocycline',
    url: URL,
    category: 'observational',
    title: '',
    summary: 'This open-label clinical trial was designed to test oral minocycline in retinitis pigmentosa.'
  }]);

  for (const [, label] of block.matchAll(/\[([^\]]+)\]\(https?:/g)) {
    assert.ok(label.length <= 90, `label too long: ${label}`);
    assert.ok(!/\bthis open-label\b/i.test(label), `a rationale sentence became a link label: ${label}`);
  }
  assert.ok(block.includes('[Minocycline]('), 'expected the agent name as the fallback label');
});

test('a clamped rationale never ends mid-word', () => {
  // Shipped as "...does not provide evidence of establ".
  const sentence = 'This open-label clinical trial was designed to test oral minocycline ' +
    'in retinitis pigmentosa, but the study record does not provide evidence of established benefit.';
  const clamped = clampToWord(sentence, 150);

  assert.ok(clamped.length <= 151, 'clamped text must respect its budget');
  assert.ok(!/\bestabl$/.test(clamped), 'must not cut mid-word');
  assert.ok(
    /[.!?…]$/.test(clamped),
    `a shortened line must be marked as shortened: ${clamped}`
  );
});

test('a card whose title or status declares it investigational is not an approved treatment', () => {
  // "Oral N-Acetylcysteine (NAC) — Investigational (Phase 3 Trial Ongoing)"
  // rendered under the heading "3. Approved Treatments", and under the
  // export's "FDA-Approved Treatments" H2, with only a border colour
  // distinguishing it. The same agent already appears, correctly, under
  // "Researched, Not Yet FDA-Approved".
  assert.ok(declaresNotApproved('Oral N-Acetylcysteine (NAC) — Investigational (Phase 3 Trial Ongoing)'));
  assert.ok(declaresNotApproved('Not yet FDA-approved'));
  assert.ok(declaresNotApproved('investigational'));

  // A real approved status must survive. This is precisely why testing for an
  // "approved" PREFIX is wrong: the status a model writes is "FDA-approved
  // for X", and a prefix test drops every genuinely approved treatment.
  assert.ok(!declaresNotApproved('FDA-approved for OAB'));
  assert.ok(!declaresNotApproved('approved'));
  assert.ok(!declaresNotApproved('Voretigene neparvovec-rzyl (Luxturna)'));
  assert.ok(!declaresNotApproved(''));
});

test('two spellings of one agent collapse, but two agents sharing a class do not', () => {
  // "DHA (omega-3 fatty acid)" and "Docosahexaenoic acid (DHA)" shipped as two
  // cards with contradictory conclusions — one stating the hypothesis, one
  // reporting a null result. The shared identity lives only in the
  // parenthetical, which the old key stripped before comparing.
  const dedupe = (names) => {
    const seen = new Set();
    return names.filter((n) => {
      const keys = agentDedupKeys(n);
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    });
  };

  assert.deepEqual(
    dedupe(['DHA (omega-3 fatty acid)', 'Docosahexaenoic acid (DHA)']),
    ['DHA (omega-3 fatty acid)']
  );
  assert.deepEqual(
    dedupe(['TUDCA (tauroursodeoxycholic acid)', 'Tauroursodeoxycholic acid (TUDCA)']),
    ['TUDCA (tauroursodeoxycholic acid)']
  );

  // A descriptive parenthetical names a class, not an agent. Keying on it
  // would wrongly merge two distinct omega-3s into a single card.
  assert.equal(dedupe(['DHA (omega-3 fatty acid)', 'EPA (omega-3 fatty acid)']).length, 2);
  assert.equal(dedupe(['Taurine', 'Rapamycin', 'Vitamin A palmitate']).length, 3);
});
