const budgets = [50000, 100000, 200000, 400000, 1000000];

/**
 * Fusion's optional suffix is local metadata, never a provider model/tariff.
 * @param {string} value
 * @returns {{ choice: string, context?: number }}
 */
export function splitContext(value) {
  const match = /@(\d+)(k|M)$/.exec(value);
  return match ? { choice: value.slice(0, match.index), context: Number(match[1]) * (match[2] === 'M' ? 1000000 : 1000) } : { choice: value };
}

/** @param {number} tokens */
export function contextLabel(tokens) {
  return tokens >= 1000000 ? `${tokens / 1000000}M` : `${tokens / 1000}k`;
}

/**
 * @param {string} value
 * @param {number} [context]
 */
export function withContext(value, context) {
  return `${splitContext(value).choice}${context === undefined ? '' : `@${contextLabel(context)}`}`;
}

/** @param {number | undefined} window */
export function contextOptions(window) {
  return budgets.filter(value => Number.isSafeInteger(window) && value <= window);
}

/**
 * @param {number | undefined} context
 * @param {number | undefined} window
 */
export function validateContext(context, window) {
  if (context === undefined) return;
  if (!budgets.includes(context) || !contextOptions(window).includes(context)) {
    throw new Error(`Context budget ${contextLabel(context)} is unavailable for this model (native context: ${window === undefined ? 'unknown' : contextLabel(window)}). Choose Default or a supported smaller context.`);
  }
}
