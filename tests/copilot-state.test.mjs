import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { History } from '../com.github.copilot/extensions/fusion-guard/state.mjs';

test('Copilot history retains remaining choices without depending on obsolete utility data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-copilot-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json');
  const history = new History(path);
  const lead = { model: 'chosen-lead', effort: 'high', contextTier: 'long_context' };
  const sidekick = { model: 'chosen-sidekick', effort: 'low', contextTier: 'default' };
  const advisor = { model: 'chosen-advisor', effort: 'high' };
  for (const utility of [undefined, { model: 'old-helper' }, 42]) {
    const old = { last: { lead, sidekick, advisor, utility },
      recents: { lead: [lead], sidekick: [sidekick], advisor: [advisor],
        utility: utility?.model ? [utility] : utility } };
    await writeFile(path, JSON.stringify(old));
    const saved = await history.load();
    assert.deepEqual(saved.last?.lead, lead);
    assert.deepEqual(saved.last?.sidekick, sidekick);
    assert.deepEqual(saved.last?.advisor, advisor);
    assert.deepEqual(saved.recents.lead, [lead]);
    assert.deepEqual(saved.recents.sidekick, [sidekick]);
    assert.deepEqual(saved.recents.advisor, [advisor]);
    assert.equal(saved.last.reviewer, null);
    assert.deepEqual(saved.recents.reviewer, []);
    assert.equal(saved.last.utility, undefined);
    assert.equal(saved.recents.utility, undefined);
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(old));
  }
});

test('reviewer history is optional in legacy data and keeps distinct explicit effort/context recents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-copilot-review-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = new History(join(dir, 'history.json'));
  const setup = { lead: { model: 'lead' }, sidekick: { model: 'worker' }, advisor: null };
  await writeFile(history.path, JSON.stringify({ last: setup, recents: { lead: [setup.lead], sidekick: [setup.sidekick], advisor: [] } }));
  assert.equal((await history.load()).last.lead.model, 'lead');
  for (const contextTier of ['default', 'long_context']) {
    await history.record({ ...setup, reviewer: { model: 'review', effort: 'high', contextTier } }, ['reviewer']);
  }
  await history.record({ ...setup, reviewer: null }, ['reviewer']);
  const saved = await history.load();
  assert.equal(saved.last.lead.model, 'lead');
  assert.equal(saved.last.reviewer, null);
  assert.deepEqual(saved.recents.reviewer.map(choice => choice.contextTier), ['long_context', 'default']);
  assert.equal(saved.recents.lead[0].model, 'lead');
});

test('Copilot history tolerates missing/corrupt files and records only explicitly selected choices', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-copilot-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json');
  const history = new History(path);
  assert.equal((await history.load()).last, undefined);
  await writeFile(path, '{broken');
  assert.equal((await history.load()).last, undefined);
  await writeFile(path, JSON.stringify({ last: { lead: 42 }, recents: {} }));
  assert.equal((await history.load()).last, undefined);
  const setup = { lead: { model: 'lead', effort: 'high' }, sidekick: { model: 'worker' }, advisor: null };
  for (const model of ['a', 'b', 'c', 'd', 'b']) {
    await history.record({ ...setup, lead: { model, effort: 'high' } }, ['lead']);
  }
  const saved = await history.load();
  assert.deepEqual(saved.recents.lead.map(choice => choice.model), ['b', 'd', 'c']);
  assert.deepEqual(saved.recents.sidekick, []);
  assert.equal(saved.last.sidekick.model, 'worker');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).last.lead.model, 'b');
});
