import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createWorkerSupervision } from '../com.github.copilot/extensions/fusion-guard/supervision.mjs';
import { createHooks } from '../com.github.copilot/extensions/fusion-guard/hooks.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const state = { agent: { id: 'fusion', source: 'user' }, tasks: [], messages: [], requests: [], logs: [],
    timers: new Set(), configurations: new Map(), cancellations: new Set(), time: 120000 };
  const listeners = new Map();
  const session = {
    sessionId: 'root',
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
      return () => listeners.get(type).delete(callback);
    },
    send: async options => {
      const messageId = `message-${state.messages.length}`;
      state.messages.push({ ...options, messageId });
      return messageId;
    },
    log: async message => state.logs.push(message),
    rpc: {
      agent: { getCurrent: async () => ({ agent: state.agent }) },
      tasks: {
        list: async () => ({ tasks: state.tasks }),
        getProgress: async ({ id }) => ({ progress: { type: 'agent', recentActivity: [
          { timestamp: '2026-01-01T00:00:00Z', message: `editing ${id}` },
        ] } }),
        sendMessage: async message => { state.requests.push(message); return { sent: true }; },
      },
    },
  };
  state.attached = session;
  const roles = {
    ownerForTarget: async task => task.owner ?? null,
    configurationForOrigin: origin => state.configurations.get(origin),
  };
  const timerOptions = {
    now: () => state.time,
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      state.timers.add(timer);
      return timer;
    },
    unschedule: timer => state.timers.delete(timer),
  };
  const monitor = createWorkerSupervision(() => state.attached, roles,
    task => state.cancellations.has(task.id), timerOptions);
  const emit = (type, data = {}, agentId) => {
    for (const callback of listeners.get(type) ?? []) callback({ type, data, ...(agentId ? { agentId } : {}) });
  };
  function worker(id, owner = 'root', role = 'fusion-sidekick', extra = {}) {
    const task = { id, type: 'agent', toolCallId: `call-${id}`, startedAt: '2026-01-01T00:00:00Z',
      status: 'running', executionMode: 'background', agentType: role, owner, ...extra };
    state.tasks.push(task);
    if (role !== 'fusion-sidekick') state.configurations.set(id, { callId: task.toolCallId, role, name: role });
    return task;
  }
  const consumeRoot = message => emit('user.message', { messageId: message.messageId, turnId: 'next-turn' });
  return { state, session, monitor, roles, timerOptions, emit, worker, consumeRoot, listeners };
}

test('registers one 60s timer and routes summaries and quiet requests to confirmed owners', async () => {
  const f = fixture();
  f.worker('coding');
  f.worker('advisor', 'root', 'fusion-advisor');
  f.worker('reviewer', 'root', 'fusion-reviewer');
  f.worker('advisor-evidence', 'advisor');
  f.worker('review-evidence', 'reviewer');
  f.worker('foreign', 'root', 'general-purpose');
  f.worker('unowned', null);
  f.monitor.start(); f.monitor.start();
  assert.equal(f.state.timers.size, 1);
  assert.equal([...f.state.timers][0].delay, 60000);
  await f.monitor.check();
  const root = f.state.messages[0];
  assert.equal(root.mode, 'enqueue');
  assert.match(root.prompt, /coding/);
  assert.doesNotMatch(root.prompt, /evidence|foreign|unowned/);
  assert.deepEqual(f.state.requests.map(message => message.id), ['advisor', 'reviewer']);
  assert.match(f.state.requests[0].message, /advisor-evidence/);
  assert.doesNotMatch(f.state.requests[0].message, /review-evidence|coding/);
  f.consumeRoot(root);
  f.emit('assistant.turn_start', { turnId: 'a-next' }, 'advisor');
  f.emit('assistant.turn_start', { turnId: 'r-next' }, 'reviewer');
  await f.monitor.check();
  const ping = f.state.requests.find(message => message.id === 'advisor-evidence');
  assert.equal(ping.fromAgentId, 'advisor');
  assert.equal(f.state.requests.find(message => message.id === 'coding').fromAgentId, undefined);
  const count = f.state.requests.filter(message => message.id.endsWith('evidence')).length;
  await f.monitor.check();
  assert.equal(f.state.requests.filter(message => message.id.endsWith('evidence')).length, count);
  f.monitor.stop();
});

test('pending root summaries coalesce until the admitted message is consumed, using fresh samples', async () => {
  const f = fixture(); f.worker('coding');
  const admission = deferred();
  f.session.send = async options => {
    f.state.messages.push({ ...options, messageId: 'notice' });
    return admission.promise;
  };
  f.monitor.start();
  const first = f.monitor.check();
  await new Promise(resolve => setImmediate(resolve));
  f.emit('assistant.turn_start', { turnId: 'already-running' });
  admission.resolve('notice');
  await first;
  await f.monitor.check();
  f.emit('assistant.message', { originatingMessageId: 'other' });
  await f.monitor.check();
  assert.equal(f.state.messages.length, 1);
  f.session.rpc.tasks.getProgress = async () => ({ progress: { type: 'agent', recentActivity: [
    { timestamp: '2026-01-01T00:01:00Z', message: 'fresh native activity' },
  ] } });
  f.emit('assistant.message', { originatingMessageId: 'notice' });
  await f.monitor.check();
  assert.equal(f.state.messages.length, 2);
  assert.match(f.state.messages[1].prompt, /fresh native activity/);
  f.monitor.stop();
});

test('summaries display native activity and intent, never response text', async () => {
  const f = fixture(); f.worker('coding', 'root', 'fusion-sidekick', { latestResponse: 'private response contents' });
  f.monitor.start(); await f.monitor.check();
  assert.match(f.state.messages[0].prompt, /editing coding/);
  assert.doesNotMatch(f.state.messages[0].prompt, /private response contents/);
  f.consumeRoot(f.state.messages[0]);
  f.session.rpc.tasks.getProgress = async () => ({ progress: { type: 'agent', recentActivity: [], latestIntent: 'checking results' } });
  await f.monitor.check();
  assert.match(f.state.messages[1].prompt, /checking results/);
  f.consumeRoot(f.state.messages[1]);
  f.session.rpc.tasks.getProgress = async () => ({ progress: { type: 'agent', recentActivity: [] } });
  await f.monitor.check();
  assert.match(f.state.messages[2].prompt, /responding/);
  assert.doesNotMatch(f.state.messages[2].prompt, /private response contents/);
  f.monitor.stop();
});

test('late progress cannot send a summary after any sampled child finishes or changes owner', async () => {
  for (const owner of ['root', 'advisor']) for (const change of ['terminal', 'reowned']) {
    const f = fixture();
    if (owner !== 'root') f.worker('advisor', 'root', 'fusion-advisor');
    const child = f.worker('child', owner);
    f.worker('unchanged-child', owner);
    const progress = deferred();
    const getProgress = f.session.rpc.tasks.getProgress;
    f.session.rpc.tasks.getProgress = request => request.id === child.id ? progress.promise : getProgress(request);
    f.monitor.start(); const check = f.monitor.check();
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'terminal') child.status = 'completed';
    else child.owner = owner === 'root' ? 'different-owner' : 'root';
    progress.resolve({ progress: { type: 'agent', recentActivity: [] } });
    await check;
    const summaries = () => owner === 'root' ? f.state.messages : f.state.requests.filter(message =>
      message.id === 'advisor' && message.message.includes('child'));
    assert.equal(summaries().length, 0, `${owner}: ${change}`);
    child.status = 'running'; child.owner = owner;
    await f.monitor.check();
    assert.equal(summaries().length, 1, `${owner}: admission released after ${change}`);
    f.monitor.stop();
  }
});

test('malformed task metadata suppresses unsafe notices without stopping monitoring or losing the quiet baseline', async () => {
  const f = fixture(); f.worker('coding');
  f.monitor.start(); await f.monitor.check();
  f.consumeRoot(f.state.messages[0]);
  const list = f.session.rpc.tasks.list;
  f.session.rpc.tasks.list = async () => ({ tasks: null });
  await f.monitor.check();
  assert.equal(f.state.timers.size, 1);
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.state.requests.length, 0);
  f.session.rpc.tasks.list = list;
  await f.monitor.check();
  assert.equal(f.state.messages.length, 2);
  assert.equal(f.state.requests[0].id, 'coding');
  f.consumeRoot(f.state.messages[1]);
  let malformed = true;
  f.session.rpc.tasks.list = async () => {
    if (malformed) { malformed = false; return { tasks: null }; }
    return list();
  };
  await f.monitor.check();
  assert.match(f.state.messages[2].prompt, /status unavailable/);
  f.monitor.stop();
});

test('idle leaves and terminal tasks are omitted; idle owners with active children remain', async () => {
  const f = fixture();
  f.worker('idle-leaf', 'root', 'fusion-sidekick', { status: 'idle' });
  f.worker('done', 'root', 'fusion-sidekick', { status: 'completed' });
  f.worker('failed', 'root', 'fusion-sidekick', { status: 'failed' });
  f.worker('cancelled', 'root', 'fusion-sidekick', { status: 'cancelled' });
  f.worker('advisor', 'root', 'fusion-advisor', { status: 'idle' });
  f.worker('evidence', 'advisor');
  f.monitor.start(); await f.monitor.check();
  assert.match(f.state.messages[0].prompt, /advisor/);
  assert.doesNotMatch(f.state.messages[0].prompt, /idle-leaf|done|failed|cancelled/);
  f.consumeRoot(f.state.messages[0]);
  f.emit('assistant.turn_start', {}, 'advisor');
  await f.monitor.check();
  assert.equal(f.state.requests.some(message => message.id === 'idle-leaf'), false);
  assert.equal(f.state.requests.filter(message => message.id === 'advisor').length, 2);
  f.monitor.stop();
});

test('unknown progress and status never establish no-progress proof; clocks and prompts do not reset dedup', async () => {
  const f = fixture();
  const task = f.worker('coding');
  f.worker('unknown', 'root', 'fusion-sidekick', { status: undefined });
  f.session.rpc.tasks.getProgress = async () => ({});
  f.monitor.start(); await f.monitor.check(); await f.monitor.check();
  assert.equal(f.state.requests.length, 0);
  f.session.rpc.tasks.getProgress = async () => ({ progress: { type: 'agent', recentActivity: [] } });
  await f.monitor.check(); await f.monitor.check();
  assert.deepEqual(f.state.requests.map(message => message.id), ['coding']);
  task.activeTimeMs = 9000; task.prompt = 'automatic ping'; f.state.time += 60000;
  await f.monitor.check();
  assert.equal(f.state.requests.length, 1);
  f.monitor.stop();
});

test('native continuation restarts monitoring after an idle leaf stopped its timer', async () => {
  const f = fixture(); const task = f.worker('coding', 'root', 'fusion-sidekick', { status: 'idle' });
  f.monitor.start(); await f.monitor.check();
  assert.equal(f.state.timers.size, 0);
  f.emit('tool.execution_start', { toolName: 'write_agent', arguments: { agent_id: task.id } });
  task.status = 'running';
  assert.equal(f.state.timers.size, 1);
  await f.monitor.check();
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.state.requests.length, 0, 'continuation begins with a fresh progress baseline');
  f.monitor.stop();
});

test('foreground owner delivery is unavailable and logged once, without fake child messages', async () => {
  const f = fixture();
  f.worker('advisor', 'root', 'fusion-advisor', { executionMode: 'sync' });
  f.worker('evidence', 'advisor');
  f.monitor.start(); await f.monitor.check(); await f.monitor.check();
  assert.equal(f.state.requests.some(message => message.id === 'advisor'), false);
  assert.equal(f.state.logs.length, 1);
  assert.match(f.state.logs[0], /foreground|sync/i);
  f.monitor.stop();
});

test('detach, Fusion off, shutdown and explicit stop prevent late sends and release subscriptions', async () => {
  for (const reason of ['detach', 'off', 'shutdown', 'stop']) {
    const f = fixture(); f.worker('coding');
    const progress = deferred();
    f.session.rpc.tasks.getProgress = () => progress.promise;
    f.monitor.start(); const pending = f.monitor.check();
    await new Promise(resolve => setImmediate(resolve));
    if (reason === 'detach') f.state.attached = { ...f.session };
    if (reason === 'off') f.state.agent = null;
    if (reason === 'shutdown') f.emit('session.shutdown');
    if (reason === 'stop') f.monitor.stop();
    progress.resolve({ progress: { type: 'agent', recentActivity: [] } });
    await pending;
    assert.equal(f.state.messages.length, 0, reason);
    assert.equal(f.state.requests.length, 0, reason);
    f.monitor.stop();
    assert.equal(f.state.timers.size, 0);
    assert.equal([...f.listeners.values()].some(set => set.size), false);
  }
});

test('reused task generations and cancellation are revalidated before quiet requests', async () => {
  for (const change of ['generation', 'cancel', 'idle', 'owner']) {
    const f = fixture(); f.worker('coding');
    f.monitor.start(); await f.monitor.check();
    const list = f.session.rpc.tasks.list;
    let reads = 0;
    f.session.rpc.tasks.list = async () => {
      if (++reads === 2) {
        if (change === 'generation') f.state.tasks[0] = { ...f.state.tasks[0], toolCallId: 'new-call' };
        if (change === 'cancel') f.state.cancellations.add('coding');
        if (change === 'idle') f.state.tasks[0].status = 'idle';
        if (change === 'owner') f.state.tasks[0].owner = null;
      }
      return list();
    };
    await f.monitor.check();
    assert.equal(f.state.requests.length, 0, change);
    f.monitor.stop();
  }
});

test('hooks expose supported session-end teardown', () => {
  const hooks = createHooks(() => undefined);
  assert.equal(typeof hooks.dispose, 'function');
  hooks.onSessionEnd({ sessionId: 'root' }, { sessionId: 'root' });
  hooks.dispose();
});

test('installed SDK admits root enqueue and worker messages over inert transport', async t => {
  const sdk = process.env.FUSION_COPILOT_SDK || join(homedir(), '.copilot/pkg/linux-x64/1.0.95/copilot-sdk/index.js');
  try { await access(sdk); } catch (error) {
    if (process.env.FUSION_COPILOT_SDK || error.code !== 'ENOENT') throw error;
    t.skip('Optional installed Copilot SDK unavailable.'); return;
  }
  const { CopilotSession } = await import(pathToFileURL(sdk).href);
  const f = fixture(); f.worker('coding');
  const calls = [];
  const session = new CopilotSession('root', { sendRequest: async (method, params) => {
    calls.push({ method, params });
    if (method === 'session.send') return { messageId: 'sdk-notice' };
    const handler = method.replace(/^session\./, '').split('.').reduce((value, key) => value?.[key], f.session.rpc);
    assert.equal(typeof handler, 'function', method);
    return handler(params);
  } });
  const monitor = createWorkerSupervision(() => session, f.roles, () => false, f.timerOptions);
  monitor.start(); await monitor.check(); await monitor.check(); monitor.stop();
  assert.equal(calls.find(call => call.method === 'session.send').params.mode, 'enqueue');
  assert.equal(calls.find(call => call.method === 'session.tasks.sendMessage').params.id, 'coding');
});
