import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectUsage } from './usage.ts';
import { createFusion } from './index.ts';

const usage = (input: number) => ({ input, output: 10, cacheRead: 20, cacheWrite: 5, totalTokens: input + 35, cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } });
const assistant = (id: string, model: string, input: number) => ({ type: 'message', id, message: { role: 'assistant', provider: 'p', model, usage: usage(input) } });
const owner = (root: string, role = 'sidekick') => ({ type: 'custom', customType: 'fusion.pi.owner', data: { root, caller: root, role } });

test('Pi usage counts stored descendants once, includes summaries, and excludes unrelated sessions and mirrored results', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-usage-');
  const rootEntries = [assistant('a', 'one', 100), assistant('b', 'two', 200),
    { type: 'compaction', id: 'sum', usage: usage(50) },
    { type: 'usage', id: 'warm', provider: 'p', model: 'one', usage: usage(25) },
    { type: 'message', id: 'mirror', message: { role: 'toolResult', toolName: 'fusion_delegate', usage: usage(9999) } },
    { type: 'custom_message', customType: 'fusion.pi.background-result', details: { usage: usage(9999) } },
  ];
  const files: Record<string, any[]> = {
    child: [owner('root', 'advisor'), assistant('c', 'two', 300)],
    evidence: [owner('child'), assistant('d', 'one', 400)],
    foreign: [owner('other-root'), assistant('e', 'one', 10000)],
  };
  for (const [id, entries] of Object.entries(files)) {
    const parent = id === 'evidence' ? 'child' : id === 'foreign' ? 'other-root' : 'root';
    await writeFile(join(dir, `${id}.jsonl`), [JSON.stringify({ type: 'session', id, cwd: '/work', parentSession: parent }), ...entries.map(entry => JSON.stringify(entry))].join('\n') + '\n');
  }
  const ctx: any = { cwd: '/work', sessionManager: { getSessionId: () => 'root', getEntries: () => rootEntries }, modelRegistry: { find: () => undefined } };
  const result = await collectUsage(ctx, dir);
  assert.equal(result.sessions, 3);
  assert.equal(result.report.models.find(row => row.model === 'p/one')?.values.input, 525);
  assert.equal(result.report.models.find(row => row.model === 'p/two')?.values.input, 500);
  assert.equal(result.report.models.find(row => row.model === 'Unattributed')?.values.input, 50);
  assert.equal(result.report.total.values.input, 1075);
  assert.equal(result.report.total.values.cacheWrite, 30);
  assert.ok(Math.abs(result.report.total.values.cost - 0.6) < 1e-10);
  assert.deepEqual(result.notes, []);
});

test('Pi reports unavailable child histories and incomplete writes without repairing files or claiming complete totals', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-usage-partial-');
  const file = join(dir, 'child.jsonl');
  const data = [
    { type: 'session', id: 'child', cwd: '/work', parentSession: 'root' }, owner('root'), assistant('a', 'one', 100),
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n{"type":';
  await writeFile(file, data);
  const ctx: any = { cwd: '/work', sessionManager: { getSessionId: () => 'root', getEntries: () => [
    { type: 'custom', customType: 'fusion.pi.child', data: { id: 'missing' } },
    { type: 'message', id: 'unpriced', message: { role: 'assistant', provider: 'p', model: 'two', usage: { ...usage(10), cost: { total: 0 } } } },
  ] }, modelRegistry: { find: () => undefined } };
  const result = await collectUsage(ctx, dir);
  assert.equal(result.report.total.values.input, 110);
  assert.equal(result.report.models.find(row => row.model === 'p/two')?.missing.cost, 1);
  assert.ok(result.notes.length > 0);
  assert.equal(await readFile(file, 'utf8'), data);
});

test('/usage works without Fusion setup and displays a report without changing model or history', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-usage-command-');
  const commands = new Map<string, any>(), notices: string[] = [];
  createFusion({ registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool() {}, on() {} } as any, undefined, dir);
  const entries = [assistant('a', 'one', 1234)];
  const before = JSON.stringify(entries);
  await commands.get('usage')('', { cwd: dir, sessionManager: { getSessionId: () => 'root', getEntries: () => entries },
    modelRegistry: { find: () => undefined }, ui: { notify: (text: string) => notices.push(text) } });
  assert.match(notices[0], /1,234/);
  assert.match(notices[0], /\$0\.1000/);
  assert.equal(JSON.stringify(entries), before);
});
