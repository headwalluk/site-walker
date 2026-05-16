import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from './tokens.js';

test('estimateTokens: ceil(chars / 3)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('ab'), 1);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 2);
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens('abcdefg'), 3);
});
