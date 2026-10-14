import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { LiveWorkers } from './worker.ts';
import { RunRegistry } from './viewer.ts';

function fixture() {
  let now = 0, scheduled: (() => void) | undefined, stopped = 0;
  const workers = new LiveWorkers({ now: () => now, schedule: ((callback: () => void) => {
    scheduled = callback; return { unref() {} };
  }) as typeof setInterval, unschedule: () => { stopped++; } });
  const registry = new RunRegistry();
  const inbox = new Map<string, string[]>();
  const add = (id: string, owner = 'root-owner', ready = () => true) => {
    const listeners = new Set<(event: AgentSessionEvent) => void>(), messages: Array<{ content: string; options: unknown }> = [];
    let valid = true;
    const session = { sessionId: id, isIdle: false,
      subscribe: (listener: (event: AgentSessionEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      sendCustomMessage: async (message: { content: string }, options: unknown) => { messages.push({ content: message.content, options }); },
    } as unknown as AgentSession;
    const run = registry.add('sidekick', 'private task text must not leak'); run.startedAt = 0;
    const controller = new AbortController();
    const attach = () => workers.attach(owner, run, session, controller, () => valid, undefined, { ready, notify: text => {
      if (!inbox.has(owner)) inbox.set(owner, []); inbox.get(owner)!.push(text);
    } });
    attach();
    return { run, session, controller, messages, attach, idle: (value: boolean) => { Object.defineProperty(session, 'isIdle', { value, configurable: true }); }, invalidate: () => { valid = false; }, listeners,
      event: (event: unknown) => { for (const listener of listeners) listener(event as AgentSessionEvent); } };
  };
  return { workers, add, inbox, advance: async () => { now += 60000; await workers.checkProgress(); },
    scheduled: () => scheduled, stopped: () => stopped };
}

test('supervision includes every direct worker without cross-owner content or raw output', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.add(`direct-worker-${i}`);
  const evidence = f.add('evidence-worker', 'advisor-owner');
  evidence.event({ type: 'tool_execution_start', toolName: 'read', args: { path: 'SECRET_SOURCE_PATH' } });
  await f.advance();
  assert.equal(f.inbox.get('root-owner')?.length, 1);
  assert.equal(f.inbox.get('advisor-owner')?.length, 1);
  for (let i = 0; i < 6; i++) assert.ok(f.inbox.get('root-owner')![0].includes(`direct-worker-${i}`));
  for (const [owner, updates] of f.inbox) for (const text of updates) {
    assert.equal(text.includes('SECRET_SOURCE_PATH'), false);
    assert.equal(text.includes('private task'), false);
    assert.equal(text.includes(owner === 'root-owner' ? 'evidence-worker' : 'direct-worker'), false);
  }
  f.workers.dispose();
});

test('quiet requests deduplicate and custom/user input does not count as output progress', async () => {
  const f = fixture(), child = f.add('quiet-worker');
  await f.advance();
  await f.advance();
  assert.equal(child.messages.length, 1);
  assert.deepEqual(child.messages[0].options, { deliverAs: 'steer' });
  child.event({ type: 'message_end', message: { role: 'custom' } });
  child.event({ type: 'message_update', message: { role: 'user' } });
  await f.advance();
  assert.equal(child.messages.length, 1);
  child.event({ type: 'message_update', message: { role: 'assistant' } });
  await f.advance();
  await f.advance();
  assert.equal(child.messages.length, 2, 'new observed output permits one later quiet request');
  assert.equal(child.controller.signal.aborted, false);
  f.workers.dispose();
});

test('busy owner skips updates with no backlog and idle, cancelled or finished workers never receive quiet requests', async () => {
  const f = fixture(); let ready = false;
  const child = f.add('busy-owner-worker', 'root-owner', () => ready);
  await f.advance(); await f.advance();
  assert.equal(f.inbox.size, 0);
  ready = true; child.idle(true);
  child.event({ type: 'tool_execution_update', toolName: 'bash' });
  await f.advance(); await f.advance();
  assert.equal(f.inbox.get('root-owner')?.length, 2, 'only current ticks are delivered');
  assert.equal(child.messages.length, 1, 'idle worker was not restarted');
  child.idle(false); child.controller.abort();
  await f.advance();
  assert.match(f.inbox.get('root-owner')!.at(-1)!, /cancel/i);
  assert.equal(child.messages.length, 1);
  child.run.status = 'done'; await f.advance();
  assert.equal(child.messages.length, 1);
  f.workers.dispose();
});

test('release, invalidation and disposal unsubscribe and discard late ticks; resumed handles reset quiet state', async () => {
  const f = fixture(), child = f.add('resumed-worker');
  const late = f.scheduled()!;
  await f.advance(); await f.advance();
  f.workers.release(child.session.sessionId);
  assert.equal(child.listeners.size, 0);
  late(); await f.workers.checkProgress();
  assert.equal(child.messages.length, 1);
  child.attach(); await f.advance();
  assert.equal(child.messages.length, 1, 'resumed run starts with a fresh observation');
  await f.advance(); assert.equal(child.messages.length, 2);
  child.invalidate(); await f.advance();
  assert.equal(child.listeners.size, 0);
  const another = f.add('disposed-worker');
  const old = f.scheduled()!; f.workers.dispose(); old(); await f.workers.checkProgress();
  assert.equal(another.listeners.size, 0);
  assert.equal(another.messages.length, 0);
  assert.ok(f.stopped() >= 2);
});

test('releasing a sampled worker prevents its stale grouped summary while other owners still receive updates', async () => {
  const f = fixture(), child = f.add('departing-worker');
  f.add('remaining-worker'); f.add('other-owner-worker', 'other-owner');
  const pending = f.advance();
  f.workers.release(child.session.sessionId);
  await pending;
  assert.equal(f.inbox.has('root-owner'), false);
  assert.equal(f.inbox.get('other-owner')?.length, 1);
  await f.advance();
  assert.equal(f.inbox.get('root-owner')?.length, 1);
  assert.equal(f.inbox.get('root-owner')![0].includes('departing-worker'), false);
  f.workers.dispose();
});
