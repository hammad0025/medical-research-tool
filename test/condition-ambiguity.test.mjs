import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'offline-condition-fixture';
process.env.MRT_DISABLE_USAGE_LIMIT = '1';
process.env.MRT_RESEARCH_PIPELINE_ENABLED = '1';

const { resolveCondition } = await import('../lib/condition-resolver.js');
const { asInternalReq } = await import('../lib/internal-call.js');
const researchHandler = (await import('../api/research.js')).default;

const response = () => {
  const headers = new Map();
  const captured = { statusCode: 200, body: undefined };
  captured.res = {
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { captured.statusCode = code; return this; },
    json(value) { captured.body = value; return this; },
    end(value) { captured.body = value; return this; }
  };
  return captured;
};

const invoke = async (body) => {
  const out = response();
  await researchHandler(asInternalReq({
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    query: {},
    socket: { remoteAddress: '127.0.0.1' }
  }), out.res);
  return out;
};

test('BPD requires a full condition name across casing, punctuation, and spacing', async () => {
  for (const input of ['BPD', '  bPd  ', 'B.P.D.', ' b p d ']) {
    const result = await resolveCondition(input);
    assert.equal(result.needsConfirmation, true, input);
    assert.equal(result.resolved, null, input);
    assert.equal(result.autoCanonicalize, false, input);
    assert.deepEqual(result.alternatives, [
      'Bipolar disorder',
      'Borderline personality disorder',
      'Bronchopulmonary dysplasia'
    ]);
    assert.match(result.message, /enter or select the full condition name/i);
  }
});

test('MS requires confirmation across punctuation and spacing variants', async () => {
  for (const input of ['MS', ' ms ', 'M.S.', 'm s']) {
    const result = await resolveCondition(input);
    assert.equal(result.needsConfirmation, true, input);
    assert.equal(result.resolved, null, input);
    assert.equal(result.autoCanonicalize, false, input);
    assert.deepEqual(result.alternatives, [
      'Multiple sclerosis',
      'Mitral stenosis',
      'Metabolic syndrome'
    ]);
  }
});

test('other clinically overloaded abbreviations fail closed while full names remain usable', async () => {
  const cases = [
    ['AD', ['Alzheimer disease', 'Atopic dermatitis']],
    ['A.S.D.', ['Autism spectrum disorder', 'Atrial septal defect']],
    ['m d', ['Muscular dystrophy', 'Major depressive disorder']],
    ['P.D.', ['Parkinson disease', 'Personality disorder']]
  ];
  for (const [input, alternatives] of cases) {
    const result = await resolveCondition(input);
    assert.equal(result.needsConfirmation, true, input);
    assert.deepEqual(result.alternatives, alternatives, input);
  }
});

test('disease-defining conflicts never use partial aliases to narrow or replace the condition', async () => {
  const pulmonaryHypertension = await resolveCondition('pulmonary hypertension');
  assert.equal(pulmonaryHypertension.resolved, 'Pulmonary hypertension');
  assert.equal(pulmonaryHypertension.autoCanonicalize, false);
  assert.notEqual(
    pulmonaryHypertension.resolved,
    'Idiopathic pulmonary arterial hypertension'
  );

  for (const input of [
    'type 1 diabetes insipidus',
    'Type I diabetes insipidus',
    'type one diabetes insipidus'
  ]) {
    const result = await resolveCondition(input);
    assert.equal(result.needsConfirmation, true, input);
    assert.equal(result.resolved, null, input);
    assert.deepEqual(result.alternatives, [
      'Type 1 diabetes mellitus',
      'Diabetes insipidus'
    ]);
  }
});

test('established exact short names keep their deterministic resolutions', async () => {
  const schizophrenia = await resolveCondition('schizo');
  assert.equal(schizophrenia.needsConfirmation, false);
  assert.equal(schizophrenia.resolved, 'Schizophrenia');

  const retinitisPigmentosa = await resolveCondition('RP');
  assert.equal(retinitisPigmentosa.needsConfirmation, false);
  assert.equal(retinitisPigmentosa.resolved, 'Retinitis Pigmentosa');

  for (const fullName of [
    'Multiple sclerosis',
    'Mitral stenosis',
    'Metabolic syndrome',
    'Pulmonary hypertension',
    'Diabetes insipidus',
    'Type 1 diabetes mellitus',
    'Schizophrenia',
    'Retinitis pigmentosa'
  ]) {
    const result = await resolveCondition(fullName);
    assert.equal(result.needsConfirmation, false, fullName);
    assert.ok(result.resolved, fullName);
  }
});

test('gather and synthesis routes reject ambiguous conditions before provider access despite client hints', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('Provider access must not occur for an unresolved condition name.');
  };

  try {
    for (const condition of ['  bPd  ', 'M.S.', 'type 1 diabetes insipidus']) {
      for (const mode of ['research', 'repurpose', 'trials']) {
        for (const phase of ['gather', 'synthesize']) {
          const result = await invoke({
            mode,
            phase,
            patient: { condition },
            conditionResolution: {
              needsConfirmation: false,
              resolved: 'Bipolar Disorder'
            },
            providedDossier: { canonical: 'Bipolar Disorder' },
            providedEvidence: { condition: 'Bipolar Disorder' },
            providedTrials: { studies: [] },
            gatherFingerprint: 'client-supplied',
            gatherSeal: 'client-supplied'
          });

          assert.equal(result.statusCode, 409, `${condition}/${mode}/${phase}`);
          assert.equal(result.body.code, 'CONDITION_CONFIRMATION_REQUIRED');
          assert.equal(result.body.needsConfirmation, true);
          assert.match(result.body.error, /enter or select the full condition name/i);
        }
      }
    }

    const topLevelCondition = await invoke({
      mode: 'research',
      phase: 'gather',
      condition: 'B.P.D.',
      patient: {},
      conditionResolution: { needsConfirmation: false }
    });
    assert.equal(topLevelCondition.statusCode, 409);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('frontend checks all paid research modes and returns to Profile for confirmation', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  assert.match(source, /mode === 'research' \|\| mode === 'repurpose' \|\| mode === 'trials'/);
  assert.match(source, /if \(resolution\?\.needsConfirmation\)/);
  assert.match(source, /setTab\('profile'\)/);
  assert.match(source, /enter or select the full condition name/i);
});
