import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createFusion } from './index.ts';
import { emptyUsage, type Launch } from './worker.ts';

async function fixture(launch?: (options: Launch) => Promise<{ id: string; text: string; usage: ReturnType<typeof emptyUsage> }>) {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-review-');
  const commands = new Map<string, any>(), tools = new Map<string, any>(), handlers = new Map<string, Function>();
  const entries: any[] = [], notices: string[] = [], delivered: string[] = [], launches: Launch[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'] }));
  let model: any = models[0], effort = 'off', auth = true;
  let pendingApply: Promise<void> | undefined;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: (config: any) => tools.set(config.name, config),
    on: (name: string, handler: Function) => handlers.set(name, handler), getThinkingLevel: () => effort,
    setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { if (pendingApply) await pendingApply; model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }),
    sendMessage: (message: { content: string }) => { delivered.push(message.content); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, isIdle: () => true, get model() { return model; },
    sessionManager: { getBranch: () => entries, getSessionId: () => 'root-review' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => auth },
    ui: { notify: (text: string) => notices.push(text), setStatus() {}, select: async () => undefined },
  } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    launches.push(options);
    if (launch) return launch(options);
    const id = options.resume ?? 'reviewer-123';
    options.onStarted?.(id);
    options.onConfirmed?.(id);
    return { id, text: 'review complete', usage: emptyUsage() };
  }, dir);
  const setup = () => commands.get('fusion-models')('p/a#high p/b#medium reviewer=p/a#low', ctx);
  const delegate = (sessionID?: string, signal?: AbortSignal) => tools.get('fusion_delegate').execute('call', {
    role: 'reviewer', task: 'frozen source packet', background: true, ...(sessionID ? { sessionID } : {}),
  }, signal, undefined, ctx);
  const owned = (role = 'reviewer', root = 'root-review') => {
    const childDir = join(dir, 'fusion', createHash('sha256').update(dir).digest('hex'), 'children', 'root-review');
    const manager = SessionManager.create(dir, childDir, { parentSession: root });
    manager.appendCustomEntry('fusion.pi.owner', { role, root, caller: root });
    manager.appendMessage({ role: 'assistant', content: [], api: 'mock', provider: 'p', model: 'a', stopReason: 'stop', usage: emptyUsage(), timestamp: Date.now() } as never);
    pi.appendEntry('fusion.pi.child', { role: 'reviewer', id: manager.getSessionId() });
    return manager.getSessionId();
  };
  return { pi, ctx, commands, tools, entries, notices, delivered, launches, handlers, setup, delegate, owned,
    auth: (value: boolean) => { auth = value; }, effort: (value: string) => { effort = value; },
    applyGate: (value: Promise<void> | undefined) => { pendingApply = value; } };
}

test('lead delegates a configured reviewer directly without a review command', async () => {
  const env = await fixture();
  await env.setup();
  const started = await env.delegate();
  assert.match(started.content[0].text, /reviewer-123/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.launches.length, 1);
  assert.equal(env.launches[0].choice, 'p/a#low');
  assert.equal(env.delivered.length, 1);
  assert.match(env.delivered[0], /review complete/);
  assert.equal(env.entries.at(-1).data.role, 'reviewer');
});

test('lead selects a confirmed owned reviewer for same-change continuations or starts a fresh review', async () => {
  const env = await fixture();
  await env.setup();
  const id = env.owned();
  await env.delegate(id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.launches[0].resume, id);
  assert.equal(env.entries.filter(entry => entry.customType === 'fusion.pi.child').length, 1, 'resume retains the confirmed identity');
  await env.delegate(id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.launches[1].resume, id);
  await env.delegate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.launches[2].resume, undefined);
  assert.equal(env.entries.filter(entry => entry.customType === 'fusion.pi.child').length, 2);
  for (const target of ['unknown-id', env.owned('advisor'), env.owned('reviewer', 'foreign-root')]) {
    await assert.rejects(env.delegate(target), /confirmed direct review child|ownership/i);
  }
  env.pi.appendEntry('fusion.pi.child', { role: 'reviewer', id: 'missing-id' });
  await assert.rejects(env.delegate('missing-id'), /missing/);
  assert.equal(env.launches.length, 3, 'invalid resumes must not launch a replacement child');
});

test('independent reviewers run concurrently and same-review continuations serialize after failure', async () => {
  const pending: Array<{ finish: () => void; fail: (error: Error) => void }> = [];
  const env = await fixture(async options => {
    const id = options.resume ?? 'independent-review';
    options.onStarted?.(id);
    return new Promise((resolve, fail) => { pending.push({ fail, finish: () => resolve({ id, text: 'review complete', usage: emptyUsage() }) }); });
  });
  await env.setup();
  const id = env.owned();
  await env.delegate(id);
  const continuation = env.delegate(id);
  await env.delegate();
  assert.equal(env.launches.length, 2, 'fresh review runs while the continuation waits');
  await env.setup();
  assert.match(env.notices.at(-1)!, /active children/i);
  env.ctx.ui.select = async () => 'Turn Fusion off';
  await env.commands.get('fusion')('', env.ctx);
  assert.match(env.notices.at(-1)!, /active Fusion work/i);
  pending[0].fail(new Error('review outage'));
  await continuation;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.delivered.length, 1);
  assert.match(env.delivered[0], /review outage/);
  assert.equal(env.launches.length, 3);
  assert.equal(env.launches[2].resume, id);
  pending[1].finish();
  pending[2].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.delivered.length, 3);
  assert.match(env.delivered[1], /review complete/);
  await env.delegate(id);
  assert.equal(env.launches.length, 4);
  pending[3].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.delivered.length, 4);
});

test('reviewer launch failure releases the root without confirming an unstarted child', async () => {
  const env = await fixture(async () => { throw new Error('launch failed'); });
  await env.setup();
  await assert.rejects(env.delegate(), /launch failed/);
  await assert.rejects(env.delegate(), /launch failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.launches.length, 2);
  assert.equal(env.delivered.length, 2);
  assert.ok(env.delivered.every(result => result.includes('launch failed')));
  assert.equal(env.entries.filter(entry => entry.customType === 'fusion.pi.child').length, 0);
});

test('reviewer delegation checks active root ownership, selected lead, availability and setup races', async () => {
  const env = await fixture();
  await assert.rejects(env.delegate(), /not active/i);
  await env.setup();
  env.pi.appendEntry('fusion.pi.disabled', {});
  await assert.rejects(env.delegate(), /off/i);
  await env.setup();
  env.effort('off');
  await assert.rejects(env.delegate(), /lead model or effort/i);
  env.effort('high');
  await env.pi.setModel(env.ctx.modelRegistry.find('p', 'b')!);
  await assert.rejects(env.delegate(), /lead model or effort/i);
  await env.pi.setModel(env.ctx.modelRegistry.find('p', 'a')!);
  env.auth(false);
  await assert.rejects(env.delegate(), /available|auth/i);
  env.auth(true);
  let unblock: () => void = () => {};
  env.applyGate(new Promise(resolve => { unblock = resolve; }));
  const applying = env.setup();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(env.delegate(), /setup is being applied/i);
  unblock(); await applying;
  env.applyGate(undefined);
  env.pi.appendEntry('fusion.pi.owner', { role: 'sidekick', root: 'other-root' });
  await assert.rejects(env.delegate(), /root lead|nested/i);
  assert.equal(env.launches.length, 0);
});

test('reviewer requires a user-selected configuration and pre-cancelled delegation does not start work', async () => {
  const env = await fixture();
  await env.commands.get('fusion-models')('p/a#high p/b#medium', env.ctx);
  await assert.rejects(env.delegate(), /not configured/);
  await env.setup();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(env.delegate(undefined, controller.signal), /cancelled/);
  assert.equal(env.launches.length, 0);
  await env.delegate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.delivered.length, 1);
});

test('turning reviewer off retains confirmed children for later user-requested continuation', async () => {
  const env = await fixture();
  await env.setup();
  const id = env.owned();
  await env.commands.get('fusion-models')('p/a#high p/b#medium reviewer=off', env.ctx);
  await assert.rejects(env.delegate(id), /not configured/);
  await env.setup();
  await env.delegate(id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.launches[0].resume, id);
});

test('reviewer navigation aborts and drains work, suppresses stale delivery and retains the owned conversation', async () => {
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_shutdown']) {
    let child: Launch | undefined;
    let drained = false;
    const env = await fixture(async options => {
      options.onStarted?.(options.resume!);
      if (drained) return { id: options.resume!, text: 'continued review', usage: emptyUsage() };
      child = options;
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => {
        drained = true;
        reject(new Error('review cancelled'));
      }, { once: true }));
    });
    await env.setup();
    const id = env.owned();
    await env.delegate(id);
    await env.handlers.get(event)?.({}, env.ctx);
    assert.equal(child?.signal?.aborted, true, event);
    assert.equal(drained, true, event);
    assert.equal(env.delivered.length, 0, event);
    await env.delegate(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.launches[1].resume, id);
    assert.equal(env.delivered.length, 1);
    assert.match(env.delivered[0], /continued review/);
  }
});
