import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadKb } from '../lib/kb.js';
import { kbFactGroundingStatus } from '../lib/kb-fact-gate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = path.join(ROOT, 'data', 'kb');

const loadKbs = async () => {
  const files = (await readdir(KB_DIR))
    .filter((file) => file.endsWith('.json') && !file.startsWith('_'))
    .sort();
  return Promise.all(files.map(async (file) => ({
    file,
    kb: JSON.parse(await readFile(path.join(KB_DIR, file), 'utf8'))
  })));
};

const normalizeAgentIdentity = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const evidenceRefs = (record) => [
  record?.evidenceRef,
  ...(Array.isArray(record?.evidenceRefs) ? record.evidenceRefs : [])
].filter(Boolean);

test('quarantined KB evidence never reaches reader-facing load results', async () => {
  const result = await loadKb('Idiopathic pulmonary fibrosis');
  assert.equal(result.matched, true);
  const ids = new Set(result.items.map((item) => item.id));
  for (const id of [
    'ipf-vaccine-advisory',
    'ipf-ptx3-2021',
    'ipf-stemcells-review-2020'
  ]) {
    assert.equal(ids.has(id), false, `${id} escaped quarantine`);
    for (const record of [
      ...(result.meta.canonicalFacts || []),
      ...(result.meta.lifestyleRecommendations || [])
    ]) {
      assert.equal(evidenceRefs(record).includes(id), false, `${id} still grounds ${record.claim || record.recommendation}`);
    }
  }
});

test('arbitrary demo conditions expose only source-grounded canonical guidance', async () => {
  for (const condition of [
    'Huntington disease',
    'Sickle cell disease',
    'Breast cancer'
  ]) {
    const result = await loadKb(condition);
    assert.equal(result.matched, true, `${condition} did not resolve`);
    const itemsById = new Map(result.items.map((item) => [item.id, item]));
    const records = [
      ...(result.meta.canonicalFacts || []),
      ...(result.meta.lifestyleRecommendations || [])
    ];
    for (const record of records) {
      assert.equal(
        kbFactGroundingStatus(record, itemsById).grounded,
        true,
        `${condition} exposed unsupported text: ${record.claim || record.recommendation}`
      );
    }
  }
});

test('all KB canonical facts are substantive and locally evidence-linked', async () => {
  for (const { file, kb } of await loadKbs()) {
    const items = new Map((kb.items || []).map((item) => [item.id, item]));
    for (const [index, fact] of (kb.canonicalFacts || []).entries()) {
      const label = `${file} canonicalFacts[${index}]`;
      assert.ok(String(fact?.claim || '').trim().length >= 20, `${label} has no substantive claim`);
      assert.ok(Array.isArray(fact.evidenceRefs) && fact.evidenceRefs.length > 0, `${label} has no evidenceRefs`);
      assert.doesNotMatch(
        fact.claim,
        /\b(?:always|never|guarantees?|100%|completely safe)\b/i,
        `${label} uses absolute clinical language`
      );
      for (const ref of fact.evidenceRefs) {
        const item = items.get(ref);
        assert.ok(item, `${label} has unresolved evidence ref ${ref}`);
        assert.ok(String(item.title || '').trim(), `${label} evidence ${ref} has no title`);
        assert.ok(
          item.pmid || item.doi || item.url || (item.journal && item.year),
          `${label} evidence ${ref} lacks source identity`
        );
      }
    }
  }
});

test('all KB pipeline and exclusion records are complete and non-overlapping', async () => {
  const globalOverlaps = [];
  for (const { file, kb } of await loadKbs()) {
    const itemIds = new Set((kb.items || []).map((item) => item.id));
    const pipelineIds = new Set();
    const excludedIds = new Set();

    for (const [index, drug] of (kb.pipelineDrugs || []).entries()) {
      const label = `${file} pipelineDrugs[${index}]`;
      const identity = normalizeAgentIdentity(drug?.name);
      assert.ok(identity, `${label} has no normalized identity`);
      assert.ok(String(drug?.status || '').trim(), `${label} has no status`);
      assert.ok(String(drug?.approvalStatus || '').trim(), `${label} has no approvalStatus`);
      assert.ok(
        String(drug?.mechanism || drug?.whyItMatters || '').trim(),
        `${label} has no rationale`
      );
      assert.doesNotMatch(
        String(drug.approvalStatus),
        /^approved.*\b(?:not approved|investigational|withdrawn|revoked|non-renewal|discontinued)\b/i,
        `${label} has a contradictory approved classification`
      );
      for (const ref of evidenceRefs(drug)) {
        assert.ok(itemIds.has(ref), `${label} has unresolved evidence ref ${ref}`);
      }
      pipelineIds.add(identity);
    }

    for (const [index, agent] of (kb.excludedAgents || []).entries()) {
      const label = `${file} excludedAgents[${index}]`;
      const identity = normalizeAgentIdentity(agent?.name);
      assert.ok(identity, `${label} has no normalized identity`);
      assert.ok(String(agent?.reason || '').trim().length >= 20, `${label} has no rationale`);
      const refs = evidenceRefs(agent);
      assert.ok(refs.length > 0, `${label} has no evidence ref`);
      for (const ref of refs) {
        assert.ok(itemIds.has(ref), `${label} has unresolved evidence ref ${ref}`);
      }
      excludedIds.add(identity);
    }

    for (const identity of pipelineIds) {
      if (excludedIds.has(identity)) globalOverlaps.push(`${file}:${identity}`);
    }
  }
  assert.deepEqual(globalOverlaps, [], `pipeline/excluded overlaps: ${globalOverlaps.join(', ')}`);
});

test('CLL and MASLD adjudications preserve treatment-context semantics', async () => {
  const kbs = new Map((await loadKbs()).map(({ kb }) => [kb.slug, kb]));
  const cll = kbs.get('chronic-lymphocytic-leukemia');
  const masld = kbs.get('masld-nafld');

  assert.ok(
    cll.pipelineDrugs.some((drug) =>
      normalizeAgentIdentity(drug.name) === 'ibrutinib' && drug.approvalStatus === 'approved'),
    'ibrutinib should remain approved for treatment-eligible CLL'
  );
  assert.ok(
    !cll.excludedAgents.some((agent) => normalizeAgentIdentity(agent.name) === 'ibrutinib'),
    'the CLL12 watch-and-wait result must not globally exclude ibrutinib'
  );
  assert.ok(
    !masld.pipelineDrugs.some((drug) => normalizeAgentIdentity(drug.name) === 'empagliflozin'),
    'empagliflozin must not be promoted as a MASLD pipeline treatment'
  );
  assert.ok(
    masld.excludedAgents.some((agent) => normalizeAgentIdentity(agent.name) === 'empagliflozin'),
    'the grounded negative MASLD trial record for empagliflozin should remain'
  );
});
