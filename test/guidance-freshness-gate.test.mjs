import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGuidanceFreshness,
  enforceGuidanceFreshnessNarrative
} from '../lib/guidance-freshness-gate.js';
import { admitSourceRow } from '../lib/source-admission-gate.js';

const now = new Date('2026-07-19T12:00:00.000Z');
const currentGuidance = {
  id: 'current-guidance',
  category: 'clinical-guideline',
  isCuratedKB: true,
  title: 'American Example Society 2025 treatment guideline',
  journal: 'American Example Society',
  year: 2025,
  pmid: '12345678',
  url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/',
  abstract: 'For arbitrary alpha syndrome, the American Example Society recommends current treatment after individual clinical assessment.'
};

test('freshness gate rejects stale guidance but not old primary research', () => {
  const stale = assessGuidanceFreshness({
    ...currentGuidance,
    year: 2012,
    pmid: '12345679',
    url: 'https://pubmed.ncbi.nlm.nih.gov/12345679/'
  }, { now });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'GUIDANCE_STALE');

  const research = assessGuidanceFreshness({
    title: 'Landmark randomized trial in arbitrary alpha syndrome',
    year: 1998,
    pmid: '12345670',
    url: 'https://pubmed.ncbi.nlm.nih.gov/12345670/'
  }, { now });
  assert.equal(research.ok, true);
  assert.equal(research.reason, 'STABLE_NON_GUIDANCE_SOURCE');
});

test('freshness gate rejects superseded guidance and redirect identity swaps', () => {
  const superseded = assessGuidanceFreshness({
    ...currentGuidance,
    guidanceStatus: 'Superseded by the 2026 update'
  }, { now });
  assert.equal(superseded.reason, 'GUIDANCE_SUPERSEDED_OR_WITHDRAWN');

  const redirected = assessGuidanceFreshness(currentGuidance, {
    now,
    finalUrl: 'https://pubmed.ncbi.nlm.nih.gov/87654321/'
  });
  assert.equal(redirected.reason, 'GUIDANCE_REDIRECT_IDENTITY_MISMATCH');
});

test('a publisher redirect that keeps the DOI is the same document, not a swap', () => {
  const positionStatement = {
    category: 'clinical-guideline',
    isCuratedKB: true,
    title: 'Management of osteoporosis in postmenopausal women: the 2021 position statement of The North American Menopause Society.',
    journal: 'Menopause (New York, N.Y.)',
    year: '2021',
    doi: '10.1097/GME.0000000000001831',
    pmid: '34448749',
    canonicalUrl: 'https://journals.lww.com/10.1097/GME.0000000000001831'
  };
  // lww → its own article page, DOI intact under a slug.
  const sameDoc = assessGuidanceFreshness(positionStatement, {
    now,
    finalUrl: 'https://journals.lww.com/menopausejournal/abstract/10.1097/gme.0000000000001831~management-of-osteoporosis?redirectionsource=fulltextview'
  });
  assert.equal(sameDoc.reason !== 'GUIDANCE_REDIRECT_IDENTITY_MISMATCH', true);
  // Cross-host redirect (lww → ovid) with the DOI preserved is still the same document.
  const crossHost = assessGuidanceFreshness(positionStatement, {
    now,
    finalUrl: 'https://ovid.com/jnls/co-endocrinology/fulltext/10.1097/gme.0000000000001831~management-of-osteoporosis'
  });
  assert.equal(crossHost.reason !== 'GUIDANCE_REDIRECT_IDENTITY_MISMATCH', true);
  // A redirect onto a DIFFERENT document is still caught.
  const swapped = assessGuidanceFreshness(positionStatement, {
    now,
    finalUrl: 'https://journals.lww.com/menopausejournal/abstract/10.1097/gme.0000000009999999~some-other-paper'
  });
  assert.equal(swapped.reason, 'GUIDANCE_REDIRECT_IDENTITY_MISMATCH');
  // A redirect onto a page carrying no document identifier is still caught.
  const landing = assessGuidanceFreshness(positionStatement, {
    now,
    finalUrl: 'https://journals.lww.com/menopausejournal/pages/default.aspx'
  });
  assert.equal(landing.reason, 'GUIDANCE_REDIRECT_IDENTITY_MISMATCH');
  // A search page cannot impersonate the document by echoing its DOI back.
  const searchPage = assessGuidanceFreshness(positionStatement, {
    now,
    finalUrl: 'https://journals.lww.com/search?doi=10.1097/gme.0000000000001831'
  });
  assert.equal(searchPage.reason, 'GUIDANCE_REDIRECT_IDENTITY_MISMATCH');
});

test('freshness gate rejects guidance without date or version identity', () => {
  const missingDate = assessGuidanceFreshness({
    category: 'clinical-guideline',
    isCuratedKB: true,
    title: 'American Example Society current recommendations',
    journal: 'American Example Society',
    url: 'https://guidelines.example.org/current-recommendations'
  }, { now });
  assert.equal(missingDate.reason, 'GUIDANCE_DATE_MISSING');

  const missingVersion = assessGuidanceFreshness({
    category: 'clinical-guideline',
    isCuratedKB: true,
    title: 'American Example Society current recommendations',
    journal: 'American Example Society',
    year: 2025,
    url: 'https://guidelines.example.org/current-recommendations'
  }, { now });
  assert.equal(missingVersion.reason, 'GUIDANCE_VERSION_MISSING');
});

test('freshness gate accepts current identified authoritative guidance', () => {
  const result = assessGuidanceFreshness(currentGuidance, { now });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'GUIDANCE_CURRENT');
  assert.equal(result.versionIdentifier, '12345678');
  assert.equal(result.governingDate, '2025-12-31');
});

test('reader-facing seal removes changing claims without current guidance', () => {
  const stale = {
    ...currentGuidance,
    year: 2010,
    guidanceFreshness: assessGuidanceFreshness({
      ...currentGuidance,
      year: 2010
    }, { now })
  };
  const text = 'The society recommends treatment now. ([source](https://pubmed.ncbi.nlm.nih.gov/12345678/))';
  const rejected = enforceGuidanceFreshnessNarrative(text, {
    groundedForPrompt: [stale]
  }, { now });
  assert.equal(rejected.text, '');
  assert.equal(rejected.audit.reasons.GUIDANCE_STALE, 1);

  const accepted = enforceGuidanceFreshnessNarrative(text, {
    groundedForPrompt: [{
      ...currentGuidance,
      guidanceFreshness: assessGuidanceFreshness(currentGuidance, { now })
    }]
  }, { now });
  assert.equal(accepted.text, text);
});

test('arbitrary-condition runtime admission fails closed for stale guidance', () => {
  const result = admitSourceRow({
    ...currentGuidance,
    year: 2010,
    abstract: 'For completely novel arbitrary alpha syndrome, the society recommends treatment based on the guideline evidence and clinical assessment.'
  }, {
    condition: 'Completely Novel Arbitrary Alpha Syndrome',
    now
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GUIDANCE_STALE');
});
