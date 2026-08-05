// Regression tests for citation labels and card identity on the finished page.
//
// Every fixture below is text this product actually rendered for a Retinitis
// Pigmentosa report. These defects shipped together because each was checked
// at the layer it touched: the label truncator looked fine in isolation, the
// seed renderer looked fine in isolation, and the dedup key looked fine in
// isolation. They only misbehave in composition.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  citationAnchorLabel,
  finalizeReportText,
  dropUnapprovedFromApprovedSection
} from '../lib/report-polish.js';
import { renderResearchedCandidateBlocks } from '../lib/researched-agent-seeds.js';
import { clampToWord } from '../lib/researched-agent-search.js';
import {
  agentDedupKeys,
  isAffirmativelyApproved,
  isUnverifiedRegulatoryStatus
} from '../lib/card-identity.js';

const LONG_TITLE =
  'Preclinical biodistribution and toxicology assessment of an AAV5-based ' +
  'subretinal modifier gene therapy for inherited retinal disease';
const URL = 'https://pubmed.ncbi.nlm.nih.gov/33333333';

test('a shortened citation label is marked, and survives finalize inside its link', () => {
  // Shipped as "…subretinal modifier ge…": cut mid-word, and because
  // sanitizePublicText NFKC-rewrites "…" into three ASCII periods, the
  // claim-sentence splitter cut the markdown link in half, failed to find a
  // URL in the first half and re-cited it — rendering the title twice with
  // unbalanced parentheses.
  //
  // The fix is not to drop the marker (a title cut at a word boundary with no
  // marker reads as complete when it isn't) but to make the splitter treat a
  // markdown link as atomic, so the marker is safe again.
  const label = citationAnchorLabel({ title: LONG_TITLE }, URL);

  assert.ok(label.length < LONG_TITLE.length, 'this fixture is meant to be shortened');
  assert.match(label, /…$/, 'a shortened label must say it was shortened');
  const stem = label.replace(/…$/, '');
  assert.ok(LONG_TITLE.startsWith(stem), 'the label must be a prefix of the title');
  assert.equal(LONG_TITLE[stem.length], ' ', `label ends mid-word: ${label}`);

  // The whole point: this label, inside a link, must not be split or doubled.
  const evidence = { topRanked: [{ title: LONG_TITLE, url: URL }] };
  const line = `## 1. Condition Snapshot\n\nRod cells degenerate first ([${label}](${URL})).\n`;
  const once = finalizeReportText(line, { evidence, trials: null });
  const twice = finalizeReportText(once, { evidence, trials: null });

  assert.equal(
    (twice.match(/Preclinical biodistribution/g) || []).length, 1,
    'the citation title must not be duplicated by a second finalize'
  );
  assert.equal(once, twice, 'finalize must be idempotent over a sealed report');
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

test('an unverified regulatory status is disqualifying; off-label is not', () => {
  // Four programmes reached a heading reading "Approved Treatments" while
  // stating "FDA status: Unknown — insufficient verified FDA/DailyMed label
  // evidence". A blacklist of words like "investigational" never saw them.
  assert.ok(isUnverifiedRegulatoryStatus('Unknown — insufficient verified FDA/DailyMed label evidence.'));
  assert.ok(isUnverifiedRegulatoryStatus('Investigational (Phase 3 Trial Ongoing)'));
  assert.ok(isUnverifiedRegulatoryStatus('Not yet FDA-approved'));
  assert.ok(isUnverifiedRegulatoryStatus('pending FDA review'));

  // Off-label is a KNOWN status: the drug carries a real FDA label for
  // another indication, and this product shows such options with a flag.
  // Treating it as disqualifying dropped dutasteride from an AGA report.
  assert.ok(!isUnverifiedRegulatoryStatus('Off-label for androgenetic alopecia'));
  assert.ok(!isUnverifiedRegulatoryStatus('FDA-approved for OAB'));
  assert.ok(!isUnverifiedRegulatoryStatus(''));

  // The stricter test still means strictly approved, and is not the
  // complement of the one above.
  assert.ok(isAffirmativelyApproved('FDA-approved for OAB'));
  assert.ok(isAffirmativelyApproved('FDA approved 2017 (first ocular gene therapy)'));
  assert.ok(!isAffirmativelyApproved('Off-label for androgenetic alopecia'));
  assert.ok(!isAffirmativelyApproved('Unknown — insufficient verified label evidence.'));
});

test('the approved section drops unverified cards and keeps the approved one', () => {
  const section3 = [
    '## 3. Approved Treatments (Backed by Research)',
    '',
    'TREATMENT: Voretigene neparvovec-rzyl (Luxturna)',
    'FDA_STATUS: approved — for biallelic RPE65 mutations',
    'EFFICACY: Improved navigation under low light.',
    '',
    'TREATMENT: MCO-010 (sonpiretigene isteparvovec)',
    'FDA_STATUS: Unknown — insufficient verified FDA/DailyMed label evidence.',
    'EFFICACY: Under FDA review.',
    '',
    'TREATMENT: jCell (human retinal progenitor cells)',
    'FDA_STATUS: Unknown — insufficient verified FDA/DailyMed label evidence.',
    '',
    'TREATMENT: Dutasteride (Avodart)',
    'FDA_STATUS: Off-label for this condition',
    'EFFICACY: Studied off-label.',
    '',
    '## 4. Clinical Trials',
    ''
  ].join('\n');

  const out = dropUnapprovedFromApprovedSection(section3);
  assert.ok(out.includes('Voretigene neparvovec-rzyl'), 'the approved drug must stay');
  assert.ok(!out.includes('MCO-010'), 'an unverified programme must not stand under "Approved"');
  assert.ok(!out.includes('jCell'), 'an unverified programme must not stand under "Approved"');
  assert.ok(out.includes('Dutasteride'), 'an off-label drug with a real label must stay');
  assert.ok(out.includes('## 4. Clinical Trials'), 'the next section must be untouched');
});

test('a card with no status line is left alone rather than deleted', () => {
  // Absent metadata is a model omission. Dropping a genuine approved drug
  // over it would be a worse failure than the one the gate guards against.
  const section3 = [
    '## 3. Approved Treatments',
    '',
    'TREATMENT: Pirfenidone (Esbriet)',
    'EFFICACY: Slowed decline in forced vital capacity.',
    '',
    '## 4. Clinical Trials'
  ].join('\n');
  assert.ok(dropUnapprovedFromApprovedSection(section3).includes('Pirfenidone'));
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
