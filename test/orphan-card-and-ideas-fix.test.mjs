import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  finalizeReportText,
  stripOrphanCardFragments,
  enforceCandidateCitationRelevance
} from '../lib/report-polish.js';

test('nameless FDA-unknown fragments after a treatment card are dropped', () => {
  const input = [
    'Treatment: **Voretigene neparvovec-rzyl (Luxturna)** — gene therapy',
    'FDA status: approved',
    'Sources: [Lancet](https://pubmed.ncbi.nlm.nih.gov/28712537/)',
    '---',
    'FDA status: Unknown — insufficient verified FDA/DailyMed label evidence.',
    '---',
    ' Full safety data are not yet published ([Oral N-acetylcysteine improves cone function](https://pmc.ncbi.nlm.nih.gov/articles/PMC7269599)).'
  ].join('\n');
  const cleaned = stripOrphanCardFragments(input);
  assert.match(cleaned, /Luxturna/);
  assert.doesNotMatch(cleaned, /N-acetylcysteine|insufficient verified FDA/i);
});

test('cross-drug citations are demoted on rewritten Treatment and Drug-idea cards', () => {
  const evidence = {
    groundedForPrompt: [
      {
        title: 'Oral N-acetylcysteine improves cone function in retinitis pigmentosa',
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7269599/',
        text: 'Oral N-acetylcysteine improved cone function in retinitis pigmentosa patients.'
      },
      {
        title: 'Lancet Phase 3 RCT — voretigene',
        url: 'https://pubmed.ncbi.nlm.nih.gov/28712537/',
        text: 'Voretigene neparvovec (Luxturna) improved functional vision in RPE65 mutation-associated retinal dystrophy.'
      }
    ]
  };
  const text = [
    'Treatment: Luxturna',
    'What studies found: Improved vision ([Oral N-acetylcysteine improves cone function](https://pmc.ncbi.nlm.nih.gov/articles/PMC7269599/)).',
    'Drug or supplement idea: Oral N-acetylcysteine (NAC)',
    'What the research says: Cone function improved ([Oral N-acetylcysteine improves cone function](https://pmc.ncbi.nlm.nih.gov/articles/PMC7269599/)).'
  ].join('\n');
  const result = enforceCandidateCitationRelevance(text, evidence);
  assert.ok(result.demoted.some((row) => /Luxturna/i.test(row)));
  assert.doesNotMatch(
    result.text.split('Drug or supplement idea')[0],
    /pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC7269599/
  );
  assert.match(result.text, /Drug or supplement idea: Oral N-acetylcysteine/);
});

test('finalizeReportText does not leave a NAC citation under a Luxturna card', () => {
  const evidence = {
    groundedForPrompt: [
      {
        title: 'Oral N-acetylcysteine improves cone function in retinitis pigmentosa',
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7269599/',
        text: 'Oral N-acetylcysteine improved cone function in retinitis pigmentosa patients in a phase I trial.'
      },
      {
        title: 'Lancet Phase 3 RCT — voretigene',
        url: 'https://pubmed.ncbi.nlm.nih.gov/28712537/',
        text: 'Voretigene neparvovec (Luxturna) improved functional vision versus control.'
      }
    ],
    fdaLabels: []
  };
  const input = [
    '## 3. Approved Treatments',
    'TREATMENT: Voretigene neparvovec-rzyl (Luxturna) — subretinal injection',
    'FDA_STATUS: approved',
    'REFERENCES: [Lancet Phase 3 RCT — voretigene](https://pubmed.ncbi.nlm.nih.gov/28712537/)',
    '---',
    'FDA_STATUS: Unknown — insufficient verified FDA/DailyMed label evidence.',
    '---',
    'Full safety data are not yet published ([Oral N-acetylcysteine improves cone function](https://pmc.ncbi.nlm.nih.gov/articles/PMC7269599/)).'
  ].join('\n');
  const out = finalizeReportText(input, {
    evidence,
    trials: { studies: [] },
    patient: { condition: 'Retinitis Pigmentosa' }
  });
  assert.match(out, /Luxturna/i);
  assert.doesNotMatch(out, /N-acetylcysteine|PMC7269599/i);
});

test('ideas parser and lane splitter recognize rewritten Drug or supplement idea labels', async () => {
  const app = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  assert.match(app, /SAFETY CONCERN': 'SAFETY'/);
  assert.match(app, /CANDIDATE\|Drug or supplement idea/);
  assert.match(app, /prePolishText/);
  assert.match(app, /survivingFrom\(prePolishText\)/);
  assert.match(app, /why_for_this_condition/);
});
