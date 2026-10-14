import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as models from '../com.github.copilot/extensions/fusion-guard/models.mjs';

test('native tier metadata separates input budgets from total context with nullable supported tiers', () => {
  const model = {
    id: 'p/tiered', supportedContextTiers: null,
    capabilities: { limits: {
      max_context_window_tokens: 200000, max_prompt_tokens: 180000, max_output_tokens: 20000,
    } },
    billing: { token_prices: {
      default: { max_prompt_tokens: 120000 }, long_context: { max_prompt_tokens: 980000 },
    } },
  };
  assert.deepEqual(models.contextTiers(model), ['default', 'long_context']);
  assert.equal(models.contextLimits(model, 'default').inputTokens, 120000);
  assert.equal(models.contextLimits(model, 'default').contextTokens, 140000);
  assert.equal(models.contextLimits(model, 'long_context').inputTokens, 980000);
  assert.equal(models.contextLimits(model, 'long_context').contextTokens, 1000000);
});

test('normalized prompt limits and legacy contextMax aliases are input budgets', () => {
  for (const field of ['maxPromptTokens', 'contextMax']) {
    const model = {
      id: 'p/normalized', supportedContextTiers: null,
      capabilities: { limits: { max_output_tokens: 16000 } },
      billing: { tokenPrices: { [field]: 128000, longContext: { [field]: 1000000 } } },
    };
    assert.equal(models.contextLimits(model, 'default').inputTokens, 128000);
    assert.equal(models.contextLimits(model, 'default').contextTokens, 144000);
    assert.equal(models.contextLimits(model, 'long_context').inputTokens, 1000000);
    assert.equal(models.contextLimits(model, 'long_context').contextTokens, 1016000);
  }
});

test('reported base total applies without tier pricing; explicit tier pricing overrides it', () => {
  const model = { capabilities: { limits: {
    max_context_window_tokens: 200000, max_prompt_tokens: 128000, max_output_tokens: 32000,
  } }, billing: null };
  assert.equal(models.contextLimits(model, 'default').inputTokens, 128000);
  assert.equal(models.contextLimits(model, 'default').contextTokens, 200000);
  model.billing = { token_prices: { default: { max_prompt_tokens: 128000 } } };
  assert.equal(models.contextLimits(model, 'default').contextTokens, 160000);
});

test('missing output cannot turn a tier input override into a known total context', () => {
  const model = { capabilities: { limits: {
    max_context_window_tokens: 200000, max_prompt_tokens: 128000,
  } }, billing: { token_prices: { long_context: { max_prompt_tokens: 1000000 } } } };
  assert.equal(models.contextLimits(model, 'default').contextTokens, 200000);
  model.billing.token_prices.default = { max_prompt_tokens: 128000 };
  assert.equal(models.contextLimits(model, 'default').contextTokens, undefined);
  model.billing.token_prices.default.max_prompt_tokens = 120000;
  assert.equal(models.contextLimits(model, 'default').inputTokens, 120000);
  assert.equal(models.contextLimits(model, 'default').contextTokens, undefined);
  assert.equal(models.contextLimits(model, 'long_context').inputTokens, 1000000);
  assert.equal(models.contextLimits(model, 'long_context').contextTokens, undefined);
  delete model.capabilities.limits.max_prompt_tokens;
  assert.equal(models.contextLimits(model, 'default').contextTokens, undefined);
});

test('missing long-tier input never borrows base budgets and missing base total can be derived', () => {
  const model = { capabilities: { limits: { max_prompt_tokens: 128000, max_output_tokens: 16000 } },
    billing: { token_prices: null, tokenPrices: null } };
  assert.equal(models.contextLimits(model, 'default').contextTokens, 144000);
  assert.equal(models.contextLimits(model, 'long_context').inputTokens, undefined);
  assert.equal(models.contextLimits(model, 'long_context').contextTokens, undefined);
});

test('malformed limits remain unknown rather than coercing values or guessing totals', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, 0, -1, '128000', true, {}]) {
    const model = { capabilities: { limits: {
      max_context_window_tokens: value, max_prompt_tokens: value, max_output_tokens: value,
    } }, billing: {
      token_prices: { default: { max_prompt_tokens: value }, long_context: { max_prompt_tokens: value } },
      tokenPrices: { maxPromptTokens: value, contextMax: value,
        longContext: { maxPromptTokens: value, contextMax: value } },
    } };
    for (const tier of ['default', 'long_context']) {
      assert.equal(models.contextLimits(model, tier).inputTokens, undefined);
      assert.equal(models.contextLimits(model, tier).contextTokens, undefined);
    }
    model.capabilities.limits.max_prompt_tokens = 128000;
    assert.equal(models.contextLimits(model, 'default').inputTokens, 128000);
    assert.equal(models.contextLimits(model, 'default').contextTokens, undefined);
  }
});
