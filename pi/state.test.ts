import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, activeState, choose, label, parseChoice, resolveChoice, validateSetup, type Registry } from './state.ts';

const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'], thinkingLevelMap: { xhigh: 'xhigh' } })) as unknown as ReturnType<Registry['getAvailable']>;
const registry: Registry = {
  find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id),
  getAvailable: () => models,
  hasConfiguredAuth: () => true,
};

test('explicit efforts, distinct required choices, and no implicit models', () => {
  assert.throws(() => validateSetup({ lead: 'p/a#high', sidekick: 'p/a#high' }, registry), /different/);
  assert.throws(() => validateSetup({ lead: 'p/a', sidekick: 'p/b#high' }, registry), /effort/);
  assert.throws(() => validateSetup({ lead: 'p/a#invalid', sidekick: 'p/b#high' }, registry), /effort/);
  assert.throws(() => validateSetup({ lead: 'p/a#high', sidekick: 'p/b#high' }, { ...registry, hasConfiguredAuth: () => false }), /authentication/);
  assert.equal(label(parseChoice('p/a#xhigh')!), 'p/a#xhigh');
});

test('context choices roundtrip, validate native limits and clone without changing the registry model', () => {
  const native = { ...models[0], contextWindow: 250000, maxTokens: 32000 };
  const budgetRegistry: Registry = { ...registry, find: () => native };
  const ref = parseChoice('p/a#low@100k')!;
  assert.equal(ref.context, 100000);
  assert.equal(label(ref), 'p/a#low@100k');
  const selected = resolveChoice(label(ref), budgetRegistry);
  assert.equal(selected.model.contextWindow, 100000);
  assert.notEqual(selected.model, native);
  assert.deepEqual(selected.model, { ...native, contextWindow: 100000 });
  assert.equal(selected.effort, 'low');
  assert.equal(native.contextWindow, 250000);
  assert.equal(resolveChoice('p/a#low', budgetRegistry).model.contextWindow, 250000);
  for (const choice of ['p/a#low@75k', 'p/a#low@400k']) assert.throws(() => resolveChoice(choice, budgetRegistry), /Context budget/);
  assert.equal(parseChoice('p/a#low@100k@200k'), undefined);
  assert.throws(() => validateSetup({ lead: 'p/a#low@50k', sidekick: 'p/a#low@100k' }, budgetRegistry), /different/);
  assert.throws(() => resolveChoice('p/a#low@1000k', { ...budgetRegistry, getAvailable: () => [] }), /p\/a#low@1M/);
});

test('budget choices persist unchanged in branch state and role history alongside native defaults', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-state-context-');
  const history = new History(dir, '/context/work');
  const setup = { lead: 'p/a#high@100k', sidekick: 'p/b#low@50k', advisor: 'p/a#low', reviewer: 'p/b#medium@200k' };
  await history.record(setup, { lead: true, sidekick: true, advisor: true, reviewer: true });
  await history.record({ ...setup, lead: 'p/a#high' }, { lead: true });
  const stored = await new History(dir, '/context/work').load();
  assert.equal(stored.last?.sidekick, setup.sidekick);
  assert.equal(stored.last?.reviewer, setup.reviewer);
  assert.deepEqual(stored.recents.lead, ['p/a#high', setup.lead]);
  assert.deepEqual(activeState([{ type: 'custom', customType: 'fusion.pi.setup', data: setup }]).setup, setup);
});

test('reviewer stays optional and an explicit choice survives off and legacy history loading', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-state-reviewer-');
  const history = new History(dir, '/review/work');
  const setup = { lead: 'p/a#high', sidekick: 'p/b#medium', advisor: 'p/a#low' };
  await mkdir(history.dir, { recursive: true });
  await writeFile(history.path, JSON.stringify({ version: 1, last: setup, recents: { lead: [setup.lead], sidekick: [setup.sidekick], advisor: [setup.advisor] } }));
  const legacy = await history.load();
  assert.equal(legacy.last?.reviewer, undefined);
  assert.deepEqual(legacy.recents.reviewer, []);
  assert.equal(legacy.last?.lead, setup.lead);
  assert.deepEqual(legacy.recents.advisor, [setup.advisor]);
  const reviewed = validateSetup({ ...legacy.last, reviewer: 'p/a#high' }, registry);
  assert.equal(reviewed.reviewer, 'p/a#high', 'same family/choice is allowed; diversity is advice only');
  await history.record(reviewed, { reviewer: true });
  await history.record(choose(reviewed, { reviewer: null }), { reviewer: true });
  const disabled = await history.load();
  assert.equal(disabled.last?.reviewer, undefined);
  assert.deepEqual(disabled.recents.reviewer, ['p/a#high']);
  assert.deepEqual(disabled.recents.lead, [setup.lead]);
  assert.deepEqual(disabled.recents.sidekick, [setup.sidekick]);
  assert.deepEqual(disabled.recents.advisor, [setup.advisor]);
});

test('recent choices are per-role newest-first deduped capped at three; off retains history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-state-'));
  const history = new History(dir, '/a/work');
  for (const role of ['lead', 'sidekick', 'advisor', 'reviewer'] as const) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'medium']) {
      await history.record({ [role]: `p/a#${effort}` }, { [role]: true });
    }
  }
  for (const role of ['lead', 'sidekick', 'advisor', 'reviewer'] as const) {
    assert.deepEqual((await history.load()).recents[role], ['p/a#medium', 'p/a#xhigh', 'p/a#high']);
  }
  await history.record({ advisor: undefined }, { advisor: true });
  assert.deepEqual((await history.load()).recents.advisor, ['p/a#medium', 'p/a#xhigh', 'p/a#high']);
  assert.deepEqual((await new History(dir, '/another/work').load()).recents.lead, []);
  await writeFile(history.path, '{broken');
  await assert.rejects(history.record({ lead: 'p/a#low' }, { lead: true }), /history/);
  assert.equal(await readFile(history.path, 'utf8'), '{broken');
});

test('active branch chooses its last setup and retains confirmed sidekicks', () => {
  const setup = { lead: 'p/a#high', sidekick: 'p/b#high' };
  const base = { type: 'custom', customType: 'fusion.pi.setup', data: setup };
  const child = { type: 'custom', customType: 'fusion.pi.child', data: { role: 'sidekick', id: 'safe-id-1' } };
  const second = { ...child, data: { role: 'sidekick', id: 'safe-id-2' } };
  assert.deepEqual(activeState([base, child]).sidekicks, ['safe-id-1']);
  const changed = activeState([base, child, second, { ...base, data: { ...setup, sidekick: 'p/a#low' } }]);
  assert.deepEqual(changed.setup, { ...setup, sidekick: 'p/a#low' });
  assert.deepEqual(changed.sidekicks, ['safe-id-1', 'safe-id-2']);
  assert.deepEqual(activeState([base]).sidekicks, []);
  assert.deepEqual(activeState([]).sidekicks, []);
  assert.deepEqual(choose(setup, { advisor: null }), { ...setup, advisor: undefined });
});

test('branch-local Fusion off retains setup and child IDs until explicitly re-enabled', () => {
  const setup = { lead: 'p/a#high', sidekick: 'p/b#medium' };
  const base = { type: 'custom', customType: 'fusion.pi.setup', data: setup };
  const child = { type: 'custom', customType: 'fusion.pi.child', data: { role: 'sidekick', id: 'sidekick-123' } };
  const second = { ...child, data: { role: 'sidekick', id: 'sidekick-456' } };
  const off = { type: 'custom', customType: 'fusion.pi.disabled', data: {} };
  const disabled = activeState([base, child, second, off]);
  assert.deepEqual(disabled.sidekicks, ['sidekick-123', 'sidekick-456']);
  assert.deepEqual(disabled.setup, setup);
  assert.equal(disabled.disabled, true);
  const enabled = activeState([base, child, second, off, base]);
  assert.deepEqual(enabled.sidekicks, ['sidekick-123', 'sidekick-456']);
  assert.equal(enabled.disabled, false);
});

test('legacy branch retains owned sidekick and advisor while ignoring obsolete utility data', () => {
  const setup = { lead: 'p/a#high', sidekick: 'p/b#medium', advisor: 'p/a#low' };
  const obsolete = { type: 'custom', customType: 'fusion.pi.child', data: { role: 'utility', id: '../obsolete', caller: null } };
  const state = activeState([obsolete,
    { type: 'custom', customType: 'fusion.pi.setup', data: { ...setup, utility: 'missing/model#invalid' } },
    { type: 'custom', customType: 'fusion.pi.child', data: { role: 'sidekick', id: 'sidekick-123' } }, obsolete,
    { type: 'custom', customType: 'fusion.pi.child', data: { role: 'advisor', id: 'advisor-123' } },
  ]);
  assert.deepEqual(validateSetup(state.setup!, registry), setup);
  assert.deepEqual(state.sidekicks, ['sidekick-123']);
  assert.deepEqual(state.advisors, ['advisor-123']);
});

test('legacy history preserves remaining selections without validating obsolete utility models', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-state-legacy-');
  const history = new History(dir, '/legacy/work');
  const setup = { lead: 'p/a#high', sidekick: 'p/b#medium', advisor: 'p/a#low' };
  const recents = { lead: ['p/a#high'], sidekick: ['p/b#medium'], advisor: ['p/a#low'] };
  const raw = JSON.stringify({ version: 1, last: { ...setup, utility: { obsolete: true } }, recents: { ...recents, utility: ['missing/model#invalid'] } });
  await mkdir(history.dir, { recursive: true });
  await writeFile(history.path, raw);
  const loaded = await history.load();
  assert.deepEqual(validateSetup(loaded.last!, registry), setup);
  assert.deepEqual(loaded.recents, { ...recents, reviewer: [] });
  assert.equal(await readFile(history.path, 'utf8'), raw, 'loading does not rewrite historical data');
  await history.record({ ...loaded.last, sidekick: 'p/b#low' }, { sidekick: true });
  const saved = await history.load();
  assert.equal(saved.last?.sidekick, 'p/b#low');
  assert.equal(saved.last?.advisor, setup.advisor);
  assert.deepEqual(saved.recents.sidekick, ['p/b#low', 'p/b#medium']);
  assert.deepEqual(saved.recents.advisor, recents.advisor);
});
