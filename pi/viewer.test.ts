import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initTheme, Theme, type AgentSession, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createFusion } from './index.ts';
import { detailLines, orderRuns, outcome, plain, RunRegistry, splitRuns, tui, widgetLines, type Run } from './viewer.ts';
import { createViewer, persistedRuns } from './viewer-ui.ts';
import { emptyUsage, type Launch } from './worker.ts';

type Message = AgentSession['messages'][number];
const user = (prompt: string, timestamp: number): Message => ({ role: 'user', content: prompt, timestamp });
const assistant = (content: string, timestamp: number, stopReason = 'stop', errorMessage?: string): Message => ({ role: 'assistant', content: [{ type: 'text', text: content }], timestamp, stopReason, errorMessage } as Message);
const run = (status: Run['status'] = 'running'): Run => ({ role: 'sidekick', prompt: 'Investigate wide text 中文 and return evidence', startedAt: 1000, status, messages: [] });
const theme = new Theme({ accent: 33, border: 33, text: 7, dim: 8, muted: 8, thinkingXhigh: 33, error: 1, success: 2,
  mdHeading: 33, mdLink: 33, mdLinkUrl: 8, mdCode: 3, mdCodeBlock: 7, mdCodeBlockBorder: 8,
  mdQuote: 8, mdQuoteBorder: 8, mdHr: 8, mdListBullet: 33,
} as ConstructorParameters<typeof Theme>[0], { selectedBg: 0, customMessageBg: 93 } as ConstructorParameters<typeof Theme>[1], '256color');
const renderedDetail = (run: Run, fullOutput = false, width = 160) => detailLines(run, width, theme, fullOutput).map(plain).map(line => line.trimEnd()).join('\n');

test('resuming a child keeps each prompt and its trajectory and final outcome separate', () => {
  const messages = [user('first exact\nmultiline prompt', 1000), assistant('first result', 2000),
    user('second prompt', 4000), assistant('partial', 4500, 'toolUse'),
    { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'evidence' }], isError: false, timestamp: 4600 } as Message,
    assistant('', 5000, 'error', 'provider rejected'), user('third prompt', 6000), assistant('', 7000, 'aborted', 'cancelled')];
  const runs = splitRuns(messages, { role: 'sidekick', sessionID: 'sidekick-id' });
  assert.equal(runs.length, 3);
  assert.equal(runs[0].prompt, 'first exact\nmultiline prompt');
  assert.equal(runs[0].result, 'first result');
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[1].status, 'failed');
  assert.equal(runs[1].error, 'provider rejected');
  assert.equal(runs[2].status, 'aborted');
  assert.equal(runs[2].error, 'cancelled');
  assert.ok(!renderedDetail(runs[0]).includes('provider rejected'));
  assert.ok(renderedDetail(runs[1]).includes('evidence'));
  assert.equal(runs[1].startedAt, 4000);
  assert.equal(runs[1].endedAt, 5000);
});

test('active retries are running, terminal responses determine result/error, incomplete trajectories are not done', () => {
  const failed = [assistant('', 2000, 'error', 'rate limit')];
  assert.equal(outcome(failed, true).status, 'running');
  assert.equal(outcome(failed).error, 'rate limit');
  assert.equal(outcome([assistant('answer', 2000)]).result, 'answer');
  assert.equal(outcome([assistant('', 2000, 'aborted')]).status, 'aborted');
  assert.equal(outcome([user('task', 1000)]).status, 'aborted');
  assert.notEqual(outcome([assistant('', 2000, 'toolUse')]).status, 'done');
});

test('widget respects terminal column width, caps runs, and prioritizes active work', () => {
  const runs = Array.from({ length: 8 }, () => ({ ...run('done'), result: 'completed' }));
  runs[7] = { ...run(), role: 'sidekick', activity: 'bash 中文中文中文' } as typeof runs[number];
  for (const width of [1, 12, 40, 120]) {
    const lines = widgetLines(runs, width, 6000);
    assert.equal(lines.length, 6);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
  }
  const lines = widgetLines(runs, 200, 6000);
  assert.ok(lines[0].includes('bash'));
  assert.ok(lines[0].includes('sidekick'));
  assert.equal(Number(lines.at(-1)!.match(/\d+/)?.[0]), 3);
  assert.equal(widgetLines([], 80).length, 0);
});

test('live events expose streamed text, calls and partial results, then freeze a finished trajectory', () => {
  const registry = new RunRegistry();
  const active = registry.add('sidekick', 'inspect');
  registry.update(active, { type: 'message_start', message: user('exact SDK prompt', 1000) });
  registry.update(active, { type: 'message_start', message: assistant('partial', 2000) });
  registry.update(active, { type: 'message_end', message: assistant('full text', 2000) });
  registry.update(active, { type: 'tool_execution_start', toolCallId: 'call', toolName: 'bash', args: { command: 'inspect' } });
  registry.update(active, { type: 'tool_execution_update', toolCallId: 'call', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'streaming output' }] } });
  const detail = renderedDetail(active);
  assert.ok(detail.includes('full text'));
  assert.ok(!detail.includes('partial\n'));
  assert.ok(detail.includes('streaming output'));
  assert.ok(widgetLines([active], 200, 6000)[0].includes('bash'));
  registry.finish(active, 'final answer');
  assert.equal(active.status, 'done');
  assert.ok(renderedDetail(active).includes('final answer'));
  assert.equal(active.toolProgress, undefined);
  assert.equal(active.prompt, 'exact SDK prompt');
  assert.equal(active.startedAt, 1000);
  const frozen = widgetLines([active], 200, active.endedAt! + 10000);
  assert.deepEqual(frozen, widgetLines([active], 200, active.endedAt! + 20000));
  const failed = registry.add('advisor', 'review'); registry.finish(failed, undefined, new Error('failure'));
  assert.equal(failed.status, 'failed');
  const aborted = registry.add('sidekick', 'cancel'); registry.finish(aborted, undefined, new Error('cancelled'), true);
  assert.equal(aborted.status, 'aborted');
});

test('reviewer viewer shows its owned ID for explicit follow-ups and bounded read activity', () => {
  const registry = new RunRegistry();
  const review = registry.add('reviewer', 'snapshot-007 supplied review packet');
  review.sessionID = 'reviewer-007';
  registry.update(review, { type: 'tool_execution_start', toolCallId: 'evidence', toolName: 'read', args: { path: 'snapshot.txt', offset: 1, limit: 10 } });
  const widget = widgetLines([review], 160)[0];
  assert.ok(widget.includes('reviewer') && widget.includes('read'));
  assert.ok(renderedDetail(review).includes(review.sessionID));
  registry.finish(review, 'snapshot-007: no introduced defects found within inspected scope');
  assert.ok(renderedDetail(review).includes(review.result!));
  assert.ok(detailLines(review, 160, theme).some(line => line.includes(theme.getFgAnsi('success'))));
  for (const width of [12, 80]) assert.ok(detailLines(review, width, theme).every(line => tui.visibleWidth(line) <= width));
});

test('details preserve the whole prompt and assistant text but bound tool payloads and remove terminal controls', () => {
  const active = run();
  active.prompt = 'Exact prompt\n' + 'long prompt '.repeat(300);
  active.messages = [{ ...assistant('', 2000), content: [
    { type: 'text', text: 'assistant text '.repeat(400) },
    { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'x'.repeat(5000) } },
  ] } as Message, { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: '\x1b[2J' + 'y'.repeat(5000) }], timestamp: 3000, isError: false } as Message];
  const detail = renderedDetail(active);
  const prose = detail.replace(/\s+/g, ' ');
  assert.ok(prose.includes(active.prompt.replace(/\s+/g, ' ').trim()));
  assert.ok(prose.includes('assistant text '.repeat(400).trim()));
  assert.ok(!detail.replace(/\s/g, '').includes('x'.repeat(2000)));
  assert.ok(!detail.replace(/\s/g, '').includes('y'.repeat(3000)));
  assert.ok(!detail.includes('\x1b'));
});

test('persisted viewer reads every confirmed sidekick without repairing unterminated JSONL files', async () => {
  const dir = await mkdtemp('/tmp/fusion-viewer-');
  const owner = { root: 'root-123', role: 'sidekick', caller: 'root-123' };
  const entries = [
    { type: 'session', id: 'sidekick-123', cwd: dir, parentSession: 'root-123' },
    { type: 'custom', customType: 'fusion.pi.owner', data: owner },
    ...[user('one', 1000), assistant('result one', 2000), user('two', 3000), assistant('result two', 4000)].map(message => ({ type: 'message', message })),
  ];
  const file = join(dir, 'child.jsonl');
  const original = entries.map(entry => JSON.stringify(entry)).join('\n');
  await writeFile(file, original);
  const otherEntries = [
    { ...entries[0], id: 'sidekick-456' }, entries[1],
    ...[user('independent check', 1000), assistant('independent result', 2000)].map(message => ({ type: 'message', message })),
  ];
  const otherFile = join(dir, 'other.jsonl');
  const otherOriginal = otherEntries.map(entry => JSON.stringify(entry)).join('\n');
  await writeFile(otherFile, otherOriginal);
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'root-123', getBranch: () => [
    { type: 'custom', customType: 'fusion.pi.setup', data: { lead: 'p/a#off', sidekick: 'p/b#off' } },
    { type: 'custom', customType: 'fusion.pi.child', data: { role: 'sidekick', id: 'sidekick-123' } },
    { type: 'custom', customType: 'fusion.pi.child', data: { role: 'sidekick', id: 'sidekick-456' } },
  ] } } as unknown as ExtensionContext;
  assert.deepEqual((await persistedRuns(ctx, dir)).map(run => run.result).sort(), ['independent result', 'result one', 'result two']);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(await readFile(otherFile, 'utf8'), otherOriginal);
  assert.deepEqual((await readdir(dir)).sort(), ['child.jsonl', 'other.jsonl']);
  owner.root = 'another-root';
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
  await writeFile(otherFile, otherEntries.map(entry => JSON.stringify(entry)).join('\n'));
  assert.equal((await persistedRuns(ctx, dir)).length, 0);
});

test('legacy viewer retains sidekick and advisor histories without adopting or deleting utility chats', async () => {
  const dir = await mkdtemp('/tmp/opencode/fusion-viewer-legacy-');
  const saved = new Map<string, string>();
  for (const role of ['sidekick', 'advisor', 'utility']) {
    const caller = role === 'utility' ? 'sidekick-123' : 'root-123';
    const entries = [
      { type: 'session', id: `${role}-123`, cwd: dir, parentSession: caller },
      { type: 'custom', customType: 'fusion.pi.owner', data: { role, root: 'root-123', ...(role === 'utility' ? { caller } : {}) } },
      ...[user(`${role} task`, 1000), assistant(`${role} result`, 2000)].map(message => ({ type: 'message', message })),
    ];
    const file = join(dir, `${role}.jsonl`), raw = entries.map(entry => JSON.stringify(entry)).join('\n');
    saved.set(file, raw);
    await writeFile(file, raw);
  }
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'root-123', getBranch: () => [
    { type: 'custom', customType: 'fusion.pi.setup', data: { lead: 'p/a#off', sidekick: 'p/b#off', advisor: 'p/a#low', utility: 'obsolete' } },
    ...['sidekick', 'advisor', 'utility'].map(role => ({ type: 'custom', customType: 'fusion.pi.child', data: { role, id: `${role}-123`, caller: 'sidekick-123' } })),
  ] } } as unknown as ExtensionContext;
  const runs = await persistedRuns(ctx, dir);
  assert.deepEqual(runs.map(run => run.result).sort(), ['advisor result', 'sidekick result']);
  for (const [file, raw] of saved) assert.equal(await readFile(file, 'utf8'), raw);
});

test('session switch removes completed and cancelled runs from the next session viewer', async () => {
  const handlers = new Map<string, Function>(), commands = new Map<string, Function>();
  let tool: any;
  let root = 'root-old';
  let pending: Launch | undefined;
  const notices: string[] = [];
  const setup = { lead: 'p/a#off', sidekick: 'p/b#off' };
  const model = { provider: 'p', id: 'a', reasoning: false, input: ['text'], contextWindow: 200000 };
  const models = [model, { ...model, id: 'b' }];
  const pi = { on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: Function }) => commands.set(name, options.handler), registerShortcut() {},
    registerTool: (definition: unknown) => { tool = definition; }, getThinkingLevel: () => 'off', sendMessage() {}, appendEntry() {} } as unknown as ExtensionAPI;
  const ctx = { cwd: '/tmp', hasUI: true, model,
    modelRegistry: { find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id), getAvailable: () => models, hasConfiguredAuth: () => true },
    sessionManager: { getSessionId: () => root, getBranch: () => [{ type: 'custom', customType: 'fusion.pi.setup', data: setup, id: 'setup' }] },
    ui: { notify: (text: string) => notices.push(text), setWidget() {} } } as unknown as ExtensionContext;
  createFusion(pi, async options => {
    options.onStarted?.('sidekick-123');
    if (options.task === 'complete') return { id: 'sidekick-123', text: 'done', usage: emptyUsage() };
    pending = options;
    return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  }, '/tmp/fusion-viewer-no-saved-files');
  await tool.execute('call1', { role: 'sidekick', task: 'complete', background: true }, undefined, undefined, ctx);
  await new Promise(resolve => setImmediate(resolve));
  await tool.execute('call2', { role: 'sidekick', task: 'wait', background: true }, undefined, undefined, ctx);
  assert.ok(pending);
  await handlers.get('session_before_switch')!();
  assert.ok(pending.signal?.aborted);
  root = 'root-new';
  // With stale entries this would try to open custom UI, which this context deliberately lacks.
  await commands.get('fusion-agents')!('', ctx);
  assert.equal(notices.length, 2);
});

test('overlay keyboard selection opens the chosen live run, pages its prompt and returns to the list', async () => {
  initTheme('dark', false);
  const registry = new RunRegistry();
  const first = registry.add('sidekick', 'first task'); registry.finish(first, 'first result');
  const second = registry.add('sidekick', 'second task\n' + Array.from({ length: 60 }, (_, i) => `prompt row ${i}`).join('\n'));
  const output = Array.from({ length: 12 }, (_, i) => `output row ${i}`).join('\n') + '\n' + 'x'.repeat(4000) + 'hidden tail';
  second.messages = [{ ...assistant('', 1000), content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'sleep 5 && ls' } }] } as Message,
    { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: output }], timestamp: 2000, isError: false } as Message];
  const viewer = createViewer(registry);
  let screen = 0;
  type Component = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  const ctx = { cwd: '/tmp', hasUI: true, sessionManager: { getSessionId: () => 'root-viewer', getBranch: () => [] },
    ui: { notify() {}, setWidget() {},
      async custom(factory: (terminal: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component) {
        let finish: (value: unknown) => void = () => {};
        const completed = new Promise(resolve => { finish = resolve; });
        const component = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, undefined, finish);
        const initial = component.render(100).join('\n');
        if (screen === 0) {
          assert.ok(initial.includes('first task'));
          assert.ok(initial.includes('second task'));
          assert.ok(initial.indexOf('second task') < initial.indexOf('first task'));
          component.handleInput('\r');
        } else if (screen === 1) {
          assert.ok(initial.includes('second task'));
          assert.ok(!initial.includes('first result'));
          component.handleInput('\x1b[6~');
          const paged = component.render(100).join('\n');
          assert.notEqual(paged, initial);
          component.handleInput('\x1b[5~');
          assert.equal(component.render(100).join('\n'), initial);
          registry.update(second, { type: 'message_start', message: assistant('live evidence arrived', 2000) });
          for (let i = 0; i < 10; i++) { component.handleInput('\x1b[6~'); component.render(100); }
          const preview = component.render(100).map(plain);
          assert.ok(preview.join('\n').includes('live evidence arrived'));
          assert.ok(!preview.join('\n').includes('output row 11'));
          component.handleInput('o');
          const expanded = component.render(100).map(plain);
          assert.equal(expanded[2], preview[2], 'expanding output retains the scroll offset');
          let full = expanded.join('\n');
          for (let i = 0; i < 10; i++) { component.handleInput('\x1b[6~'); full += '\n' + component.render(100).map(plain).join('\n'); }
          assert.ok(full.includes('output row 11'));
          assert.ok(!full.includes('hidden tail'));
          component.handleInput('o');
          const collapsed = component.render(100).map(plain).join('\n');
          assert.ok(!collapsed.includes('output row 11'));
          assert.ok(collapsed.includes('live evidence arrived'));
          component.handleInput('\x1b');
        } else {
          assert.ok(initial.includes('first task'));
          component.handleInput('\x1b');
        }
        screen++;
        const result = await completed;
        component.dispose(); return result;
      },
    } } as unknown as ExtensionContext;
  try { await viewer.open(ctx, '/tmp/fusion-viewer-no-saved-files/root-viewer'); }
  finally { viewer.clear(); }
  assert.equal(screen, 3);
});

test('finishing and clearing detach SDK observers so late events cannot change retained run data', () => {
  const registry = new RunRegistry();
  const listeners = new Set<(event: { type: 'message_start'; message: Message }) => void>();
  const session = { sessionId: 'sidekick-123', subscribe(listener: (event: { type: 'message_start'; message: Message }) => void) {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } } as unknown as AgentSession;
  const emit = (prompt: string) => { for (const listener of listeners) listener({ type: 'message_start', message: user(prompt, 1000) }); };
  const finished = registry.add('sidekick', 'initial'); registry.attach(finished, session);
  emit('received from SDK');
  assert.equal(finished.prompt, 'received from SDK');
  registry.finish(finished, 'complete');
  const detail = renderedDetail(finished);
  emit('late event after finish');
  assert.equal(renderedDetail(finished), detail);
  const cleared = registry.add('sidekick', 'next'); registry.attach(cleared, session);
  registry.clear();
  emit('late event after switch');
  assert.equal(registry.runs.length, 0);
  assert.equal(cleared.messages.length, 0);
});

test('tool steps show readable commands, paths and ranges instead of JSON argument objects', () => {
  const active = run();
  const args = { command: 'sleep 5 && ls' };
  active.messages = [{ ...assistant('', 2000), content: [
    { type: 'toolCall', id: 'bash', name: 'bash', arguments: args },
    { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'pi/index.ts', offset: 10, limit: 20 } },
    { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'docs/result.md', content: 'hidden write content' } },
    { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'docs/edit.md', oldText: 'hidden old text', newText: 'hidden new text' } },
    { type: 'toolCall', id: 'lookup', name: 'grep', arguments: { pattern: 'failure', path: 'logs' } },
  ] } as Message];
  const detail = renderedDetail(active);
  assert.ok(detail.includes(args.command));
  assert.ok(!detail.includes(JSON.stringify(args)));
  assert.ok(!detail.includes('{'));
  const read = detail.split('\n').find(line => line.includes('pi/index.ts'))!;
  assert.ok(read.includes('10') && read.includes('29'));
  assert.ok(detail.includes('docs/result.md') && detail.includes('docs/edit.md'));
  assert.ok(!detail.includes('hidden write content') && !detail.includes('hidden old text'));
  assert.ok(detail.includes('failure') && detail.includes('logs'));
  const numbered = detail.split('\n').filter(line => /^\d+\s/.test(line));
  assert.deepEqual(numbered.map(line => Number(line.match(/^\d+/)![0])), [1, 2, 3, 4, 5]);
});

test('completed and live tool outputs preview three lines with an accurate remainder, and full mode is bounded', () => {
  const active = run();
  const rows = Array.from({ length: 9 }, (_, i) => `unique output ${i}`);
  active.messages = [{ ...assistant('', 2000), content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'ls' } }] } as Message,
    { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: rows.join('\n') }], timestamp: 3000, isError: false } as Message];
  const preview = renderedDetail(active);
  assert.ok(rows.slice(0, 3).every(row => preview.includes(row)));
  assert.ok(rows.slice(3).every(row => !preview.includes(row)));
  assert.equal(Number(preview.match(/…\s+(\d+)/)?.[1]), rows.length - 3);
  assert.ok(rows.every(row => renderedDetail(active, true).includes(row)));
  const styled = detailLines(active, 160, theme).find(line => plain(line).includes(rows[0]))!;
  assert.ok(styled.startsWith(theme.getFgAnsi('dim')));
  active.messages.pop();
  active.toolProgress = rows.join('\n');
  assert.ok(!renderedDetail(active).includes(rows[8]));
  assert.ok(renderedDetail(active, true).includes(rows[8]));
  active.toolProgress = '\x1b[2J\x1b[31m' + 'Z'.repeat(4000) + 'hidden tail\x07';
  const full = renderedDetail(active, true).replace(/\s/g, '');
  assert.ok(!full.includes('hiddentail'));
  assert.equal((full.match(/Z/g) ?? []).length, 2000);
  assert.ok(!full.includes('\x1b') && !full.includes('\x07'));
  for (const width of [12, 80]) assert.ok(detailLines(active, width, theme, true).every(line => tui.visibleWidth(line) <= width));
});

test('Markdown prose is formatted and failure/abort diagnostics have error styling rather than success styling', () => {
  const done = run('done');
  done.prompt = '**task emphasis**';
  done.messages = [assistant('**assistant emphasis**\n\n- item', 2000)];
  done.result = '**result emphasis**';
  const prose = renderedDetail(done);
  assert.ok(prose.includes('task emphasis') && prose.includes('assistant emphasis') && prose.includes('result emphasis'));
  assert.ok(!prose.includes('**'));
  assert.ok(detailLines(done, 160, theme).some(line => line.includes(theme.getFgAnsi('success'))));
  for (const status of ['failed', 'aborted'] as const) {
    const failed = { ...run(status), error: '\x1b[2Jpermission denied\x07' };
    const lines = detailLines(failed, 160, theme);
    const diagnostic = lines.find(line => plain(line).includes('permission denied'))!;
    assert.ok(diagnostic.startsWith(theme.getFgAnsi('error')));
    assert.ok(lines.some(line => plain(line).includes('✗')));
    assert.ok(!lines.some(line => line.includes(theme.getFgAnsi('success'))));
    assert.ok(!renderedDetail(failed).includes('\x1b') && !renderedDetail(failed).includes('\x07'));
  }
  const toolError = { ...run(), messages: [
    { ...assistant('', 2000), content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'cat private-file' } }] } as Message,
    { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'access denied' }], timestamp: 3000, isError: true } as Message,
  ] };
  const lines = detailLines(toolError, 160, theme);
  const call = lines.find(line => plain(line).includes('cat private-file'))!;
  assert.ok(call.startsWith(theme.getFgAnsi('error')) && plain(call).includes('✗'));
  assert.ok(lines.find(line => plain(line).includes('access denied'))!.startsWith(theme.getFgAnsi('error')));
});

test('list keeps active runs above finished ones and follows the highlighted run when it finishes', async () => {
  initTheme('dark', false);
  const registry = new RunRegistry();
  const finished = registry.add('sidekick', 'previously-finished'); registry.finish(finished, 'previous result'); finished.endedAt = 500;
  const oldest = registry.add('sidekick', 'oldest-active'); oldest.startedAt = 1000;
  const target = registry.add('advisor', 'highlighted-target'); target.startedAt = 2000;
  const newest = registry.add('advisor', 'newest-active'); newest.startedAt = 3000;
  const viewer = createViewer(registry);
  let screen = 0;
  type Component = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  const ctx = { cwd: '/tmp', hasUI: true, sessionManager: { getSessionId: () => 'root-list-order', getBranch: () => [] },
    ui: { notify() {}, setWidget() {},
      async custom(factory: (terminal: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component) {
        let finish: (value: unknown) => void = () => {};
        const completed = new Promise(resolve => { finish = resolve; });
        const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, undefined, finish);
        const initial = component.render(160).map(plain);
        if (screen === 0) {
          const position = (prompt: string) => initial.findIndex(line => line.includes(prompt));
          assert.ok(position('oldest-active') < position('highlighted-target'));
          assert.ok(position('highlighted-target') < position('newest-active'));
          assert.ok(position('newest-active') < position('previously-finished'));
          component.handleInput('\x1b[B');
          const before = component.render(160).map(plain);
          assert.ok(before.find(line => line.startsWith('→ '))!.includes('highlighted-target'));
          registry.finish(target, 'target result');
          const after = component.render(160).map(plain);
          assert.ok(after.find(line => line.startsWith('→ '))!.includes('highlighted-target'));
          assert.ok(after.findIndex(line => line.includes('highlighted-target')) > before.findIndex(line => line.includes('highlighted-target')));
          assert.ok(after.findIndex(line => line.includes('newest-active')) < after.findIndex(line => line.includes('highlighted-target')));
          component.handleInput('\r');
        } else if (screen === 1) {
          assert.ok(initial.join('\n').includes('highlighted-target'));
          assert.ok(initial.join('\n').includes('target result'));
          assert.ok(!initial.join('\n').includes('newest-active'));
          component.handleInput('\x1b');
        } else component.handleInput('\x1b');
        screen++;
        const result = await completed;
        component.dispose(); return result;
      },
    } } as unknown as ExtensionContext;
  try { await viewer.open(ctx, '/tmp/fusion-viewer-no-saved-files/root-list-order'); }
  finally { viewer.clear(); }
});

test('run ordering uses oldest active starts and newest terminal ends, falling back to start time', () => {
  const olderActive = { ...run(), prompt: 'older-active', startedAt: 100 };
  const newerActive = { ...run(), prompt: 'newer-active', startedAt: 200 };
  const done = { ...run('done'), prompt: 'latest-completion', startedAt: 10, endedAt: 600 };
  const failed = { ...run('failed'), prompt: 'earlier-failure', startedAt: 300, endedAt: 400 };
  const aborted = { ...run('aborted'), prompt: 'aborted-no-end', startedAt: 500 };
  const runs = [failed, newerActive, aborted, done, olderActive];
  const expected = [olderActive, newerActive, done, aborted, failed];
  assert.deepEqual(orderRuns(runs), expected);
  assert.deepEqual(runs, [failed, newerActive, aborted, done, olderActive], 'ordering must not mutate the registry or saved arrays');
  const widget = widgetLines(runs, 200, 1000);
  expected.forEach((run, index) => assert.ok(widget[index].includes(run.prompt)));
});

test('list and Markdown detail overlays paint every column, including blank space and text after ANSI resets', async () => {
  initTheme('dark', false);
  const resetTheme = Object.create(theme) as Theme;
  resetTheme.bold = value => `\x1b[1m${value}\x1b[0m`;
  function assertOpaque(lines: string[], width: number) {
    const expected = resetTheme.getBgAnsi('customMessageBg');
    for (const line of lines) {
      assert.equal(tui.visibleWidth(line), width);
      let background: string | undefined;
      for (const part of line.matchAll(/\x1b\[[0-9;]*m|[^\x1b]+/g)) {
        const fragment = part[0];
        if (!fragment.startsWith('\x1b')) {
          if (tui.visibleWidth(fragment)) assert.equal(background, expected, 'every visible span must retain the custom-message background');
          continue;
        }
        const codes = fragment.slice(2, -1).split(';').map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === 0 || code === 49) background = undefined;
          if (code === 38 || code === 48) {
            const count = codes[i + 1] === 5 ? 3 : 5;
            if (code === 48) background = `\x1b[${codes.slice(i, i + count).join(';')}m`;
            i += count - 1;
          }
        }
      }
    }
  }
  const registry = new RunRegistry();
  const active = registry.add('advisor', '**highlighted prompt** text after reset\n\nSecond paragraph 中文');
  active.messages = [assistant('**assistant emphasis** and following text', 2000)];
  registry.finish(active, '**final emphasis** and following result');
  const viewer = createViewer(registry);
  let screen = 0;
  type Component = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  const ctx = { cwd: '/tmp', hasUI: true, sessionManager: { getSessionId: () => 'root-opaque', getBranch: () => [] },
    ui: { notify() {}, setWidget() {},
      async custom(factory: (terminal: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component) {
        let finish: (value: unknown) => void = () => {};
        const completed = new Promise(resolve => { finish = resolve; });
        const component = factory({ terminal: { rows: 50 }, requestRender() {} }, resetTheme, undefined, finish);
        for (const width of [12, 80, 160]) assertOpaque(component.render(width), width);
        const lines = component.render(160);
        if (screen === 0) component.handleInput('\r');
        else {
          if (screen === 1) {
            assert.ok(lines.some(line => !plain(line).trim()), 'detail coverage includes blank lines');
            assert.ok(lines.some(line => line.includes('\x1b[0m') && plain(line).includes('following text')), 'exercise Markdown text after a full style reset');
            component.handleInput('\x1b[6~');
            assertOpaque(component.render(160), 160);
          }
          component.handleInput('\x1b');
        }
        screen++;
        const result = await completed;
        component.dispose(); return result;
      },
    } } as unknown as ExtensionContext;
  try { await viewer.open(ctx, '/tmp/fusion-viewer-no-saved-files/root-opaque'); }
  finally { viewer.clear(); }
});
