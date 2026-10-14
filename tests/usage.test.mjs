import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, formatUsage } from '../shared/usage.mjs';

test('usage combines model calls and preserves partial token and cost coverage', () => {
  const report = summarizeUsage([
    { model: 'p/a', input: 1000, output: 80, cacheRead: 200, cacheWrite: 30, cost: 0.12 },
    { model: 'p/b', input: 400, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
    { model: 'p/a', input: 50, output: 10, cacheRead: 100, cacheWrite: 0 },
    { model: 'p/c' },
  ]);
  assert.equal(report.models.find(row => row.model === 'p/a').values.input, 1050);
  assert.equal(report.models.find(row => row.model === 'p/a').values.cacheRead, 300);
  assert.equal(report.total.values.output, 110);
  assert.equal(report.total.values.cacheWrite, 30);
  assert.equal(report.total.values.cost, 0.12);
  assert.equal(report.total.missing.input, 1);
  assert.equal(report.total.missing.cost, 2);
  assert.equal(report.models.find(row => row.model === 'p/b').missing.cost, 0);
  const rendered = formatUsage(report, 3);
  assert.match(rendered, /1,450 \(partial\)/);
  assert.match(rendered, /\$0\.1200 \(partial\)/);
  assert.match(rendered, /\$0\.0000/);
  assert.match(rendered, /n\/a/);
});

test('empty sessions and invalid metrics never masquerade as measured zero usage', () => {
  assert.match(formatUsage(summarizeUsage([]), 1), /No recorded usage/);
  const report = summarizeUsage([{ model: 'p/a', input: NaN, output: -1, cacheRead: Infinity }]);
  assert.equal(report.total.missing.input, 1);
  assert.equal(report.total.missing.output, 1);
  assert.equal(report.total.missing.cacheRead, 1);
});
