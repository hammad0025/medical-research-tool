import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize,
  normalizePasscode,
  parseExplicitBoolean,
  parsePageSize
} from '../lib/normalize.js';
import {
  assertNoDuplicateJsonKeys,
  parseJsonRejectDuplicates
} from '../lib/strict-json.js';

const seeded = (seed = 0x5eed1234) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

test('normalize is idempotent and invariant to seeded case, spacing, and punctuation noise', () => {
  const random = seeded();
  const words = ['Idiopathic', 'Pulmonary', 'Fibrosis'];
  for (let i = 0; i < 100; i += 1) {
    const noisy = words
      .map((word) => random() < 0.5 ? word.toUpperCase() : word.toLowerCase())
      .join(random() < 0.5 ? '   ' : ` ${['-', '/', ','][Math.floor(random() * 3)]} `);
    const once = normalize(noisy);
    assert.equal(normalize(once), once, `idempotence failed for ${JSON.stringify(noisy)}`);
    assert.equal(once, 'idiopathic pulmonary fibrosis');
  }

  assert.equal(normalize('Café\u0301 type 1.5—disease'), 'cafe type 1.5 disease');
  assert.equal(normalize('type 1.5'), 'type 1.5', 'decimal subtype punctuation must survive');
});

test('explicit parsers reject truthiness and numeric-prefix mutation classes', () => {
  const trueTokens = ['true', '1', 'yes', 'on'];
  const falseTokens = ['false', '0', 'no', 'off'];
  for (const token of trueTokens) {
    assert.equal(parseExplicitBoolean(` \t${token.toUpperCase()}\n`, false), true);
  }
  for (const token of falseTokens) {
    assert.equal(parseExplicitBoolean(` \t${token.toUpperCase()}\n`, true), false);
  }
  for (const mutation of ['truthy', '00', '1e0', '-1', 'yesplease', {}, []]) {
    assert.equal(parseExplicitBoolean(mutation, false), false, `${String(mutation)} must use fallback`);
  }

  const options = { fallback: 17, min: 3, max: 50 };
  assert.equal(parsePageSize('2', options), 3);
  assert.equal(parsePageSize('3', options), 3);
  assert.equal(parsePageSize('50', options), 50);
  assert.equal(parsePageSize('51', options), 50);
  for (const mutation of ['2.9', '3x', '-3', '+3', '1e2', '', '9007199254740992']) {
    assert.equal(parsePageSize(mutation, options), 17, `${mutation} must not be partially parsed`);
  }
  assert.equal(normalizePasscode('  A-B_C!  '), 'a-b_c!');
});

test('strict JSON seeded nested duplicates fail while sibling keys remain legal', () => {
  const random = seeded(0xd00f);
  for (let i = 0; i < 80; i += 1) {
    const key = `field_${Math.floor(random() * 1e6)}`;
    const nestedDuplicate = JSON.stringify({
      envelope: { safe: i }
    }).replace(`"safe":${i}`, `"${key}":${i},"${key}":${i + 1}`);
    assert.throws(
      () => parseJsonRejectDuplicates(nestedDuplicate),
      new RegExp(`Duplicate JSON key: ${key}`)
    );

    const siblings = `{"left":{"${key}":${i}},"right":{"${key}":${i + 1}}}`;
    assert.doesNotThrow(() => parseJsonRejectDuplicates(siblings));
  }
});

test('strict JSON compares decoded keys and ignores key-like string payloads', () => {
  assert.throws(
    () => parseJsonRejectDuplicates('{"name":1,"na\\u006de":2}'),
    /Duplicate JSON key: name/
  );
  assert.throws(
    () => parseJsonRejectDuplicates('{"\\ud83d\\ude80":1,"🚀":2}'),
    /Duplicate JSON key: 🚀/
  );
  assert.doesNotThrow(() => assertNoDuplicateJsonKeys(
    '{"payload":"{\\"x\\":1,\\"x\\":2}","items":[{"x":1},{"x":2}]}'
  ));
  assert.throws(() => parseJsonRejectDuplicates('{"x":"unterminated}'), /Unterminated JSON string/);
});
