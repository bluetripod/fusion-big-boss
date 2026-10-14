import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openOwned, assertChildRequest, allowedLeadCall } from './worker.ts';

test('owned session exact ID, role and root verified before opening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-child-'));
  const manager = SessionManager.create(dir, dir, { parentSession: 'root-one' });
  manager.appendCustomEntry('fusion.pi.owner', { role: 'sidekick', root: 'root-one', caller: 'root-one' });
  manager.appendMessage({ role: 'assistant', content: [], api: 'mock', provider: 'p', model: 'a', stopReason: 'stop', usage: {} } as never);
  assert.equal(openOwned(dir, dir, manager.getSessionId(), 'root-one', 'sidekick').getSessionId(), manager.getSessionId());
  assert.throws(() => openOwned(dir, dir, manager.getSessionId(), 'root-two', 'sidekick'), /ownership/);
  assert.throws(() => openOwned(dir, dir, manager.getSessionId(), 'root-one', 'advisor'), /ownership/);
  assert.throws(() => openOwned(dir, dir, 'absent-id', 'root-one', 'sidekick'), /missing/);
  assert.throws(() => openOwned(dir, dir, '../../other', 'root-one', 'sidekick'), /ID/);
});

test('legacy root-owned sidekick and advisor resume without caller marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-legacy-child-'));
  for (const role of ['sidekick', 'advisor'] as const) {
    const manager = SessionManager.create(dir, dir, { parentSession: 'root-one' });
    manager.appendCustomEntry('fusion.pi.owner', { role, root: 'root-one' });
    manager.appendMessage({ role: 'assistant', content: [], api: 'mock', provider: 'p', model: 'a', stopReason: 'stop', usage: {} } as never);
    const id = manager.getSessionId();
    assert.equal(openOwned(dir, dir, id, 'root-one', role).getSessionId(), id);
    assert.throws(() => openOwned(dir, dir, id, 'other-root', role), /ownership/);
    const foreign = SessionManager.create(dir, dir, { parentSession: 'foreign-sidekick' });
    foreign.appendCustomEntry('fusion.pi.owner', { role, root: 'root-one', caller: 'foreign-sidekick' });
    foreign.appendMessage({ role: 'assistant', content: [], api: 'mock', provider: 'p', model: 'a', stopReason: 'stop', usage: {} } as never);
    assert.throws(() => openOwned(dir, dir, foreign.getSessionId(), 'root-one', role), /ownership/);
  }
});

test('reviewer resume requires exact role, root and caller identities', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-reviewer-owner-');
  for (const caller of ['root-one', 'foreign-caller', undefined]) {
    const manager = SessionManager.create(dir, dir, { parentSession: 'root-one' });
    manager.appendCustomEntry('fusion.pi.owner', { role: 'reviewer', root: 'root-one', ...(caller ? { caller } : {}) });
    manager.appendMessage({ role: 'assistant', content: [], api: 'mock', provider: 'p', model: 'a', stopReason: 'stop', usage: {} } as never);
    const id = manager.getSessionId();
    if (caller === 'root-one') {
      assert.equal(openOwned(dir, dir, id, 'root-one', 'reviewer').getSessionId(), id);
      assert.throws(() => openOwned(dir, dir, id, 'root-one', 'advisor'), /ownership/);
    } else assert.throws(() => openOwned(dir, dir, id, 'root-one', 'reviewer'), /ownership/);
  }
});

test('routing excludes unauthorized delegation and lead shell/search/large reads', () => {
  assert.doesNotThrow(() => assertChildRequest('sidekick', { task: 'x', background: true }));
  assert.throws(() => assertChildRequest('sidekick', { task: 'x', background: false }), /background/);
  assert.throws(() => assertChildRequest('sidekick', { task: 'x' }), /background/);
  assert.throws(() => assertChildRequest('utility' as never, { task: 'x' }), /role/);
  assert.throws(() => assertChildRequest('sidekick', { task: 'x', model: 'rogue' } as never), /model/);
  assert.doesNotThrow(() => assertChildRequest('advisor', { task: 'x', background: true }));
  assert.doesNotThrow(() => assertChildRequest('reviewer', { task: 'snapshot packet', background: true }));
  assert.throws(() => assertChildRequest('reviewer', { task: 'snapshot packet', background: false }), /background/);
  assert.throws(() => assertChildRequest('reviewer', { task: 'snapshot packet' }), /background/);
  assert.equal(allowedLeadCall('bash', {})?.block, true);
  assert.equal(allowedLeadCall('grep', {})?.block, true);
  assert.equal(allowedLeadCall('read', { path: 'x', offset: 1, limit: 351 })?.block, true);
  assert.equal(allowedLeadCall('read', { path: 'x', offset: 1, limit: 201 }), undefined);
  assert.equal(allowedLeadCall('read', { path: 'x', offset: 1, limit: 350 }), undefined);
  assert.equal(allowedLeadCall('ask_user', { questions: [] }), undefined);
  assert.equal(allowedLeadCall('strange_tool', {})?.block, true);
});
