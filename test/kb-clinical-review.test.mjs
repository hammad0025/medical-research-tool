import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MANIFEST_PATH,
  generateManifest,
  validateManifest
} from '../scripts/kb-clinical-review.mjs';

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-clinical-review-'));
  await mkdir(join(root, 'data', 'kb'), { recursive: true });
  await writeFile(
    join(root, 'data', 'kb', 'generated.json'),
    `${JSON.stringify({
      condition: 'Fixture Condition',
      curatedBy: 'auto-grounded generator',
      generatedBy: 'fixture generator',
      reviewed: false,
      items: [],
      canonicalFacts: [],
      redFlags: [],
      pipelineDrugs: [],
      excludedAgents: []
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, 'data', 'kb', 'curated.json'),
    `${JSON.stringify({ condition: 'Curated Fixture', curatedBy: 'human', reviewed: true })}\n`
  );
  return root;
};

const loadManifest = async (root) =>
  JSON.parse(await readFile(join(root, DEFAULT_MANIFEST_PATH), 'utf8'));

const saveManifest = async (root, manifest) =>
  writeFile(join(root, DEFAULT_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);

test('review queue starts unsigned and includes only generated KBs', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const manifest = await generateManifest({ root });
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].condition, 'Fixture Condition');
  assert.match(manifest.entries[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.entries[0].review, {
    reviewer: '',
    date: '',
    decision: '',
    correction: ''
  });

  const result = await validateManifest({ root });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes('unsigned')));
});

test('verification accepts a complete approval tied to the current digest', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await generateManifest({ root });
  const manifest = await loadManifest(root);
  manifest.entries[0].review = {
    reviewer: 'Fixture Reviewer',
    date: '2026-07-18',
    decision: 'approved',
    correction: ''
  };
  await saveManifest(root, manifest);

  const result = await validateManifest({ root });
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('verification fails closed for rejection, correction, changed content, and malformed records', async (t) => {
  const cases = [
    {
      name: 'rejected',
      mutate: async (_root, manifest) => {
        manifest.entries[0].review.decision = 'rejected';
      },
      expected: 'rejected'
    },
    {
      name: 'correction',
      mutate: async (_root, manifest) => {
        manifest.entries[0].review.correction = 'Correct the efficacy statement.';
      },
      expected: 'unresolved correction'
    },
    {
      name: 'stale',
      mutate: async (root) => {
        await writeFile(
          join(root, 'data', 'kb', 'generated.json'),
          `${JSON.stringify({
            condition: 'Fixture Condition',
            curatedBy: 'auto-grounded generator',
            generatedBy: 'fixture generator',
            reviewed: false,
            items: [{ id: 'changed' }]
          })}\n`
        );
      },
      expected: 'stale sign-off'
    },
    {
      name: 'malformed',
      mutate: async (_root, manifest) => {
        manifest.entries[0].review.date = '07/18/2026';
      },
      expected: 'malformed review date'
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const root = await makeRoot();
      subtest.after(() => rm(root, { recursive: true, force: true }));
      await generateManifest({ root });
      const manifest = await loadManifest(root);
      manifest.entries[0].review = {
        reviewer: 'Fixture Reviewer',
        date: '2026-07-18',
        decision: 'approved',
        correction: ''
      };
      await scenario.mutate(root, manifest);
      await saveManifest(root, manifest);

      const result = await validateManifest({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.failures.some((failure) => failure.includes(scenario.expected)),
        result.failures.join('\n')
      );
    });
  }
});

test('generation refuses to erase populated review records', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await generateManifest({ root });
  const manifest = await loadManifest(root);
  manifest.entries[0].review.reviewer = 'Fixture Reviewer';
  await saveManifest(root, manifest);

  await assert.rejects(
    generateManifest({ root }),
    /Refusing to overwrite populated review records/
  );
});
