import test from 'node:test';
import assert from 'node:assert/strict';

import { lookupDisease } from '../lib/disease-registry.js';
import { resolveCondition, conditionsResolveToSameIdentity } from '../lib/condition-resolver.js';
import {
  getDossier,
  clearDossierCache,
  mergeRegistryWithDossier
} from '../lib/disease-dossier.js';
import { buildDossierBlock } from '../api/research.js';
import { ontologyConfirm, confirmSubtypes } from '../lib/condition-umbrella.js';

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
// F2 (resolveCondition) — a GENERAL term must not silently bind to a narrower or
// adjacent variant; it falls through to the general-concept (LLM) path instead.
// ---------------------------------------------------------------------------
test('a general term does not resolve to a more-specific variant', async () => {
  for (const general of ['diabetes', 'tuberculosis']) {
    const r = await resolveCondition(general);
    // Must not have been bound to a specific child like "Prediabetes syndrome"
    // or "Silicotuberculosis"; the general string is preserved for the dossier.
    assert.equal(norm(r.resolved), general,
      `"${general}" should stay general, resolved to "${r.resolved}" via ${r.source}`);
    assert.equal(r.source, 'user-input');
  }
});

test('generic vs subtype are NOT the same identity (trial-binding safety)', async () => {
  assert.equal(await conditionsResolveToSameIdentity('diabetes', 'Type 1 diabetes'), false);
  assert.equal(await conditionsResolveToSameIdentity('diabetes', 'Type 2 diabetes'), false);
});

test('specific terms and abbreviations still resolve (no over-rejection)', async () => {
  // user typed the specific subtype → keep resolving it
  assert.match(norm((await resolveCondition('Type 1 diabetes')).resolved), /type\s*1/);
  assert.match(norm((await resolveCondition('type 2 diabetes')).resolved), /type\s*2/);
  // an abbreviation is a PREFIX of the full name (same disease) → still resolves
  assert.equal((await resolveCondition('schizo')).resolved, 'Schizophrenia');
  // and when the user actually types the specific variant, it resolves to it
  assert.match(norm((await resolveCondition('prediabetes')).resolved), /prediabetes/);
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

// ---------------------------------------------------------------------------
// Universal resolution — umbrella awareness (agent-primary, ontology-validated).
// ---------------------------------------------------------------------------
test('ontologyConfirm attaches a real MONDO id to known diseases and flags unknowns', async () => {
  const known = await ontologyConfirm('Type 2 diabetes mellitus');
  assert.equal(known.ontologyConfirmed, true);
  assert.match(known.mondo, /^MONDO:\d+$/);

  const unknown = await ontologyConfirm('Zzz Not A Real Disease');
  assert.equal(unknown.ontologyConfirmed, false);
  assert.equal(unknown.mondo, null);
});

test('confirmSubtypes annotates agent-provided subtypes without dropping unconfirmed ones', async () => {
  const rows = await confirmSubtypes(['Type 1 diabetes mellitus', 'A subtype the flat registry lacks']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ontologyConfirmed, true);
  assert.equal(rows[1].ontologyConfirmed, false);
});

test('mergeRegistryWithDossier carries the agent umbrella signal', () => {
  const base = {
    canonical: 'Diabetes', synonyms: ['Diabetes'], subspecialty: 'Endocrinology',
    topCenters: [], keyInvestigators: [], patientAdvocacy: [], landmarkTrials: [],
    meshTerms: [], redFlags: [], uncertainty: 0.12,
    generatedBy: 'disease-registry:diabetes', source: 'disease-registry'
  };
  const llm = { isUmbrella: true, subtypes: ['Type 1 diabetes', 'Type 2 diabetes'], uncertainty: 0.2 };
  const merged = mergeRegistryWithDossier(base, llm);
  assert.equal(merged.isUmbrella, true);
  assert.deepEqual(merged.subtypes, ['Type 1 diabetes', 'Type 2 diabetes']);
});

test('buildDossierBlock instructs umbrella research when the dossier flags it', () => {
  const umbrella = buildDossierBlock({
    canonical: 'Diabetes', generatedBy: 'test', uncertainty: 0.2,
    isUmbrella: true, subtypes: ['Type 1 diabetes', 'Type 2 diabetes']
  });
  assert.match(umbrella, /UMBRELLA CONDITION/);
  assert.match(umbrella, /Type 1 diabetes/);
  assert.match(umbrella, /Type 2 diabetes/);

  const specific = buildDossierBlock({
    canonical: 'Idiopathic Pulmonary Fibrosis', generatedBy: 'test', uncertainty: 0.1,
    isUmbrella: false, subtypes: []
  });
  assert.doesNotMatch(specific, /UMBRELLA CONDITION/);
});

// ---------------------------------------------------------------------------
// F3 — live approved-drug discovery. The condition's FDA-approved drugs (named
// by the dossier) join the openFDA label fetch, so Approved Treatments cards get
// real DailyMed links for ANY condition — not only ones the patient takes.
// ---------------------------------------------------------------------------
import { buildFdaLabelTargets } from '../lib/evidence.js';

test('buildFdaLabelTargets unions patient meds with the condition approved drugs', () => {
  const targets = buildFdaLabelTargets(
    ['metformin', 'aspirin'],
    { approvedDrugs: ['pirfenidone', 'Metformin', 'nintedanib'] }
  );
  // patient meds first, approved drugs appended, deduped case-insensitively
  assert.deepEqual(targets, ['metformin', 'aspirin', 'pirfenidone', 'nintedanib']);
});

test('buildFdaLabelTargets is a no-op passthrough without a dossier', () => {
  assert.deepEqual(buildFdaLabelTargets(['lisinopril'], null), ['lisinopril']);
  assert.deepEqual(buildFdaLabelTargets([], { approvedDrugs: [] }), []);
});

test('mergeRegistryWithDossier carries the approved-drug list', () => {
  const merged = mergeRegistryWithDossier(
    { canonical: 'X', synonyms: ['X'], topCenters: [], keyInvestigators: [], patientAdvocacy: [],
      landmarkTrials: [], meshTerms: [], redFlags: [], uncertainty: 0.12, generatedBy: 'r', source: 'disease-registry' },
    { approvedDrugs: ['pirfenidone', 'nintedanib'], uncertainty: 0.2 }
  );
  assert.deepEqual(merged.approvedDrugs, ['pirfenidone', 'nintedanib']);
});

test('buildDossierBlock lists approved drugs for Section 3 (label-gated)', () => {
  const block = buildDossierBlock({
    canonical: 'Idiopathic Pulmonary Fibrosis', generatedBy: 'test', uncertainty: 0.1,
    approvedDrugs: ['pirfenidone', 'nintedanib']
  });
  assert.match(block, /FDA-APPROVED drugs for this condition/);
  assert.match(block, /pirfenidone/);
  assert.match(block, /Never assert approval without a verified label/);
});
