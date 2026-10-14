import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitContext, withContext, contextLabel, contextOptions, validateContext } from '../shared/context.mjs';

test('context choices retain model/effort and can return to the native default', () => {
  const value = withContext('openrouter/anthropic/haiku#high', 100000);
  assert.deepEqual(splitContext(value), { choice: 'openrouter/anthropic/haiku#high', context: 100000 });
  assert.equal(withContext(value), 'openrouter/anthropic/haiku#high');
  assert.deepEqual(splitContext('p/model#off'), { choice: 'p/model#off' });
});

test('context choices cannot exceed model capacity or accept unsupported budgets', () => {
  assert.ok(contextOptions(128000).includes(100000));
  assert.ok(!contextOptions(128000).includes(200000));
  assert.throws(() => validateContext(200000, 128000), /context/i);
  assert.throws(() => validateContext(99000, 200000), /context/i);
  assert.throws(() => validateContext(100000, undefined), /context/i);
  assert.doesNotThrow(() => validateContext(undefined, undefined));
});

test('million-token choices use M units and still accept saved k-unit choices', () => {
  assert.equal(contextLabel(1000000), '1M');
  assert.equal(contextLabel(100000), '100k');
  assert.equal(withContext('p/astra#high', 1000000), 'p/astra#high@1M');
  assert.deepEqual(splitContext('p/astra#high@1M'), splitContext('p/astra#high@1000k'));
  assert.ok(contextOptions(1050000).includes(1000000));
  assert.ok(contextOptions(10000000).every(value => value <= 1000000));
  assert.throws(() => validateContext(splitContext('p/astra#high@10M').context, 10000000), /context/i);
});
