import test from 'node:test';
import assert from 'node:assert/strict';

import { lookupDisease } from '../lib/disease-registry.js';
import {
  getDossier,
  clearDossierCache,
  mergeRegistryWithDossier
} from '../lib/disease-dossier.js';
import { buildDossierBlock } from '../api/research.js';

const norm = (s) => String(s || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// F2 — a general query must not ground the dossier on a fuzzy narrower/adjacent
//      registry match (e.g. "tuberculosis" -> "Silicotuberculosis" ~58). The
//      dossier only adopts a registry name as its identity at a near-exact
//      score (>= 90); weaker matches fall through to the LLM, which resolves
//      general terms correctly.
// ---------------------------------------------------------------------------
test('getDossier does not adopt a fuzzy registry match as the disease identity', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    clearDossierCache();
    const d = await getDossier('tuberculosis', { bypassCache: true });
    assert.notEqual(d.source, 'disease-registry',
      `a fuzzy registry match must not become the dossier identity (got source=${d.source}, canonical=${d.canonical})`);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('legitimate conditions still resolve confidently', async () => {
  for (const [query, expected] of [
    ['Hashimoto thyroiditis', 'hashimoto thyroiditis'],
    ['celiac disease', 'celiac disease'],
    ['Parkinson disease', 'parkinson disease'],
    ['amyotrophic lateral sclerosis', 'amyotrophic lateral sclerosis']
  ]) {
    const r = await lookupDisease(query);
    assert.ok(r && r.score >= 55, `${query} should resolve, got ${r && r.score}`);
    assert.equal(norm(r.entry.name), expected);
  }
});

test('a query that is MORE specific than a core name still matches the core', async () => {
  // needle.includes(hay) direction stays confident — user was more specific.
  const r = await lookupDisease('type 2 diabetes');
  assert.ok(r && r.score >= 55);
  assert.match(norm(r.entry.name), /diabetes/);
});

// ---------------------------------------------------------------------------
// F1 — a registry-resolved condition returns its identity even with no API key
//      (previously it returned empty rich fields; now it is at least the
//      correct canonical name/specialty, and enrichment fills the rest when a
//      key is present).
// ---------------------------------------------------------------------------
test('no-key path returns the registry identity, not a raw-string fallback', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    clearDossierCache();
    const d = await getDossier('Hashimoto thyroiditis', { bypassCache: true });
    assert.equal(norm(d.canonical), 'hashimoto thyroiditis');
    assert.equal(d.source, 'disease-registry');
    assert.equal(d.skippedLlm, true);
    assert.equal(d.fallbackReason, 'no_api_key_registry_only');
    // Without a key the rich fields cannot be enriched yet.
    assert.deepEqual(d.topCenters, []);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// F1 — the hybrid merge: registry identity is kept, LLM fills the rich fields,
//      empty LLM fields never overwrite the base, uncertainty follows the LLM.
// ---------------------------------------------------------------------------
test('mergeRegistryWithDossier keeps identity and fills rich fields', () => {
  const base = {
    canonical: 'Hashimoto thyroiditis',
    synonyms: ['Hashimoto thyroiditis', 'chronic lymphocytic thyroiditis'],
    subspecialty: 'Endocrinology',
    topCenters: [], keyInvestigators: [], patientAdvocacy: [],
    landmarkTrials: [], meshTerms: [], redFlags: [],
    uncertainty: 0.12, generatedBy: 'disease-registry:hashimoto', source: 'disease-registry'
  };
  const llm = {
    canonical: 'Hashimoto thyroiditis (LLM)',
    synonyms: ['autoimmune thyroiditis'],
    topCenters: [{ name: 'Mayo Clinic', city: 'Rochester', country: 'USA', why: 'thyroid center' }],
    keyInvestigators: [],
    redFlags: ['Often misdiagnosed as primary hypothyroidism'],
    meshTerms: ['Thyroiditis, Autoimmune'],
    uncertainty: 0.3
  };
  const merged = mergeRegistryWithDossier(base, llm);
  // identity from the registry, not the LLM
  assert.equal(merged.canonical, 'Hashimoto thyroiditis');
  assert.equal(merged.subspecialty, 'Endocrinology');
  // rich fields filled from the LLM
  assert.equal(merged.topCenters.length, 1);
  assert.equal(merged.topCenters[0].name, 'Mayo Clinic');
  assert.deepEqual(merged.meshTerms, ['Thyroiditis, Autoimmune']);
  assert.equal(merged.redFlags.length, 1);
  // empty LLM field does not overwrite base
  assert.deepEqual(merged.keyInvestigators, []);
  // synonyms are unioned
  assert.ok(merged.synonyms.includes('autoimmune thyroiditis'));
  assert.ok(merged.synonyms.includes('chronic lymphocytic thyroiditis'));
  // uncertainty follows the LLM (the rich fields are LLM-generated)
  assert.equal(merged.uncertainty, 0.3);
  assert.equal(merged.source, 'disease-registry+dossier');
  assert.equal(merged.enrichedFromRegistry, true);
});

// ---------------------------------------------------------------------------
// F5 — the top-centers directive is gated on uncertainty: confident dossiers
//      say "MUST surface"; shaky ones say "UNVERIFIED" and do not command it.
// ---------------------------------------------------------------------------
test('confident dossier centers get a MUST-surface directive', () => {
  const block = buildDossierBlock({
    canonical: 'X', generatedBy: 'test', uncertainty: 0.15,
    topCenters: [{ name: 'A Center', city: 'Boston', country: 'USA', why: 'leads' }]
  });
  assert.match(block, /MUST surface/);
  assert.doesNotMatch(block, /UNVERIFIED/);
});

test('uncertain dossier centers are flagged UNVERIFIED, not forced', () => {
  const block = buildDossierBlock({
    canonical: 'X', generatedBy: 'test', uncertainty: 0.7,
    topCenters: [{ name: 'A Center', city: 'Boston', country: 'USA', why: 'leads' }]
  });
  assert.match(block, /UNVERIFIED/);
  assert.doesNotMatch(block, /MUST surface these in the "Top Centers/);
});
