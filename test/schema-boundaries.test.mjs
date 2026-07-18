import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoDuplicateJsonKeys,
  parseJsonRejectDuplicates
} from '../lib/strict-json.js';

test('rejects duplicate keys at every object depth', () => {
  assert.throws(
    () => parseJsonRejectDuplicates('{"items":[],"items":[1]}'),
    /Duplicate JSON key: items/
  );
  assert.throws(
    () => parseJsonRejectDuplicates('{"safe":{"redFlags":[],"redFlags":["x"]}}'),
    /Duplicate JSON key: redFlags/
  );
});

test('allows the same key in separate objects and escaped key text', () => {
  const parsed = parseJsonRejectDuplicates(
    '{"left":{"name":"a"},"right":{"name":"b"},"escaped":{"na\\u006de":"c"}}'
  );
  assert.equal(parsed.left.name, 'a');
  assert.equal(parsed.right.name, 'b');
  assert.equal(parsed.escaped.name, 'c');
});

test('does not treat string contents as object keys', () => {
  assert.doesNotThrow(() =>
    assertNoDuplicateJsonKeys('{"text":"{\\"same\\":1,\\"same\\":2}","same":1}')
  );
});
