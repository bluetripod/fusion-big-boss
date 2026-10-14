import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createFusion, parseModelsArgs } from './index.ts';
import type { Launch } from './worker.ts';
import { emptyUsage } from './worker.ts';
import { History } from './state.ts';

test('text grammar permits optional advisor/reviewer choices and off, but rejects removed utility options', () => {
  assert.deepEqual(parseModelsArgs('p/a#low p/b#high advisor=p/a#xhigh'), { lead: 'p/a#low', sidekick: 'p/b#high', advisor: 'p/a#xhigh' });
  assert.equal(parseModelsArgs('p/a#low p/b#high advisor=off').advisor, null);
  assert.equal(parseModelsArgs('p/a#low p/b#high reviewer=p/a#low').reviewer, 'p/a#low');
  assert.equal(parseModelsArgs('p/a#low p/b#high reviewer=off').reviewer, null);
  assert.throws(() => parseModelsArgs('p/a#low p/b#high reviewer=off reviewer=p/z#low'), /repeated/);
  assert.throws(() => parseModelsArgs('p/a#low p/b#high utility=off'), /Unknown/);
  assert.throws(() => parseModelsArgs('p/a#low p/b#high utility=p/a#low'), /Unknown/);
  assert.throws(() => parseModelsArgs('p/a#low p/b#high model=p/z#low'), /Unknown/);
  assert.throws(() => parseModelsArgs('p/a#low p/b#high advisor=off advisor=p/z#low'), /repeated/);
});

test('Apply refuses a running root turn and blocks delegation while a model change is pending', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-apply-race-');
  const commands = new Map<string, any>(), tools = new Map<string, any>(), entries: any[] = [], notices: string[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'] }));
  let model: any = models[0], effort = 'off', idle = false, mutations = 0;
  let unblock: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: (config: any) => tools.set(config.name, config), on: () => {},
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; },
    setModel: async (value: any) => { mutations++; if (gate) await gate; model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }) } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, isIdle: () => idle, get model() { return model; },
    sessionManager: { getBranch: () => entries, getSessionId: () => 'root-apply-race' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    ui: { notify: (message: string) => { notices.push(message); }, setStatus: () => {} } } as unknown as ExtensionContext;
  createFusion(pi, undefined, dir);
  await commands.get('fusion-models')('p/a#high p/b#medium', ctx);
  assert.equal(mutations, 0);
  assert.equal(entries.length, 0);
  assert.match(notices.at(-1)!, /idle|running/i);
  idle = true;
  await commands.get('fusion-models')('p/a#high p/b#medium', ctx);
  assert.equal(entries.length, 1);
  gate = new Promise(resolve => { unblock = resolve; });
  const pending = commands.get('fusion-models')('p/a#low p/b#medium', ctx);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(tools.get('fusion_delegate').execute('call', { role: 'sidekick', task: 'start during Apply', background: true }, undefined, undefined, ctx), /configur|Apply/i);
  assert.equal(entries.length, 1);
  unblock!();
  await pending;
  assert.equal(entries.length, 2);
});

test('root budget restores on resume, tree, input and preflight without changing external choices or a running turn; Apply rolls back cap substitution', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-root-context-');
  const commands = new Map<string, any>(), handlers = new Map<string, Function>(), entries: any[] = [], notices: string[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'], contextWindow: 250000, maxTokens: 16000 }));
  let model: any = models[0], effort = 'off', idle = true, substitute = false;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: () => {}, on: (name: string, handler: Function) => handlers.set(name, handler),
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; },
    setModel: async (value: any) => { model = substitute && value.contextWindow === 100000 ? { ...value, contextWindow: 250000 } : value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }) } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, isIdle: () => idle, get model() { return model; }, sessionManager: { getBranch: () => entries, getSessionId: () => 'root-context' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    ui: { notify: (message: string) => notices.push(message), setStatus: () => {} } } as unknown as ExtensionContext;
  createFusion(pi, undefined, dir);
  await commands.get('fusion-models')('p/a#high@50k p/b#medium@100k', ctx);
  const chosen = model, history = new History(dir, dir), stored = JSON.stringify(await history.load());
  assert.equal(model.contextWindow, 50000);
  assert.equal(model.maxTokens, 16000);
  substitute = true;
  await commands.get('fusion-models')('p/a#high@100k p/b#medium@100k', ctx);
  assert.equal(model, chosen, 'failed cap verification restores the previous explicit clone');
  assert.equal(entries.length, 1);
  assert.equal(JSON.stringify(await history.load()), stored);
  assert.match(notices.at(-1)!, /clamped|substitut/i);
  substitute = false;
  for (const event of ['session_start', 'session_tree', 'input', 'before_agent_start']) {
    model = models[0];
    await handlers.get(event)?.({ systemPromptOptions: { sections: {} } }, ctx);
    assert.equal(model.contextWindow, 50000, event);
    assert.equal(model.id, 'a');
    assert.equal(effort, 'high');
  }
  assert.equal(models[0].contextWindow, 250000);
  assert.equal(entries.length, 1, 'restoration does not replace the saved setup');
  model = models[0]; idle = false;
  assert.deepEqual(await handlers.get('input')?.({}, ctx), { action: 'handled' });
  assert.equal(model, models[0], 'never reapply a clone during streaming');
  idle = true;
  model = models[1];
  assert.deepEqual(await handlers.get('input')?.({}, ctx), { action: 'handled' });
  await handlers.get('session_start')?.({}, ctx);
  assert.equal(model, models[1], 'do not substitute an externally selected model');
  model = models[0]; effort = 'low';
  assert.deepEqual(await handlers.get('input')?.({}, ctx), { action: 'handled' });
  assert.equal(model, models[0]);
  assert.equal(effort, 'low', 'do not replace an externally selected effort');
});

test('confirmed advisor continuations serialize across failure while independent workers can run', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-advisor-race-');
  const commands = new Map<string, any>(), tools = new Map<string, any>(), entries: any[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'] }));
  let model: any = models[0], effort = 'off', starts = 0;
  const pending: Array<{ resolve: (value: { id: string; text: string; usage: ReturnType<typeof emptyUsage> }) => void; reject: (error: Error) => void }> = [];
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: (config: any) => tools.set(config.name, config), on: () => {},
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }) } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, isIdle: () => true, get model() { return model; },
    sessionManager: { getBranch: () => entries, getSessionId: () => 'root-advisor' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    ui: { notify: () => {}, setStatus: () => {} } } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    starts++;
    options.onStarted?.(`advisor-${starts}`);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  }, dir);
  await commands.get('fusion-models')('p/a#high p/b#medium advisor=p/a#low', ctx);
  pi.appendEntry('fusion.pi.child', { role: 'advisor', id: 'advisor-0001' });
  const call = (id?: string) => tools.get('fusion_delegate').execute('call', { role: 'advisor', task: 'assess', ...(id ? { sessionID: id } : {}) }, undefined, undefined, ctx);
  const first = call('advisor-0001');
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = call('advisor-0001');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1, 'continuation waits before opening another SDK file manager');
  const independent = call();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2);
  pending[0].reject(new Error('consultation failed'));
  await assert.rejects(first, /consultation failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 3);
  pending[1].resolve({ id: 'advisor-0002', text: 'independent', usage: emptyUsage() });
  pending[2].resolve({ id: 'advisor-0001', text: 'retry succeeded', usage: emptyUsage() });
  await independent;
  await duplicate;
  const subsequent = call('advisor-0001');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 4);
  pending[3].resolve({ id: 'advisor-0001', text: 'again', usage: emptyUsage() });
  await subsequent;
});

test('/fusion turns off in this session, releases tool and prompt guards, and explicitly re-enables saved setup', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-off-');
  const commands = new Map<string, any>(), tools = new Map<string, any>(), handlers = new Map<string, Function>(), entries: any[] = [], notices: string[] = [], menu: string[][] = [];
  const statuses = new Map<string, string>();
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'], contextWindow: 250000 }));
  let model: any = models[0], effort = 'off';
  const answers: Array<string | undefined> = ['Turn Fusion off', 'Turn Fusion off', 'Enable saved Fusion setup'];
  let finish: ((value: { id: string; text: string; usage: ReturnType<typeof emptyUsage> }) => void) | undefined;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: (config: any) => tools.set(config.name, config), on: (name: string, fn: Function) => handlers.set(name, fn),
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }),
    sendMessage: () => {} } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, isIdle: () => true, get model() { return model; }, sessionManager: { getBranch: () => entries, getSessionId: () => 'root-off' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    ui: { select: async (_title: string, options: string[]) => { menu.push(options); return answers.shift(); }, notify: (text: string) => { notices.push(text); },
      setStatus: (key: string, text?: string) => { if (text) statuses.set(key, text); else statuses.delete(key); } } } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    options.onStarted?.('child-id-123');
    return new Promise(resolve => { finish = value => { options.onConfirmed?.(value.id); resolve(value); }; });
  }, dir);
  await commands.get('fusion-models')('p/a#high@100k p/b#medium@50k', ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: on');
  const selectedModel = model, selectedEffort = effort;
  await tools.get('fusion_delegate').execute('call', { role: 'sidekick', task: 'active work', background: true }, undefined, undefined, ctx);
  await commands.get('fusion')('', ctx);
  assert.equal(menu[0][0], 'Turn Fusion off');
  assert.ok(notices.some(text => /Finish or stop active Fusion work/.test(text)));
  assert.equal(handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'pwd' } }, ctx)?.block, true);
  finish!({ id: 'child-id-123', text: 'done', usage: emptyUsage() });
  await new Promise(resolve => setImmediate(resolve));
  effort = 'low';
  await commands.get('fusion')('', ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: off');
  assert.equal(model.contextWindow, 250000);
  assert.equal(model.id, selectedModel.id);
  assert.equal(effort, 'low', 'turning Fusion off restores native context without replacing an external effort change');
  model = { ...model, contextWindow: 70000 };
  await handlers.get('session_start')?.({}, ctx);
  assert.equal(model.contextWindow, 70000, 'an inactive Fusion setup must not overwrite an external context choice');
  assert.equal(await handlers.get('input')?.({}, ctx), undefined);
  assert.equal(handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'pwd' } }, ctx), undefined);
  const prompt = { systemPromptOptions: { sections: {} } } as any;
  await handlers.get('before_agent_start')?.(prompt, ctx);
  assert.equal(prompt.systemPromptOptions.sections.fusion_role, undefined);
  await assert.rejects(tools.get('fusion_delegate').execute('call', { role: 'sidekick', task: 'should not launch', background: true }, undefined, undefined, ctx), /off|disabled/i);
  await commands.get('fusion')('', ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: on');
  assert.equal(menu[2][0], 'Enable saved Fusion setup');
  assert.equal(handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'pwd' } }, ctx)?.block, true);
  assert.equal(model.contextWindow, 100000);
  assert.equal(model.id, selectedModel.id);
  assert.equal(effort, selectedEffort, 'explicit re-enable reapplies the saved effort');
  assert.equal((await new History(dir, dir).load()).last?.lead, 'p/a#high@100k');
  assert.ok(notices.some(text => /off/i.test(text)));
  const before = entries.length;
  answers.push(undefined);
  await commands.get('fusion')('', ctx);
  assert.equal(entries.length, before, 'Escape does not change active state');
});

test('Fusion status restores from the active branch on session start and tree navigation', async () => {
  const handlers = new Map<string, Function>();
  const statuses = new Map<string, string>();
  const setup = { type: 'custom', customType: 'fusion.pi.setup', data: { lead: 'p/a#high', sidekick: 'p/b#medium' } };
  const disabled = { type: 'custom', customType: 'fusion.pi.disabled', data: {} };
  let branch: any[] = [setup];
  const pi = { registerCommand: () => {}, registerTool: () => {}, on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getBranch: () => branch }, ui: {
    setStatus: (key: string, text?: string) => { if (text) statuses.set(key, text); else statuses.delete(key); },
  } } as unknown as ExtensionContext;
  createFusion(pi);
  await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: on');
  branch = [setup, disabled];
  await handlers.get('session_tree')?.({ type: 'session_tree' }, ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: off');
  await handlers.get('session_start')?.({ type: 'session_start', reason: 'resume' }, ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: off');
  branch = [];
  await handlers.get('session_start')?.({ type: 'session_start', reason: 'new' }, ctx);
  assert.equal(statuses.has('fusion'), false);
  branch = [setup];
  await handlers.get('session_start')?.({ type: 'session_start', reason: 'fork' }, ctx);
  assert.equal(statuses.get('fusion'), 'Fusion: on');
  branch = [];
  await handlers.get('session_tree')?.({ type: 'session_tree' }, ctx);
  assert.equal(statuses.has('fusion'), false);
});

test('explicit apply, parallel sidekicks, owned continuations and branch cancellation', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-fake-');
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'], thinkingLevelMap: { xhigh: 'xhigh' } }));
  let selected: any = models[0], effort = 'off', auth = true, starts = 0;
  const finish = new Map<string, (result: { id: string; text: string; usage: ReturnType<typeof emptyUsage> }) => void>();
  const delivered: string[] = [];
  const launches: Launch[] = [];
  const pi = {
    registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, opts.handler),
    registerTool: (opts: { name: string }) => tools.set(opts.name, opts),
    on: (name: string, handler: Function) => handlers.set(name, handler),
    getThinkingLevel: () => effort,
    setModel: async (model: any) => { if (!auth) return false; selected = model; return true; },
    setThinkingLevel: (value: string) => { effort = value; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }),
    sendMessage: (message: { content: string }) => { delivered.push(message.content); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, isIdle: () => true,
    get model() { return selected; },
    sessionManager: { getBranch: () => entries, getSessionId: () => 'root-test' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => auth },
    ui: { notify: (text: string) => { notifications.push(text); }, select: async () => undefined, setStatus: () => {} },
  } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    launches.push(options); starts++;
    const id = options.resume ?? (starts === 1 ? 'child-id-123' : 'child-id-parallel');
    options.onStarted?.(id);
    const data = await new Promise<{ id: string; text: string; usage: ReturnType<typeof emptyUsage> }>(resolve => { finish.set(id, resolve); });
    options.onConfirmed?.(data.id);
    return data;
  }, dir);
  await commands.get('fusion')!('', ctx);
  assert.equal(entries.length, 0);
  await commands.get('fusion-models')!('p/a#high p/b#xhigh', ctx);
  assert.equal(entries.length, 1);
  assert.equal(effort, 'high');
  effort = 'off';
  assert.deepEqual(await handlers.get('input')?.({}, ctx), { action: 'handled' });
  effort = 'high';
  const delegate = tools.get('fusion_delegate');
  const first = delegate.execute('call', { role: 'sidekick', task: 'work', background: true }, undefined, undefined, ctx);
  assert.match((await first).content[0].text, /sessionID: child-id-123/);
  assert.equal(starts, 1);
  await assert.rejects(delegate.execute('call', { role: 'sidekick', task: 'overlap', background: true, sessionID: 'child-id-123' }, undefined, undefined, ctx), /confirmed/);
  const parallel = await delegate.execute('parallel', { role: 'sidekick', task: 'independent check', background: true }, undefined, undefined, ctx);
  assert.match(parallel.content[0].text, /sessionID: child-id-parallel/);
  assert.equal(launches[1].resume, undefined);
  finish.get('child-id-parallel')!({ id: 'child-id-parallel', text: 'parallel done', usage: emptyUsage() });
  await new Promise(resolve => setImmediate(resolve));
  await commands.get('fusion-models')!('p/b#high p/a#xhigh', ctx);
  assert.match(notifications.at(-1)!, /Wait for active children/);
  finish.get('child-id-123')!({ id: 'child-id-123', text: 'done', usage: emptyUsage() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.length, 3);
  assert.equal(delivered.length, 2);
  assert.match(delivered[1], /done/);
  assert.equal(launches[0].resume, undefined);
  await assert.rejects(delegate.execute('call', { role: 'sidekick', task: 'foreign', background: true, sessionID: 'foreign-child' }, undefined, undefined, ctx), /confirmed|another/);
  const second = delegate.execute('call', { role: 'sidekick', task: 'follow-up', background: true, sessionID: 'child-id-123' }, undefined, undefined, ctx);
  await second;
  assert.equal(launches[2].resume, 'child-id-123');
  await delegate.execute('parallel', { role: 'sidekick', task: 'parallel follow-up', background: true, sessionID: 'child-id-parallel' }, undefined, undefined, ctx);
  assert.equal(launches[3].resume, 'child-id-parallel');
  const switched = handlers.get('session_before_switch')?.();
  // Simulate completion after the abort reservation has gone: captured ctx still
  // reports the old root/branch, so only the generation invalidation can guard delivery.
  Object.defineProperty(launches[2].signal!, 'aborted', { value: false, configurable: true });
  finish.get('child-id-123')!({ id: 'child-id-123', text: 'late', usage: emptyUsage() });
  finish.get('child-id-parallel')!({ id: 'child-id-parallel', text: 'late parallel', usage: emptyUsage() });
  await switched;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.length, 3);
  assert.equal(delivered.length, 2);
  auth = false;
  await commands.get('fusion-models')!('p/a#high p/b#xhigh', ctx);
  assert.equal(entries.length, 3);
  auth = true;
  await commands.get('fusion-models')!('p/a#high p/b#medium', ctx);
  assert.equal(entries.length, 4);
  const third = delegate.execute('call', { role: 'sidekick', task: 'new human-selected effort', background: true, sessionID: 'child-id-123' }, undefined, undefined, ctx);
  await third;
  assert.equal(launches[4].resume, 'child-id-123');
  assert.equal(launches[4].choice, 'p/b#medium');
  finish.get('child-id-123')!({ id: 'child-id-123', text: 'updated model', usage: emptyUsage() });
  await new Promise(resolve => setImmediate(resolve));
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(delegate.execute('call', { role: 'sidekick', task: 'must not start', background: true }, preAborted.signal, undefined, ctx), /cancelled before it started/);
  assert.equal(launches.length, 5);
  await assert.rejects(delegate.execute('call', { role: 'sidekick', task: 'bad model', model: 'unapproved' }, undefined, undefined, ctx), /override/);
  await assert.rejects(delegate.execute('call', { role: 'utility', task: 'removed role' }, undefined, undefined, ctx), /role/);
});

test('interactive picker uses recent, new model, optional off, unavailable rejection and Escape without writing', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-picker-');
  const commands = new Map<string, any>(), entries: any[] = [], steps: Array<{ title: RegExp; answer?: string; includes?: string; excludes?: string }> = [];
  const models = ['a', 'b', 'c', 'd'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'], thinkingLevelMap: { xhigh: 'xhigh' }, contextWindow: 250000 }));
  let model: any = models[0], effort = 'off', available = models;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: () => {}, on: () => {},
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }) } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, isIdle: () => true, get model() { return model; }, sessionManager: { getBranch: () => entries, getSessionId: () => 'root-picker' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => available, hasConfiguredAuth: () => true },
    ui: { notify: () => {}, setStatus: () => {}, input: async (title: string) => { const next = steps.shift()!; assert.match(title, next.title); return next.answer; },
      select: async (title: string, options: string[]) => { const next = steps.shift()!; assert.match(title, next.title); if (next.includes) assert.ok(options.includes(next.includes)); if (next.excludes) assert.equal(options.includes(next.excludes), false); return next.answer; } } } as unknown as ExtensionContext;
  createFusion(pi, undefined, dir);
  await commands.get('fusion-models')('p/a#high p/b#medium advisor=p/d#low', ctx);
  steps.push(
    { title: /Fusion setup/, answer: 'lead: p/a#high' }, { title: /Choose lead/, answer: 'Choose new model', includes: 'p/a#high' },
    { title: /lead model search/, answer: 'd' }, { title: /Choose lead model/, answer: 'p/d' }, { title: /Choose lead effort/, answer: 'high' },
    { title: /Choose lead context/, answer: 'Default (250k)', includes: '200k', excludes: '400k' },
    { title: /Fusion setup/, answer: 'sidekick: p/b#medium' }, { title: /Choose sidekick/, answer: 'p/b#medium' },
    { title: /Fusion setup/, answer: 'advisor: p/d#low' }, { title: /Choose advisor/, answer: 'Turn advisor off', includes: 'p/d#low' },
    { title: /Fusion setup/, answer: 'advisor: off' }, { title: /Choose advisor/, answer: 'Choose new model', includes: 'p/d#low' },
    { title: /advisor model search/, answer: 'c' }, { title: /Choose advisor model/, answer: 'p/c' }, { title: /Choose advisor effort/, answer: 'high' },
    { title: /Choose advisor context/, answer: 'Default (250k)' },
    { title: /Fusion setup/, answer: 'reviewer: off' }, { title: /Choose reviewer/, answer: 'Choose new model', includes: 'Turn reviewer off' },
    { title: /reviewer model search/, answer: 'a' }, { title: /Choose reviewer model/, answer: 'p/a' }, { title: /Choose reviewer effort/, answer: 'low' },
    { title: /Choose reviewer context/, answer: 'Default (250k)' },
    { title: /Fusion setup/, answer: 'Apply this setup' },
  );
  await commands.get('fusion')('', ctx);
  assert.equal(steps.length, 0);
  assert.deepEqual(entries.at(-1).data, { lead: 'p/d#high', sidekick: 'p/b#medium', advisor: 'p/c#high', reviewer: 'p/a#low' });
  const history = new History(dir, dir);
  const recents = (await history.load()).recents;
  assert.deepEqual(recents.lead, ['p/d#high', 'p/a#high']);
  assert.deepEqual(recents.sidekick, ['p/b#medium']);
  assert.deepEqual(recents.advisor, ['p/c#high', 'p/d#low']);
  assert.deepEqual(recents.reviewer, ['p/a#low']);
  const before = entries.length, oldHistory = JSON.stringify(await history.load());
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high' }, { title: /Choose lead/, answer: 'Choose new model' },
    { title: /lead model search/, answer: 'a' }, { title: /Choose lead model/, answer: 'p/a' }, { title: /Choose lead effort/ });
  await commands.get('fusion')('', ctx);
  assert.equal(entries.length, before);
  assert.equal(JSON.stringify(await history.load()), oldHistory);
  available = models.filter(item => item.id !== 'c');
  steps.push({ title: /Fusion setup/, answer: 'advisor: p/c#high' }, { title: /Choose advisor/, answer: 'p/c#high (unavailable)', includes: 'p/c#high (unavailable)' },
    { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(entries.length, before);
  assert.equal(JSON.stringify(await history.load()), oldHistory);
  assert.equal(entries.at(-1).data.advisor, 'p/c#high');
  available = models;
  steps.push({ title: /Fusion setup/, answer: 'reviewer: p/a#low' }, { title: /Choose reviewer/, answer: 'Turn reviewer off', includes: 'p/a#low' },
    { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(entries.at(-1).data.reviewer, undefined);
  assert.deepEqual((await history.load()).recents.reviewer, ['p/a#low']);

  const saved = entries.at(-1).data;
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high' }, { title: /Choose lead/, answer: 'Change context budget', includes: 'Change context budget' },
    { title: /Choose lead context/, answer: '100k', includes: 'Default (250k)' },
    { title: /Fusion setup/, answer: 'sidekick: p/b#medium' }, { title: /Choose sidekick/, answer: 'Change context budget' },
    { title: /Choose sidekick context/, answer: '50k' }, { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.deepEqual(entries.at(-1).data, { ...saved, lead: 'p/d#high@100k', sidekick: 'p/b#medium@50k' });
  assert.equal(model.contextWindow, 100000);
  assert.equal(model.id, 'd');
  assert.equal(effort, 'high');
  assert.equal(models[3].contextWindow, 250000);
  const budgetHistory = JSON.stringify(await history.load()), budgetEntries = entries.length;
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high@100k' }, { title: /Choose lead/, answer: 'Change context budget' },
    { title: /Choose lead context/, answer: 'Default (250k)' },
    { title: /Fusion setup/, answer: 'sidekick: p/b#medium@50k' }, { title: /Choose sidekick/, answer: 'Change context budget' },
    { title: /Choose sidekick context/ });
  await commands.get('fusion')('', ctx);
  assert.equal(entries.length, budgetEntries, 'cancelling context selection discards the earlier draft edit too');
  assert.equal(model.contextWindow, 100000);
  assert.equal(JSON.stringify(await history.load()), budgetHistory);
  steps.push({ title: /Fusion setup/, answer: 'Use last setup' }, { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(entries.at(-1).data.lead, 'p/d#high@100k');
  assert.equal(entries.at(-1).data.sidekick, 'p/b#medium@50k');
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high@100k' }, { title: /Choose lead/, answer: 'Change context budget' },
    { title: /Choose lead context/, answer: 'Default (250k)' }, { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(model.contextWindow, 250000);
  assert.equal(entries.at(-1).data.lead, 'p/d#high');
  assert.equal(entries.at(-1).data.sidekick, 'p/b#medium@50k');
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high' }, { title: /Choose lead/, answer: 'p/d#high@100k', includes: 'p/d#high@100k' },
    { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(model.contextWindow, 100000, 'selecting a recent keeps its budget without another chooser');
  assert.equal(effort, 'high');

  models[3].contextWindow = 1050000;
  await commands.get('fusion-models')('p/d#high@1000k p/b#medium', ctx);
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high@1M', includes: 'lead: p/d#high@1M' },
    { title: /Choose lead/, answer: 'Change context budget', includes: 'p/d#high@1M' },
    { title: /Choose lead context/, answer: '1M', includes: '1M', excludes: '1000k' },
    { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(steps.length, 0);
  assert.equal(model.contextWindow, 1000000);
  assert.equal(effort, 'high');
  assert.equal(models[3].contextWindow, 1050000);
  const million = await history.load();
  assert.equal(million.last?.lead, 'p/d#high@1M');
  assert.deepEqual(million.recents.lead, ['p/d#high@1M', 'p/d#high@100k', 'p/d#high']);
  steps.push({ title: /Fusion setup/, answer: 'lead: p/d#high@1M' },
    { title: /Choose lead/, answer: 'Change context budget' },
    { title: /Choose lead context/, answer: 'Default (1.05M)', includes: 'Default (1.05M)' },
    { title: /Fusion setup/, answer: 'lead: p/d#high' },
    { title: /Choose lead/, answer: 'p/d#high@1M', includes: 'p/d#high@1M' },
    { title: /Fusion setup/, answer: 'Apply this setup' });
  await commands.get('fusion')('', ctx);
  assert.equal(steps.length, 0);
  assert.equal(model.contextWindow, 1000000, 'the M-unit recent remains selectable and keeps its budget');
});

test('real Pi loader registers commands and owned tool without inference or real auth', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-sdk-');
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve('pi/index.ts')] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader, sessionManager: SessionManager.inMemory(dir), tools: ['fusion_delegate'] });
  try {
    const commands = resourceLoader.getExtensions().extensions.flatMap(ext => [...ext.commands.keys()]);
    assert.ok(commands.includes('fusion'));
  assert.ok(commands.includes('fusion-models'));
  assert.ok(commands.includes('usage'));
  assert.equal(commands.includes('fusion-review'), false);
    assert.ok(session.getAllTools().some(tool => tool.name === 'fusion_delegate'));
    assert.equal(session.getActiveToolNames().includes('fusion_delegate'), true);
    assert.equal(session.messages.length, 0);
  } finally { session.dispose(); }
});

test('failed child is not confirmed and cancelled background work is not reported as success', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-errors-');
  const commands = new Map<string, any>(), tools = new Map<string, any>(), handlers = new Map<string, Function>(), entries: any[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'] }));
  let model: any = models[0], effort = 'off', attempts = 0;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: (config: any) => tools.set(config.name, config), on: (name: string, handler: Function) => handlers.set(name, handler),
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }) } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, isIdle: () => true, get model() { return model; }, sessionManager: { getBranch: () => entries, getSessionId: () => 'root-error' },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    ui: { notify: () => {}, setStatus: () => {} } } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    attempts++;
    if (attempts === 1) throw new Error('provider failure');
    options.onStarted?.('child-id-123');
    return new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  }, dir);
  await commands.get('fusion-models')('p/a#high p/b#medium', ctx);
  const delegate = tools.get('fusion_delegate');
  await assert.rejects(delegate.execute('call', { role: 'sidekick', task: 'one', background: true }, undefined, undefined, ctx), /provider failure/);
  assert.equal(entries.length, 1);
  const started = await delegate.execute('call', { role: 'sidekick', task: 'two', background: true }, undefined, undefined, ctx);
  assert.match(started.content[0].text, /child-id-123/);
  await handlers.get('session_before_switch')?.();
  assert.equal(entries.length, 1);
});

test('lead controls a blocked background advisor, rejects foreign/stale callers and delivers cancellation', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-pi-controls-');
  const commands = new Map<string, any>(), tools = new Map<string, any>(), handlers = new Map<string, Function>(), entries: any[] = [], delivered: string[] = [];
  const models = ['a', 'b'].map(id => ({ provider: 'p', id, reasoning: true, input: ['text'] }));
  let model: any = models[0], effort = 'off', root = 'root-controls';
  const launches: Launch[] = [], messages: string[] = [];
  let settleCancelled!: () => void;
  const pi = { registerCommand: (name: string, config: any) => commands.set(name, config.handler), registerTool: (config: any) => tools.set(config.name, config), on: (name: string, handler: Function) => handlers.set(name, handler),
    getThinkingLevel: () => effort, setThinkingLevel: (value: string) => { effort = value; }, setModel: async (value: any) => { model = value; return true; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length + 1) }),
    sendMessage: (message: { content: string }) => delivered.push(message.content) } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, isIdle: () => true, get model() { return model; }, sessionManager: { getBranch: () => entries, getSessionId: () => root },
    modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    ui: { notify: () => {}, setStatus: () => {} } } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    launches.push(options);
    const id = `worker-controls-${launches.length}`;
    options.onSessionReady?.({ sessionId: id, isStreaming: true, sendCustomMessage: async (message: { content: string }) => { messages.push(message.content); },
      subscribe: (listener: Function) => { listener({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'partial findings' }], timestamp: Date.now() } }); return () => {}; } } as any);
    options.onStarted?.(id);
    return new Promise((_resolve, reject) => {
      if (launches.length === 1) settleCancelled = () => reject(new Error('cancelled after delayed interruption'));
      else options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  }, dir);
  await commands.get('fusion-models')('p/a#high p/b#medium advisor=p/a#low', ctx);
  const call = (params: unknown) => tools.get('fusion_worker').execute('control', params, undefined, undefined, ctx);
  await tools.get('fusion_delegate').execute('call', { role: 'advisor', task: 'assess', background: true }, undefined, undefined, ctx);
  await tools.get('fusion_delegate').execute('other', { role: 'sidekick', task: 'independent', background: true }, undefined, undefined, ctx);
  const target = { sessionID: 'worker-controls-1' };
  assert.match((await call({ ...target, action: 'status' })).content[0].text, /partial findings/);
  await call({ ...target, action: 'message', message: '/wrap-up findings now' });
  assert.deepEqual(messages, ['/wrap-up findings now']);
  await assert.rejects(call({ ...target, action: 'message', message: ' ' }), /message/i);
  await assert.rejects(call({ ...target, action: 'cancel', model: 'unapproved' }), /argument|override/i);
  root = 'foreign-root';
  await assert.rejects(call({ ...target, action: 'cancel' }), /own|stale|root/i);
  root = 'root-controls';
  entries.push({ type: 'custom', customType: 'fusion.pi.owner', data: { role: 'sidekick' } });
  await assert.rejects(call({ ...target, action: 'cancel' }), /lead|nested|caller/i);
  entries.pop();
  assert.equal(launches[0].signal?.aborted, false);
  const cancelled = await call({ ...target, action: 'cancel' });
  assert.match(cancelled.content[0].text, /requested/i);
  assert.match(cancelled.content[0].text, /partial findings/);
  assert.equal(launches[0].signal?.aborted, true);
  assert.equal(launches[1].signal?.aborted, false);
  const pending = (await call({ ...target, action: 'status' })).content[0].text;
  assert.match(pending, /stopping not confirmed/i);
  assert.match(pending, /State: running/);
  assert.equal(delivered.length, 0, 'abort request alone cannot produce a completion');
  settleCancelled();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(delivered.some(text => /cancel/i.test(text) && text.includes('partial findings')));
  await handlers.get('session_before_tree')?.();
  await assert.rejects(call({ sessionID: 'worker-controls-2', action: 'message', message: 'stale' }), /confirmed|stale|own/i);
  assert.equal(delivered.length, 1, 'navigation suppresses unrelated late cancellation results');
});
