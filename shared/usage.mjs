const metrics = /** @type {const} */ (['input', 'output', 'cacheRead', 'cacheWrite', 'cost']);
/** @typedef {typeof metrics[number]} Metric */
/** @typedef {{model: string} & Partial<Record<Metric, number>>} UsageRecord */
/** @typedef {{model: string, records: number, values: Record<Metric, number>, missing: Record<Metric, number>}} UsageRow */
/** @param {string} model @returns {UsageRow} */
function row(model) {
  return { model, records: 0, values: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, missing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
}

/** @param {UsageRecord[]} records */
export function summarizeUsage(records) {
  const models = new Map();
  const total = row('Total');
  for (const record of records) {
    if (!models.has(record.model)) models.set(record.model, row(record.model));
    for (const target of [models.get(record.model), total]) {
      target.records++;
      for (const metric of metrics) {
        const value = record[metric];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target.values[metric] += value;
        else target.missing[metric]++;
      }
    }
  }
  return { models: /** @type {UsageRow[]} */ ([...models.values()]).sort((a, b) => a.model.localeCompare(b.model)), total };
}

/** @param {ReturnType<typeof summarizeUsage>} report @param {number} sessions @param {string[]} [notes] */
export function formatUsage(report, sessions, notes = []) {
  if (!report.total.records) return ['No recorded usage yet.', ...notes].join('\n');
  /** @param {UsageRow} row @param {Metric} metric */
  const value = (row, metric) => row.missing[metric] === row.records ? 'n/a'
    : (metric === 'cost' ? `$${row.values[metric].toFixed(4)}` : row.values[metric].toLocaleString('en-US')) + (row.missing[metric] ? ' (partial)' : '');
  const lines = [`Recorded usage · ${sessions} session${sessions === 1 ? '' : 's'} (including descendants)`, ''];
  for (const row of [...report.models, report.total]) {
    lines.push(row.model.replace(/[\x00-\x1f\x7f-\x9f]/g, ''),
      `  Input ${value(row, 'input')} · Output ${value(row, 'output')}`,
      `  Cache read ${value(row, 'cacheRead')} · Cache write ${value(row, 'cacheWrite')}`,
      `  Cost (USD) ${value(row, 'cost')}`, '');
  }
  lines.push('Recorded costs are estimates, not invoices. Unpriced/subscription costs may be unavailable.',
    'n/a = not recorded; partial = known subtotal only. In-flight or unrecorded requests may be absent.', ...notes);
  return lines.join('\n');
}
