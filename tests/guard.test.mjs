import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHooks, inspectTextTarget, registerExtension } from '../com.github.copilot/extensions/fusion-guard/hooks.mjs';
import { fusionAgentIdentity } from '../com.github.copilot/extensions/fusion-guard/identity.mjs';
import { containsGitCommand } from '../shared/git-command.mjs';
import { createRoleResolver } from '../com.github.copilot/extensions/fusion-guard/roles.mjs';
import { createCancelTool } from '../com.github.copilot/extensions/fusion-guard/cancel.mjs';

const leadPath = fileURLToPath(new URL('../com.github.copilot/agents/fusion.agent.md', import.meta.url));
const foreignPath = fileURLToPath(new URL('./foreign-fusion.agent.md', import.meta.url));
const packagedLead = { id: 'fusion-big-boss:fusion',
  name: 'fusion-big-boss:fusion', source: 'plugin', path: leadPath };
const looseLead = { id: 'fusion', name: 'fusion', source: 'user' };
const event = (type, agentId, data) => ({
  type, ...(agentId ? { agentId } : {}), data,
  id: `${type}-${data.toolCallId}`, parentId: null, timestamp: '2026-01-01T00:00:00Z',
});
const spawn = (id, role, parentAgentId = null, parentTaskId) => [
  event('tool.execution_start', parentAgentId, { toolName: 'task', toolCallId: `call-${id}` }),
  event('subagent.started', id, { agentName: role, agentType: role, toolCallId: `call-${id}`,
    executionMode: 'background', model: role.endsWith('reviewer') ? 'selected-reviewer' : 'user-choice',
    ...(parentTaskId ? { parentId: parentTaskId } : {}) }),
];

function fixture(agent = packagedLead) {
  const agents = Object.fromEntries(['fusion-sidekick', 'fusion-big-boss:fusion-sidekick']
    .map(role => [role, { model: 'user-choice', effortLevel: 'high', modelPolicy: 'required' }]));
  const state = { agent, subagents: { agents, disabledSubagents: ['fusion-big-boss:fusion-advisor'] }, journal: [],
    cursorStatus: 'ok', settingsFailure: false, agentFailure: false, reads: [], logs: [],
    tasks: [{ type: 'agent', id: 'task-sidekick',
      agentType: 'fusion-big-boss:fusion-sidekick', toolCallId: 'call-sidekick', status: 'idle' }] };
  const listeners = new Map();
  const session = {
    sessionId: 'root',
    log: async message => state.logs.push(message),
    connection: { sendRequest: async (method) => {
      assert.equal(method, 'user.settings.get');
      if (state.settingsFailure) throw new Error('settings unavailable');
      return { settings: { subagents: { value: state.subagents } } };
    } },
    on: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    rpc: {
      model: { list: async () => ({ list: [
        { id: 'user-choice', supportedReasoningEfforts: ['high'] },
        { id: 'selected-reviewer', supportedReasoningEfforts: ['high'] },
      ] }) },
      agent: { getCurrent: async () => {
        if (state.agentFailure) throw new Error('agent metadata unavailable');
        return { agent: state.agent };
      } },
      tasks: { list: async () => ({ tasks: state.tasks }) },
      eventLog: { read: async (request) => {
        state.reads.push(request);
        const events = state.journal.filter((item) => request.types.includes(item.type));
        const start = Number(request.cursor ?? 0);
        const batch = events.slice(start, start + 2);
        return { events: batch, cursor: String(start + batch.length),
          hasMore: start + batch.length < events.length,
          cursorStatus: typeof state.cursorStatus === 'function' ? state.cursorStatus(start) : state.cursorStatus };
      } },
    },
  };
  state.append = (items, notify = false) => {
    for (const item of items) {
      state.journal.push(item);
      if (notify) for (const fn of listeners.get(item.type) ?? []) fn(item);
    }
  };
  return { session, state };
}

async function installed(f) {
  let hooks;
  let tools;
  await registerExtension(async (options) => { hooks = options.hooks; tools = options.tools; return f.session; },
    async () => ({ kind: 'text' }));
  return {
    cancel: async (agentId, target, extra = {}) => {
      const toolCallId = `cancel-${f.state.journal.length}`;
      f.state.append([event('tool.execution_start', agentId === 'root' ? null : agentId,
        { toolName: 'fusion_cancel', toolCallId })], true);
      return tools.find(tool => tool.name === 'fusion_cancel').handler({ agent_id: target }, {
        sessionId: f.session.sessionId, toolCallId, toolName: 'fusion_cancel',
        ...(agentId === 'root' ? {} : { agentId }), ...extra,
      });
    },
    tool: (sessionId, toolName, toolArgs = {}) => hooks.onPreToolUse(
      { sessionId, toolName, toolArgs }, { sessionId: f.session.sessionId }),
    prompt: (sessionId, prompt = 'private user question') => hooks.onUserPromptSubmitted(
      { sessionId, prompt }, { sessionId: f.session.sessionId }),
    result: (failed = false, sessionId = f.session.sessionId) => hooks[failed ? 'onPostToolUseFailure' : 'onPostToolUse']?.(
      { sessionId, toolName: 'task',
        toolArgs: { agent_type: 'fusion-sidekick', mode: 'background' } }, { sessionId: f.session.sessionId }),
  };
}

function reviewReady(f, name = 'fusion-big-boss:fusion-reviewer') {
  f.state.subagents.agents[name] = { model: 'selected-reviewer', effortLevel: 'high', modelPolicy: 'required' };
}
function advisorReady(f, name = 'fusion-big-boss:fusion-advisor') {
  f.state.subagents.agents[name] = { model: 'user-choice', effortLevel: 'high', modelPolicy: 'required' };
  f.state.subagents.disabledSubagents = f.state.subagents.disabledSubagents.filter(key => key !== name);
}
const denies = (result, reason) => {
  assert.equal(result?.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, reason);
};

function cancellable(f) {
  f.session.rpc.tasks.getProgress = async ({ id }) => ({ progress: { type: 'agent',
    recentActivity: [{ message: `partial ${id}`, timestamp: '2026-01-01T00:00:00Z' }] } });
  f.session.rpc.tasks.cancel = async ({ id }) => {
    const task = f.state.tasks.find(task => task.id === id);
    task.status = 'cancelled';
    return { cancelled: true };
  };
}

test('cancel interrupts only the verified target and evidence descendants, retaining output and history', async () => {
  const f = fixture(); cancellable(f);
  f.state.tasks[0].status = 'running';
  f.state.append([...spawn('sidekick', 'fusion-sidekick'), ...spawn('advisor', 'fusion-advisor'),
    ...spawn('evidence', 'fusion-sidekick', 'advisor', 'advisor-task')]);
  f.state.tasks.push(
    { type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running', latestResponse: 'finding so far' },
    { type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'running' });
  const history = f.state.journal.slice();
  const h = await installed(f);
  const result = await h.cancel('root', 'advisor-task');
  assert.equal(result.target.requested, true);
  assert.equal(result.target.confirmedStopped, true);
  assert.equal(result.target.output, 'finding so far');
  assert.equal(result.descendants[0].confirmedStopped, true);
  assert.equal(f.state.tasks[0].status, 'running');
  assert.equal(f.state.tasks[1].status, 'cancelled');
  assert.equal(f.state.tasks[2].status, 'cancelled');
  assert.deepEqual(f.state.journal.slice(0, history.length), history);
  assert.equal(f.state.tasks[1].latestResponse, 'finding so far');
});

for (const caller of ['advisor', 'reviewer']) test(`${caller} can cancel only its evidence worker; sidekicks cannot control`, async () => {
  const f = fixture(); cancellable(f);
  f.state.append([...spawn('sidekick', 'fusion-sidekick'), ...spawn(caller, `fusion-${caller}`),
    ...spawn('evidence', 'fusion-sidekick', caller, 'parent-task')]);
  f.state.tasks.push(
    { type: 'agent', id: 'parent-task', agentType: `fusion-${caller}`, toolCallId: `call-${caller}`, status: 'running' },
    { type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'running' });
  const h = await installed(f);
  for (const [origin, target] of [[caller, 'task-sidekick'], ['root', 'evidence-task'], ['sidekick', 'parent-task'], ['evidence', 'task-sidekick']]) {
    await assert.rejects(h.cancel(origin, target), /own|sidekick|evidence|delegate/i);
  }
  await assert.rejects(h.cancel('sidekick', 'parent-task', { agentId: undefined }), /caller|identity|origin/i);
  assert.equal(f.state.tasks[1].status, 'running');
  assert.equal((await h.cancel(caller, 'evidence-task')).target.confirmedStopped, true);
});

test('cancel distinguishes host acceptance from observed stop and reports failures without losing partial output', async () => {
  for (const outcome of ['accepted', 'rejected', 'error', 'terminal']) {
    const f = fixture(); cancellable(f);
    f.state.append(spawn('sidekick', 'fusion-sidekick'));
    f.state.tasks[0].status = outcome === 'terminal' ? 'completed' : 'running';
    f.state.tasks[0].result = 'x'.repeat(10000);
    f.session.rpc.tasks.cancel = async () => {
      if (outcome === 'terminal') assert.fail('terminal worker must not be cancelled');
      if (outcome === 'error') throw new Error('stop failed');
      return { cancelled: outcome === 'accepted' };
    };
    const result = (await (await installed(f)).cancel('root', 'task-sidekick')).target;
    assert.equal(result.requested, outcome !== 'terminal');
    assert.equal(result.confirmedStopped, outcome === 'terminal');
    assert.equal(result.outputTruncated, true);
    assert.ok(result.output.length < 10000);
    assert.match(result.progress.recentActivity[0].message, /partial/);
    if (outcome === 'error' || outcome === 'rejected') assert.ok(result.error);
  }
});

test('advisor live routes reject foreign ancestry and cancel fails closed on ambiguous targets or callers', async () => {
  for (const fault of ['ancestry', 'duplicate', 'missing', 'status', 'caller', 'journal']) {
    const f = fixture(); cancellable(f);
    f.state.append(spawn('advisor', 'fusion-advisor'));
    f.state.tasks.push({ type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' });
    f.state.subagents.agents['fusion-advisor'] = { model: 'user-choice', effortLevel: 'high', modelPolicy: 'required' };
    if (fault === 'ancestry') f.state.journal[1].data.parentId = 'foreign-parent';
    if (fault === 'duplicate') f.state.tasks.push({ ...f.state.tasks[1] });
    if (fault === 'missing') f.state.tasks[1].toolCallId = 'missing';
    if (fault === 'status') f.state.tasks[1].status = 'mystery';
    if (fault === 'journal') f.state.cursorStatus = 'lost';
    const h = await installed(f);
    if (fault === 'ancestry') for (const name of ['write_agent', 'read_agent']) {
      denies(await h.tool('root', name, { agent_id: 'advisor-task', message: 'progress?' }), /owner|parent/);
    }
    await assert.rejects(h.cancel('root', 'advisor-task', fault === 'caller' ? { agentId: 'unknown' } : {}), /verify|confirm|caller|status/i);
    assert.notEqual(f.state.tasks[1].status, 'cancelled');
  }
});

test('cancel reports failed and unverified descendants while stopping the parent', async () => {
  const f = fixture(); cancellable(f);
  f.state.append([...spawn('advisor', 'fusion-advisor'),
    ...spawn('evidence', 'fusion-sidekick', 'advisor', 'advisor-task'),
    ...spawn('unknown', 'foreign:worker', 'advisor', 'advisor-task'),
    ...spawn('untracked', 'fusion-sidekick', 'advisor', 'advisor-task')]);
  f.state.tasks = [
    { type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' },
    { type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'running' },
    { type: 'agent', id: 'unknown-task', agentType: 'foreign:worker', toolCallId: 'call-unknown', status: 'running' },
  ];
  const cancel = f.session.rpc.tasks.cancel;
  f.session.rpc.tasks.cancel = args => {
    if (args.id === 'evidence-task') throw new Error('evidence stop failed');
    return cancel(args);
  };
  const result = await (await installed(f)).cancel('root', 'advisor-task');
  assert.equal(result.target.confirmedStopped, true);
  assert.equal(result.descendants[0].requested, true);
  assert.equal(result.descendants[0].confirmedStopped, false);
  assert.match(result.descendants[0].error, /evidence stop failed/);
  assert.equal(result.descendants[1].requested, false);
  assert.match(result.descendants[1].error, /ownership/);
  assert.equal(f.state.tasks[2].status, 'running');
  assert.equal(result.descendants[2].runtime_agent_id, 'untracked');
  assert.equal(result.descendants[2].requested, false);
  assert.equal(result.descendants[2].confirmedStopped, false);
  assert.match(result.descendants[2].error, /tracked/);
});

test('cancel rejects invalid inputs and missing invocation evidence before touching a worker', async () => {
  const f = fixture(); cancellable(f);
  f.state.append(spawn('sidekick', 'fusion-sidekick'));
  f.state.tasks[0].status = 'running';
  let tool;
  await registerExtension(async options => { tool = options.tools.find(tool => tool.name === 'fusion_cancel'); return f.session; });
  for (const args of [null, [], {}, { agent_id: '' }, { agent_id: ' ' }, { agent_id: 'task-sidekick', model: 'other' }, { agent_ids: ['task-sidekick'] }]) {
    await assert.rejects(tool.handler(args, { sessionId: 'root' }), /one explicit agent_id/);
  }
  await assert.rejects(tool.handler({ agent_id: 'task-sidekick' }, { sessionId: 'root', toolCallId: 'missing' }), /caller identity/);
  assert.equal(f.state.tasks[0].status, 'running');
});

test('cancellation rejects in-flight old attachments and replays ownership on the new attachment', async () => {
  for (const sameRoot of [true, false]) {
    const first = fixture(); cancellable(first);
    first.state.append([...spawn('sidekick', 'fusion-sidekick'), event('tool.execution_start', null, { toolName: 'fusion_cancel', toolCallId: 'cancel' })]);
    first.state.tasks[0].status = 'running';
    let session = first.session;
    const roles = createRoleResolver(() => session); roles.subscribe(session);
    const hooks = createHooks(() => session, undefined, roles);
    const tool = createCancelTool(() => session, roles, hooks);
    let release;
    let entered;
    const checking = new Promise(resolve => { entered = resolve; });
    first.session.rpc.agent.getCurrent = async () => {
      entered();
      await new Promise(resolve => { release = resolve; });
      return { agent: packagedLead };
    };
    const pending = tool.handler({ agent_id: 'task-sidekick' }, { sessionId: 'root', toolCallId: 'cancel' });
    await checking;
    const next = fixture(); cancellable(next);
    if (!sameRoot) next.session.sessionId = 'next-root';
    session = next.session; roles.subscribe(session);
    release();
    await assert.rejects(pending, /verify|attached/i);
    assert.equal(first.state.tasks[0].status, 'running');
    await assert.rejects(tool.handler({ agent_id: 'task-sidekick' }, { sessionId: session.sessionId, toolCallId: 'cancel' }), /caller identity/);
    next.state.append([...spawn('sidekick', 'fusion-sidekick'), event('tool.execution_start', null, { toolName: 'fusion_cancel', toolCallId: 'new-cancel' })]);
    assert.equal((await tool.handler({ agent_id: 'task-sidekick' }, { sessionId: session.sessionId, toolCallId: 'new-cancel' })).target.confirmedStopped, true);
  }
});

test('installed 1.0.95 SDK dispatches registered cancellation with child attribution and task RPCs over an inert transport', async (t) => {
  const sdk = process.env.FUSION_COPILOT_SDK || join(homedir(), '.copilot/pkg/linux-x64/1.0.95/copilot-sdk/index.js');
  try { await access(sdk); } catch (error) {
    if (process.env.FUSION_COPILOT_SDK || error.code !== 'ENOENT') throw error;
    t.skip('Optional installed Copilot SDK unavailable.'); return;
  }
  const { CopilotSession } = await import(pathToFileURL(sdk).href);
  const f = fixture(); cancellable(f);
  f.state.append([...spawn('sidekick', 'fusion-sidekick'), ...spawn('advisor', 'fusion-advisor'),
    ...spawn('evidence', 'fusion-sidekick', 'advisor', 'advisor-task')]);
  f.state.tasks.push(
    { type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' },
    { type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'running' });
  const replies = new Map();
  const session = new CopilotSession('root', { sendRequest: async (method, params) => {
    assert.equal(params.sessionId, 'root');
    if (method === 'session.tools.handlePendingToolCall') { replies.set(params.requestId, params); return {}; }
    const handler = method.replace(/^session\./, '').split('.').reduce((value, key) => value?.[key], f.session.rpc);
    assert.equal(typeof handler, 'function', `Unexpected RPC ${method}`);
    return handler(params);
  } });
  await registerExtension(async options => { session.registerTools(options.tools); return session; });
  async function invoke(origin, id) {
    const toolCallId = `sdk-${replies.size}`;
    f.state.append([event('tool.execution_start', origin, { toolName: 'fusion_cancel', toolCallId })]);
    await session._executeToolAndRespond(toolCallId, 'fusion_cancel', toolCallId, { agent_id: id },
      session.getToolHandler('fusion_cancel'), undefined, undefined, origin);
    return replies.get(toolCallId);
  }
  assert.match((await invoke('sidekick', 'advisor-task')).error, /cannot delegate/);
  assert.match((await invoke('advisor', 'task-sidekick')).error, /own evidence/);
  const result = JSON.parse((await invoke('advisor', 'evidence-task')).result);
  assert.equal(result.target.confirmedStopped, true);
  assert.equal(f.state.tasks[1].status, 'running');
  assert.equal(f.state.tasks[2].status, 'cancelled');
});

test('verified coding sidekick runs Git and native web retrieval but cannot delegate', async () => {
  const f = fixture();
  f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
  const h = await installed(f);
  for (const command of ['git -C . status', 'function g(){ git status; }; g']) {
    assert.equal(await h.tool('sidekick', 'bash', { command }), undefined);
  }
  assert.equal(await h.tool('sidekick', 'write_bash', { shellId: 'session', input: 'git diff\n' }), undefined);
  assert.equal(await h.tool('sidekick', 'web_fetch', { url: 'https://example.invalid/source' }), undefined);
  denies(await h.tool('sidekick', 'task', { agent_type: 'fusion-utility', mode: 'background' }), /cannot delegate/);
  denies(await h.tool('sidekick', 'write_agent', { agent_id: 'task-sidekick' }), /cannot delegate/);
  denies(await h.tool('root', 'bash', { command: 'git status' }), /Fusion lead cannot run/);
  denies(await h.tool('root', 'web_fetch', { url: 'https://example.invalid/source' }), /sidekick/);
  assert.equal(await h.tool('sidekick', 'web_search', { query: 'official API docs' }), undefined);
  denies(await h.tool('root', 'web_search', { query: 'official API docs' }), /sidekick/);
  for (const name of ['github-mcp-server-web_search', 'github-mcp-server/web_search']) {
    assert.equal(await h.tool('sidekick', name, { query: 'official API docs' }), undefined);
    denies(await h.tool('root', name, { query: 'official API docs' }), /sidekick/);
  }
});

test('direct reviewer task without a command validates configuration and fresh background bounds', async () => {
  const f = fixture(); reviewReady(f);
  const h = await installed(f);
  const args = { agent_type: 'fusion-big-boss:fusion-reviewer', mode: 'background' };
  const launch = extra => h.tool('root', 'task', { ...args, ...extra });
  assert.equal(await launch(), undefined);
  for (const key of ['model', 'reasoning_effort', 'context_tier']) {
    denies(await launch({ [key]: 'override' }), /must omit model/);
  }
  denies(await launch({ agent_id: 'old-review' }), /fresh/);
  denies(await launch({ mode: 'sync' }), /background/);
});

test('reviewer delegation validates exact enabled model settings and fails closed on unavailable metadata', async () => {
  for (const failure of ['missing', 'disabled', 'foreign-key', 'preferred', 'effort', 'context', 'unavailable-model', 'metadata', 'catalog', 'identity']) {
    const f = fixture(); reviewReady(f);
    const key = 'fusion-big-boss:fusion-reviewer';
    const entry = f.state.subagents.agents[key];
    const catalog = f.session.rpc.model.list;
    const h = await installed(f);
    if (failure === 'missing') delete f.state.subagents.agents[key];
    if (failure === 'disabled') f.state.subagents.disabledSubagents.push(key);
    if (failure === 'foreign-key') { f.state.subagents.agents['fusion-reviewer'] = entry; delete f.state.subagents.agents[key]; }
    if (failure === 'preferred') entry.modelPolicy = 'preferred';
    if (failure === 'effort') entry.effortLevel = 'inherit';
    if (failure === 'context') entry.contextTier = 'long_context';
    if (failure === 'unavailable-model') entry.model = 'missing';
    if (failure === 'metadata') f.state.settingsFailure = true;
    if (failure === 'catalog') f.session.rpc.model.list = async () => { throw new Error('unavailable'); };
    if (failure === 'identity') f.state.agentFailure = true;
    const launch = () => h.tool('root', 'task', { agent_type: key, mode: 'background' });
    denies(await launch(), /verify|confirm|disabled|effort|unavailable/i);
    f.state.settingsFailure = false; f.state.agentFailure = false;
    f.session.rpc.model.list = catalog;
    f.state.subagents.disabledSubagents = [];
    reviewReady(f);
    assert.equal(await launch(), undefined, failure);
  }
});

test('owned reviewer accepts steering and continuation with one target, supported status and no overrides', async () => {
  const f = fixture(); reviewReady(f);
  const task = { type: 'agent', id: 'review-task', agentType: 'fusion-big-boss:fusion-reviewer', toolCallId: 'call-reviewer', status: 'idle' };
  f.state.tasks.push(task);
  f.state.append(spawn('reviewer', task.agentType));
  const other = { ...task, id: 'other-review-task', toolCallId: 'call-other-reviewer' };
  f.state.tasks.push(other); f.state.append(spawn('other-reviewer', task.agentType));
  const h = await installed(f);
  const write = (id = task.id, extra = {}) => h.tool('root', 'write_agent', { agent_id: id, message: 'more evidence', ...extra });
  assert.equal(await h.tool('root', 'read_agent', { agent_id: task.id }), undefined);
  assert.equal(await write(), undefined);
  assert.equal(await write(other.id), undefined);
  denies(await h.tool('root', 'write_agent', { agent_ids: [task.id, 'task-sidekick'], message: 'more evidence' }), /one explicit agent_id/);
  denies(await h.tool('root', 'write_agent', { agent_ids: [task.id], message: 'more evidence' }), /one explicit agent_id/);
  for (const key of ['model', 'reasoning_effort', 'context_tier']) denies(await write(task.id, { [key]: 'override' }), /must omit model/);
  task.status = 'running';
  assert.equal(await write(), undefined);
  assert.equal(await h.tool('root', 'read_agent', { agent_id: task.id }), undefined);
  task.status = 'mystery'; denies(await write(), /status/);
  task.status = 'idle';
  assert.equal(await write(), undefined);
  for (const status of ['completed', 'failed', 'cancelled']) {
    task.status = status;
    denies(await write(), /terminal|running or idle/);
  }
});

test('non-Fusion roots and descendants retain ordinary native delegation, group writes and passive reads', async () => {
  const f = fixture(null);
  f.state.append(spawn('ordinary-worker', 'build'));
  f.state.tasks.push(
    { type: 'agent', id: 'review-loose', agentType: 'fusion-reviewer', status: 'idle' },
    { type: 'agent', id: 'review-packaged', agentType: 'fusion-big-boss:fusion-reviewer', status: 'idle' },
    { type: 'agent', id: 'other-task', agentType: 'build', status: 'idle' });
  const h = await installed(f);
  for (const agent of [null, { id: 'build', name: 'build', source: 'user' }]) {
    f.state.agent = agent;
    for (const caller of ['root', 'ordinary-worker']) {
      for (const task of f.state.tasks.filter(task => task.id.startsWith('review-'))) {
        assert.equal(await h.tool(caller, 'task', { agent_type: task.agentType, mode: 'background' }), undefined);
        assert.equal(await h.tool(caller, 'write_agent', { agent_id: task.id, message: 'Review again' }), undefined);
        assert.equal(await h.tool(caller, 'write_agent', { agent_ids: ['other-task', task.id], message: 'Review again' }), undefined);
        assert.equal(await h.tool(caller, 'read_agent', { agent_id: task.id }), undefined);
      }
      for (const scope of ['children', 'siblings', 'all']) {
        assert.equal(await h.tool(caller, 'write_agent', { scope, message: 'Continue' }), undefined);
      }
      assert.equal(await h.tool(caller, 'write_agent', { agent_id: 'other-task', message: 'Continue coding' }), undefined);
      assert.equal(await h.tool(caller, 'write_agent', { agent_ids: ['other-task', 'task-sidekick'], message: 'Continue coding' }), undefined);
      assert.equal(await h.tool(caller, 'task', { agent_type: 'build', mode: 'sync' }), undefined);
      assert.equal(await h.tool(caller, 'task', { agent_type: 'foreign:fusion-reviewer', mode: 'background' }), undefined);
      assert.equal(await h.tool(caller, 'bash', { command: 'npm test' }), undefined);
      assert.equal(await h.tool(caller, 'edit', { path: leadPath }), undefined);
    }
  }
});

test('default native group writes pass through without a task catalog; unknown root identity still fails closed', async () => {
  const f = fixture(null);
  const h = await installed(f);
  const tool = (name, args) => h.tool('root', name, args);
  for (const catalog of [undefined, async () => ({ tasks: undefined }), async () => { throw new Error('registry unavailable'); }]) {
    f.session.rpc.tasks = catalog ? { list: catalog } : undefined;
    for (const scope of ['children', 'siblings']) {
      assert.equal(await tool('write_agent', { scope, message: 'Continue' }), undefined);
    }
    assert.equal(await tool('write_agent', { agent_id: 'ordinary-task', message: 'Continue' }), undefined);
  }
  assert.equal(await tool('read_agent', { agent_id: 'reviewer-task' }), undefined);
  assert.equal(await tool('task', { agent_type: 'build', mode: 'background' }), undefined);
  assert.equal(await tool('bash', { command: 'npm test' }), undefined);
  f.state.agentFailure = true;
  for (const name of ['task', 'write_agent']) {
    denies(await tool(name, { agent_type: 'fusion-reviewer', agent_id: 'reviewer-task' }), /Cannot verify.*selected agent/);
  }
});

test('reviewer follow-ups reject unknown, foreign, duplicate or unowned targets and unavailable evidence', async () => {
  for (const failure of ['unknown', 'foreign', 'duplicate', 'status', 'ancestry', 'journal', 'task-outage']) {
    const f = fixture(); reviewReady(f);
    const task = { type: 'agent', id: 'review-task', agentType: 'fusion-big-boss:fusion-reviewer', toolCallId: 'call-reviewer', status: 'idle' };
    f.state.tasks.push(task); f.state.append(spawn('reviewer', task.agentType));
    if (failure === 'foreign') task.agentType = 'foreign:fusion-reviewer';
    if (failure === 'duplicate') f.state.tasks.push({ ...task });
    if (failure === 'status') delete task.status;
    if (failure === 'ancestry') f.state.journal[1].data.parentId = 'foreign-parent';
    if (failure === 'journal') f.state.cursorStatus = 'lost';
    if (failure === 'task-outage') f.session.rpc.tasks.list = async () => { throw new Error('unavailable'); };
    const h = await installed(f);
    denies(await h.tool('root', 'write_agent', { agent_id: failure === 'unknown' ? 'unknown-task' : task.id }), /confirm|verify|metadata|running/i);
  }
});

test('verified reviewer tools enforce read-only inspection and native skills, including ordinary tools descendants previously bypassed', async () => {
  const f = fixture();
  f.state.append(spawn('reviewer', 'fusion-big-boss:fusion-reviewer'));
  f.state.append(spawn('sidekick', 'fusion-sidekick'));
  const h = await installed(f);
  assert.equal(await h.tool('reviewer', 'view', { path: leadPath, view_range: [1, 350] }), undefined);
  assert.equal(await h.tool('reviewer', 'skill', { skill: 'code-review-and-quality' }), undefined);
  for (const tool of ['bash', 'write_bash', 'read_bash', 'powershell', 'local_shell', 'grep', 'glob', 'rg', 'web_fetch', 'web_search', 'edit', 'create', 'apply_patch', 'list_agents', 'manage_agents', 'sql', 'ask_user']) {
    denies(await h.tool('reviewer', tool, { command: 'npm test', agent_id: 'task-sidekick' }), /read-only/, tool);
  }
  for (const range of [undefined, [0, 2], [1, 351], [1, -1], [1, Infinity]]) {
    denies(await h.tool('reviewer', 'view', { path: leadPath, view_range: range }), /finite/);
  }
  assert.equal(await h.tool('sidekick', 'bash', { command: 'npm test' }), undefined);
  assert.equal(await h.tool('sidekick', 'edit', { path: leadPath }), undefined);
  f.state.agentFailure = true;
  assert.equal(await h.tool('sidekick', 'bash', { command: 'npm test' }), undefined);
  denies(await h.tool('reviewer', 'view', { path: leadPath, view_range: [1, 20] }), /Cannot verify/);
  denies(await h.tool('reviewer', 'edit', { path: leadPath }), /Cannot verify/);
  f.state.agentFailure = false;
  f.state.agent = { id: 'build', name: 'build', source: 'user' };
  denies(await h.tool('reviewer', 'bash', { command: 'npm test' }), /read-only/);
  assert.equal(await h.tool('reviewer', 'view', { path: leadPath, view_range: [1, 20] }), undefined);
  assert.equal(await h.tool('root', 'bash', { command: 'npm test' }), undefined);
  f.state.agent = packagedLead;
  f.state.append([event('subagent.started', 'reviewer', { agentName: 'fusion-sidekick', agentType: 'fusion-sidekick', toolCallId: 'call-reviewer', executionMode: 'background' })], true);
  f.state.cursorStatus = 'lost';
  denies(await h.tool('reviewer', 'bash', { command: 'npm test' }), /Cannot verify.*reviewer/);
  denies(await h.tool('reviewer', 'skill', { skill: 'code-review-and-quality' }), /Cannot verify.*reviewer/);
});

test('a missed reviewer start with unavailable replay cannot bypass view bounds', async () => {
  const f = fixture();
  const replay = f.session.rpc.eventLog.read;
  f.session.rpc.eventLog.read = async () => { throw new Error('journal unavailable'); };
  const roles = createRoleResolver(() => f.session);
  roles.subscribe(f.session);
  const hooks = createHooks(() => f.session, inspectTextTarget, roles);
  const tool = (toolName, toolArgs, sessionId = 'reviewer') => hooks.onPreToolUse({ sessionId, toolName, toolArgs }, { sessionId: 'root' });
  for (const args of [{ path: leadPath }, { path: leadPath, view_range: [1, 100000] }, { path: '/packet.png', view_range: [1, 10] }]) {
    denies(await tool('view', args), /Cannot verify/);
  }
  for (const toolName of ['skill', 'edit', 'bash']) denies(await tool(toolName, { skill: 'code-review-and-quality', command: 'npm test' }), /Cannot verify/);
  f.state.agentFailure = true;
  denies(await tool('view', { path: leadPath, view_range: [1, 10] }), /Cannot verify/);
  f.state.agentFailure = false;
  f.state.agent = null;
  assert.equal(await tool('view', { path: leadPath }), undefined);
  assert.equal(await tool('edit', { path: leadPath }), undefined);
  f.state.agent = packagedLead;
  f.session.rpc.eventLog.read = replay;
  f.state.append([...spawn('reviewer', 'fusion-big-boss:fusion-reviewer'), ...spawn('sidekick', 'fusion-sidekick')]);
  assert.equal(await tool('view', { path: leadPath, view_range: [1, 10] }), undefined);
  assert.equal(await tool('skill', { skill: 'code-review-and-quality' }), undefined);
  denies(await tool('view', { path: leadPath, view_range: [1, 100000] }), /finite/);
  for (const toolName of ['edit', 'bash']) denies(await tool(toolName, { command: 'npm test', agent_id: 'task-sidekick' }), /read-only/);
  assert.equal(await tool('view', { path: leadPath }, 'sidekick'), undefined);
  assert.equal(await tool('bash', { command: 'npm test' }, 'sidekick'), undefined);
  assert.equal(await tool('edit', { path: leadPath }, 'sidekick'), undefined);
});

for (const caller of ['reviewer', 'advisor']) test(`${caller} delegates only to its own evidence sidekicks with no source-editing tools`, async () => {
  const f = fixture(); reviewReady(f);
  if (caller === 'advisor') advisorReady(f);
  f.state.append([...spawn('sidekick', 'fusion-sidekick'), ...spawn(caller, `fusion-big-boss:fusion-${caller}`)]);
  f.state.tasks.push({ type: 'agent', id: 'review-task', agentType: `fusion-big-boss:fusion-${caller}`, toolCallId: `call-${caller}`, status: 'running' });
  const h = await installed(f);
  assert.equal(await h.tool(caller, 'task', { agent_type: 'fusion-sidekick', mode: 'background', prompt: 'Find parseModel in ai.opencode/index.ts; locations only' }), undefined);
  f.state.append(spawn('evidence', 'fusion-sidekick', caller, 'review-task'), true);
  f.state.tasks.push({ type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'idle' });
  assert.equal(await h.tool(caller, 'write_agent', { agent_id: 'evidence-task', message: 'Run git diff -- ai.opencode/index.ts' }), undefined);
  assert.equal(await h.tool(caller, 'read_agent', { agent_id: 'evidence-task' }), undefined);
  denies(await h.tool(caller, 'write_agent', { agent_id: 'task-sidekick' }), /owner|own/);
  denies(await h.tool('root', 'write_agent', { agent_id: 'evidence-task' }), /own|borrow/);
  denies(await h.tool(caller, 'task', { agent_type: 'fusion-advisor', mode: 'background' }), /read-only/);
  const another = await h.tool(caller, 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  if (caller === 'reviewer') denies(another, /persistent sidekick/);
  else assert.equal(another, undefined);
  f.state.tasks.at(-1).status = 'running';
  assert.equal(await h.tool(caller, 'write_agent', { agent_id: 'evidence-task', message: 'Wrap up with evidence and blockers' }), undefined);
  assert.equal(await h.tool(caller, 'read_agent', { agent_id: 'evidence-task' }), undefined);
  assert.equal(await h.tool('evidence', 'bash', { command: 'git diff -- ai.opencode/index.ts' }), undefined);
  assert.equal(await h.tool('evidence', 'grep', { pattern: 'parseModel', path: 'ai.opencode/index.ts' }), undefined);
  for (const tool of ['edit', 'create', 'apply_patch', 'task', 'write_agent', 'web_fetch', 'sql']) {
    denies(await h.tool('evidence', tool, { command: 'npm test' }), /evidence/);
  }
  assert.equal(await h.tool('sidekick', 'edit', { path: leadPath }), undefined);
  f.state.cursorStatus = 'lost';
  denies(await h.tool('evidence', 'edit', { path: leadPath }), /Cannot verify/);
  f.state.agent = { id: 'build', name: 'build', source: 'user' };
  denies(await h.tool('evidence', 'edit', { path: leadPath }), /Cannot verify/);
});

test('direct reviewer delegation uses only the current attachment after same-root or new-root reconnect', async () => {
  for (const sameRoot of [true, false]) {
    const first = fixture(); reviewReady(first);
    let session = first.session;
    const roles = createRoleResolver(() => session);
    roles.subscribe(session);
    const hooks = createHooks(() => session, undefined, roles);
    await hooks.onPreToolUse({ sessionId: 'root', toolName: 'bash', toolArgs: { command: 'npm test' } }, { sessionId: 'root' });
    const next = fixture(); reviewReady(next);
    if (!sameRoot) next.session.sessionId = 'next-root';
    session = next.session; roles.subscribe(session);
    const launch = (root = session.sessionId) => hooks.onPreToolUse({ sessionId: root, toolName: 'task', toolArgs: {
      agent_type: 'fusion-big-boss:fusion-reviewer', mode: 'background',
    } }, { sessionId: root });
    if (!sameRoot) denies(await launch('root'), /no longer attached/);
    assert.equal(await launch(), undefined);
  }
});

for (const caller of ['root', 'reviewer', 'advisor']) test(`${caller} delegation waiting on native settings cannot pass after attachment replacement`, async () => {
  const first = fixture(); reviewReady(first);
  reviewReady(first, 'fusion-reviewer'); advisorReady(first, 'fusion-advisor');
  first.state.tasks = [];
  if (caller !== 'root') first.state.append(spawn(caller, `fusion-${caller}`));
  let session = first.session;
  const roles = createRoleResolver(() => session);
  roles.subscribe(session);
  const hooks = createHooks(() => session, undefined, roles);
  let release;
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const settings = first.session.connection.sendRequest;
  first.session.connection.sendRequest = async (...args) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return settings(...args);
  };
  const launch = () => hooks.onPreToolUse({ sessionId: caller, toolName: 'task', toolArgs: {
    agent_type: caller === 'root' ? 'fusion-big-boss:fusion-reviewer' : 'fusion-sidekick', mode: 'background',
  } }, { sessionId: 'root' });
  const stale = launch();
  await checking;
  const next = fixture(); reviewReady(next);
  reviewReady(next, 'fusion-reviewer'); advisorReady(next, 'fusion-advisor');
  next.state.tasks = [];
  if (caller !== 'root') {
    next.state.append(spawn(caller, `fusion-${caller}`));
    next.state.tasks.push({ type: 'agent', id: 'caller-task', agentType: `fusion-${caller}`, toolCallId: `call-${caller}`, status: 'running' });
  }
  session = next.session; roles.subscribe(session);
  release();
  denies(await stale, /no longer attached/);
  assert.equal(await launch(), undefined);
});

test('old in-flight root identity replies cannot change current attachment tool routing', async () => {
  for (const prompt of [false, true]) {
    const first = fixture(null);
    let session = first.session;
    const roles = createRoleResolver(() => session);
    roles.subscribe(session);
    const hooks = createHooks(() => session, undefined, roles);
    let release;
    let entered;
    const checking = new Promise(resolve => { entered = resolve; });
    first.session.rpc.agent.getCurrent = async () => {
      entered();
      await new Promise(resolve => { release = resolve; });
      return { agent: null };
    };
    const stale = prompt
      ? hooks.onUserPromptSubmitted({ sessionId: 'root' }, { sessionId: 'root' })
      : hooks.onPreToolUse({ sessionId: 'root', toolName: 'bash', toolArgs: { command: 'npm test' } }, { sessionId: 'root' });
    await checking;
    const next = fixture(); reviewReady(next); session = next.session; roles.subscribe(session);
    denies(await hooks.onPreToolUse({ sessionId: 'root', toolName: 'bash', toolArgs: { command: 'npm test' } }, { sessionId: 'root' }), /Fusion lead cannot run/);
    release();
    if (prompt) assert.equal(await stale, undefined);
    else denies(await stale, /Cannot verify/);
    assert.equal(await hooks.onPreToolUse({ sessionId: 'root', toolName: 'task', toolArgs: {
      agent_type: 'fusion-big-boss:fusion-reviewer', mode: 'background',
    } }, { sessionId: 'root' }), undefined);
  }
});

test('Agent Plugins 1.0 manifest and Copilot directory layout expose the remaining profiles', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'fusion-big-boss');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(Object.hasOwn(manifest, 'agents'), false);
  assert.equal(Object.hasOwn(manifest, 'extensions'), false);
  const rootEntries = await readdir(new URL('../', import.meta.url));
  assert.equal(rootEntries.includes('agents'), false);
  assert.equal(rootEntries.includes('extensions'), false);
  const names = ['fusion', 'fusion-sidekick', 'fusion-advisor', 'fusion-reviewer'];
  const agentsDir = new URL('../com.github.copilot/agents/', import.meta.url);
  assert.deepEqual((await readdir(agentsDir)).sort(), names.map((name) => `${name}.agent.md`).sort());
  for (const name of names) {
    const profile = await readFile(new URL(`${name}.agent.md`, agentsDir), 'utf8');
    assert.match(profile, new RegExp(`^---\\nname: ${name}\\n`));
    assert.doesNotMatch(profile, /^model:|^reasoning-effort:/m);
  }
});

test('packaged identity requires plugin source, exact profile path, and name; loose user profile still works', () => {
  assert.equal(fusionAgentIdentity(packagedLead), 'fusion');
  assert.equal(fusionAgentIdentity({ ...packagedLead, name: 'fusion' }), 'fusion');
  assert.equal(fusionAgentIdentity(looseLead), 'fusion');
  assert.equal(fusionAgentIdentity({ ...packagedLead, id: '' }), 'unverified');
  assert.equal(fusionAgentIdentity({ ...packagedLead, id: 'fusion', path: foreignPath }), 'unrelated');
  assert.equal(fusionAgentIdentity({ ...packagedLead, name: 'foreign-plugin:fusion' }), 'unverified');
  assert.equal(fusionAgentIdentity({ ...packagedLead, path: undefined }), 'unverified');
  assert.equal(fusionAgentIdentity({ ...packagedLead, name: 'other' }), 'unverified');
  assert.equal(fusionAgentIdentity(null), 'unrelated');
  assert.equal(fusionAgentIdentity(undefined), 'unverified');
  assert.equal(fusionAgentIdentity({}), 'unverified');
  assert.equal(fusionAgentIdentity({ source: 'user' }), 'unverified');
});

test('packaged lead activates guard, role-aware child routing, and advisor prompt status', async () => {
  const f = fixture();
  f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
  const h = await installed(f);
  denies(await h.tool('root', 'bash', { command: 'npm test' }), /Fusion lead cannot run/);
  denies(await h.tool('root', 'grep', { pattern: 'text' }), /Fusion lead cannot search/);
  denies(await h.tool('root', 'web_fetch', { url: 'https://example.invalid' }), /sidekick/);
  denies(await h.tool('root', 'web_search', { query: 'anything' }), /sidekick/);
  assert.equal(await h.tool('sidekick', 'bash', { command: 'npm test' }), undefined);
  assert.equal(await h.tool('sidekick', 'web_search', { query: 'anything' }), undefined);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background', model: 'override' }), /must omit model/);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), /disabled in \/subagents/);
  const notice = await h.prompt('root');
  assert.deepEqual(Object.keys(notice), ['additionalContext']);
  assert.match(notice.additionalContext, /advisor: disabled/);
  assert.doesNotMatch(notice.additionalContext, /private user question/);
  assert.equal(await h.prompt('sidekick'), undefined);
});

test('loose user Fusion supports 350-line root views while delegation bounds stay unchanged', async () => {
  const f = fixture(looseLead);
  f.state.subagents.disabledSubagents = ['fusion-advisor'];
  f.state.tasks[0].agentType = 'fusion-sidekick';
  f.state.append(spawn('sidekick', 'fusion-sidekick'));
  const h = await installed(f);
  denies(await h.tool('root', 'bash', { command: 'npm test' }), /Fusion lead cannot run/);
  denies(await h.tool('root', 'view', { path: leadPath, view_range: [25, 375] }), /finite/);
  assert.equal(await h.tool('root', 'view', { path: leadPath, view_range: [1, 201] }), undefined);
  assert.equal(await h.tool('root', 'view', { path: leadPath, view_range: [25, 374] }), undefined);
  assert.equal(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick' }), undefined);
  denies(await h.tool('root', 'write_agent', { agent_id: 'unknown-task' }), /Cannot confirm/);
  denies(await h.tool('sidekick', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /cannot delegate/);
  denies(await h.tool('sidekick', 'write_agent', { agent_id: 'task-sidekick' }), /cannot delegate/);
});

test('lead view inspects real files rather than trusting the requested path or extension', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-guard-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = join(dir, 'code.txt');
  const image = join(dir, 'image.png');
  const binary = join(dir, 'binary.dat');
  const folder = join(dir, 'folder');
  await writeFile(text, 'hello\nworld\n');
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  await writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));
  await mkdir(folder);
  const f = fixture();
  const hooks = createHooks(() => f.session);
  const view = (path) => hooks.onPreToolUse({ sessionId: 'root', toolName: 'view',
    toolArgs: { path, view_range: [1, 2] } }, { sessionId: 'root' });
  assert.equal(await view(text), undefined);
  for (const path of [image, binary, folder, join(dir, 'missing')]) {
    denies(await view(path), /readable regular text file/);
  }
  f.state.append(spawn('reviewer', 'fusion-reviewer'));
  const roles = createRoleResolver(() => f.session);
  roles.subscribe(f.session);
  const reviewerHooks = createHooks(() => f.session, inspectTextTarget, roles);
  const reviewerView = path => reviewerHooks.onPreToolUse({ sessionId: 'reviewer', toolName: 'view',
    toolArgs: { path, view_range: [1, 2] } }, { sessionId: 'root' });
  assert.equal(await reviewerView(text), undefined);
  for (const path of [image, binary, folder, join(dir, 'missing')]) denies(await reviewerView(path), /readable regular text file/);
  assert.deepEqual(await inspectTextTarget(text, { stat, open: async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  } }), { kind: 'unreadable' });
});

test('lead can launch independent sidekicks with fresh background calls', async () => {
  const f = fixture(); f.state.append(spawn('sidekick', 'fusion-sidekick'));
  const h = await installed(f);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), undefined);
  for (const args of [
    { agent_type: 'fusion-sidekick', mode: 'sync' },
    { agent_type: 'fusion-sidekick', mode: 'background', agent_id: 'previous' },
    { agent_type: 'fusion-advisor', mode: 'background', sessionID: 'previous' },
    { agent_type: 'fusion-utility', mode: 'background' },
  ]) denies(await h.tool('root', 'task', args), /fresh|background/);
  for (const override of ['model', 'reasoning_effort', 'context_tier']) {
    denies(await h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background', [override]: 'override' }), /must omit model/);
  }
});

test('lead can launch sidekicks alongside verified workers in any known status', async () => {
  for (const status of ['running', 'idle', 'completed', 'failed', 'cancelled']) {
    const f = fixture(); f.state.tasks[0].status = status;
    f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
    const h = await installed(f);
    const decision = await h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
    assert.equal(decision, undefined, status);
  }
});

for (const caller of ['root', 'advisor']) test(`${caller} admits independent sidekicks and messages only owned workers`, async () => {
  const f = fixture(); f.state.append(spawn('sidekick', 'fusion-sidekick'));
  if (caller === 'advisor') {
    advisorReady(f);
    f.state.append(spawn('advisor', 'fusion-big-boss:fusion-advisor'));
    f.state.tasks.push({ type: 'agent', id: 'advisor-task', agentType: 'fusion-big-boss:fusion-advisor', toolCallId: 'call-advisor', status: 'running' });
  }
  const h = await installed(f);
  const launch = () => h.tool(caller, 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  for (const decision of await Promise.all([launch(), launch()])) assert.equal(decision, undefined);
  for (const id of ['first', 'second']) {
    f.state.append(spawn(id, 'fusion-sidekick', caller === 'root' ? null : caller, caller === 'root' ? undefined : 'advisor-task'), true);
    f.state.tasks.push({ type: 'agent', id: `${id}-task`, agentType: 'fusion-sidekick', toolCallId: `call-${id}`, status: 'idle' });
  }
  for (const id of ['first-task', 'second-task']) {
    assert.equal(await h.tool(caller, 'write_agent', { agent_id: id, message: 'Run git status --short' }), undefined);
    assert.equal(await h.tool(caller, 'read_agent', { agent_id: id }), undefined);
  }
  f.state.tasks.at(-1).status = 'running';
  assert.equal(await h.tool(caller, 'write_agent', { agent_id: 'second-task', message: 'Report current findings' }), undefined);
  assert.equal(await h.tool(caller, 'read_agent', { agent_id: 'second-task' }), undefined);
  assert.equal(await h.tool(caller, 'write_agent', { agent_id: 'first-task' }), undefined);
  if (caller === 'advisor') {
    denies(await h.tool(caller, 'write_agent', { agent_id: 'task-sidekick' }), /owner|own/);
    denies(await h.tool('root', 'write_agent', { agent_id: 'first-task' }), /own|borrow/);
  } else {
    f.state.append(spawn('foreign', 'foreign:fusion-sidekick'), true);
    f.state.tasks.push({ type: 'agent', id: 'foreign-task', agentType: 'foreign:fusion-sidekick', toolCallId: 'call-foreign', status: 'idle' });
    denies(await h.tool(caller, 'write_agent', { agent_id: 'foreign-task' }), /Cannot confirm/);
  }
});

test('reviewer sidekick launch is reserved until start evidence or tool outcome', async () => {
  const f = fixture(); reviewReady(f);
  f.state.tasks = [{ type: 'agent', id: 'review-task', agentType: 'fusion-big-boss:fusion-reviewer', toolCallId: 'call-reviewer', status: 'running' }];
  f.state.append(spawn('reviewer', 'fusion-big-boss:fusion-reviewer'));
  const h = await installed(f);
  const launch = () => h.tool('reviewer', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  const decisions = await Promise.all([launch(), launch()]);
  assert.equal(decisions.filter(decision => decision === undefined).length, 1);
  denies(decisions.find(decision => decision !== undefined), /pending|starting/i);
  await h.result(true, 'reviewer');
  assert.equal(await launch(), undefined);
  await h.result(false, 'reviewer'); // A tool result without start evidence must not lock out a retry.
  assert.equal(await launch(), undefined);
  f.state.tasks.push({ type: 'agent', id: 'new-sidekick', agentType: 'fusion-sidekick',
    toolCallId: 'call-new', status: 'idle' });
  f.state.append(spawn('new', 'fusion-sidekick', 'reviewer', 'review-task'), true);
  denies(await launch(), /write_agent.*new-sidekick/);
  f.state.tasks.at(-1).status = 'failed';
  assert.equal(await launch(), undefined);
});

test('fresh sidekick fails closed on unavailable status or unverified ownership and can recover', async () => {
  const f = fixture(); const h = await installed(f);
  const launch = () => h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  denies(await launch(), /Cannot verify|Cannot confirm/);
  f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
  delete f.state.tasks[0].status;
  denies(await launch(), /status.*retry|status.*Retry/);
  f.state.tasks = [];
  f.session.rpc.tasks.list = async () => { throw new Error('unavailable'); };
  denies(await launch(), /metadata.*retry|metadata.*Retry/);
  f.session.rpc.tasks.list = async () => ({ tasks: f.state.tasks });
  assert.equal(await launch(), undefined);
});

test('fresh sidekick delegation requires enabled required model and explicit effort', async () => {
  const name = 'fusion-sidekick';
  for (const invalid of ['missing', 'disabled', 'preferred', 'inherit', 'unknown']) {
    const f = fixture();
    f.state.tasks = [];
    const entry = f.state.subagents.agents[name];
    if (invalid === 'missing') delete f.state.subagents.agents[name];
    if (invalid === 'disabled') f.state.subagents.disabledSubagents.push(name);
    if (invalid === 'preferred') entry.modelPolicy = 'preferred';
    if (invalid === 'inherit') entry.effortLevel = 'inherit';
    if (invalid === 'unknown') f.state.settingsFailure = true;
    const h = await installed(f);
    denies(await h.tool('root', 'task', { agent_type: name, mode: 'background' }), /model.*effort.*Model enforcement: required.*\/subagents/i);
    f.state.settingsFailure = false;
    f.state.subagents.disabledSubagents = [];
    f.state.subagents.agents[name] = { model: 'user-choice', effortLevel: 'high', modelPolicy: 'required' };
    assert.equal(await h.tool('root', 'task', { agent_type: name, mode: 'background' }), undefined, invalid);
  }
});

test('workers without explicit effort require a confirmed no-effort model', async () => {
  for (const name of ['fusion-sidekick', 'fusion-advisor']) {
    for (const effortLevel of [undefined, 'default']) {
      const f = fixture(); f.state.tasks = [];
      f.state.subagents.agents[name] = { model: 'selected', modelPolicy: 'required',
        ...(effortLevel === undefined ? {} : { effortLevel }) };
      let model = { id: 'selected', supportedReasoningEfforts: ['high'] };
      f.session.rpc.model = { list: async () => ({ list: model ? [model] : [] }) };
      const h = await installed(f);
      const launch = () => h.tool('root', 'task', { agent_type: name, mode: 'background' });
      denies(await launch(), /explicit.*effort/i);
      model = undefined;
      denies(await launch(), /not confirmed|Cannot verify/);
      model = { id: 'selected' };
      assert.equal(await launch(), undefined);
    }
  }
});

test('worker settings use the exact requested namespaced key', async () => {
  const f = fixture(); f.state.tasks = [];
  delete f.state.subagents.agents['fusion-big-boss:fusion-sidekick'];
  const h = await installed(f);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-sidekick', mode: 'background' }), /Cannot confirm/);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), undefined);
});

test('independent sidekick launch requires unique same-root task and start correlation', async () => {
  const f = fixture();
  f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
  const h = await installed(f);
  const launch = () => h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  assert.equal(await launch(), undefined);
  f.state.tasks.push({ ...f.state.tasks[0] });
  denies(await launch(), /Cannot verify.*owner\/parent/);
  denies(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick' }), /Cannot confirm/);
  f.state.tasks.pop();
  f.state.tasks[0].toolCallId = 'missing-call';
  denies(await launch(), /Cannot verify.*owner\/parent/);
});

test('independent sidekick check replays a missed start and fails closed if evidence is unavailable', async () => {
  const f = fixture();
  const h = await installed(f);
  const launch = () => h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  denies(await launch(), /owner|parent/i);
  f.state.append(spawn('sidekick', 'fusion-sidekick')); // no live event notification
  assert.equal(await launch(), undefined);
  f.state.cursorStatus = 'lost';
  f.state.tasks[0].toolCallId = 'unknown';
  denies(await launch(), /owner|parent/i);
});

test('running workers admit steering and remain readable without waiting for completion', async () => {
  for (const name of ['fusion-sidekick', 'fusion-advisor']) {
    const f = fixture();
    f.state.subagents.agents['fusion-advisor'] = { model: 'user-choice', effortLevel: 'high', modelPolicy: 'required' };
    f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
    const task = { type: 'agent', id: 'target', agentType: name, toolCallId: 'call-target', status: 'running' };
    f.state.tasks.push(task);
    f.state.append(spawn('target', name));
    const h = await installed(f);
    assert.equal(await h.tool('root', 'write_agent', { agent_id: 'target', message: 'Wrap up with findings and unfinished work' }), undefined);
    assert.equal(await h.tool('root', 'read_agent', { agent_id: 'target' }), undefined);
    task.status = 'idle';
    assert.equal(await h.tool('root', 'write_agent', { agent_id: 'target' }), undefined);
    for (const status of ['completed', 'failed', 'cancelled']) {
      task.status = status;
      denies(await h.tool('root', 'write_agent', { agent_id: 'target' }), /terminal|running or idle/);
    }
    for (const status of [undefined, 'unknown']) {
      task.status = status;
      denies(await h.tool('root', 'write_agent', { agent_id: 'target' }), /status.*Retry/);
      assert.equal(await h.tool('root', 'read_agent', { agent_id: 'target' }), undefined);
    }
  }
});

test('steering rejects sidekick callers and multi-target messages', async () => {
  const f = fixture(); f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
  f.state.tasks.push({ type: 'agent', id: 'advisor', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' });
  f.state.append(spawn('advisor', 'fusion-advisor'));
  const h = await installed(f);
  denies(await h.tool('sidekick', 'write_agent', { agent_id: 'advisor' }), /cannot delegate/);
  denies(await h.tool('root', 'write_agent', { agent_ids: ['task-sidekick', 'advisor'] }), /one explicit agent_id/);
  assert.equal(await h.tool('root', 'read_agent', { agent_ids: ['task-sidekick', 'advisor'] }), undefined);
  f.session.rpc.tasks.list = async () => { throw new Error('unavailable'); };
  denies(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick' }), /metadata.*Retry/);
});

test('foreign and obsolete role names cannot inherit verified sidekick permissions', async () => {
  const f = fixture();
  f.state.tasks = [{ type: 'agent', id: 'task-sidekick',
    agentType: 'fusion-big-boss:fusion-sidekick', toolCallId: 'call-sidekick', status: 'idle' },
  { type: 'agent', id: 'task-foreign', agentType: 'foreign:fusion-sidekick', toolCallId: 'call-foreign' }];
  f.state.append([...spawn('sidekick', 'fusion-big-boss:fusion-sidekick'),
    ...spawn('nested-utility', 'fusion-big-boss:fusion-utility', 'sidekick', 'task-sidekick'),
    ...spawn('foreign', 'foreign:fusion-sidekick')]);
  const h = await installed(f);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-sidekick', mode: 'background' }), undefined);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-utility', mode: 'background' }), /fresh/);
  denies(await h.tool('nested-utility', 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
  denies(await h.tool('nested-utility', 'bash', { command: 'git status' }), /Cannot verify/);
  assert.equal(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick' }), undefined);
  denies(await h.tool('root', 'task', { agent_type: 'foreign:fusion-sidekick', mode: 'background' }), /fresh/);
  denies(await h.tool('foreign', 'task', { agent_type: 'fusion-big-boss:fusion-sidekick', mode: 'background' }), /Cannot verify/);
  denies(await h.tool('root', 'write_agent', { agent_id: 'task-foreign' }), /Cannot confirm/);
});

test('advisor settings and follow-ups use the exact requested or targeted role key', async () => {
  const f = fixture();
  const ready = { model: 'user-choice', effortLevel: 'high', modelPolicy: 'required' };
  f.state.tasks.push(
    { type: 'agent', id: 'advisor-qualified', agentType: 'fusion-big-boss:fusion-advisor', toolCallId: 'call-advisor-qualified', status: 'idle' },
    { type: 'agent', id: 'advisor-loose', agentType: 'fusion-advisor', toolCallId: 'call-advisor-loose', status: 'idle' });
  f.state.append([...spawn('advisor-qualified', 'fusion-big-boss:fusion-advisor'), ...spawn('advisor-loose', 'fusion-advisor')]);
  f.state.subagents = { disabledSubagents: ['fusion-big-boss:fusion-advisor'], agents: {
    'fusion-big-boss:fusion-advisor': ready, 'fusion-advisor': ready,
  } };
  const h = await installed(f);
  assert.match((await h.prompt('root')).additionalContext, /advisor: disabled/);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), /disabled/);
  denies(await h.tool('root', 'write_agent', { agent_id: 'advisor-qualified' }), /disabled/);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-advisor', mode: 'background' }), undefined);
  assert.equal(await h.tool('root', 'write_agent', { agent_id: 'advisor-loose' }), undefined);
  f.state.subagents.disabledSubagents = ['fusion-advisor'];
  assert.match((await h.prompt('root')).additionalContext, /configured and not disabled/);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), undefined);
  assert.equal(await h.tool('root', 'write_agent', { agent_id: 'advisor-qualified' }), undefined);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-advisor', mode: 'background' }), /disabled/);
  denies(await h.tool('root', 'write_agent', { agent_id: 'advisor-loose' }), /disabled/);
  denies(await h.tool('root', 'write_agent', { agent_ids: ['advisor-qualified', 'advisor-loose'] }), /one explicit agent_id/);
  denies(await h.tool('root', 'task', { agent_type: 'foreign:fusion-advisor', mode: 'background' }), /fresh/);
  f.state.subagents = { agents: { 'fusion-advisor': ready } };
  assert.match((await h.prompt('root')).additionalContext, /not configured/);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), /Cannot confirm/);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-advisor', mode: 'background' }), undefined);
  const loose = fixture(looseLead);
  loose.state.subagents = { disabledSubagents: ['fusion-advisor'], agents: {
    'fusion-big-boss:fusion-advisor': ready,
  } };
  assert.match((await (await installed(loose)).prompt('root')).additionalContext, /advisor: disabled/);
  const compatible = fixture({ ...packagedLead, name: 'fusion' });
  compatible.state.subagents = loose.state.subagents;
  assert.match((await (await installed(compatible)).prompt('root')).additionalContext, /configured and not disabled/);
});

test('foreground sidekick cannot receive verified background permissions', async () => {
  const f = fixture();
  const events = spawn('sidekick', 'fusion-sidekick');
  events[1].data.executionMode = 'sync';
  f.state.append(events);
  const h = await installed(f);
  denies(await h.tool('sidekick', 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
  denies(await h.tool('sidekick', 'bash', { command: 'git status' }), /Cannot verify/);
});

test('foreground advisor has verified read-only identity and can launch only owned evidence', async () => {
  const f = fixture(); advisorReady(f, 'fusion-advisor');
  f.state.tasks = [{ type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running', executionMode: 'sync' }];
  const events = spawn('advisor', 'fusion-advisor'); events[1].data.executionMode = 'sync';
  f.state.append(events);
  const h = await installed(f);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-advisor', mode: 'sync' }), undefined);
  assert.equal(await h.tool('advisor', 'view', { path: leadPath, view_range: [1, 20] }), undefined);
  denies(await h.tool('advisor', 'edit', { path: leadPath }), /read-only/);
  assert.equal(await h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), undefined);
  f.state.append(spawn('evidence', 'fusion-sidekick', 'advisor', 'advisor-task'), true);
  f.state.tasks.push({ type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'idle' });
  assert.equal(await h.tool('advisor', 'write_agent', { agent_id: 'evidence-task' }), undefined);
  denies(await h.tool('root', 'write_agent', { agent_id: 'advisor-task' }), /background/);
});

test('disabled or unavailable coding workers remain readable and cancellable but reject continuation', async () => {
  const f = fixture(); cancellable(f);
  f.state.append(spawn('sidekick', 'fusion-big-boss:fusion-sidekick'));
  const h = await installed(f);
  const name = f.state.tasks[0].agentType;
  f.state.subagents.disabledSubagents.push(name);
  denies(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick' }), /disabled/);
  assert.equal(await h.tool('root', 'read_agent', { agent_id: 'task-sidekick' }), undefined);
  f.state.tasks[0].status = 'running';
  assert.equal(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick', message: 'Wrap up' }), undefined);
  f.state.tasks[0].status = 'idle';
  f.state.subagents.disabledSubagents = [];
  f.state.subagents.agents[name].model = 'gone';
  denies(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick' }), /unavailable/);
  assert.equal((await h.cancel('root', 'task-sidekick')).target.confirmedStopped, true);
});

for (const caller of ['advisor', 'reviewer']) test(`${caller} revalidates its own exact configuration for new and continued evidence, preserving status/cancel`, async () => {
  const f = fixture(); cancellable(f); advisorReady(f); reviewReady(f);
  const name = `fusion-big-boss:fusion-${caller}`;
  f.state.tasks = [
    { type: 'agent', id: 'parent-task', agentType: name, toolCallId: `call-${caller}`, status: 'running' },
    { type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'idle' },
  ];
  f.state.append([...spawn(caller, name), ...spawn('evidence', 'fusion-sidekick', caller, 'parent-task')]);
  const h = await installed(f);
  for (const fault of ['disabled', 'missing', 'changed-model']) {
    const saved = structuredClone(f.state.subagents);
    if (fault === 'disabled') f.state.subagents.disabledSubagents.push(name);
    if (fault === 'missing') delete f.state.subagents.agents[name];
    if (fault === 'changed-model') f.state.subagents.agents[name].model = caller === 'advisor' ? 'selected-reviewer' : 'user-choice';
    denies(await h.tool(caller, 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /disabled|confirm|model/);
    denies(await h.tool(caller, 'write_agent', { agent_id: 'evidence-task' }), /disabled|confirm|model/);
    assert.equal(await h.tool(caller, 'read_agent', { agent_id: 'evidence-task' }), undefined);
    f.state.tasks[1].status = 'running';
    assert.equal(await h.tool(caller, 'write_agent', { agent_id: 'evidence-task', message: 'Wrap up' }), undefined);
    f.state.tasks[1].status = 'idle';
    f.state.subagents = saved;
  }
  f.state.subagents.disabledSubagents.push(name);
  assert.equal((await h.cancel(caller, 'evidence-task')).target.confirmedStopped, true);
});

test('Off retains coding and evidence role boundaries and permits owned status/cancellation', async () => {
  const f = fixture(); cancellable(f); advisorReady(f, 'fusion-advisor');
  f.state.append([...spawn('sidekick', 'fusion-sidekick'), ...spawn('advisor', 'fusion-advisor'),
    ...spawn('evidence', 'fusion-sidekick', 'advisor', 'advisor-task')]);
  f.state.tasks.push(
    { type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' },
    { type: 'agent', id: 'evidence-task', agentType: 'fusion-sidekick', toolCallId: 'call-evidence', status: 'idle' });
  const h = await installed(f);
  f.state.agent = null;
  assert.equal(await h.tool('root', 'bash', { command: 'npm test' }), undefined);
  denies(await h.tool('root', 'write_agent', { agent_id: 'task-sidekick', message: 'Continue' }), /off/);
  denies(await h.tool('root', 'write_agent', { scope: 'children', message: 'Continue' }), /off/);
  assert.equal(await h.tool('sidekick', 'web_search', { query: 'API docs' }), undefined);
  denies(await h.tool('sidekick', 'task', { agent_type: 'build', mode: 'background' }), /cannot delegate/);
  denies(await h.tool('sidekick', 'write_agent', { agent_id: 'advisor-task' }), /cannot delegate/);
  denies(await h.tool('evidence', 'web_search', { query: 'anything' }), /evidence/);
  denies(await h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /off/);
  assert.equal(await h.tool('advisor', 'read_agent', { agent_id: 'evidence-task' }), undefined);
  assert.equal((await h.cancel('root', 'advisor-task')).target.confirmedStopped, true);
});

test('cancellation closes advisor evidence admission during RPC and after acknowledgement, failures reopen it', async () => {
  for (const outcome of ['accepted', 'rejected', 'error']) {
    const f = fixture(); cancellable(f); advisorReady(f, 'fusion-advisor');
    f.state.tasks = [{ type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' }];
    f.state.append(spawn('advisor', 'fusion-advisor'));
    const h = await installed(f);
    const launch = () => h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
    let release; let entered;
    const stopping = new Promise(resolve => { entered = resolve; });
    f.session.rpc.tasks.cancel = async () => {
      entered(); await new Promise(resolve => { release = resolve; });
      if (outcome === 'error') throw new Error('cannot stop');
      return { cancelled: outcome === 'accepted' };
    };
    const pending = h.cancel('root', 'advisor-task');
    await stopping;
    denies(await launch(), /cancellation/);
    release(); const result = await pending;
    if (outcome === 'accepted') {
      denies(await launch(), /cancellation/);
      denies(await h.tool('root', 'write_agent', { agent_id: 'advisor-task' }), /cancellation/);
    } else {
      assert.ok(result.target.error);
      assert.equal(await launch(), undefined);
    }
  }
});

test('a duplicate pending cancellation cannot reopen the original cancelled owner', async () => {
  const f = fixture(); cancellable(f); advisorReady(f, 'fusion-advisor');
  f.state.tasks = [{ type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' }];
  f.state.append(spawn('advisor', 'fusion-advisor'));
  const h = await installed(f);
  let release, entered, calls = 0;
  const stopping = new Promise(resolve => { entered = resolve; });
  f.session.rpc.tasks.cancel = async () => {
    if (++calls > 1) return { cancelled: false };
    entered(); await new Promise(resolve => { release = resolve; });
    return { cancelled: true };
  };
  const pending = h.cancel('root', 'advisor-task');
  await stopping;
  try {
    await h.cancel('root', 'advisor-task').catch(() => {});
    denies(await h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /cancellation/);
  } finally { release(); await pending; }
  denies(await h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /cancellation/);
});

test('parent cancellation racing with evidence settings validation closes late admission', async () => {
  const f = fixture(); cancellable(f); advisorReady(f, 'fusion-advisor');
  f.state.tasks = [{ type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' }];
  f.state.append(spawn('advisor', 'fusion-advisor'));
  const h = await installed(f);
  let release; let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const settings = f.session.connection.sendRequest;
  f.session.connection.sendRequest = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return settings(...args); };
  const pending = h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  await checking;
  assert.equal((await h.cancel('root', 'advisor-task')).target.confirmedStopped, true);
  f.session.connection.sendRequest = settings; release();
  denies(await pending, /cancellation|cancelled/);
});

test('only a successful, current-generation native continuation reopens cancelled advisor admission', async () => {
  const f = fixture(); cancellable(f); advisorReady(f, 'fusion-advisor');
  const parent = { type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running' };
  f.state.tasks = [parent]; f.state.append(spawn('advisor', 'fusion-advisor'));
  f.session.rpc.tasks.cancel = async () => ({ cancelled: true });
  const h = await installed(f);
  const launch = () => h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' });
  const startWrite = id => f.state.append([event('tool.execution_start', null, {
    toolName: 'write_agent', toolCallId: id, arguments: { agent_id: parent.id, message: 'Continue' },
  })], true);
  const finishWrite = (id, success) => f.state.append([event('tool.execution_complete', null, { toolCallId: id, success })], true);
  await h.cancel('root', parent.id);
  parent.status = 'idle';
  startWrite('failed-write');
  assert.equal(await h.tool('root', 'write_agent', { agent_id: parent.id, message: 'Continue' }), undefined);
  finishWrite('failed-write', false);
  denies(await launch(), /cancellation/);
  startWrite('stale-write');
  await h.cancel('root', parent.id);
  finishWrite('stale-write', true);
  denies(await launch(), /cancellation/);
  startWrite('current-write');
  assert.equal(await h.tool('root', 'write_agent', { agent_id: parent.id, message: 'Continue' }), undefined);
  parent.status = 'running'; finishWrite('current-write', true);
  assert.equal(await launch(), undefined);
});

test('a replacement task ID is neither cancelled nor locked by an older request', async () => {
  const f = fixture(); cancellable(f); advisorReady(f, 'fusion-advisor');
  f.state.tasks = [{ type: 'agent', id: 'advisor-task', agentType: 'fusion-advisor', toolCallId: 'call-advisor', status: 'running', startedAt: 'old' }];
  f.state.append(spawn('advisor', 'fusion-advisor'));
  const h = await installed(f);
  const list = f.session.rpc.tasks.list;
  let reads = 0;
  f.session.rpc.tasks.list = async () => {
    if (++reads === 3) {
      f.state.append(spawn('replacement', 'fusion-advisor'), true);
      f.state.tasks = [{ ...f.state.tasks[0], toolCallId: 'call-replacement', startedAt: 'new' }];
    }
    return list();
  };
  const result = await h.cancel('root', 'advisor-task');
  assert.equal(result.target.requested, false);
  assert.match(result.target.error, /identity changed/);
  assert.equal(f.state.tasks[0].status, 'running');
  denies(await h.tool('advisor', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /caller task/);
  assert.equal(await h.tool('replacement', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), undefined);
});

test('advisor cannot fetch, run Git directly, invoke other roles or borrow the lead sidekick', async () => {
  const f = fixture(); f.state.append(spawn('advisor', 'fusion-advisor'));
  const h = await installed(f);
  assert.equal(await h.tool('advisor', 'view', { path: leadPath, view_range: [1, 350] }), undefined);
  denies(await h.tool('advisor', 'view', { path: leadPath, view_range: [1, 351] }), /finite/);
  denies(await h.tool('advisor', 'web_fetch', { url: 'https://example.invalid' }), /sidekick/);
  denies(await h.tool('advisor', 'bash', { command: 'git status' }), /read-only/);
  for (const role of ['fusion-advisor', 'fusion-utility']) {
    denies(await h.tool('advisor', 'task', { agent_type: role, mode: 'background' }), /read-only/);
  }
  for (const tool of ['write_agent', 'read_agent']) {
    denies(await h.tool('advisor', tool, { agent_id: 'task-sidekick' }), /owner|own/);
  }
});

test('advisor status and authorization refresh after a user-setting toggle without choosing a model', async () => {
  const f = fixture(); const h = await installed(f);
  assert.match((await h.prompt('root')).additionalContext, /disabled/);
  f.state.subagents = { agents: { 'fusion-big-boss:fusion-advisor': {
    model: 'user-choice', effortLevel: 'high', modelPolicy: 'required',
  } } };
  assert.match((await h.prompt('root')).additionalContext, /configured and not disabled/);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), undefined);
  f.state.settingsFailure = true;
  assert.match((await h.prompt('root')).additionalContext, /status unavailable/);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), /Cannot verify/);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /Cannot verify/);
});

test('advisor omitted effort stays unconfigured for models with effort choices', async () => {
  const f = fixture();
  f.state.subagents = { agents: { 'fusion-big-boss:fusion-advisor': { model: 'selected', modelPolicy: 'required' } } };
  let hasEffortSelector = true;
  f.session.rpc.model = { list: async () => ({ list: [{ id: 'selected',
    ...(hasEffortSelector ? { supportedReasoningEfforts: ['high'] } : {}),
  }] }) };
  const h = await installed(f);
  assert.match((await h.prompt('root')).additionalContext, /not configured/);
  denies(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), /explicit supported advisor effort/);
  hasEffortSelector = false;
  assert.match((await h.prompt('root')).additionalContext, /configured and not disabled/);
  assert.equal(await h.tool('root', 'task', { agent_type: 'fusion-big-boss:fusion-advisor', mode: 'background' }), undefined);
});

test('foreign same-named plugin and unrelated agents never inherit Fusion restrictions', async () => {
  for (const agent of [{ ...packagedLead, id: 'fusion', path: foreignPath },
    { id: 'build', name: 'build', source: 'user' }]) {
    const f = fixture(agent); const h = await installed(f);
    assert.equal(await h.prompt('root'), undefined);
    assert.equal(await h.tool('root', 'bash', { command: 'git status' }), undefined);
    assert.equal(await h.tool('child', 'web_fetch', { url: 'https://example.invalid' }), undefined);
  }
  const unknown = fixture({ ...packagedLead, path: undefined });
  const h = await installed(unknown);
  assert.equal(await h.prompt('root'), undefined);
  denies(await h.tool('root', 'bash', { command: 'git status' }), /Cannot verify/);
  const mismatched = fixture({ ...packagedLead, name: 'other' });
  const guarded = await installed(mismatched);
  denies(await guarded.tool('root', 'bash', { command: 'git status' }), /Cannot verify/);
});

test('identity outage and incomplete metadata fail closed while default agent stays unrestricted', async () => {
  const f = fixture({ id: 'build', name: 'build', source: 'user' });
  const h = await installed(f);
  assert.equal(await h.tool('root', 'bash', { command: 'npm test' }), undefined);
  f.state.agent = packagedLead;
  f.state.agentFailure = true;
  denies(await h.tool('root', 'bash', { command: 'npm test' }), /Cannot verify/);
  f.state.agentFailure = false;
  denies(await h.tool('root', 'bash', { command: 'npm test' }), /Fusion lead cannot run/);
  f.state.agent = null;
  assert.equal(await h.tool('root', 'bash', { command: 'npm test' }), undefined);
  assert.equal(await h.prompt('root'), undefined);
  f.state.agent = undefined;
  denies(await h.tool('root', 'bash', { command: 'npm test' }), /Cannot verify/);
  f.state.agent = {};
  denies(await h.tool('root', 'bash', { command: 'npm test' }), /Cannot verify/);
  f.state.agent = { id: 'build', name: 'build', source: 'user' };
  assert.equal(await h.tool('root', 'bash', { command: 'npm test' }), undefined);
});

test('incomplete ancestry and partial replay fail closed, then recover', async () => {
  const f = fixture(); f.state.append(spawn('sidekick', 'fusion-sidekick'));
  const h = await installed(f);
  f.state.append([...spawn('late-sidekick', 'fusion-sidekick'),
    event('tool.execution_start', null, { toolName: 'task', toolCallId: 'later' })]);
  f.state.cursorStatus = (start) => start >= 4 ? 'expired' : 'ok';
  denies(await h.tool('late-sidekick', 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
  f.state.cursorStatus = 'ok';
  assert.equal(await h.tool('late-sidekick', 'web_fetch', { url: 'https://example.invalid' }), undefined);
  f.state.append(spawn('orphan', 'fusion-sidekick', 'unknown-agent', 'task-registry-id'));
  denies(await h.tool('orphan', 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
});

test('descendant-created workers never acquire direct-root sidekick permissions', async () => {
  const f = fixture();
  f.state.append([...spawn('sidekick', 'fusion-sidekick'),
    ...spawn('nested', 'fusion-sidekick', 'sidekick', 'task-sidekick'),
    ...spawn('missing-parent', 'fusion-sidekick', 'sidekick')]);
  const h = await installed(f);
  assert.equal(await h.tool('sidekick', 'web_fetch', { url: 'https://example.invalid' }), undefined);
  for (const id of ['nested', 'missing-parent']) {
    denies(await h.tool(id, 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
    denies(await h.tool(id, 'bash', { command: 'git status' }), /Cannot verify/);
    denies(await h.tool(id, 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /Cannot verify/);
  }
});

test('first child tool can backfill missed events; conflicting child identity fails closed', async () => {
  const f = fixture(); const h = await installed(f);
  f.state.append(spawn('sidekick', 'fusion-sidekick')); // no subscription callback
  assert.equal(await h.tool('sidekick', 'bash', { command: 'git status' }), undefined);
  assert.equal(await h.tool('sidekick', 'bash', { command: 'npm test' }), undefined);
  f.state.append([event('subagent.started', 'sidekick', { agentName: 'fusion-advisor',
    agentType: 'fusion-advisor', toolCallId: 'call-sidekick', executionMode: 'background',
  })], true);
  denies(await h.tool('sidekick', 'task', { agent_type: 'fusion-sidekick', mode: 'background' }), /Cannot verify/);
  denies(await h.tool('sidekick', 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
});

test('unavailable journal RPC, malformed page, and opaque empty cursor preserve fail-closed replay', async () => {
  const f = fixture(); f.state.append(spawn('sidekick', 'fusion-sidekick'));
  const originalRead = f.session.rpc.eventLog.read;
  f.session.rpc.eventLog.read = async () => { throw new Error('temporarily unavailable'); };
  const h = await installed(f);
  denies(await h.tool('sidekick', 'web_fetch', { url: 'https://example.invalid' }), /Cannot verify/);
  f.session.rpc.eventLog.read = async (request) => ({ ...(await originalRead(request)), hasMore: 'invalid' });
  denies(await h.tool('sidekick', 'bash', { command: 'git status' }), /Cannot verify/);
  const items = spawn('sidekick', 'fusion-sidekick');
  f.state.reads.length = 0;
  f.session.rpc.eventLog.read = async (request) => {
    f.state.reads.push(request);
    return !Object.hasOwn(request, 'cursor')
      ? { events: [items[0]], cursor: '', hasMore: true, cursorStatus: 'ok' }
      : { events: [items[1]], cursor: 'tail', hasMore: false, cursorStatus: 'ok' };
  };
  assert.equal(await h.tool('sidekick', 'web_fetch', { url: 'https://example.invalid' }), undefined);
  assert.equal(f.state.reads[1].cursor, '');
});

test('same-root reconnect discards stale worker roles and refuses a different attached root', async () => {
  const first = fixture(); first.state.append(spawn('sidekick', 'fusion-sidekick'));
  let session = first.session;
  const roles = createRoleResolver(() => session);
  const hooks = createHooks(() => session, async () => ({ kind: 'text' }), roles);
  roles.subscribe(session);
  await roles.refresh(session);
  const call = (root = session.sessionId) => hooks.onPreToolUse({ sessionId: 'sidekick',
    toolName: 'web_fetch', toolArgs: { url: 'https://example.invalid' } }, { sessionId: root });
  assert.equal(await call(), undefined);
  const resumed = fixture(); session = resumed.session; roles.subscribe(session);
  denies(await call(), /Cannot verify/);
  resumed.state.append(spawn('sidekick', 'fusion-sidekick'));
  assert.equal(await call(), undefined);
  const other = fixture(); other.session.sessionId = 'different-root'; session = other.session;
  roles.subscribe(session);
  denies(await call(), /Cannot verify/);
  denies(await call('root'), /no longer attached/);
});

test('bounded Git routing skips incidental text, retains chains and control structures', () => {
  for (const command of ['git status', '/usr/bin/git -C repo status', 'npm test && git diff',
    'echo ok | git status', 'sudo -u root git status', 'echo $(git status)',
    'if test -d .; then git status; fi', 'for item in a; do git status; done',
    'function g(){ git status; }; g']) {
    assert.equal(containsGitCommand(command), true, command);
  }
  for (const command of ['npm test', 'echo then git status', "echo 'then' git status",
    "printf '%s\\n' 'do' git status", "echo ';' git status", 'pytest -k git',
    "echo 'function g(){ git status; }; g'", 'echo { git status }']) {
    assert.equal(containsGitCommand(command), false, command);
  }
  for (const input of [undefined, null, 42, { text: 'git status' }]) {
    assert.equal(containsGitCommand(input), false);
  }
});
