const type = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const strings = (value) => value === undefined || Array.isArray(value) && value.every(item => typeof item === 'string' && item);

export function reasoningEfforts(model) {
  const options = model.capabilities?.supports?.reasoning_effort ?? model.supportedReasoningEfforts;
  return options?.length ? options : model.defaultReasoningEffort ? [model.defaultReasoningEffort] : [];
}

export function contextTiers(model) {
  if (model.supportedContextTiers != null) {
    return model.supportedContextTiers.filter(tier => ['default', 'long_context'].includes(tier));
  }
  // Native session catalogs use CAPI TieredTokenPrices; normalized relay/server
  // projections expose ModelBillingTokenPrices.longContext instead.
  const native = model.billing?.token_prices;
  if (typeof native?.default?.max_prompt_tokens === 'number' && native.default.max_prompt_tokens > 0
    && typeof native?.long_context?.max_prompt_tokens === 'number' && native.long_context.max_prompt_tokens > 0
    || type(model.billing?.tokenPrices?.longContext) === 'object') return ['default', 'long_context'];
  return [];
}

export function contextLimits(model, tier) {
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  const limits = model.capabilities?.limits;
  const baseInput = positive(limits?.max_prompt_tokens);
  const output = positive(limits?.max_output_tokens);
  const native = model.billing?.token_prices?.[tier];
  const normalized = tier === 'long_context' ? model.billing?.tokenPrices?.longContext : model.billing?.tokenPrices;
  const tierInput = positive(native?.max_prompt_tokens) ?? positive(normalized?.maxPromptTokens) ?? positive(normalized?.contextMax);
  const inputTokens = tierInput ?? (tier === 'default' ? baseInput : undefined);
  // Tier pricing overrides the total even when its input budget matches the base.
  const baseTotal = tier === 'default' && tierInput === undefined
    ? positive(limits?.max_context_window_tokens) : undefined;
  const contextTokens = baseTotal ?? (inputTokens !== undefined && output !== undefined ? positive(inputTokens + output) : undefined);
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(contextTokens !== undefined ? { contextTokens } : {}) };
}

// SessionModelList uses `list: JsonValue[]`, unlike server ModelList.models.
// Validate only the entry fields consumed by the picker and model guard.
export async function listModels(session, stage) {
  const response = await session.rpc.model.list({});
  const list = response?.list;
  const detail = `stage=${stage}, responseType=${type(response)}, listType=${type(list)}, listCount=${Array.isArray(list) ? list.length : 'unknown'}, providerCount=${Array.isArray(response?.providers) ? response.providers.length : 'unreported'}`;
  if (type(response) !== 'object' || !Array.isArray(list)) {
    throw new Error(`Unrecognized session.model.list response (${detail}); no fallback was selected. Report the CLI version and these diagnostics.`);
  }
  for (const [entryIndex, model] of list.entries()) {
    const invalid = type(model) !== 'object' ? ['entry', model] : [
      ['id', model.id, typeof model.id === 'string' && !!model.id],
      ['supportedReasoningEfforts', model.supportedReasoningEfforts, strings(model.supportedReasoningEfforts)],
      ['capabilities.supports.reasoning_effort', model.capabilities?.supports?.reasoning_effort,
        model.capabilities?.supports?.reasoning_effort === null || strings(model.capabilities?.supports?.reasoning_effort)],
      ['supportedContextTiers', model.supportedContextTiers, model.supportedContextTiers === null || strings(model.supportedContextTiers)],
      ['defaultReasoningEffort', model.defaultReasoningEffort, model.defaultReasoningEffort === undefined
        || typeof model.defaultReasoningEffort === 'string' && !!model.defaultReasoningEffort],
    ].find(([, , valid]) => !valid);
    if (invalid) {
      throw new Error(`Unrecognized session.model.list response (${detail}, entryIndex=${entryIndex}, field=${invalid[0]}, valueType=${type(invalid[1])}); no fallback was selected. Report the CLI version and these diagnostics.`);
    }
  }
  if (!list.length) {
    throw new Error(`No models are available from session.model.list (${detail}); no fallback was selected. Report the CLI version and these diagnostics.`);
  }
  return list;
}
