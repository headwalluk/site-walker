import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NormalisedParametersSchema, parseModelSlug } from './types.js';

test('parseModelSlug: splits on first `/` only', () => {
  assert.deepEqual(parseModelSlug('pi/qwen2:1.5b'), { provider: 'pi', model: 'qwen2:1.5b' });
  assert.deepEqual(parseModelSlug('openrouter/anthropic/claude-haiku-4.5'), {
    provider: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
  });
  assert.deepEqual(parseModelSlug('anthropic/claude-haiku-4.5'), {
    provider: 'anthropic',
    model: 'claude-haiku-4.5',
  });
});

test('parseModelSlug: rejects missing slash, empty provider, empty model', () => {
  assert.throws(() => parseModelSlug('qwen2'), /Invalid model slug/);
  assert.throws(() => parseModelSlug('/qwen2'), /Invalid model slug/);
  assert.throws(() => parseModelSlug('pi/'), /Invalid model slug/);
  assert.throws(() => parseModelSlug(''), /Invalid model slug/);
});

test('NormalisedParametersSchema: accepts empty object', () => {
  const parsed = NormalisedParametersSchema.parse({});
  assert.deepEqual(parsed, {});
});

test('NormalisedParametersSchema: accepts valid keys', () => {
  const parsed = NormalisedParametersSchema.parse({
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 256,
    stop: ['</s>'],
  });
  assert.equal(parsed.temperature, 0.7);
  assert.equal(parsed.top_p, 0.9);
  assert.equal(parsed.max_tokens, 256);
  assert.deepEqual(parsed.stop, ['</s>']);
});

test('NormalisedParametersSchema: rejects unknown keys', () => {
  assert.throws(() => NormalisedParametersSchema.parse({ frequency_penalty: 0.5 }));
});

test('NormalisedParametersSchema: rejects out-of-range values', () => {
  assert.throws(() => NormalisedParametersSchema.parse({ temperature: 3 }));
  assert.throws(() => NormalisedParametersSchema.parse({ temperature: -0.1 }));
  assert.throws(() => NormalisedParametersSchema.parse({ top_p: 1.5 }));
  assert.throws(() => NormalisedParametersSchema.parse({ max_tokens: 0 }));
  assert.throws(() => NormalisedParametersSchema.parse({ max_tokens: 1.5 }));
});
