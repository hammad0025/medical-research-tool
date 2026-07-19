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
