import test from 'node:test';
import assert from 'node:assert/strict';

import { checkProfileCoherence, checkDossierProfileCoherence } from '../lib/profile-coherence.js';
import { isLinkCheckEnabled } from '../api/research.js';

// ---------------------------------------------------------------------------
// F9 — profile/sex coherence generalized beyond breast cancer.
// ---------------------------------------------------------------------------
test('flags sex-specific condition vs mismatched profile sex', () => {
  for (const [condition, gender] of [
    ['prostate cancer', 'female'],
    ['benign prostatic hyperplasia', 'female'],
    ['testicular cancer', 'female'],
    ['ovarian cancer', 'male'],
    ['endometriosis', 'male'],
    ['uterine fibroids', 'male'],
    ['cervical cancer', 'male'],
    ['male breast cancer', 'female'],   // preserved original behavior
    ['female breast cancer', 'male']     // preserved original behavior
  ]) {
    const r = checkProfileCoherence({ condition, gender });
    assert.equal(r.ok, false, `${condition} + ${gender} should flag`);
    assert.equal(r.code, 'PROFILE_INCOHERENT');
  }
});

test('does NOT flag coherent or sex-neutral conditions (no false positives)', () => {
  for (const [condition, gender] of [
    ['breast cancer', 'male'],            // both sexes get breast cancer
    ['breast cancer', 'female'],
    ['prostate cancer', 'male'],
    ['ovarian cancer', 'female'],
    ['cervical spondylosis', 'male'],     // cervical SPINE — must not trip "cervix"
    ['cervical radiculopathy', 'female'],
    ['lung cancer', 'female'],
    ['hypertension', 'male'],
    ['type 2 diabetes', 'female']
  ]) {
    assert.equal(checkProfileCoherence({ condition, gender }).ok, true,
      `${condition} + ${gender} should NOT flag`);
  }
});

test('missing condition or sex is a no-op', () => {
  assert.equal(checkProfileCoherence({ condition: 'prostate cancer' }).ok, true);
  assert.equal(checkProfileCoherence({ gender: 'female' }).ok, true);
});

test('dossier coherence catches a wrong-sex stale pool', () => {
  // patient condition is neutral + female, but the gathered dossier resolved to
  // a male-specific disease → stale/contaminated pool.
  const r = checkDossierProfileCoherence(
    { condition: 'cancer', gender: 'female' },
    { canonical: 'Prostate cancer' }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATHER_STALE');
  // coherent dossier passes
  assert.equal(
    checkDossierProfileCoherence({ condition: 'ovarian cancer', gender: 'female' },
      { canonical: 'Ovarian cancer' }).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// F8 — the link-check disable toggle is ignored in production/preview.
// ---------------------------------------------------------------------------
test('MRT_LINKCHECK_ENABLED=0 is honored locally but NOT in production', () => {
  const saved = { v: process.env.VERCEL_ENV, n: process.env.NODE_ENV, l: process.env.MRT_LINKCHECK_ENABLED };
  try {
    // local/CI: toggle honored
    delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
    process.env.MRT_LINKCHECK_ENABLED = '0';
    assert.equal(isLinkCheckEnabled(), false, 'toggle should be honored outside production');

    process.env.MRT_LINKCHECK_ENABLED = '1';
    assert.equal(isLinkCheckEnabled(), true);

    // production: toggle ignored, link-check forced on
    process.env.VERCEL_ENV = 'production';
    process.env.MRT_LINKCHECK_ENABLED = '0';
    assert.equal(isLinkCheckEnabled(), true, 'production must force link-check on');

    // preview counts as production for this purpose
    process.env.VERCEL_ENV = 'preview';
    assert.equal(isLinkCheckEnabled(), true);
  } finally {
    if (saved.v === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.v;
    if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
    if (saved.l === undefined) delete process.env.MRT_LINKCHECK_ENABLED; else process.env.MRT_LINKCHECK_ENABLED = saved.l;
  }
});
