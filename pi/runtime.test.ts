import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { createAgentSession, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { LiveWorkers, openOwned, runChild } from './worker.ts';
import { RunRegistry, splitRuns } from './viewer.ts';
import { createFusion } from './index.ts';
import { collectUsage } from './usage.ts';
import { persistedRuns } from './viewer-ui.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Registry } from './state.ts';

const usage = { input: 3, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 9, cost: { input: .03, output: .05, cacheRead: .01, cacheWrite: 0, total: .09 } };
function reply(model: Model<any>, text: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(), usage };
}
async function fixture(respond?: (model: Model<any>, index: number, context: TranscriptContext, cwd: string, options?: SimpleStreamOptions) => AssistantMessage) {
  const agentDir = await mkdtemp('/tmp/opencode/fusion-pi-runtime-');
  const cwd = join(agentDir, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(cwd);
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_SENTINEL: respect repository conventions.\n');
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const requests: Array<{ model: string; reasoning?: string; contextWindow: number; maxTokens: number; context: TranscriptContext; sessionId?: string }> = [];
  const release = new Map<string, (value: string | AssistantMessage) => void>();
  runtime.registerProvider('fusion-fake', {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/never-used', apiKey: 'in-memory-test-only',
    models: ['one', 'two'].map(id => ({ id, name: id, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 250000, maxTokens: 1000 })),
    streamSimple(model, context, options) {
      requests.push({ model: model.id, reasoning: options?.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, context, sessionId: options?.sessionId });
      const stream = createAssistantMessageEventStream();
      const message = respond?.(model, requests.length, context, cwd, options) ?? reply(model, `fake turn ${requests.length}`);
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (message.stopReason === 'pending') {
          release.set(options!.sessionId!, value => {
            const message = typeof value === 'string' ? reply(model, value) : value;
            stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
          });
          const onAbort = () => stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
          if (options?.signal?.aborted) onAbort();
          else options?.signal?.addEventListener('abort', onAbort, { once: true });
          return;
        }
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
      });
      return stream;
    },
  });
  const models = runtime.getModels('fusion-fake');
  const registry = { find: (p: string, id: string) => models.find(model => model.provider === p && model.id === id), getAvailable: () => [...models], hasConfiguredAuth: () => true } as Registry;
  return { agentDir, cwd, runtime, requests, registry, release, dir: join(agentDir, 'children') };
}

for (const role of ['advisor', 'reviewer'] as const) test(`${role} controls blocked background evidence and receives same-run steering results`, { timeout: 10000 }, async () => {
  let evidenceID = '', ownerCalls = 0, evidenceCalls = 0;
  let controlsDone!: () => void;
  const controlled = new Promise<void>(resolve => { controlsDone = resolve; });
  const steer = '/skill:unexpanded wrap up findings and unfinished work';
  const env = await fixture((model, _index, context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!;
      return ++evidenceCalls === 1 ? { ...reply(model, 'partial evidence'), stopReason: 'pending' } : reply(model, JSON.stringify(context.messages));
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'start-evidence', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'collect evidence', background: true } },
    ] };
    if (ownerCalls === 2) {
      const started = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'start-evidence');
      evidenceID = /sidekick sessionID: ([\w-]+)/.exec(JSON.stringify(started))![1];
      return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'inspect', name: 'fusion_worker', arguments: { action: 'status', sessionID: evidenceID } },
        { type: 'toolCall', id: 'steer', name: 'fusion_worker', arguments: { action: 'message', sessionID: evidenceID, message: steer } },
        { type: 'toolCall', id: 'foreign', name: 'fusion_worker', arguments: { action: 'cancel', sessionID: 'foreign-worker' } },
      ] };
    }
    controlsDone();
    return reply(model, JSON.stringify(context.messages.filter(message => message.role !== 'system')));
  });
  const workers = new LiveWorkers();
  const base = { ...env, root: 'root-controls', role, choice: 'fusion-fake/one#low', sidekickChoice: 'fusion-fake/two#medium', task: 'assess', briefing: 'contract', modelRuntime: env.runtime, workers };
  let owner!: AgentSession;
  const registry = new RunRegistry(), run = registry.add(role, base.task), controller = new AbortController();
  const operation = runChild({ ...base, signal: controller.signal, onSessionReady: (session, steer) => {
    owner = session; registry.attach(run, session); workers.attach(base.root, run, session, controller, () => true, steer);
  } });
  await controlled;
  assert.equal(evidenceCalls, 1, 'owner has inspected and steered while evidence is still blocked');
  await owner.waitForIdle();
  await workers.control({ action: 'message', sessionID: owner.sessionId, message: '/wrap-up-owner include unfinished work' }, base.root, () => { throw new Error('unexpected fallback'); });
  await owner.waitForIdle();
  env.release.get(evidenceID)!('initial evidence complete');
  const result = await operation;
  const manager = openOwned(env.cwd, env.dir, result.id, base.root, role);
  const messages = manager.buildSessionContext().messages;
  const inspect = messages.find(message => message.role === 'toolResult' && message.toolCallId === 'inspect');
  assert.ok(inspect && inspect.role === 'toolResult' && !inspect.isError);
  assert.match(JSON.stringify(inspect.content), /partial evidence/);
  const foreign = messages.find(message => message.role === 'toolResult' && message.toolCallId === 'foreign');
  assert.ok(foreign && foreign.role === 'toolResult' && foreign.isError);
  assert.ok(result.text.includes(steer), 'delivered evidence output reaches owner inference');
  assert.ok(result.text.includes('/wrap-up-owner include unfinished work'), 'owner retains steering in the same conversation');
  const evidence = openOwned(env.cwd, env.dir, evidenceID, result.id, 'sidekick').buildSessionContext().messages;
  assert.equal(evidence.filter(message => message.role === 'user').length, 1);
  assert.ok(evidence.some(message => message.role === 'custom' && message.content === steer));
  assert.equal(evidenceCalls, 2, 'steering continued the same conversation');
  assert.equal(splitRuns(evidence, { role: 'sidekick', sessionID: evidenceID }).length, 1, 'custom steering does not split persisted viewer runs');
  const count = env.requests.length;
  const terminal = await workers.control({ action: 'message', sessionID: evidenceID, message: 'too late' }, result.id,
    id => openOwned(env.cwd, env.dir, id, result.id, 'sidekick'));
  assert.match(terminal, /State: done/);
  assert.equal(env.requests.length, count, 'completed controls never restart the worker');
});

for (const role of ['advisor', 'reviewer'] as const) test(`${role} wakes on automatic evidence supervision in its native owner conversation`, { timeout: 10000 }, async t => {
  let ownerCalls = 0, evidenceID = '', owner!: AgentSession;
  const env = await fixture((model, _index, context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!;
      return { ...reply(model, 'evidence still running'), stopReason: 'pending' };
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'start-supervised-evidence', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'collect bounded evidence', background: true } },
    ] };
    return reply(model, JSON.stringify(context.messages.filter(message => message.role === 'user')));
  });
  let now = Date.now();
  const workers = new LiveWorkers({ now: () => now });
  const controller = new AbortController();
  const operation = runChild({ ...env, root: 'root-supervised-evidence', role, choice: 'fusion-fake/one#low', sidekickChoice: 'fusion-fake/two#medium',
    task: 'assess', briefing: 'contract', modelRuntime: env.runtime, workers, signal: controller.signal,
    onSessionReady: session => { owner = session; } });
  t.after(async () => { controller.abort(); workers.dispose(); await operation.catch(() => {}); });
  while (ownerCalls < 2) await new Promise(resolve => setImmediate(resolve));
  await owner.waitForIdle();
  now += 60000; await workers.checkProgress();
  await owner.waitForIdle();
  assert.equal(ownerCalls, 3, 'automatic evidence update wakes the idle owner before evidence completion');
  const delivered = owner.messages.filter(message => message.role === 'custom' && message.customType === 'fusion.pi.steering');
  assert.equal(delivered.length, 1);
  assert.ok(JSON.stringify(delivered[0]).includes(evidenceID));
  assert.equal(env.requests.filter(request => request.sessionId === evidenceID).length, 1, 'summary does not restart evidence inference');
  env.release.get(evidenceID)!('bounded evidence complete');
  const result = await operation;
  assert.ok(result.text.includes('bounded evidence complete'), 'owner still consumes final evidence after a supervision wake');
  const calls = env.requests.length;
  now += 60000; await workers.checkProgress();
  assert.equal(env.requests.length, calls, 'released evidence cannot wake a terminal owner');
});

for (const role of ['advisor', 'reviewer'] as const) test(`${role} wakes on root steering while evidence is blocked and drains its cancellation before final delivery`, { timeout: 10000 }, async t => {
  let ownerCalls = 0, evidenceID = '', owner!: AgentSession, settled = false;
  const env = await fixture((model, _index, context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!;
      return { ...reply(model, 'blocked evidence partial output'), stopReason: 'pending' };
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'evidence', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'inspect', background: true } },
    ] };
    if (ownerCalls === 2) return reply(model, 'waiting for evidence');
    assert.ok(JSON.stringify(context.messages).includes('/report-now cancel stuck evidence'));
    if (JSON.stringify(context.messages).includes('Evidence cancellation requested')) return reply(model, 'wrap-up: evidence cancelled; partial findings retained');
    return { ...reply(model, 'working on wrap-up'), stopReason: 'pending' };
  });
  const tools = new Map<string, any>(), delivered: string[] = [];
  const entries: any[] = [{ type: 'custom', customType: 'fusion.pi.setup', id: 'setup-wake', data: {
    lead: 'fusion-fake/one#high', sidekick: 'fusion-fake/two#medium', [role]: 'fusion-fake/one#low',
  } }];
  const pi = { registerCommand: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {}, getThinkingLevel: () => 'high',
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length) }),
    sendMessage: (message: { content: string }) => delivered.push(message.content) } as unknown as ExtensionAPI;
  const ctx = { cwd: env.cwd, hasUI: false, isIdle: () => true, model: env.runtime.getModel('fusion-fake', 'one'), modelRegistry: env.registry,
    sessionManager: { getSessionId: () => 'root-wake', getBranch: () => entries }, ui: { notify: () => {} } } as unknown as ExtensionContext;
  let workers!: LiveWorkers, operation!: ReturnType<typeof runChild>;
  createFusion(pi, options => {
    workers = options.workers!;
    operation = runChild({ ...options, modelRuntime: env.runtime, onSessionReady: (session, steer) => {
      owner = session; options.onSessionReady?.(session, steer);
    } });
    void operation.finally(() => { settled = true; }).catch(() => {});
    return operation;
  }, env.agentDir);
  const control = (params: unknown) => tools.get('fusion_worker').execute('control', params, undefined, undefined, ctx);
  await tools.get('fusion_delegate').execute('start', { role, task: 'inspect', background: true }, undefined, undefined, ctx);
  t.after(async () => { await control({ action: 'cancel', sessionID: owner.sessionId }); await operation.catch(() => {}); });
  while (ownerCalls < 2) await new Promise(resolve => setImmediate(resolve));
  await owner.waitForIdle();
  const ack = await control({ action: 'message', sessionID: owner.sessionId, message: '/report-now cancel stuck evidence' });
  assert.match(ack.content[0].text, /admitted/i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ownerCalls, 3, 'root steering reaches the owner before evidence is released');
  assert.equal(settled, false, 'acknowledgement does not await the blocked wake response');
  env.release.get(owner.sessionId)!({ ...reply(env.runtime.getModel('fusion-fake', 'one')!, ''), stopReason: 'toolUse', content: [
    { type: 'toolCall', id: 'cancel-evidence', name: 'fusion_worker', arguments: { action: 'cancel', sessionID: evidenceID } },
  ] });
  while (!(await workers.control({ action: 'status', sessionID: evidenceID }, owner.sessionId,
    id => openOwned(env.cwd, owner.sessionManager.getSessionDir(), id, owner.sessionId, 'sidekick'))).includes('No live handle')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'finishing evidence cannot dispose the pending wake turn');
  env.release.get(owner.sessionId)!('wrap-up: evidence cancelled; partial findings retained');
  const result = await operation;
  assert.match(result.text, /wrap-up: evidence cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /wrap-up: evidence cancelled/);
  assert.equal(owner.isIdle, true);
  const evidence = openOwned(env.cwd, owner.sessionManager.getSessionDir(), evidenceID, result.id, 'sidekick').buildSessionContext().messages;
  assert.ok(evidence.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  assert.equal(splitRuns(owner.messages, { role, sessionID: result.id }).length, 1);
  const calls = env.requests.length;
  await control({ action: 'message', sessionID: result.id, message: 'late wake' });
  assert.equal(env.requests.length, calls, 'terminal controls do not restart inference');
});

test('targeted evidence cancellation returns partial results to its owner and cannot grant sidekicks controls', { timeout: 10000 }, async () => {
  let ownerCalls = 0, evidenceID = '';
  const env = await fixture((model, _index, context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!;
      const tools = context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded?.map(tool => tool.name) ?? [] : []);
      assert.equal(tools.includes('fusion_worker'), false);
      return { ...reply(model, 'retained partial evidence'), stopReason: 'pending' };
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'start', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'gather evidence', background: true } },
    ] };
    if (ownerCalls === 2) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'cancel', name: 'fusion_worker', arguments: { action: 'cancel', sessionID: evidenceID } },
    ] };
    return reply(model, JSON.stringify(context.messages.filter(message => message.role === 'user' || message.role === 'toolResult')));
  });
  const result = await runChild({ ...env, root: 'root-cancel', role: 'advisor', choice: 'fusion-fake/one#low', sidekickChoice: 'fusion-fake/two#medium', task: 'inspect', briefing: 'contract', modelRuntime: env.runtime });
  assert.match(result.text, /cancellation requested/i);
  assert.match(result.text, /retained partial evidence/);
  const messages = openOwned(env.cwd, env.dir, evidenceID, result.id, 'sidekick').buildSessionContext().messages;
  assert.ok(messages.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  const owner = openOwned(env.cwd, env.dir, result.id, 'root-cancel', 'advisor').buildSessionContext().messages;
  assert.equal(owner.filter(message => message.role === 'custom' && message.customType === 'fusion.pi.evidence-result').length, 1);
});

for (const failure of ['provider', 'delivery'] as const) test(`idle steering ${failure} failure reaches the caller and cancels outstanding evidence`, { timeout: 10000 }, async t => {
  let ownerCalls = 0, evidenceID = '', owner!: AgentSession;
  const env = await fixture((model, _index, _context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!;
      return { ...reply(model, 'retained evidence before wake failed'), stopReason: 'pending' };
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'start', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'inspect', background: true } },
    ] };
    return ownerCalls === 2 ? reply(model, 'waiting') : { ...reply(model, ''), stopReason: 'error', errorMessage: 'wake outage' };
  });
  const workers = new LiveWorkers(), registry = new RunRegistry(), controller = new AbortController(), run = registry.add('advisor', 'inspect');
  const base = { ...env, root: 'root-wake-failure', role: 'advisor' as const, choice: 'fusion-fake/one#low', sidekickChoice: 'fusion-fake/two#medium', task: 'inspect', briefing: 'contract', modelRuntime: env.runtime, workers };
  const operation = runChild({ ...base, signal: controller.signal, onSessionReady: (session, steer) => {
    owner = session; registry.attach(run, session); workers.attach(base.root, run, session, controller, () => true, steer);
  } });
  const failed = assert.rejects(operation, /Worker steering failed.*wake outage/);
  t.after(async () => { controller.abort(); await operation.catch(() => {}); });
  while (ownerCalls < 2) await new Promise(resolve => setImmediate(resolve));
  await owner.waitForIdle();
  if (failure === 'delivery') {
    const send = owner.sendCustomMessage.bind(owner);
    owner.sendCustomMessage = async (message, options) => {
      if (message.customType === 'fusion.pi.steering') throw new Error('wake outage');
      return send(message, options);
    };
  }
  await workers.control({ action: 'message', sessionID: owner.sessionId, message: 'report now' }, base.root, () => { throw new Error('unexpected fallback'); });
  await failed;
  assert.match((await workers.control({ action: 'status', sessionID: owner.sessionId }, base.root, () => { throw new Error('unexpected fallback'); })), /Worker steering failed.*wake outage/);
  assert.equal(owner.isIdle, true);
  const evidence = openOwned(env.cwd, env.dir, evidenceID, owner.sessionId, 'sidekick').buildSessionContext().messages;
  assert.ok(evidence.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  const restored = splitRuns(openOwned(env.cwd, env.dir, owner.sessionId, base.root, 'advisor').buildSessionContext().messages,
    { role: 'advisor', sessionID: owner.sessionId }).at(-1)!;
  assert.equal(restored.status, 'failed');
  assert.match(restored.error!, /wake outage/);
});

test('parent control cancellation cascades evidence, preserves histories and leaves unrelated work live', { timeout: 10000 }, async () => {
  let parentID = '', evidenceID = '', ownerCalls = 0;
  let owner!: AgentSession;
  let evidenceStarted!: () => void;
  const ready = new Promise<void>(resolve => { evidenceStarted = resolve; });
  const env = await fixture((model, _index, _context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!; evidenceStarted();
      return { ...reply(model, 'evidence before interruption'), stopReason: 'pending' };
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'evidence', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'collect', background: true } },
    ] };
    return reply(model, 'waiting for evidence');
  });
  const workers = new LiveWorkers(), registry = new RunRegistry(), controller = new AbortController();
  const base = { ...env, root: 'root-cascade', choice: 'fusion-fake/one#low', task: 'inspect', briefing: 'contract', modelRuntime: env.runtime, workers };
  const run = registry.add('advisor', base.task);
  const operation = runChild({ ...base, role: 'advisor', sidekickChoice: 'fusion-fake/two#medium', signal: controller.signal,
    onSessionReady: session => { owner = session; parentID = session.sessionId; registry.attach(run, session); workers.attach(base.root, run, session, controller); } });
  const rejected = assert.rejects(operation, /cancelled|aborted/i);
  await ready;
  const ownedEvidence = evidenceID;
  let unrelatedID = '';
  let otherStarted!: () => void;
  const otherReady = new Promise<void>(resolve => { otherStarted = resolve; });
  const otherController = new AbortController();
  const other = runChild({ ...base, role: 'sidekick', choice: 'fusion-fake/two#medium', signal: otherController.signal,
    onStarted: id => { unrelatedID = id; otherStarted(); } });
  const otherRejected = assert.rejects(other, /cancelled|aborted/i);
  await otherReady;
  await owner.waitForIdle();
  const report = await workers.control({ action: 'cancel', sessionID: parentID }, base.root, () => { throw new Error('unexpected fallback'); });
  assert.match(report, /stops unconfirmed/);
  assert.ok(report.includes(ownedEvidence));
  await rejected;
  assert.equal(otherController.signal.aborted, false);
  const history = openOwned(env.cwd, env.dir, ownedEvidence, parentID, 'sidekick').buildSessionContext().messages;
  assert.ok(history.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  const before = env.requests.filter(request => request.sessionId === parentID).length;
  const restored = splitRuns(openOwned(env.cwd, env.dir, parentID, base.root, 'advisor').buildSessionContext().messages,
    { role: 'advisor', sessionID: parentID }).at(-1)!;
  assert.equal(restored.status, 'aborted', 'an evidence-waiting owner must not restore as successfully done');
  assert.equal(restored.result, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.requests.filter(request => request.sessionId === parentID).length, before, 'cancelled owner is not restarted for evidence delivery');
  otherController.abort();
  await otherRejected;
  assert.ok(unrelatedID);
});

async function rootSession(env: Awaited<ReturnType<typeof fixture>>, sessionManager: SessionManager, settingsManager = SettingsManager.inMemory(), resume = false) {
  const resourceLoader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => createFusion(pi, options => runChild({ ...options, modelRuntime: env.runtime }), env.agentDir)] });
  await resourceLoader.reload();
  return (await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: env.runtime, settingsManager, resourceLoader, sessionManager,
    ...(resume ? {} : { model: env.runtime.getModel('fusion-fake', 'one'), thinkingLevel: 'high' as const }), tools: ['fusion_delegate'],
    sessionStartEvent: { type: 'session_start', reason: resume ? 'resume' : 'startup' } })).session;
}

test('real child SDK sends role and project instructions, survives restart and explicit model change', async () => {
  const env = await fixture();
  env.registry.find('fusion-fake', 'one')!.contextWindow = 1050000;
  const base = { ...env, root: 'root-1234', role: 'sidekick' as const, choice: 'fusion-fake/one#high@1M', task: 'first job', briefing: 'CANONICAL_BRIEFING_SENTINEL', modelRuntime: env.runtime };
  let confirmed: string | undefined;
  const first = await runChild({ ...base, onConfirmed: id => { confirmed = id; } });
  assert.equal(first.id, confirmed);
  assert.equal(env.requests.length, 1);
  const sent = JSON.stringify(env.requests[0].context.messages);
  assert.match(sent, /CANONICAL_BRIEFING_SENTINEL/);
  assert.match(sent, /PROJECT_INSTRUCTIONS_SENTINEL/);
  assert.equal(openOwned(env.cwd, env.dir, first.id, base.root, 'sidekick').getSessionId(), first.id);
  const second = await runChild({ ...base, choice: 'fusion-fake/two#low@50k', task: 'follow-up', resume: first.id });
  assert.equal(second.id, first.id);
  assert.equal(env.requests[1].model, 'two');
  assert.equal(env.requests[0].reasoning, 'high');
  assert.equal(env.requests[1].reasoning, 'low');
  assert.equal(env.requests[0].contextWindow, 1000000);
  assert.equal(env.requests[1].contextWindow, 50000);
  assert.equal(env.requests[1].maxTokens, 1000);
  assert.match(JSON.stringify(env.requests[1].context.messages), /first job/);
  const third = await runChild({ ...base, choice: 'fusion-fake/two#low', task: 'restore native default', resume: first.id });
  assert.equal(third.id, first.id);
  assert.equal(env.requests[2].contextWindow, 250000);
  assert.equal(env.registry.find('fusion-fake', 'two')?.contextWindow, 250000);
  const recorded = await collectUsage({ cwd: env.cwd, modelRegistry: env.registry,
    sessionManager: { getSessionId: () => base.root, getEntries: () => [] } } as unknown as ExtensionContext, env.dir);
  assert.equal(recorded.sessions, 2);
  assert.equal(recorded.report.models.find(row => row.model === 'fusion-fake/one')?.values.input, 3);
  assert.equal(recorded.report.models.find(row => row.model === 'fusion-fake/two')?.values.input, 6);
  assert.equal(recorded.report.total.values.cacheRead, 3);
  assert.ok(Math.abs(recorded.report.total.values.cost - 0.27) < 1e-10);
});

test('child refuses a substituted context window before inference, including resumed and evidence-only workers', async () => {
  const env = await fixture();
  env.registry.find('fusion-fake', 'one')!.contextWindow = 1050000;
  const base = { ...env, root: 'root-context', role: 'sidekick' as const, choice: 'fusion-fake/one#high@1000k', task: 'bounded job', briefing: 'canonical', modelRuntime: env.runtime };
  const first = await runChild(base);
  for (const extra of [{}, { resume: first.id }, { evidenceOnly: true }]) {
    const before = env.requests.length;
    await assert.rejects(runChild({ ...base, ...extra, onSessionReady: session => { session.agent.state.model = { ...session.model!, contextWindow: 250000 }; } }), /fusion-fake\/one#high@1M/);
    assert.equal(env.requests.length, before, 'no provider request after SDK cap substitution');
  }
});

test('root SDK provider observes chosen window on apply, input drift and disk resume without global settings writes', async () => {
  const env = await fixture();
  const settingsPath = join(env.agentDir, 'settings.json');
  const settingsText = JSON.stringify({ compaction: { enabled: false, reserveTokens: 16384 }, defaultProvider: 'fusion-fake', defaultModel: 'two', defaultThinkingLevel: 'low' });
  await writeFile(settingsPath, settingsText);
  const settings = SettingsManager.create(env.cwd, env.agentDir);
  const manager = SessionManager.create(env.cwd, join(env.agentDir, 'root-sessions'));
  const first = await rootSession(env, manager, settings);
  try {
    await first.prompt('/fusion-models fusion-fake/one#high@50k fusion-fake/two#medium@100k');
    await first.prompt('first root turn', { expandPromptTemplates: false });
    assert.equal(env.requests[0].contextWindow, 50000);
    await first.setModel(env.runtime.getModel('fusion-fake', 'one')!);
    first.setThinkingLevel('high');
    assert.equal(first.model?.contextWindow, 250000);
    await first.prompt('repair input drift', { expandPromptTemplates: false });
    assert.equal(env.requests[1].contextWindow, 50000);
    assert.equal(first.thinkingLevel, 'high');
  } finally { first.dispose(); }
  const reopened = SessionManager.open(manager.getSessionFile()!, manager.getSessionDir(), env.cwd);
  const resumed = await rootSession(env, reopened, settings, true);
  try {
    assert.equal(resumed.model?.contextWindow, 250000, 'SDK transcript stores provider/id, not the Fusion clone');
    await resumed.bindExtensions({});
    assert.equal(resumed.model?.contextWindow, 50000, 'session_start restores the persisted role budget');
    await resumed.prompt('resumed root turn', { expandPromptTemplates: false, source: 'rpc' });
    assert.equal(env.requests.at(-1)?.contextWindow, 50000);
    assert.equal(env.requests.at(-1)?.reasoning, 'high');
    assert.equal(env.requests.at(-1)?.maxTokens, 1000);
    assert.ok(JSON.stringify(env.requests.at(-1)?.context.messages).includes('first root turn'));
    assert.equal(settings.getCompactionSettings(resumed.model).enabled, false);
    assert.equal(settings.getCompactionSettings(resumed.model).reserveTokens, 16384);
    await settings.flush();
    assert.equal(await readFile(settingsPath, 'utf8'), settingsText);
    assert.equal(env.runtime.getModel('fusion-fake', 'one')?.contextWindow, 250000);
  } finally { resumed.dispose(); }
});

test('real SDK pre-agent-start repairs same-model cap drift introduced after input without provider substitution', async () => {
  const env = await fixture();
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on('before_agent_start', async () => {
        await pi.setModel(env.runtime.getModel('fusion-fake', 'one')!);
        pi.setThinkingLevel('high');
      });
      createFusion(pi, undefined, env.agentDir);
    }] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: env.runtime, settingsManager, resourceLoader,
    model: env.runtime.getModel('fusion-fake', 'one'), thinkingLevel: 'high', tools: [], sessionManager: SessionManager.inMemory(env.cwd) });
  try {
    await session.prompt('/fusion-models fusion-fake/one#high@100k fusion-fake/two#medium@50k');
    await session.prompt('noninteractive start', { source: 'rpc', expandPromptTemplates: false });
    assert.equal(env.requests[0].contextWindow, 100000);
    assert.equal(env.requests[0].model, 'one');
    assert.equal(env.requests[0].reasoning, 'high');
    assert.equal(env.runtime.getModel('fusion-fake', 'one')?.contextWindow, 250000);
  } finally { session.dispose(); }
});

for (const mode of ['success', 'failure', 'disabled'] as const) test(`reduced root window uses native compaction (${mode}), without changing settings or trimming history`, async () => {
  let rootID = '';
  const env = await fixture((model, _index, _context, _cwd, options) => options?.sessionId !== rootID && mode === 'failure'
    ? { ...reply(model, ''), stopReason: 'error', errorMessage: 'summary unavailable' }
    : reply(model, options?.sessionId === rootID ? 'root continued' : 'earlier conversation checkpoint'));
  const manager = SessionManager.inMemory(env.cwd);
  rootID = manager.getSessionId();
  const oldText = 'earlier evidence '.repeat(10000);
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: oldText }], timestamp: Date.now() - 10000 });
  manager.appendMessage({ ...reply(env.runtime.getModel('fusion-fake', 'one')!, 'earlier response'), timestamp: Date.now() - 9000,
    usage: { ...usage, input: 39995, totalTokens: 40000 } });
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'recent evidence '.repeat(6000) }], timestamp: Date.now() - 8000 });
  manager.appendMessage({ ...reply(env.runtime.getModel('fusion-fake', 'one')!, 'recent response'), timestamp: Date.now() - 7000,
    usage: { ...usage, input: 39995, totalTokens: 40000 } });
  const settings = SettingsManager.inMemory({ compaction: { enabled: mode !== 'disabled', reserveTokens: 16384, keepRecentTokens: 20000 }, retry: { enabled: false } });
  const session = await rootSession(env, manager, settings);
  const compactions: Array<{ reason: string; result?: unknown; errorMessage?: string }> = [];
  session.subscribe(event => { if (event.type === 'compaction_end') compactions.push(event); });
  try {
    await session.prompt('/fusion-models fusion-fake/one#high@50k fusion-fake/two#medium@100k');
    const settingsBefore = settings.getCompactionSettings(session.model);
    await session.prompt('next input '.repeat(8000), { expandPromptTemplates: false });
    const rootRequest = env.requests.find(request => request.sessionId === rootID);
    assert.ok(rootRequest, 'native inference continues after preflight');
    assert.equal(rootRequest.contextWindow, 50000);
    assert.deepEqual(settings.getCompactionSettings(session.model), settingsBefore);
    const compacted = manager.getBranch().filter(entry => entry.type === 'compaction');
    if (mode === 'success') {
      assert.ok(compactions.some(event => event.reason === 'threshold' && event.result), JSON.stringify({ compactions, requests: env.requests.map(request => ({ id: request.sessionId, window: request.contextWindow })), settings: settingsBefore }));
      assert.ok(compacted.length > 0);
      assert.equal(rootRequest.context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(oldText)), false);
    } else {
      assert.equal(compacted.length, 0);
      assert.ok(JSON.stringify(rootRequest.context.messages).includes(oldText), 'failed/disabled compaction does not cause Fusion to arbitrarily trim history');
      if (mode === 'failure') {
        assert.ok(compactions.some(event => event.reason === 'threshold' && /summary unavailable/.test(event.errorMessage ?? '')), JSON.stringify({ compactions, requests: env.requests.map(request => ({ id: request.sessionId, window: request.contextWindow })), settings: settingsBefore }));
        assert.ok(oldText.length + 8000 * 'next input '.length > rootRequest.contextWindow * 4,
          'native threshold failure may still send a transcript larger than the budget; this is not a strict cap');
      } else assert.equal(compactions.length, 0, 'respect native auto-compaction off');
    }
    assert.ok(manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes(oldText)), 'native compaction retains durable history');
  } finally { session.dispose(); }
});

function sandboxTools(cwd: string, options: { readOnly: boolean; textOnly?: boolean }) {
  const read = createReadToolDefinition(cwd, options.textOnly ? { operations: {
    access,
    async readFile(path) {
      const content = await readFile(path);
      if (content.includes(0)) throw new Error('Text files only');
      return content;
    },
  } } : undefined);
  const mutations = [defineTool(createWriteToolDefinition(cwd)), defineTool(createEditToolDefinition(cwd))];
  if (options.readOnly) for (const tool of mutations) tool.execute = async () => { throw new Error('Read-only sandbox'); };
  return [defineTool(read), defineTool(createLsToolDefinition(cwd)), defineTool(createGrepToolDefinition(cwd)), defineTool(createFindToolDefinition(cwd)), ...mutations,
    defineTool({ name: 'bash', label: 'Sandbox Bash', description: 'Deny shell execution in this regression fixture.',
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
      async execute() { throw new Error('Sandbox command denied'); },
    }),
  ];
}

test('sandbox sidekick restrictions survive owned continuation and missing-factory resume fails before inference', async () => {
  const env = await fixture((model, index) => index % 3 === 1
    ? { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: `shell-${index}`, name: 'bash', arguments: { command: 'touch sandbox-marker' } },
      { type: 'toolCall', id: `edit-${index}`, name: 'edit', arguments: { path: 'source.txt', edits: [{ oldText: index === 1 ? 'original' : 'changed', newText: index === 1 ? 'changed' : 'continued' }] } },
    ] } as AssistantMessage : index % 3 === 2 ? { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: `read-${index}`, name: 'read', arguments: { path: 'source.txt' } },
    ] } : reply(model, 'completed'));
  await writeFile(join(env.cwd, 'source.txt'), 'original');
  const base = { ...env, root: 'sandbox-root', role: 'sidekick' as const, choice: 'fusion-fake/one#low', task: 'check sandbox', briefing: 'contract', modelRuntime: env.runtime };
  const first = await runChild({ ...base, sandboxTools });
  const second = await runChild({ ...base, sandboxTools, resume: first.id });
  assert.equal(second.id, first.id);
  await assert.rejects(access(join(env.cwd, 'sandbox-marker')), { code: 'ENOENT' });
  assert.equal(await readFile(join(env.cwd, 'source.txt'), 'utf8'), 'continued');
  const messages = openOwned(env.cwd, env.dir, first.id, base.root, 'sidekick').buildSessionContext().messages;
  for (const index of [1, 4]) {
    const shell = messages.find(message => message.role === 'toolResult' && message.toolCallId === `shell-${index}`);
    assert.ok(shell && shell.role === 'toolResult' && shell.isError);
    const read = messages.find(message => message.role === 'toolResult' && message.toolCallId === `read-${index + 1}`);
    assert.ok(read && read.role === 'toolResult' && !read.isError);
    assert.ok(JSON.stringify(read.content).includes(index === 1 ? 'changed' : 'continued'));
  }
  const before = env.requests.length;
  await assert.rejects(runChild({ ...base, resume: first.id }));
  assert.equal(env.requests.length, before);
});

test('sandbox incomplete and throwing factories fail closed before any model turn or workload', async () => {
  const env = await fixture((model, index) => index === 1 ? ({ ...reply(model, ''), stopReason: 'toolUse', content: [
    { type: 'toolCall', id: 'marker', name: 'bash', arguments: { command: 'touch sandbox-marker' } },
  ] }) : reply(model, 'completed'));
  const base = { ...env, root: 'sandbox-root', role: 'sidekick' as const, choice: 'fusion-fake/one#low', task: 'check sandbox', briefing: 'contract', modelRuntime: env.runtime };
  for (const factory of [
    (cwd: string, options: { readOnly: boolean }) => sandboxTools(cwd, options).filter(tool => tool.name !== 'bash'),
    () => { throw new Error('Sandbox factory unavailable'); },
  ]) {
    const before = env.requests.length;
    await assert.rejects(runChild({ ...base, sandboxTools: factory }));
    assert.equal(env.requests.length, before);
    await assert.rejects(access(join(env.cwd, 'sandbox-marker')), { code: 'ENOENT' });
  }
});

test('sandbox advisor propagates the factory to read-only evidence and retains bounded text-only owner reads', async () => {
  let ownerCalls = 0, evidenceCalls = 0;
  const env = await fixture((model, _index, context) => {
    if (model.id === 'one' && ++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'bounded', name: 'read', arguments: { path: 'source.txt', offset: 1, limit: 350 } },
      { type: 'toolCall', id: 'unbounded', name: 'read', arguments: { path: 'source.txt' } },
      { type: 'toolCall', id: 'oversized', name: 'read', arguments: { path: 'source.txt', offset: 1, limit: 351 } },
      { type: 'toolCall', id: 'binary', name: 'read', arguments: { path: 'binary.txt', offset: 1, limit: 1 } },
      { type: 'toolCall', id: 'owner-write', name: 'write', arguments: { path: 'source.txt', content: 'tampered' } },
      { type: 'toolCall', id: 'delegate', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'inspect source', background: true } },
    ] } as AssistantMessage;
    if (model.id === 'two' && ++evidenceCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'evidence-shell', name: 'bash', arguments: { command: 'touch sandbox-marker' } },
      { type: 'toolCall', id: 'evidence-read', name: 'read', arguments: { path: 'source.txt' } },
      { type: 'toolCall', id: 'evidence-edit', name: 'edit', arguments: { path: 'source.txt', edits: [{ oldText: 'frozen', newText: 'tampered' }] } },
      { type: 'toolCall', id: 'evidence-write', name: 'write', arguments: { path: 'source.txt', content: 'tampered' } },
    ] } as AssistantMessage;
    return reply(model, context.messages.filter(message => message.role === 'toolResult').map(message => JSON.stringify(message.content)).join('\n'));
  });
  await writeFile(join(env.cwd, 'source.txt'), 'frozen evidence');
  await writeFile(join(env.cwd, 'binary.txt'), Buffer.from([65, 0, 66]));
  const base = { ...env, root: 'sandbox-root', role: 'advisor' as const, choice: 'fusion-fake/one#low', sidekickChoice: 'fusion-fake/two#low', task: 'assess source', briefing: 'contract', modelRuntime: env.runtime, sandboxTools };
  const result = await runChild(base);
  await assert.rejects(access(join(env.cwd, 'sandbox-marker')), { code: 'ENOENT' });
  assert.equal(await readFile(join(env.cwd, 'source.txt'), 'utf8'), 'frozen evidence');
  const owner = openOwned(env.cwd, env.dir, result.id, base.root, 'advisor');
  const messages = owner.buildSessionContext().messages;
  for (const [id, failed] of [['bounded', false], ['unbounded', true], ['oversized', true], ['binary', true], ['owner-write', true]] as const) {
    const message = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(message && message.role === 'toolResult');
    assert.equal(message.isError, failed, id);
    if (!failed) assert.ok(JSON.stringify(message.content).includes('frozen evidence'));
  }
  const marker = owner.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.evidence-sidekick');
  assert.ok(marker && marker.type === 'custom');
  const child = openOwned(env.cwd, env.dir, (marker.data as { id: string }).id, result.id, 'sidekick').buildSessionContext().messages;
  for (const [id, failed] of [['evidence-shell', true], ['evidence-read', false], ['evidence-edit', true], ['evidence-write', true]] as const) {
    const message = child.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(message && message.role === 'toolResult');
    assert.equal(message.isError, failed, id);
    if (!failed) assert.ok(JSON.stringify(message.content).includes('frozen evidence'));
  }
});

test('sidekick runs ordinary Git directly through its SDK bash tool', async () => {
  const env = await fixture((model, index) => index === 1
    ? { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'git-version', name: 'bash', arguments: { command: 'git --version' } }] }
    : reply(model, 'Git inspected'));
  const result = await runChild({ ...env, root: 'root-1234', role: 'sidekick', choice: 'fusion-fake/one#high', task: 'inspect Git', briefing: 'canonical', modelRuntime: env.runtime });
  const history = openOwned(env.cwd, env.dir, result.id, 'root-1234', 'sidekick').getBranch();
  const git = history.find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'git-version');
  assert.ok(git && git.type === 'message' && git.message.role === 'toolResult');
  assert.equal(git.message.isError, false);
  assert.match(JSON.stringify(git.message.content), /git version/);
});

test('sidekick discovers, reads and edits files directly in one owned SDK conversation', async () => {
  const env = await fixture((model, index) => {
    const calls = [
      [{ type: 'toolCall', id: 'write-file', name: 'write', arguments: { path: 'task.txt', content: 'original evidence\n' } }],
      [
        { type: 'toolCall', id: 'list-file', name: 'ls', arguments: { path: '.' } },
        { type: 'toolCall', id: 'find-file', name: 'find', arguments: { pattern: 'task*.txt', path: '.' } },
        { type: 'toolCall', id: 'grep-file', name: 'grep', arguments: { pattern: 'original', path: 'task.txt' } },
        { type: 'toolCall', id: 'read-before', name: 'read', arguments: { path: 'task.txt' } },
      ],
      [{ type: 'toolCall', id: 'edit-file', name: 'edit', arguments: { path: 'task.txt', edits: [{ oldText: 'original', newText: 'checked' }] } }],
      [{ type: 'toolCall', id: 'read-after', name: 'read', arguments: { path: 'task.txt' } }],
    ][index - 1];
    return calls ? { ...reply(model, ''), stopReason: 'toolUse', content: calls } as AssistantMessage : reply(model, 'checks complete');
  });
  const result = await runChild({ ...env, root: 'root-1234', role: 'sidekick', choice: 'fusion-fake/one#high', task: 'execute approved file change', briefing: 'canonical', modelRuntime: env.runtime });
  assert.equal(await readFile(join(env.cwd, 'task.txt'), 'utf8'), 'checked evidence\n');
  const messages = openOwned(env.cwd, env.dir, result.id, 'root-1234', 'sidekick').buildSessionContext().messages;
  for (const [id, evidence] of [['list-file', 'task.txt'], ['find-file', 'task.txt'], ['grep-file', 'original evidence'], ['read-before', 'original evidence'], ['read-after', 'checked evidence']]) {
    const tool = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(tool && tool.role === 'toolResult');
    assert.equal(tool.isError, false, JSON.stringify(tool.content));
    assert.ok(JSON.stringify(tool.content).includes(evidence));
  }
  const tools = env.requests[0].context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded?.map(tool => tool.name) ?? [] : []);
  assert.equal(tools.includes('fusion_delegate'), false);
  assert.equal(tools.includes('fusion_utility'), false);
});

for (const role of ['reviewer', 'advisor'] as const) test(`${role} directly reuses a user-selected evidence sidekick while both remain unable to edit source`, async () => {
  let reviewerCalls = -1, evidenceCalls = 0;
  let delegated = false;
  let evidenceID: string | undefined;
  const env = await fixture((model, _index, context) => {
    if (model.id === 'one') {
      if (!delegated) {
        delegated = true;
        reviewerCalls += 2;
        return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: `bounded-${reviewerCalls}`, name: 'read', arguments: { path: 'snapshot.txt', offset: 1, limit: 350 } },
        { type: 'toolCall', id: `oversized-${reviewerCalls}`, name: 'read', arguments: { path: 'snapshot.txt', offset: 1, limit: 351 } },
        { type: 'toolCall', id: `foreign-${reviewerCalls}`, name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'Run git --version', background: true, sessionID: 'foreign-child' } },
        { type: 'toolCall', id: `override-${reviewerCalls}`, name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'Run git --version', background: true, model: 'fusion-fake/one' } },
        { type: 'toolCall', id: `delegate-${reviewerCalls}`, name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'Run git --version; return factual output only', background: true, ...(evidenceID ? { sessionID: evidenceID } : {}) } },
        ] };
      }
    } else {
      evidenceCalls++;
      if (evidenceCalls % 2 === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: `git-${evidenceCalls}`, name: 'bash', arguments: { command: 'git --version' } },
        { type: 'toolCall', id: `read-${evidenceCalls}`, name: 'read', arguments: { path: 'snapshot.txt' } },
        { type: 'toolCall', id: `write-${evidenceCalls}`, name: 'write', arguments: { path: 'snapshot.txt', content: 'tampered' } },
        { type: 'toolCall', id: `nested-${evidenceCalls}`, name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'Run git --version', background: true } },
      ] };
    }
    return reply(model, context.messages.filter(message => message.role === 'toolResult' || message.role === 'user').map(message => JSON.stringify(message.content)).join('\n'));
  });
  await writeFile(join(env.cwd, 'snapshot.txt'), 'frozen source');
  const base = { ...env, root: 'root-1234', role, choice: 'fusion-fake/one#low@50k', sidekickChoice: 'fusion-fake/two#medium@100k', task: 'Assess snapshot.txt and request exact check output', briefing: 'canonical evidence contract', modelRuntime: env.runtime };
  const first = await runChild(base);
  assert.match(first.text, /git version/);
  const manager = openOwned(env.cwd, env.dir, first.id, base.root, role);
  const messages = manager.buildSessionContext().messages;
  for (const [id, failed] of [['bounded-1', false], ['oversized-1', true], ['foreign-1', true], ['override-1', true]] as const) {
    const result = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(result && result.role === 'toolResult');
    assert.equal(result.isError, failed);
  }
  const owner = manager.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.evidence-sidekick');
  assert.ok(owner && owner.type === 'custom');
  const child = (owner.data as { id: string }).id;
  evidenceID = child;
  assert.equal(openOwned(env.cwd, env.dir, child, first.id, 'sidekick').getSessionId(), child);
  delegated = false;
  const second = await runChild({ ...base, resume: first.id });
  assert.equal(second.id, first.id);
  assert.equal(openOwned(env.cwd, env.dir, first.id, base.root, role).getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.evidence-sidekick').length, 1);
  assert.equal(await readFile(join(env.cwd, 'snapshot.txt'), 'utf8'), 'frozen source');
  const evidence = openOwned(env.cwd, env.dir, child, first.id, 'sidekick').buildSessionContext().messages;
  for (const id of ['write-1', 'write-3', 'nested-1', 'nested-3']) {
    const result = evidence.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(result && result.role === 'toolResult');
    assert.equal(result.isError, true);
  }
  assert.equal(env.requests.filter(request => request.model === 'two').every(request => request.reasoning === 'medium'), true);
  assert.equal(env.requests.filter(request => request.model === 'one').every(request => request.contextWindow === 50000), true);
  assert.equal(env.requests.filter(request => request.model === 'two').every(request => request.contextWindow === 100000 && request.maxTokens === 1000), true);
  if (role === 'reviewer') {
    evidenceID = undefined;
    delegated = false;
    await runChild({ ...base, resume: first.id });
    const saved = openOwned(env.cwd, env.dir, first.id, base.root, role).getBranch();
    assert.deepEqual(saved.filter(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.evidence-sidekick')
      .map(entry => entry.type === 'custom' ? (entry.data as { id: string }).id : ''), [child]);
  }
});

for (const role of ['advisor', 'reviewer'] as const) test(`${role} serializes busy evidence continuations in the same persistent child`, { timeout: 10000 }, async t => {
  let ownerCalls = 0, evidenceCalls = 0, evidenceID = '', queued = false;
  const env = await fixture((model, _index, context, _cwd, options) => {
    if (model.id === 'two') {
      evidenceID = options!.sessionId!;
      if (++evidenceCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'initial-read', name: 'read', arguments: { path: 'AGENTS.md' } },
      ] };
      return evidenceCalls === 2 ? { ...reply(model, 'first job waiting'), stopReason: 'pending' } : reply(model, JSON.stringify(context.messages));
    }
    if (++ownerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'initial', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'read initial evidence', background: true } },
    ] };
    if (ownerCalls >= 3 && !queued && evidenceCalls >= 2) {
      queued = true;
      return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'continuation', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'related follow-up evidence', background: true,
          ...(role === 'advisor' ? { sessionID: evidenceID } : {}) } },
      ] };
    }
    return reply(model, 'owner waiting');
  });
  let owner!: AgentSession;
  const controller = new AbortController();
  const base = { ...env, root: 'root-evidence-queue', role, choice: 'fusion-fake/one#low', sidekickChoice: 'fusion-fake/two#medium',
    task: 'collect', briefing: 'contract', modelRuntime: env.runtime, signal: controller.signal, onSessionReady: (session: AgentSession) => { owner = session; } };
  const operation = runChild(base);
  t.after(async () => { controller.abort(); await operation.catch(() => {}); });
  while (evidenceCalls < 2) await new Promise(resolve => setImmediate(resolve));
  await owner.waitForIdle();
  const ask = owner.sendCustomMessage({ customType: 'test.queue', content: 'continue evidence now', display: true }, { triggerTurn: true });
  while (!queued) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(evidenceCalls, 2, 'queued task cannot overlap the blocked evidence model turn');
  const originalID = evidenceID;
  env.release.get(evidenceID)!('initial evidence complete');
  await ask;
  const result = await operation;
  assert.equal(evidenceID, originalID);
  const messages = openOwned(env.cwd, env.dir, evidenceID, result.id, 'sidekick').buildSessionContext().messages;
  assert.equal(messages.filter(message => message.role === 'user').length, 2);
  const continuation = openOwned(env.cwd, env.dir, result.id, base.root, role).buildSessionContext().messages
    .find(message => message.role === 'toolResult' && message.toolCallId === 'continuation');
  assert.ok(continuation?.role === 'toolResult' && !continuation.isError);
});

test('advisor SDK runs independent owned evidence histories concurrently and cancels nested resumes', { timeout: 10000 }, async t => {
  let phase: 'new' | 'resume' | 'pending' = 'new';
  let delegated = false;
  const ids: string[] = [];
  const evidenceCalls = new Map<string, number>();
  const pendingIDs = new Set<string>(), cancelledIDs = new Set<string>();
  let bothStarted: () => void = () => {};
  const ready = new Promise<void>(resolve => { bothStarted = resolve; });
  const env = await fixture((model, _index, context, _cwd, options) => {
    if (model.id === 'one') {
      if (!delegated) {
        delegated = true;
        const calls = ['alpha', 'beta'].map((job, index) => ({ type: 'toolCall' as const, id: `${phase}-${job}`, name: 'fusion_delegate',
          arguments: { role: 'sidekick', task: `${phase}-${job}`, background: true, ...(phase === 'new' ? {} : { sessionID: ids[index] }) } }));
        if (phase === 'pending') calls.push({ type: 'toolCall', id: 'duplicate', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'duplicate', background: true, sessionID: ids[0] } });
        return { ...reply(model, ''), stopReason: 'toolUse', content: calls };
      }
      return reply(model, context.messages.filter(message => message.role === 'toolResult' || message.role === 'user').map(message => JSON.stringify(message.content)).join('\n'));
    }
    const id = options?.sessionId;
    assert.ok(id);
    if (phase === 'pending') {
      pendingIDs.add(id);
      options?.signal?.addEventListener('abort', () => cancelledIDs.add(id), { once: true });
      if (pendingIDs.size === 2) bothStarted();
      return { ...reply(model, ''), stopReason: 'pending' };
    }
    const count = (evidenceCalls.get(id) ?? 0) + 1;
    evidenceCalls.set(id, count);
    if (count === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'snapshot.txt' } },
      { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'snapshot.txt', content: 'tampered' } },
      { type: 'toolCall', id: 'nested', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'nested job', background: true } },
    ] };
    return reply(model, `evidence from ${id}`);
  });
  await writeFile(join(env.cwd, 'snapshot.txt'), 'frozen source');
  const base = { ...env, root: 'root-parallel', role: 'advisor' as const, choice: 'fusion-fake/one#low@50k',
    sidekickChoice: 'fusion-fake/two#medium@100k', task: 'collect independent evidence', briefing: 'canonical', modelRuntime: env.runtime, signal: t.signal };
  const first = await runChild(base);
  const advisor = openOwned(env.cwd, env.dir, first.id, base.root, 'advisor');
  for (const entry of advisor.getBranch()) {
    if (entry.type === 'custom' && entry.customType === 'fusion.pi.evidence-sidekick') ids.push((entry.data as { id: string }).id);
  }
  assert.equal(new Set(ids).size, 2);
  const ownedIDs = new Set(ids);
  ids.length = 0;
  for (const job of ['alpha', 'beta']) {
    const result = advisor.buildSessionContext().messages.find(message => message.role === 'toolResult' && message.toolCallId === `new-${job}`);
    assert.ok(result && result.role === 'toolResult');
    assert.equal(result.isError, false);
    const id = /sidekick sessionID: ([\w-]+)/.exec(JSON.stringify(result.content))?.[1];
    assert.ok(id && ownedIDs.has(id));
    ids.push(id);
    const history = openOwned(env.cwd, env.dir, id, first.id, 'sidekick').buildSessionContext().messages;
    for (const [callID, failed] of [['read', false], ['write', true], ['nested', true]] as const) {
      const tool = history.find(message => message.role === 'toolResult' && message.toolCallId === callID);
      assert.ok(tool && tool.role === 'toolResult');
      assert.equal(tool.isError, failed);
    }
  }
  phase = 'resume';
  delegated = false;
  const second = await runChild({ ...base, resume: first.id });
  assert.equal(second.id, first.id);
  for (const [index, job] of ['alpha', 'beta'].entries()) {
    const history = openOwned(env.cwd, env.dir, ids[index], first.id, 'sidekick').buildSessionContext().messages;
    const tasks = history.filter(message => message.role === 'user');
    assert.equal(tasks.length, 2);
    assert.ok(JSON.stringify(tasks[0]).includes(`new-${job}`));
    assert.ok(JSON.stringify(tasks[1]).includes(`resume-${job}`));
    assert.ok(second.text.includes(ids[index]));
  }
  const controller = new AbortController();
  phase = 'pending';
  delegated = false;
  const operation = runChild({ ...base, resume: first.id, signal: AbortSignal.any([controller.signal, t.signal]) });
  const rejected = assert.rejects(operation, /cancelled|aborted/i);
  await ready;
  controller.abort();
  await rejected;
  assert.deepEqual([...pendingIDs].sort(), [...ids].sort());
  assert.deepEqual([...cancelledIDs].sort(), [...ids].sort());
  const cancelled = openOwned(env.cwd, env.dir, first.id, base.root, 'advisor');
  const duplicate = cancelled.buildSessionContext().messages.find(message => message.role === 'toolResult' && message.toolCallId === 'duplicate');
  assert.ok(duplicate && duplicate.role === 'toolResult');
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate.content), /cancel/i);
  assert.deepEqual(cancelled.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.evidence-sidekick')
    .map(entry => entry.type === 'custom' ? (entry.data as { id: string }).id : '').sort(), [...ids].sort());
  assert.equal(await readFile(join(env.cwd, 'snapshot.txt'), 'utf8'), 'frozen source');
  const evidenceRequests = env.requests.filter(request => request.model === 'two');
  assert.ok(evidenceRequests.length > 0);
  assert.equal(evidenceRequests.every(request => request.reasoning === 'medium' && request.contextWindow === 100000), true);
});

test('sidekick SDK preserves failed shell check diagnostics as a failed tool result', async () => {
  const env = await fixture((model, index) => index === 1
    ? { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'failed-check', name: 'bash', arguments: { command: 'cat missing-check-input.txt' } }] }
    : reply(model, 'check failed; escalate to lead'));
  const result = await runChild({ ...env, root: 'root-1234', role: 'sidekick', choice: 'fusion-fake/one#high', task: 'run check', briefing: 'canonical', modelRuntime: env.runtime });
  const messages = openOwned(env.cwd, env.dir, result.id, 'root-1234', 'sidekick').buildSessionContext().messages;
  const failed = messages.find(message => message.role === 'toolResult' && message.toolCallId === 'failed-check');
  assert.ok(failed && failed.role === 'toolResult');
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /missing-check-input.txt/);
});

test('advisor resumes its durable consultation only for the exact owning root', async () => {
  const env = await fixture();
  const base = { ...env, root: 'root-1234', role: 'advisor' as const,
    choice: 'fusion-fake/one#low', task: 'first consultation', briefing: 'canonical', modelRuntime: env.runtime };
  const first = await runChild(base);
  assert.equal(openOwned(env.cwd, env.dir, first.id, base.root, 'advisor').getSessionId(), first.id);
  const second = await runChild({ ...base, task: 'related consultation', resume: first.id });
  assert.equal(second.id, first.id);
  assert.match(JSON.stringify(env.requests[1].context.messages), /first consultation/);
  assert.throws(() => openOwned(env.cwd, env.dir, first.id, 'foreign-root', 'advisor'), /ownership/);
  await assert.rejects(runChild({ ...base, root: 'foreign-root', resume: first.id }), /ownership/);
});

test('cancel after a durable edit preserves the same child for a later run', async () => {
  const env = await fixture((model, index, _context, cwd) => {
    if (index === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: join(cwd, 'cancelled.txt'), content: 'already edited' } }] };
    return index === 2 ? { ...reply(model, ''), stopReason: 'pending' } : reply(model, 'continued');
  });
  const base = { ...env, root: 'root-1234', role: 'sidekick' as const, choice: 'fusion-fake/one#high', task: 'edit then wait', briefing: 'canonical', modelRuntime: env.runtime };
  const controller = new AbortController();
  let confirmed: string | undefined;
  const operation = runChild({ ...base, signal: controller.signal, onConfirmed: id => { confirmed = id; } });
  while (env.requests.length < 2) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(operation, /cancelled|aborted/i);
  assert.equal(await readFile(join(env.cwd, 'cancelled.txt'), 'utf8'), 'already edited');
  assert.ok(confirmed);
  const next = await runChild({ ...base, task: 'continue', resume: confirmed });
  assert.equal(next.id, confirmed);
});

test('first-run worker ownership survives real SDK tree navigation after a persisted edit', { timeout: 10000 }, async t => {
  let job: 'start' | 'resume' | undefined = 'start', workerID = '', workerCalls = 0;
  const env = await fixture((model, _index, _context, _cwd, options) => {
    if (model.id === 'one') {
      if (!job) return reply(model, 'lead waiting');
      const next = job; job = undefined;
      return { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: next, name: 'fusion_delegate', arguments: {
        role: 'sidekick', task: next === 'start' ? 'write retained.txt then wait' : 'continue the existing edit', background: true,
        ...(next === 'resume' ? { sessionID: workerID } : {}),
      } }] };
    }
    workerID = options!.sessionId!;
    if (++workerCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'persist-edit', name: 'write', arguments: { path: 'retained.txt', content: 'durable first-run edit' } },
    ] };
    return workerCalls === 2 ? { ...reply(model, 'waiting after edit'), stopReason: 'pending' } : reply(model, 'continued original worker');
  });
  const manager = SessionManager.create(env.cwd, join(env.agentDir, 'roots'));
  const session = await rootSession(env, manager);
  await session.prompt('/fusion-models fusion-fake/one#high fusion-fake/two#medium');
  const setup = manager.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.setup')!;
  t.after(async () => { await session.navigateTree(setup.id); session.dispose(); });
  await session.prompt('start the approved edit');
  while (workerCalls < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(join(env.cwd, 'retained.txt'), 'utf8'), 'durable first-run edit');
  const originalLeaf = manager.getLeafId()!;
  await session.navigateTree(setup.id);
  assert.equal(manager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.child'), false);
  await session.navigateTree(originalLeaf);
  const owned = manager.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.child');
  assert.ok(owned?.type === 'custom' && (owned.data as { id: string }).id === workerID, 'returning to the original branch retains the first worker');
  const originalID = workerID;
  job = 'resume';
  await session.prompt('resume related work');
  while (workerCalls < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(workerID, originalID);
  const request = env.requests.filter(request => request.model === 'two').at(-1)!;
  assert.ok(JSON.stringify(request.context.messages).includes('durable first-run edit'));
});

test('navigation retains a first worker whose partial response becomes durable during abort', { timeout: 10000 }, async () => {
  let workerID = '', calls = 0;
  const env = await fixture((model, _index, context, _cwd, options) => {
    workerID = options!.sessionId!;
    return ++calls === 1 ? { ...reply(model, 'partial first response'), stopReason: 'pending' } : reply(model, JSON.stringify(context.messages));
  });
  const tools = new Map<string, any>(), handlers = new Map<string, Function>(), delivered: string[] = [];
  const entries: any[] = [{ type: 'custom', customType: 'fusion.pi.setup', id: 'setup', data: {
    lead: 'fusion-fake/one#high', sidekick: 'fusion-fake/two#medium',
  } }];
  const pi = { registerCommand: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: Function) => handlers.set(name, handler), getThinkingLevel: () => 'high',
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length) }),
    sendMessage: (message: { content: string }) => delivered.push(message.content) } as unknown as ExtensionAPI;
  const ctx = { cwd: env.cwd, hasUI: false, isIdle: () => true, model: env.runtime.getModel('fusion-fake', 'one'), modelRegistry: env.registry,
    sessionManager: { getSessionId: () => 'original-root', getBranch: () => entries }, ui: { notify: () => {} } } as unknown as ExtensionContext;
  createFusion(pi, options => runChild({ ...options, modelRuntime: env.runtime }), env.agentDir);
  const delegate = (sessionID?: string) => tools.get('fusion_delegate').execute('job', { role: 'sidekick', task: 'continue the specified work', background: true,
    ...(sessionID ? { sessionID } : {}) }, undefined, undefined, ctx);
  try {
    await delegate();
    while (!env.release.has(workerID)) await new Promise(resolve => setImmediate(resolve));
    await handlers.get('session_before_switch')?.();
    assert.equal(delivered.length, 0, 'navigation must suppress stale result delivery');
    assert.ok(entries.some(entry => entry.customType === 'fusion.pi.child' && entry.data.id === workerID),
      'draining cancellation must retain durable ownership in the original branch');
    const original = workerID;
    await delegate(original);
    while (!delivered.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(workerID, original);
    assert.ok(JSON.stringify(env.requests.at(-1)!.context.messages).includes('partial first response'));
  } finally { await handlers.get('session_before_switch')?.(); }
});

for (const ending of ['failure', 'cancel', 'navigation', 'lead drift', 'setup drift', 'branch drift', 'unavailable'] as const) {
  test(`SDK queued review after ${ending} never overlaps its predecessor; an independent review progresses`, { timeout: 10000 }, async t => {
    let firstID = '', rootID = 'root-queued-review', model: Model<any> | undefined;
    const calls = new Map<string, number>();
    const env = await fixture((model, _index, context, _cwd, options) => {
      const id = options!.sessionId!;
      const count = (calls.get(id) ?? 0) + 1; calls.set(id, count);
      if (!firstID) firstID = id;
      if (id !== firstID) return reply(model, 'independent review finished');
      if (count === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'freeze-evidence', name: 'read', arguments: { path: 'AGENTS.md', offset: 1, limit: 20 } },
      ] };
      if (count === 2) return { ...reply(model, 'retained review before wait'), stopReason: 'pending' };
      return reply(model, JSON.stringify(context.messages));
    });
    model = env.runtime.getModel('fusion-fake', 'one');
    const tools = new Map<string, any>(), handlers = new Map<string, Function>(), delivered: string[] = [];
    const setup = { type: 'custom', customType: 'fusion.pi.setup', id: 'queue-setup', data: {
      lead: 'fusion-fake/one#high', sidekick: 'fusion-fake/two#medium', reviewer: 'fusion-fake/two#low',
    } };
    let entries: any[] = [setup];
    const pi = { registerCommand: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (name: string, handler: Function) => handlers.set(name, handler), getThinkingLevel: () => 'high',
      appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data, id: String(entries.length) }),
      sendMessage: (message: { content: string }) => delivered.push(message.content) } as unknown as ExtensionAPI;
    const ctx = { cwd: env.cwd, hasUI: false, isIdle: () => true, get model() { return model; }, modelRegistry: env.registry,
      sessionManager: { getSessionId: () => rootID, getBranch: () => entries }, ui: { notify: () => {} } } as unknown as ExtensionContext;
    createFusion(pi, options => runChild({ ...options, modelRuntime: env.runtime }), env.agentDir);
    t.after(async () => { await handlers.get('session_before_tree')?.(); });
    const delegate = (task: string, sessionID?: string) => tools.get('fusion_delegate').execute('review', { role: 'reviewer', task, background: true,
      ...(sessionID ? { sessionID } : {}) }, undefined, undefined, ctx);
    await delegate('first review');
    while ((calls.get(firstID) ?? 0) < 2) await new Promise(resolve => setImmediate(resolve));
    const queued = delegate('related missing-evidence follow-up', firstID);
    const outcome: Promise<unknown> = queued.then(() => undefined, (error: unknown) => error);
    const further: Promise<unknown> | undefined = ending === 'cancel'
      ? delegate('another queued follow-up', firstID).then(() => undefined, (error: unknown) => error) : undefined;
    await delegate('independent review');
    while (!delivered.some(text => text.includes('independent review finished'))) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.get(firstID), 2, 'queued continuation cannot enter the provider while its predecessor is blocked');
    if (ending === 'cancel') await tools.get('fusion_worker').execute('cancel', { action: 'cancel', sessionID: firstID }, undefined, undefined, ctx);
    else if (ending === 'navigation') await handlers.get('session_before_tree')?.();
    else {
      if (ending === 'lead drift') model = env.runtime.getModel('fusion-fake', 'two');
      if (ending === 'setup drift') entries.push({ ...setup, id: 'new-setup' });
      if (ending === 'branch drift') entries = [setup];
      if (ending === 'unavailable') env.registry.hasConfiguredAuth = () => false;
      const message = reply(env.runtime.getModel('fusion-fake', 'two')!, 'predecessor completed');
      env.release.get(firstID)!(ending === 'failure' ? { ...message, stopReason: 'error', errorMessage: 'review fixture failure' } : message);
    }
    const settled = await outcome;
    if (ending === 'failure') {
      assert.equal(settled, undefined);
      while ((calls.get(firstID) ?? 0) < 3) await new Promise(resolve => setImmediate(resolve));
      const request = env.requests.filter(request => request.sessionId === firstID).at(-1)!;
      assert.ok(JSON.stringify(request.context.messages).includes('PROJECT_INSTRUCTIONS_SENTINEL'));
      assert.ok(JSON.stringify(request.context.messages).includes('related missing-evidence follow-up'));
    } else {
      assert.match(String(settled), /cancel|changed|lead model|auth|confirmed/i);
      if (further) assert.match(String(await further), /cancel/i, 'cancellation propagates through the entire queue');
      assert.equal(calls.get(firstID), 2, 'cancelled or stale queued work cannot restart inference');
    }
  });
}

test('after real SDK file edit then provider failure, first child is confirmed and resumed exactly', async () => {
  const env = await fixture((model, index, _context, cwd) => {
    if (index === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: join(cwd, 'partial.txt'), content: 'partial work' } }] };
    if (index === 2) return { ...reply(model, ''), stopReason: 'error', errorMessage: 'fake outage' };
    return reply(model, 'resumed');
  });
  const base = { ...env, root: 'root-1234', role: 'sidekick' as const, choice: 'fusion-fake/one#high', task: 'write partial work', briefing: 'canonical', modelRuntime: env.runtime };
  let confirmed: string | undefined;
  await assert.rejects(runChild({ ...base, onConfirmed: id => { confirmed = id; } }), /fake outage/);
  assert.equal(await readFile(join(env.cwd, 'partial.txt'), 'utf8'), 'partial work');
  assert.ok(confirmed, 'durable partial work must confirm the same child despite failure');
  assert.equal(openOwned(env.cwd, env.dir, confirmed!, base.root, 'sidekick').getSessionId(), confirmed);
  const next = await runChild({ ...base, task: 'resume', resume: confirmed });
  assert.equal(next.id, confirmed);
  assert.match(JSON.stringify(env.requests.at(-1)?.context.messages), /partial work/);
});

test('real Pi runtime records a failed Fusion tool result when delegation is unavailable', async () => {
  const env = await fixture((model, index) => index === 1
    ? { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'delegate-1', name: 'fusion_delegate', arguments: { role: 'advisor', task: 'assess risk' } }] }
    : reply(model, 'reported failure'));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => createFusion(pi, runChild, env.agentDir)] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: env.runtime, settingsManager, resourceLoader,
    model: env.runtime.getModel('fusion-fake', 'one'), thinkingLevel: 'high', tools: ['fusion_delegate'], sessionManager: SessionManager.inMemory(env.cwd) });
  try {
    await session.prompt('/fusion-models fusion-fake/one#high fusion-fake/two#medium');
    await session.prompt('delegate unconfigured consultation', { expandPromptTemplates: false });
    const result = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'fusion_delegate');
    assert.ok(result && result.role === 'toolResult');
    assert.equal(result.isError, true);
  } finally { session.dispose(); }
});

test('advisor SDK retains project context with read-only evidence capabilities', async () => {
  const env = await fixture();
  const base = { ...env, root: 'root-1234', choice: 'fusion-fake/one#high', task: 'inspect', briefing: 'CANONICAL_BRIEFING_SENTINEL', modelRuntime: env.runtime };
  const available = (context: TranscriptContext) => context.messages.flatMap(msg => msg.role === 'system' ? msg.toolsAdded?.map(tool => tool.name) ?? [] : []);
  await runChild({ ...base, role: 'advisor' });
  const tools = available(env.requests.at(-1)!.context);
  for (const tool of ['bash', 'edit', 'write', 'grep', 'find', 'ls']) assert.equal(tools.includes(tool), false);
  assert.match(JSON.stringify(env.requests.at(-1)!.context.messages), /PROJECT_INSTRUCTIONS_SENTINEL/);
});

test('reviewer SDK retains project instructions and reads any installed skill with frozen evidence while mutation and execution are denied', async () => {
  let skillPath = '';
  const env = await fixture((model, index, context) => {
    const advertised = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    if (index === 1) {
      const location = /<name>code-review-and-quality<\/name>[\s\S]*?<location>([^<]+)<\/location>/.exec(advertised)?.[1];
      assert.equal(location, skillPath, 'native skill discovery must advertise the temporary installed skill');
      const other = /<name>unrelated-skill-sentinel<\/name>[\s\S]*?<location>([^<]+)<\/location>/.exec(advertised)?.[1];
      assert.ok(other, 'native discovery provides the additional installed skill location');
      return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'skill', name: 'read', arguments: { path: location, offset: 1, limit: 200 } },
        { type: 'toolCall', id: 'other-skill', name: 'read', arguments: { path: other, offset: 1, limit: 20 } },
      ] };
    }
    const calls = [
      [
        { type: 'toolCall', id: 'skill-tail', name: 'read', arguments: { path: skillPath, offset: 201, limit: 10 } },
        { type: 'toolCall', id: 'snapshot', name: 'read', arguments: { path: 'snapshot.txt', offset: 1, limit: 2 } },
        { type: 'toolCall', id: 'unbounded', name: 'read', arguments: { path: 'snapshot.txt' } },
        { type: 'toolCall', id: 'too-large', name: 'read', arguments: { path: 'snapshot.txt', offset: 1, limit: 351 } },
        { type: 'toolCall', id: 'zero-offset', name: 'read', arguments: { path: 'snapshot.txt', offset: 0, limit: 1 } },
        { type: 'toolCall', id: 'binary', name: 'read', arguments: { path: 'binary.txt', offset: 1, limit: 1 } },
      ],
      [
        { type: 'toolCall', id: 'write-denied', name: 'write', arguments: { path: 'snapshot.txt', content: 'tampered' } },
        { type: 'toolCall', id: 'bash-denied', name: 'bash', arguments: { command: 'echo tampered > snapshot.txt' } },
        { type: 'toolCall', id: 'edit-denied', name: 'edit', arguments: { path: 'snapshot.txt', edits: [{ oldText: 'frozen', newText: 'tampered' }] } },
        { type: 'toolCall', id: 'grep-denied', name: 'grep', arguments: { pattern: '.', path: '.' } },
        { type: 'toolCall', id: 'delegate-denied', name: 'fusion_delegate', arguments: { role: 'sidekick', task: 'run the skill script', background: true } },
      ],
    ][index - 2];
    if (calls) return { ...reply(model, ''), stopReason: 'toolUse', content: calls } as AssistantMessage;
    const results = context.messages.filter(message => message.role === 'toolResult');
    return reply(model, results.map(result => JSON.stringify(result.content)).join('\n'));
  });
  skillPath = join(env.agentDir, 'skills', 'code-review-and-quality', 'SKILL.md');
  await mkdir(join(env.agentDir, 'skills', 'code-review-and-quality'), { recursive: true });
  await mkdir(join(env.agentDir, 'skills', 'unrelated'), { recursive: true });
  await mkdir(join(env.agentDir, 'extensions'), { recursive: true });
  const skill = '---\nname: code-review-and-quality\ndescription: Inspect changes for introduced defects.\n---\nReview evidence sentinel. Never treat author claims as proof.\n'
    + 'Review guidance continues.\n'.repeat(198) + 'Bounded skill continuation sentinel.\n';
  await writeFile(skillPath, skill);
  await writeFile(join(env.agentDir, 'skills', 'unrelated', 'SKILL.md'), '---\nname: unrelated-skill-sentinel\ndescription: Unrelated work.\n---\nRun unrelated actions.\n');
  const effect = join(env.cwd, 'extension-effect');
  await writeFile(join(env.agentDir, 'extensions', 'effect.ts'), `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(effect)}, 'executed');`);
  const ambient = 'FOREIGN_APPEND_SYSTEM_SOURCE_SENTINEL';
  await writeFile(join(env.agentDir, 'APPEND_SYSTEM.md'), ambient);
  const snapshot = 'snapshot-001 frozen source\nreturn validated input;\n';
  await writeFile(join(env.cwd, 'snapshot.txt'), snapshot);
  await writeFile(join(env.cwd, 'moving-source.txt'), 'later unrelated workspace changes');
  await writeFile(join(env.cwd, 'binary.txt'), Buffer.from([0x89, 0x50, 0, 0xff]));
  const base = { ...env, root: 'root-1234', role: 'reviewer' as const, choice: 'fusion-fake/one#low',
    task: 'Review snapshot-001 using snapshot.txt, lines 1-2. Requirements: validate input. Moving source is excluded.', briefing: 'inline reviewer contract', modelRuntime: env.runtime };
  const result = await runChild(base);
  const reviewerContext = JSON.stringify(env.requests[0].context.messages);
  assert.equal(reviewerContext.includes(ambient), true, 'reviewer retains native appended instructions');
  assert.equal(reviewerContext.includes('PROJECT_INSTRUCTIONS_SENTINEL'), true, 'reviewer retains native AGENTS.md');
  assert.equal(await readFile(join(env.cwd, 'snapshot.txt'), 'utf8'), snapshot);
  assert.equal(await readFile(skillPath, 'utf8'), skill);
  await assert.rejects(access(effect), /ENOENT/);
  const messages = openOwned(env.cwd, env.dir, result.id, base.root, 'reviewer').buildSessionContext().messages;
  for (const id of ['skill', 'other-skill', 'skill-tail', 'snapshot']) {
    const message = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(message && message.role === 'toolResult');
    assert.equal(message.isError, false);
  }
  for (const id of ['unbounded', 'too-large', 'zero-offset', 'binary', 'write-denied', 'bash-denied', 'edit-denied', 'grep-denied', 'delegate-denied']) {
    const message = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(message && message.role === 'toolResult');
    assert.equal(message.isError, true, id);
  }
  assert.ok(result.text.includes('Review evidence sentinel'));
  assert.ok(result.text.includes('Bounded skill continuation sentinel'));
  assert.ok(result.text.includes('snapshot-001 frozen source'));
  assert.equal(result.text.includes('later unrelated workspace changes'), false);
  for (const role of ['sidekick', 'advisor'] as const) {
    await runChild({ ...base, role });
    const advertised = JSON.stringify(env.requests.at(-1)!.context.messages.filter(message => message.role === 'system'));
    assert.equal(advertised.includes(skillPath), true, `${role} can read installed skill guidance`);
    assert.equal(advertised.includes(ambient), true, `${role} retains its existing append-system behavior`);
  }
});

for (const role of ['sidekick', 'advisor', 'reviewer'] as const) test(`${role} skips missing packages without installation and reads enabled installed package skills with native filters`, async () => {
  let skillPath = '';
  const env = await fixture((model, index, context) => {
    if (index === 1) {
      const advertised = JSON.stringify(context.messages.filter(message => message.role === 'system'));
      const location = /<name>code-review-and-quality<\/name>[\s\S]*?<location>([^<]+)<\/location>/.exec(advertised)?.[1];
      assert.equal(location, skillPath, 'enabled package skill remains available after ambient duplicates are disabled');
      return { ...reply(model, ''), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'package-skill', name: 'read', arguments: { path: location, offset: 1, limit: 20 } },
        { type: 'toolCall', id: 'frozen-source', name: 'read', arguments: { path: 'snapshot.txt', offset: 1, limit: 2 } },
      ] };
    }
    return reply(model, context.messages.filter(message => message.role === 'toolResult').map(message => JSON.stringify(message.content)).join('\n'));
  });
  const packageDir = join(env.agentDir, 'installed-review-package');
  skillPath = join(packageDir, 'skills', 'code-review-and-quality', 'SKILL.md');
  const filtered = join(packageDir, 'skills', 'security-and-hardening', 'SKILL.md');
  const disabledDefault = join(env.agentDir, 'skills', 'performance-optimization', 'SKILL.md');
  for (const file of [skillPath, filtered, disabledDefault]) await mkdir(dirname(file), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'installed-review-package', version: '1.0.0', pi: { skills: ['skills'] } }));
  await writeFile(skillPath, '---\nname: code-review-and-quality\ndescription: Review increment contracts.\n---\nCached package evidence: require exactly one increment.\n');
  await writeFile(filtered, '---\nname: security-and-hardening\ndescription: Disabled package guidance.\n---\nExcluded package skill evidence.\n');
  await writeFile(disabledDefault, '---\nname: performance-optimization\ndescription: Disabled ambient guidance.\n---\nExcluded default skill evidence.\n');
  await writeFile(join(env.cwd, 'snapshot.txt'), 'snapshot-cached-001\nreturn input + 1;\n');
  const attempts = join(env.agentDir, 'forbidden-package-commands.log');
  const npmStub = join(env.agentDir, 'inert-npm.mjs');
  await writeFile(attempts, '');
  await writeFile(npmStub, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'root' && args[1] === '-g') process.stdout.write(${JSON.stringify(join(env.agentDir, 'legacy-global-node-modules'))});
else { appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(args) + '\\n'); process.exitCode = 1; }
`);
  const settingsPath = join(env.agentDir, 'settings.json');
  const settings = JSON.stringify({ npmCommand: [process.execPath, npmStub],
    packages: ['npm:fusion-missing-review-fixture@1.0.0', { source: packageDir, skills: ['!skills/security-and-hardening/**'] }],
    skills: ['!**/code-review-and-quality/**', '!**/performance-optimization/**'], retry: { enabled: false },
  });
  await writeFile(settingsPath, settings);
  const outcome = await runChild({ ...env, root: 'root-1234', role, choice: 'fusion-fake/one#low',
    task: 'Review snapshot-cached-001, retained in snapshot.txt. Requirement: exactly one increment.', briefing: 'inline contract', modelRuntime: env.runtime,
  }).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  assert.equal(await readFile(attempts, 'utf8'), '', 'discovery must never invoke an installer or remote package metadata command');
  if (outcome.error) throw outcome.error;
  assert.ok(outcome.result?.text.includes('Cached package evidence: require exactly one increment.'));
  assert.ok(outcome.result?.text.includes('return input + 1;'));
  const advertised = JSON.stringify(env.requests[0].context.messages.filter(message => message.role === 'system'));
  assert.equal(advertised.includes(filtered), false, 'package exclusions remain effective');
  assert.equal(advertised.includes(disabledDefault), false, 'disabled default paths are not rediscovered');
  assert.equal(await readFile(settingsPath, 'utf8'), settings, 'file-backed account settings remain unchanged');
  await assert.rejects(access(join(env.agentDir, 'npm', 'node_modules', 'fusion-missing-review-fixture')), /ENOENT/);
});

test('reviewer discloses a non-invokable default skill, and durable failed review resumes with exact prior evidence', async () => {
  const env = await fixture((model, index) => index === 1
    ? { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-evidence', name: 'read', arguments: { path: 'evidence.txt', offset: 1, limit: 1 } }] }
    : index === 2 ? { ...reply(model, ''), stopReason: 'error', errorMessage: 'review provider outage' } : reply(model, 'review continued'));
  await writeFile(join(env.cwd, 'evidence.txt'), 'retained snapshot-002 evidence');
  const disabledSkill = join(env.agentDir, 'skills', 'code-review-and-quality', 'SKILL.md');
  await mkdir(dirname(disabledSkill), { recursive: true });
  await writeFile(disabledSkill, '---\nname: code-review-and-quality\ndescription: Manually invoked guidance.\ndisable-model-invocation: true\n---\nManual review guidance.\n');
  const oldHome = process.env.HOME;
  process.env.HOME = env.agentDir;
  try {
    const base = { ...env, root: 'root-1234', role: 'reviewer' as const, choice: 'fusion-fake/one#low', task: 'snapshot-002 packet', briefing: 'inline contract', modelRuntime: env.runtime };
    let confirmed: string | undefined;
    await assert.rejects(runChild({ ...base, onConfirmed: id => { confirmed = id; } }), /review provider outage/);
    assert.ok(confirmed, 'durable failed review retains the exact child for an explicit follow-up');
    const next = await runChild({ ...base, task: 'user-requested follow-up', resume: confirmed });
    assert.equal(next.id, confirmed);
    assert.match(next.text, /limitation.*code-review-and-quality.*unavailable/i);
    assert.ok(JSON.stringify(env.requests.at(-1)!.context.messages).includes('retained snapshot-002 evidence'));
    const ctx = { cwd: env.cwd, sessionManager: { getSessionId: () => base.root, getBranch: () => [
      { type: 'custom', customType: 'fusion.pi.setup', data: { lead: base.choice, sidekick: 'fusion-fake/two#medium', reviewer: base.choice } },
      { type: 'custom', customType: 'fusion.pi.child', data: { role: 'reviewer', id: confirmed } },
    ] } } as unknown as ExtensionContext;
    const saved = await persistedRuns(ctx, env.dir);
    assert.equal(saved[0]?.role, 'reviewer');
    assert.equal(saved[0]?.status, 'failed');
    assert.equal(saved[1]?.status, 'done');
    assert.equal(saved[1]?.sessionID, confirmed);
    assert.ok(saved[0].prompt.includes('snapshot-002 packet'));
    assert.ok(saved[1].prompt.includes('user-requested follow-up'));
    assert.equal(saved[1].messages.some(message => message.role === 'toolResult'), false, 'resumed run does not merge the prior review trajectory');
    await assert.rejects(runChild({ ...base, root: 'foreign-root', resume: confirmed }), /ownership/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  }
});

for (const role of ['sidekick', 'advisor'] as const) test(`SDK root receives background ${role} completion once as model-visible follow-up`, async () => {
  let leadCalls = 0;
  const env = await fixture((model, index) => {
    if (model.id === 'one' && ++leadCalls === 1) return { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'delegate-bg', name: 'fusion_delegate', arguments: { role, task: 'background job', background: true } }] };
    return reply(model, `completed ${index}`);
  });
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => createFusion(pi, options => runChild({ ...options, modelRuntime: env.runtime }), env.agentDir)] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: env.runtime, settingsManager, resourceLoader,
    model: env.runtime.getModel('fusion-fake', 'one'), thinkingLevel: 'high', tools: ['fusion_delegate'], sessionManager: SessionManager.inMemory(env.cwd) });
  try {
    await session.prompt('/fusion-models fusion-fake/one#high@50k fusion-fake/two#medium@100k advisor=fusion-fake/two#low@100k');
    await session.prompt('start background work', { expandPromptTemplates: false });
    const deadline = Date.now() + 4000;
    while (!session.messages.some(message => message.role === 'custom' && message.customType === 'fusion.pi.background-result') && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    await session.waitForIdle();
    const delivered = session.messages.filter(message => message.role === 'custom' && message.customType === 'fusion.pi.background-result');
    assert.equal(delivered.length, 1);
    assert.match(JSON.stringify(delivered[0]), /completed/);
    assert.equal((delivered[0] as { details?: { usage?: { input?: number } } }).details?.usage?.input, 3);
    assert.ok(env.requests.some(request => request.model === 'one' && JSON.stringify(request.context.messages).includes(`${role} sessionID:`)),
      JSON.stringify(env.requests.map(request => ({ model: request.model, messages: request.context.messages.map(message => message.role) }))));
    assert.equal(env.requests.filter(request => request.model === 'one').every(request => request.contextWindow === 50000), true);
    assert.equal(env.requests.filter(request => request.model === 'two').every(request => request.contextWindow === 100000), true);
  } finally { session.dispose(); }
});

test('ordinary user review request reaches a native background reviewer that reads installed skill and frozen evidence, with one result delivery', async () => {
  let delegateNext = true;
  let reviewerCalls = 0;
  let skillPath = '';
  const env = await fixture((model, _index, context) => {
    if (model.id === 'one' && delegateNext) {
      delegateNext = false;
      return { ...reply(model, ''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'review', name: 'fusion_delegate', arguments: {
        role: 'reviewer', task: 'snapshot-003: frozen diff and surrounding source in snapshot.txt, lines 1-2. Requirement: preserve caller contract.', background: true,
      } }] };
    }
    if (model.id === 'two') {
      if (++reviewerCalls === 1) {
        const advertised = JSON.stringify(context.messages.filter(message => message.role === 'system'));
        const location = /<name>code-review-and-quality<\/name>[\s\S]*?<location>([^<]+)<\/location>/.exec(advertised)?.[1];
        assert.equal(location, skillPath);
        return { ...reply(model, ''), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'review-skill', name: 'read', arguments: { path: location, offset: 1, limit: 20 } },
          { type: 'toolCall', id: 'review-snapshot', name: 'read', arguments: { path: 'snapshot.txt', offset: 1, limit: 2 } },
        ] };
      }
      return reply(model, 'snapshot-003 review: ' + context.messages.filter(message => message.role === 'toolResult').map(message => JSON.stringify(message.content)).join('\n'));
    }
    return reply(model, 'lead turn complete');
  });
  skillPath = join(env.agentDir, 'skills', 'code-review-and-quality', 'SKILL.md');
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, '---\nname: code-review-and-quality\ndescription: Check caller contracts.\n---\nInstalled review evidence: preserve caller contract.\n');
  const snapshot = 'snapshot-003 frozen source\nreturn validated input;\n';
  await writeFile(join(env.cwd, 'snapshot.txt'), snapshot);
  await writeFile(join(env.cwd, 'moving-source.txt'), 'later unrelated workspace changes');
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => createFusion(pi, options => runChild({ ...options, modelRuntime: env.runtime }), env.agentDir)] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, modelRuntime: env.runtime, settingsManager, resourceLoader,
    model: env.runtime.getModel('fusion-fake', 'one'), thinkingLevel: 'high', tools: ['fusion_delegate'], sessionManager: SessionManager.inMemory(env.cwd) });
  try {
    await session.prompt('/fusion-models fusion-fake/one#high fusion-fake/two#medium reviewer=fusion-fake/two#low');
    await session.prompt('Do a code review with the Fusion reviewer.', { expandPromptTemplates: false });
    const deadline = Date.now() + 4000;
    while (!session.messages.some(message => message.role === 'custom' && message.customType === 'fusion.pi.background-result') && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    await session.waitForIdle();
    const delivered = session.messages.filter(message => message.role === 'custom' && message.customType === 'fusion.pi.background-result');
    assert.equal(delivered.length, 1);
    assert.ok(JSON.stringify(delivered[0]).includes('snapshot-003 review'));
    assert.ok(JSON.stringify(delivered[0]).includes('Installed review evidence: preserve caller contract.'));
    assert.ok(JSON.stringify(delivered[0]).includes('snapshot-003 frozen source'));
    assert.equal(JSON.stringify(delivered[0]).includes('later unrelated workspace changes'), false);
    assert.equal(await readFile(join(env.cwd, 'snapshot.txt'), 'utf8'), snapshot);
    assert.ok(env.requests.some(request => request.model === 'one' && JSON.stringify(request.context.messages).includes('reviewer sessionID:')));
    const childRef = session.sessionManager.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.child');
    assert.ok(childRef && childRef.type === 'custom' && (childRef.data as { role: string }).role === 'reviewer');
    const messages = env.requests.filter(request => request.model === 'two').at(-1)!.context.messages;
    for (const id of ['review-skill', 'review-snapshot']) {
      const result = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
      assert.ok(result && result.role === 'toolResult' && !result.isError);
    }
  } finally { session.dispose(); }
});
