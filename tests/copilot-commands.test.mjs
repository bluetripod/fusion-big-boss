import assert from 'node:assert/strict';
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createCommands, parseModelsArgs } from '../com.github.copilot/extensions/fusion-guard/commands.mjs';
import { History } from '../com.github.copilot/extensions/fusion-guard/state.mjs';
import { createHooks } from '../com.github.copilot/extensions/fusion-guard/hooks.mjs';
import { createRoleResolver } from '../com.github.copilot/extensions/fusion-guard/roles.mjs';

const prefix = 'ai4corp-fusion-bigg-boss:';
const lead = { id: `${prefix}fusion`, name: `${prefix}fusion`, source: 'plugin',
  displayName: 'Fusion', description: 'Packaged Fusion lead',
  path: fileURLToPath(new URL('../com.github.copilot/agents/fusion.agent.md', import.meta.url)) };
const text = 'lead=p/lead#high sidekick=p/sidekick#low advisor=none';

async function fixture(t, Session) {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-copilot-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = new History(join(dir, 'state.json'));
  const state = { agent: null, model: { modelId: 'original', reasoningEffort: 'low' }, logs: [], tasks: [],
    // SessionModelList.list is JsonValue[]; these match app.js's session model
    // projection: id/name, capabilities and top-level reasoning metadata.
    catalog: [{ id: 'p/lead', name: 'Lead model', capabilities: { supports: { reasoningEffort: true } },
      supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
      { id: 'p/sidekick', name: 'Sidekick model', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['low', 'high'] },
      { id: 'p/utility', name: 'Utility model', capabilities: {} },
      { id: 'p/advisor', name: 'Advisor model', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['high'] }],
    settings: { other: { value: 'keep', default: null, isDefault: false }, subagents: { default: null, isDefault: false, value: { maxDepth: 3,
      agents: { unrelated: { model: 'other', modelPolicy: 'preferred' } }, disabledSubagents: ['unrelated-disabled'] } } },
    managed: { managedKeys: [], failClosed: false }, shadowedKeys: [], switchStatus: 'applied',
    agents: [{ ...lead, id: 'foreign:fusion', name: 'foreign:fusion', path: '/foreign/fusion.agent.md' }, lead] };
  const rpc = {
    managedSettings: { get: async () => state.managed },
    agent: { list: async () => ({ agents: state.agents }), getCurrent: async () => ({ agent: state.agent }),
      select: async ({ name }) => { state.agent = state.agents.find(agent => agent.id === name); state.model = { modelId: 'agent-default' }; return { agent: state.agent }; },
      deselect: async () => { state.agent = null; state.model = { modelId: 'ordinary-default', reasoningEffort: 'high' }; } },
    model: { list: async () => ({ list: state.catalog }), getCurrent: async () => ({ ...state.model }), switchTo: async ({ modelId, reasoningEffort, contextTier, autoTier }) => {
      if (state.switchStatus !== 'applied') return { status: state.switchStatus, deferred: state.switchStatus === 'deferred' };
      state.model = { modelId, ...(reasoningEffort == null ? {} : { reasoningEffort }),
        ...(contextTier ? { contextTier } : {}), ...(autoTier ? { autoTier } : {}) };
      return { status: 'applied', modelId };
    } },
    tools: { updateSubagentSettings: async ({ subagents }) => { state.live = structuredClone(subagents); } },
    tasks: { list: async () => ({ tasks: state.tasks }) },
    eventLog: { read: async () => ({ events: state.events ?? [], cursor: 'end', hasMore: false, cursorStatus: 'ok' }) },
  };
  const connection = { sendRequest: async (method, params) => {
    if (method === 'user.settings.get') return { settings: structuredClone(state.settings) };
    if (method === 'user.settings.set') {
      if (!state.shadowedKeys.length) for (const [key, value] of Object.entries(params.settings)) state.settings[key] = { value: structuredClone(value), default: null, isDefault: false };
      return Object.hasOwn(state, 'settingsWriteResult') ? state.settingsWriteResult : { shadowedKeys: state.shadowedKeys };
    }
    assert.equal(params.sessionId, 'root');
    const handler = method.replace(/^session\./, '').split('.').reduce((value, key) => value?.[key], rpc);
    if (!handler) throw new Error(`Unexpected offline RPC: ${method}`);
    return handler(params);
  } };
  const session = Session ? new Session('root', connection) : { sessionId: 'root', capabilities: {}, connection, rpc };
  session.log = async message => state.logs.push(message);
  const commands = createCommands(() => session, history);
  const run = (args = '') => commands[0].handler({ sessionId: 'root', commandName: 'fusion', command: `/fusion ${args}`, args });
  return { state, session, history, run };
}

const enter = Symbol('press Enter');

function pickerUI(answers, searches = []) {
  const select = async (_message, options, field) => {
    const answer = answers.shift();
    if (answer === enter) return field?.default ?? options[0];
    return typeof answer === 'function' ? answer(options, field) : answer;
  };
  return { select, elicitation: async ({ message, requestedSchema }) => {
    if (requestedSchema.properties.query) {
      const content = searches.shift();
      return content === null ? { action: 'cancel' } : { action: 'accept', content };
    }
    const field = requestedSchema.properties.selection;
    const selection = await select(message, field.enum, field);
    return selection == null ? { action: 'cancel' } : { action: 'accept', content: { selection } };
  } };
}

test('installed CopilotSession supports picker, Apply, direct reviewer start/resume and Off over an inert transport', async (t) => {
  const sdk = process.env.FUSION_COPILOT_SDK || join(homedir(), '.copilot/pkg/linux-x64/1.0.90-5/copilot-sdk/index.js');
  try { await access(sdk); } catch (error) {
    if (process.env.FUSION_COPILOT_SDK || error.code !== 'ENOENT') throw error;
    t.skip('Optional installed SDK unavailable; set FUSION_COPILOT_SDK to its index.js for offline contract verification.');
    return;
  }
  const { CopilotSession } = await import(pathToFileURL(sdk).href);
  const { state, session, history, run } = await fixture(t, CopilotSession);
  state.settingsWriteResult = null;
  const nativePath = fileURLToPath(new URL('../prebuilds/linux-x64/runtime.node', pathToFileURL(sdk)));
  await access(nativePath);
  const native = createRequire(import.meta.url)(nativePath);
  const installedPlugin = join(dirname(history.path), 'marketplace-plugin');
  await symlink(fileURLToPath(new URL('../', import.meta.url)), installedPlugin, 'dir');
  // Read-only discovery, no authInfo or remote agents; only this resolved local
  // plugin and an isolated config directory. Project through the host DTO helper.
  const discovered = JSON.parse(await native.customAgentsDiscoverJson(JSON.stringify({ integrationId: 'cli',
    configDir: join(dirname(history.path), 'empty-config'), projectPaths: [], hasResolvedPlugins: true,
    additionalPlugins: [{ name: 'ai4corp-fusion-bigg-boss', marketplace: 'local', installed_at: '', enabled: true,
      cache_path: installedPlugin }] })));
  state.agents = discovered.agents.map(agent => JSON.parse(native.agentsProjectInfoJson(JSON.stringify(agent))));
  assert.ok(state.agents.some(agent => agent.id === `${prefix}fusion-reviewer`), 'native discovery must expose the packaged reviewer');
  state.catalog[0].capabilities = { supports: { reasoning_effort: ['low', 'high'] } };
  delete state.catalog[0].supportedReasoningEfforts;
  state.catalog[0].billing = { token_prices: { batch_size: 1000,
    default: { max_prompt_tokens: 128000, input_price: 1, output_price: 1 },
    long_context: { max_prompt_tokens: 1000000, input_price: 2, output_price: 2 } } };
  assert.deepEqual(native.modelSupportedReasoningEfforts('p/lead', JSON.stringify(state.catalog)), ['low', 'high']);
  assert.ok(native.contextTierDerive(JSON.stringify(state.catalog[0]), 'long_context').maxPromptTokens
    > native.contextTierDerive(JSON.stringify(state.catalog[0]), 'default').maxPromptTokens);
  const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', 'p/lead', 'high', 'default', 'Cancel'];
  Object.defineProperty(session, 'ui', { value: { select: async (_message, options) => {
    const answer = answers.shift();
    return typeof answer === 'function' ? answer(options) : answer;
  } } });
  await run();
  assert.deepEqual(state.logs, []);
  assert.equal(answers.length, 0);
  assert.equal(state.agent, null);
  await run(`${text} lead-context=long_context`);
  assert.equal(state.agent?.id, lead.id, state.logs.join('\n'));
  assert.equal(state.live.agents[`${prefix}fusion-sidekick`].model, 'p/sidekick');
  const hooks = createHooks(() => session);
  assert.equal(await hooks.onPreToolUse({ sessionId: 'root', toolName: 'task',
    toolArgs: { agent_type: `${prefix}fusion-sidekick`, mode: 'background' } }, { sessionId: 'root' }), undefined);
  await run('reviewer=p/advisor#high');
  const roles = createRoleResolver(() => session);
  roles.subscribe(session);
  const reviewHooks = createHooks(() => session, undefined, roles);
  assert.equal(await reviewHooks.onPreToolUse({ sessionId: 'root', toolName: 'task',
    toolArgs: { agent_type: `${prefix}fusion-reviewer`, mode: 'background' } }, { sessionId: 'root' }), undefined);
  const task = { type: 'agent', id: 'review-task', agentType: `${prefix}fusion-reviewer`, toolCallId: 'review-call', status: 'idle' };
  state.tasks.push(task);
  state.events = [
    { type: 'tool.execution_start', data: { toolName: 'task', toolCallId: task.toolCallId } },
    { type: 'subagent.started', agentId: 'review-runtime', data: {
      agentType: task.agentType, agentName: task.agentType, toolCallId: task.toolCallId, executionMode: 'background',
    } },
  ];
  assert.equal(await reviewHooks.onPreToolUse({ sessionId: 'root', toolName: 'write_agent',
    toolArgs: { agent_id: task.id, message: 'Additional evidence for the requested review' } }, { sessionId: 'root' }), undefined);
  await run('off');
  assert.equal(state.agent, null);
  assert.deepEqual(state.model, { modelId: 'p/lead', reasoningEffort: 'high', contextTier: 'long_context' });
});

test('Copilot text setup validates syntax and refuses removed utility setup', () => {
  assert.equal(parseModelsArgs(text).lead.model, 'p/lead');
  assert.equal(parseModelsArgs(text).lead.effort, 'high');
  assert.equal(parseModelsArgs(text).advisor, null);
  for (const input of ['lead=', 'lead=x#', 'lead=x#high#low', 'unknown=x', 'lead=x lead=y', 'sidekick=none', 'lead=x trailing',
    'lead-context=1000000', 'lead-context=default lead-context=long_context', 'advisor=none advisor-context=default',
    'advisor-context=default advisor=none', 'utility=p/utility', 'utility-context=default',
    'reviewer=none#high', 'reviewer=none reviewer-context=default', 'reviewer-context=default reviewer=none', 'reviewer=x reviewer=y']) {
    assert.throws(() => parseModelsArgs(input), /invalid|duplicate|unknown|none/i);
  }
});

test('optional reviewer setup applies only its explicit model and can be disabled without losing recents', async (t) => {
  const { state, history, run } = await fixture(t);
  await run(`${text} reviewer=p/advisor#high`);
  assert.equal(state.agent?.id, lead.id, state.logs.join('\n'));
  assert.equal(state.live.agents[`${prefix}fusion-reviewer`].model, 'p/advisor');
  assert.equal((await history.load()).recents.reviewer[0].effort, 'high');
  await run('reviewer=none');
  assert.ok(state.live.disabledSubagents.includes(`${prefix}fusion-reviewer`));
  assert.equal((await history.load()).last.reviewer, null);
  assert.equal((await history.load()).recents.reviewer[0].model, 'p/advisor');
});

test('reviewer picker uses available explicit effort/context and retains recent choices without requiring a new family', async (t) => {
  const { state, session, history, run } = await fixture(t);
  state.catalog[0].supportedContextTiers = ['default', 'long_context'];
  await run(text);
  session.capabilities.ui = { elicitation: true };
  const answers = [options => options.find(value => value.startsWith('reviewer:')), 'Choose new model', 'p/lead', 'high', 'long_context', 'Apply this setup'];
  session.ui = { select: async (_message, options) => {
    const answer = answers.shift();
    const selected = typeof answer === 'function' ? answer(options) : answer;
    assert.ok(options.includes(selected));
    return selected;
  } };
  await run();
  assert.equal(answers.length, 0, state.logs.join('\n'));
  assert.equal(state.live.agents[`${prefix}fusion-reviewer`].model, 'p/lead');
  assert.equal(state.live.agents[`${prefix}fusion-reviewer`].contextTier, 'long_context');
  assert.equal((await history.load()).recents.reviewer[0].contextTier, 'long_context');
  await run('reviewer=none');
  answers.push(options => options.find(value => value.startsWith('reviewer:')), 'p/lead#high (context: long_context)', 'Apply this setup');
  await run();
  assert.equal((await history.load()).last.reviewer.model, 'p/lead');
  assert.ok(!state.live.disabledSubagents.includes(`${prefix}fusion-reviewer`));
});

test('Apply refuses a running or unverifiable reviewer; Off retains its saved model and task', async (t) => {
  const { state, history, run } = await fixture(t);
  await run(`${text} reviewer=p/advisor#high`);
  const before = structuredClone(state.live);
  state.tasks = [{ type: 'agent', id: 'review-task', agentType: `${prefix}fusion-reviewer`, status: 'running' }];
  for (const status of ['running', undefined]) {
    state.tasks[0].status = status;
    await run('reviewer=none');
    assert.deepEqual(state.live, before);
    assert.equal((await history.load()).last.reviewer.model, 'p/advisor');
  }
  await run('off');
  assert.equal(state.agent, null);
  assert.equal(state.tasks[0].id, 'review-task');
  assert.equal((await history.load()).last.reviewer.model, 'p/advisor');
});

test('Off restores ordinary native reviewer tasks and group writes while retaining model configuration', async (t) => {
  const { state, session, run } = await fixture(t);
  await run(`${text} reviewer=p/advisor#high`);
  await run('off');
  assert.equal(state.agent, null);
  assert.equal(state.settings.subagents.value.agents[`${prefix}fusion-reviewer`].model, 'p/advisor');
  const hooks = createHooks(() => session);
  const result = await hooks.onPreToolUse({ sessionId: 'root', toolName: 'task', toolArgs: {
    agent_type: `${prefix}fusion-reviewer`, mode: 'background',
  } }, { sessionId: 'root' });
  assert.equal(result, undefined);
  delete session.rpc.tasks;
  for (const scope of ['children', 'siblings']) assert.equal(await hooks.onPreToolUse({ sessionId: 'root', toolName: 'write_agent',
    toolArgs: { scope, message: 'Continue ordinary work' } }, { sessionId: 'root' }), undefined);
});

test('Off pauses retained reviewer follow-ups until explicit Apply', async (t) => {
  const { state, session, run } = await fixture(t);
  await run(`${text} reviewer=p/advisor#high`);
  const task = { type: 'agent', id: 'review-task', agentType: `${prefix}fusion-reviewer`, toolCallId: 'review-call', status: 'idle' };
  state.tasks.push(task);
  session.on = () => () => {};
  session.rpc.eventLog = { read: async () => ({ events: [
    { type: 'tool.execution_start', data: { toolName: 'task', toolCallId: task.toolCallId } },
    { type: 'subagent.started', agentId: 'review-runtime', data: {
      agentType: task.agentType, agentName: task.agentType, toolCallId: task.toolCallId, executionMode: 'background',
    } },
  ], cursor: 'end', hasMore: false, cursorStatus: 'ok' }) };
  const roles = createRoleResolver(() => session);
  roles.subscribe(session);
  const hooks = createHooks(() => session, undefined, roles);
  const write = () => hooks.onPreToolUse({ sessionId: 'root', toolName: 'write_agent',
    toolArgs: { agent_id: task.id, message: 'Review follow-up' } }, { sessionId: 'root' });
  assert.equal(await write(), undefined, state.logs.join('\n'));
  await run('off');
  assert.equal(state.agent, null);
  assert.equal((await write()).permissionDecision, 'deny');
  assert.equal(await hooks.onPreToolUse({ sessionId: 'root', toolName: 'read_agent',
    toolArgs: { agent_id: task.id } }, { sessionId: 'root' }), undefined);
  await run('apply');
  assert.equal(await write(), undefined);
});

test('Apply reuses old remaining selections and preserves obsolete native entries without activating utility', async (t) => {
  const { state, history, run } = await fixture(t);
  state.catalog[0].supportedContextTiers = ['default', 'long_context'];
  const legacyUtility = { model: 'unavailable-utility', modelPolicy: 'preferred', effortLevel: 'inherit' };
  state.settings.subagents.value.agents[`${prefix}fusion-utility`] = legacyUtility;
  state.settings.subagents.value.disabledSubagents.push(`${prefix}fusion-utility`);
  state.tasks.push({ type: 'agent', id: 'old-utility-chat', agentType: `${prefix}fusion-utility`, status: 'running' });
  await writeFile(history.path, JSON.stringify({ last: {
    lead: { model: 'p/lead', effort: 'high', contextTier: 'long_context' },
    sidekick: { model: 'p/sidekick', effort: 'low' }, advisor: null,
    utility: { model: 'unavailable-utility' },
  }, recents: { lead: [], sidekick: [], advisor: [], utility: [] } }));
  await run('apply');
  assert.equal(state.agent?.id, lead.id, state.logs.join('\n'));
  assert.deepEqual(state.model, { modelId: 'p/lead', reasoningEffort: 'high', contextTier: 'long_context' });
  assert.equal(state.live.agents[`${prefix}fusion-sidekick`].model, 'p/sidekick');
  assert.deepEqual(state.live.agents[`${prefix}fusion-utility`], legacyUtility);
  assert.ok(state.live.disabledSubagents.includes(`${prefix}fusion-utility`));
  assert.equal(state.tasks[0].id, 'old-utility-chat');
  assert.equal((await history.load()).last.sidekick.effort, 'low');
});

test('malformed session catalog responses fail closed rather than masquerading as an empty catalog', async (t) => {
  for (const response of [null, { models: [{ id: 'p/lead' }] }, { list: 'private-data' },
    { list: [null] }, { list: [{ id: 'p/lead', supportedReasoningEfforts: 'private-data' }] }]) {
    const { state, session, history, run } = await fixture(t);
    session.rpc.model.list = async () => response;
    await run(text);
    assert.equal(state.agent, null);
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
    assert.match(state.logs.at(-1), /unrecognized.*session\.model\.list/i);
    assert.doesNotMatch(state.logs.at(-1), /private-data/);
  }
});

test('catalog failures identify the entry and field without leaking values or changing picker/Apply state', async (t) => {
  const cases = [
    [null, 'entry', 'null'],
    [{ id: 7, name: 'PRIVATE-CATALOG' }, 'id', 'number'],
    [{ id: 'PRIVATE-MODEL', supportedReasoningEfforts: 'PRIVATE-DATA' }, 'supportedReasoningEfforts', 'string'],
    [{ id: 'PRIVATE-MODEL', capabilities: { supports: { reasoning_effort: 'PRIVATE-DATA' } } }, 'capabilities.supports.reasoning_effort', 'string'],
    [{ id: 'PRIVATE-MODEL', supportedContextTiers: ['PRIVATE-TIER', 42] }, 'supportedContextTiers', 'array'],
    [{ id: 'PRIVATE-MODEL', defaultReasoningEffort: null }, 'defaultReasoningEffort', 'null'],
  ];
  for (const picker of [false, true]) for (const [model, field, valueType] of cases) {
    const { state, session, history, run } = await fixture(t);
    state.catalog = [state.catalog[0], model];
    session.capabilities.ui = { elicitation: true };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model'];
    session.ui = { select: async (_message, options) => {
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(options) : answer;
    } };
    const before = structuredClone({ agent: state.agent, model: state.model, settings: state.settings });
    await run(picker ? '' : text);
    assert.deepEqual({ agent: state.agent, model: state.model, settings: state.settings }, before);
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
    const message = state.logs.at(-1);
    assert.match(message, /entryIndex=1/);
    assert.equal(/field=([^, )]+)/.exec(message)?.[1], field);
    assert.equal(/valueType=([^, )]+)/.exec(message)?.[1], valueType);
    assert.doesNotMatch(message, /PRIVATE-/);
  }
});

test('null native reasoning metadata allows picker/Apply without inventing efforts or losing top-level choices', async (t) => {
  for (const [id, effort] of [['p/utility', undefined], ['p/lead', 'low']]) {
    const { state, session, history, run } = await fixture(t);
    const model = state.catalog.find(model => model.id === id);
    model.capabilities.supports = { reasoning_effort: null };
    await run(text);
    assert.equal(state.agent?.id, lead.id, state.logs.join('\n'));
    session.capabilities.ui = { elicitation: true };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', id,
      ...(effort ? [effort] : []), 'Apply this setup'];
    session.ui = { select: async (_message, options) => {
      const answer = answers.shift();
      const selected = typeof answer === 'function' ? answer(options) : answer;
      assert.ok(options.includes(selected), `Choice unavailable: ${selected}`);
      return selected;
    } };
    await run();
    assert.equal(answers.length, 0, state.logs.join('\n'));
    assert.deepEqual(state.model, { modelId: id, ...(effort ? { reasoningEffort: effort } : {}) });
    assert.deepEqual((await history.load()).last.lead, { model: id, ...(effort ? { effort } : {}) });
    await run(`lead=${id}#unsupported`);
    assert.deepEqual(state.model, { modelId: id, ...(effort ? { reasoningEffort: effort } : {}) });
    assert.deepEqual((await history.load()).last.lead, { model: id, ...(effort ? { effort } : {}) });
  }
});

test('null context metadata skips unavailable tiers or uses advertised billing tiers in picker/Apply', async (t) => {
  const billing = { token_prices: { batch_size: 1000,
    default: { max_prompt_tokens: 128000, input_price: 1, output_price: 1 },
    long_context: { max_prompt_tokens: 1000000, input_price: 2, output_price: 2 } } };
  for (const contextTier of [undefined, 'long_context']) {
    const { state, session, history, run } = await fixture(t);
    const model = state.catalog.find(model => model.id === 'p/utility');
    model.capabilities.supports = { reasoning_effort: null };
    model.supportedContextTiers = null;
    if (contextTier) model.billing = billing;
    await run(text);
    assert.equal(state.agent?.id, lead.id, state.logs.join('\n'));
    session.capabilities.ui = { elicitation: true };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', 'p/utility',
      ...(contextTier ? [contextTier] : []), 'Apply this setup'];
    session.ui = { select: async (_message, options) => {
      const answer = answers.shift();
      const selected = typeof answer === 'function' ? answer(options) : answer;
      assert.ok(options.includes(selected), `Choice unavailable: ${selected}`);
      return selected;
    } };
    await run();
    assert.equal(answers.length, 0, state.logs.join('\n'));
    assert.deepEqual(state.model, { modelId: 'p/utility', ...(contextTier ? { contextTier } : {}) });
    assert.deepEqual((await history.load()).last.lead, { model: 'p/utility', ...(contextTier ? { contextTier } : {}) });
    if (!contextTier) {
      await run('lead-context=long_context');
      assert.deepEqual(state.model, { modelId: 'p/utility' });
      assert.deepEqual((await history.load()).last.lead, { model: 'p/utility' });
    }
  }
});

test('native reasoning and context choices apply to lead/workers and survive history without substitution', async (t) => {
  const { state, session, history, run } = await fixture(t);
  // Native ModelSupports uses a reasoning_effort array. TieredTokenPrices has
  // a batch size, default tier and optional long_context tier, not flat prices.
  state.catalog = [{ id: 'gpt-5.4', name: 'GPT-5.4', capabilities: { supports: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'] } },
    billing: { token_prices: { batch_size: 1000, default: { max_prompt_tokens: 128000, input_price: 1, output_price: 1 },
      long_context: { max_prompt_tokens: 1000000, input_price: 2, output_price: 2 } } } }, ...state.catalog];
  await run(text);
  session.capabilities.ui = { elicitation: true };
  const role = name => options => options.find(value => value.startsWith(`${name}:`));
  const answers = [role('lead'), 'Choose new model', 'gpt-5.4', 'xhigh', 'long_context',
    role('sidekick'), 'Choose new model', 'gpt-5.4', 'high', 'default', 'Apply this setup'];
  session.ui = { select: async (_message, options) => {
    const answer = answers.shift();
    const selected = typeof answer === 'function' ? answer(options) : answer;
    assert.ok(options.includes(selected), `Choice unavailable: ${selected}`);
    return selected;
  } };
  await run();
  assert.equal(answers.length, 0, state.logs.join('\n'));
  assert.deepEqual(state.model, { modelId: 'gpt-5.4', reasoningEffort: 'xhigh', contextTier: 'long_context' });
  assert.equal(state.live.agents[`${prefix}fusion-sidekick`].effortLevel, 'high');
  assert.equal(state.live.agents[`${prefix}fusion-sidekick`].contextTier, 'default');
  assert.equal((await history.load()).recents.lead[0].contextTier, 'long_context');
  const hooks = createHooks(() => session);
  state.live.agents[`${prefix}fusion-sidekick`] = { model: 'gpt-5.4', modelPolicy: 'required', effortLevel: 'default' };
  state.settings.subagents.value = state.live;
  assert.equal((await hooks.onPreToolUse({ sessionId: 'root', toolName: 'task',
    toolArgs: { agent_type: `${prefix}fusion-sidekick`, mode: 'background' } }, { sessionId: 'root' })).permissionDecision, 'deny');
});

test('advertised context tiers validate text choices and retain distinct recent context choices', async (t) => {
  const { state, history, run } = await fixture(t);
  state.catalog[0].supportedContextTiers = ['default', 'long_context'];
  await run(`${text} lead-context=long_context`);
  assert.equal(state.model.contextTier, 'long_context');
  await run('lead-context=default');
  assert.equal(state.model.contextTier, 'default');
  assert.deepEqual((await history.load()).recents.lead.map(choice => choice.contextTier), ['default', 'long_context']);
  await run('advisor-context=long_context');
  assert.equal(state.model.contextTier, 'default');
  assert.equal((await history.load()).last.advisor, null);
  await run('lead=p/lead#unsupported lead-context=default');
  assert.equal(state.model.reasoningEffort, 'high');
});

test('escaping context selection leaves the previous role draft intact and does not Apply', async (t) => {
  const { state, session, run } = await fixture(t);
  state.catalog[0].supportedContextTiers = ['default', 'long_context'];
  await run(text);
  await run('off');
  session.capabilities.ui = { elicitation: true };
  const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', 'p/lead', 'low', null, 'Cancel'];
  session.ui = { select: async (_message, options) => {
    const answer = answers.shift();
    return typeof answer === 'function' ? answer(options) : answer;
  } };
  await run();
  assert.equal(state.agent, null);
  assert.equal(state.model.reasoningEffort, 'high');
  assert.equal(answers.length, 0);
});

test('duplicate packaged selection IDs are refused before selecting either agent', async (t) => {
  const { state, run } = await fixture(t);
  state.agents.push({ ...lead, path: '/foreign/fusion.agent.md' });
  await run(text);
  assert.equal(state.agent, null);
  assert.equal(state.live, undefined);
});

test('unverified agent metadata reports only identity information and never selects or leaks prompt/config/path', async (t) => {
  const { state, run } = await fixture(t);
  state.agents = [{ id: lead.id, name: lead.name, source: 'plugin',
    path: '/private-test-directory/fusion.agent.md', prompt: 'PRIVATE-PROMPT', mcpServers: { secret: 'PRIVATE-CONFIG' } }];
  await run(text);
  assert.equal(state.agent, null);
  assert.equal(state.live, undefined);
  assert.match(state.logs.at(-1), /pathPresent/);
  assert.doesNotMatch(state.logs.at(-1), /PRIVATE-PROMPT|PRIVATE-CONFIG|private-test-directory/);
});

test('a substituted context tier prevents successful Apply/history; omission preserves existing worker override', async (t) => {
  const { state, session, history, run } = await fixture(t);
  state.catalog[0].supportedContextTiers = ['default', 'long_context'];
  state.settings.subagents.value.agents[`${prefix}fusion-sidekick`] = { contextTier: 'default' };
  await run(text);
  assert.equal(state.live.agents[`${prefix}fusion-sidekick`].contextTier, 'default');
  assert.equal((await history.load()).last.lead.contextTier, undefined);
  const switchTo = session.rpc.model.switchTo;
  session.rpc.model.switchTo = async request => {
    const result = await switchTo(request);
    state.model.contextTier = 'default';
    return result;
  };
  await run('lead-context=long_context');
  assert.equal((await history.load()).last.lead.contextTier, undefined);
  assert.equal((await history.load()).recents.lead.length, 1);
  assert.match(state.logs.at(-1), /substituted/);
});

test('a valid empty session catalog reports safe counts for picker and Apply without changing setup', async (t) => {
  for (const picker of [false, true]) {
    const { state, session, history, run } = await fixture(t);
    session.rpc.model.list = async () => ({ list: [], providers: [] });
    session.capabilities.ui = { elicitation: true };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model'];
    session.ui = { select: async (_message, options) => {
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(options) : answer;
    } };
    await run(picker ? '' : text);
    assert.equal(state.agent, null);
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
    assert.match(state.logs.at(-1), /No models.*listCount=0.*providerCount=0/i);
    assert.match(state.logs.at(-1), new RegExp(`stage=${picker ? 'picker' : 'apply'}`));
  }
});

test('text Apply selects the packaged lead, merges settings, disables advisor and passes Phase 1 guard', async (t) => {
  const { state, session, history, run } = await fixture(t);
  await run(text);
  assert.equal(state.agent.id, lead.id);
  assert.deepEqual(state.model, { modelId: 'p/lead', reasoningEffort: 'high' });
  assert.equal(state.settings.other.value, 'keep');
  const subagents = state.settings.subagents.value;
  assert.equal(subagents.agents.unrelated.model, 'other');
  assert.equal(subagents.maxDepth, 3);
  assert.ok(subagents.disabledSubagents.includes('unrelated-disabled'));
  assert.ok(subagents.disabledSubagents.includes(`${prefix}fusion-advisor`));
  assert.deepEqual(state.live, subagents);
  const hooks = createHooks(() => session);
  assert.equal(await hooks.onPreToolUse({ sessionId: 'root', toolName: 'task',
    toolArgs: { agent_type: `${prefix}fusion-sidekick`, mode: 'background' } }, { sessionId: 'root' }), undefined);
  assert.match((await hooks.onUserPromptSubmitted({ sessionId: 'root' }, { sessionId: 'root' })).additionalContext, /advisor: disabled/);
  assert.equal((await history.load()).last.sidekick.model, 'p/sidekick');
  assert.equal((await history.load()).recents.advisor.length, 0);
  await run('advisor=p/advisor#high');
  assert.ok(!state.live.disabledSubagents.includes(`${prefix}fusion-advisor`));
  assert.match((await hooks.onUserPromptSubmitted({ sessionId: 'root' }, { sessionId: 'root' })).additionalContext, /configured and not disabled/);
});

test('missing model, invalid effort or missing packaged identity fails before changing setup', async (t) => {
  for (const failure of ['model', 'effort', 'identity', 'managed']) {
    const { state, history, run } = await fixture(t);
    if (failure === 'model') state.catalog = state.catalog.filter(model => model.id !== 'p/sidekick');
    if (failure === 'identity') state.agents = [state.agents[0], { ...lead, path: '/foreign/fusion.agent.md' }];
    if (failure === 'managed') state.managed.managedKeys = ['subagents'];
    await run(failure === 'effort' ? text.replace('sidekick#low', 'sidekick#unsupported') : text);
    assert.equal(state.agent, null, failure);
    assert.equal(state.model.modelId, 'original');
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
    assert.ok(state.logs.length > 0);
  }
});

test('a managed startup model default permits explicit Apply but cannot override native switch rejection', async (t) => {
  for (const status of ['applied', 'rejected']) {
    const { state, history, run } = await fixture(t);
    state.managed = { managedKeys: ['model'], failClosed: false, settings: { model: 'auto' } };
    state.switchStatus = status;
    const settings = structuredClone(state.settings);
    await run(text);
    if (status === 'applied') {
      assert.equal(state.agent?.id, lead.id, state.logs.join('\n'));
      assert.deepEqual(state.model, { modelId: 'p/lead', reasoningEffort: 'high' });
      assert.equal(state.live.agents[`${prefix}fusion-sidekick`].model, 'p/sidekick');
      assert.equal(state.live.agents[`${prefix}fusion-sidekick`].modelPolicy, 'required');
      assert.equal((await history.load()).last.lead.model, 'p/lead');
    } else {
      assert.match(state.logs.at(-1), /Model switch rejected/);
      assert.deepEqual(state.settings, settings);
      assert.equal(state.live, undefined);
      assert.equal((await history.load()).last, undefined);
    }
  }
});

test('managed subagent restrictions and unverifiable policy still block Apply before changing setup', async (t) => {
  for (const managed of [
    { managedKeys: ['model', 'subagents.agents'], failClosed: false },
    { managedKeys: ['model'], failClosed: true },
    { managedKeys: null, failClosed: false },
  ]) {
    const { state, history, run } = await fixture(t);
    state.managed = managed;
    const before = structuredClone({ agent: state.agent, model: state.model, settings: state.settings });
    await run(text);
    assert.deepEqual({ agent: state.agent, model: state.model, settings: state.settings }, before);
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
  }
});

test('deferred/rejected model switches and shadowed settings never claim a successful Apply or record recents', async (t) => {
  for (const failure of ['deferred', 'rejected', 'shadowed']) {
    const { state, history, run } = await fixture(t);
    if (failure === 'shadowed') state.shadowedKeys = ['subagents'];
    else state.switchStatus = failure;
    await run(text);
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
    assert.match(state.logs.at(-1), new RegExp(failure, 'i'));
  }
});

test('void settings-write responses apply and save verified workers despite read-back object ordering', async (t) => {
  for (const result of [null, undefined]) {
    const { state, session, history, run } = await fixture(t);
    state.settingsWriteResult = result;
    const request = session.connection.sendRequest;
    session.connection.sendRequest = async (method, params) => {
      const response = await request(method, params);
      if (method === 'user.settings.get') {
        const value = response.settings.subagents.value;
        value.agents = Object.fromEntries(Object.entries(value.agents).reverse());
      }
      return response;
    };
    await run(text);
    assert.equal(state.live?.agents[`${prefix}fusion-sidekick`].model, 'p/sidekick', state.logs.join('\n'));
    assert.equal(state.live.agents.unrelated.model, 'other');
    assert.equal(state.live.maxDepth, 3);
    assert.ok(state.live.disabledSubagents.includes(`${prefix}fusion-advisor`));
    assert.equal((await history.load()).last.sidekick.effort, 'low');
    assert.equal((await history.load()).recents.sidekick[0].model, 'p/sidekick');
  }
});

test('settings read-back mismatches preserve live workers and saved setup for void and structured write responses', async (t) => {
  for (const result of [{ shadowedKeys: [] }, null]) {
    const { state, session, history, run } = await fixture(t);
    await run(text);
    const before = structuredClone({ live: state.live, history: await history.load() });
    state.settingsWriteResult = result;
    const request = session.connection.sendRequest;
    session.connection.sendRequest = async (method, params) => {
      const response = await request(method, params);
      if (method === 'user.settings.set') state.settings.subagents.value.agents[`${prefix}fusion-sidekick`].model = 'PRIVATE-MODEL';
      return response;
    };
    await run('sidekick=p/lead#high');
    assert.deepEqual({ live: state.live, history: await history.load() }, before);
    assert.match(state.logs.at(-1), /read.back|confirm/i);
    assert.doesNotMatch(state.logs.at(-1), /PRIVATE-MODEL/);
  }
});

test('unavailable or malformed settings read-back never applies live workers or records setup', async (t) => {
  for (const response of [null, { settings: {} }, new Error('Settings read unavailable')]) {
    const { state, session, history, run } = await fixture(t);
    state.settingsWriteResult = { shadowedKeys: [] };
    const request = session.connection.sendRequest;
    let written = false;
    session.connection.sendRequest = async (method, params) => {
      if (method === 'user.settings.get' && written) {
        if (response instanceof Error) throw response;
        return response;
      }
      const result = await request(method, params);
      if (method === 'user.settings.set') written = true;
      return result;
    };
    await run(text);
    assert.equal(state.settings.subagents.value.agents[`${prefix}fusion-sidekick`].model, 'p/sidekick');
    assert.equal(state.live, undefined);
    assert.equal((await history.load()).last, undefined);
    assert.equal((await history.load()).recents.sidekick.length, 0);
    assert.doesNotMatch(state.logs.at(-1), /Cannot read properties/);
  }
});

test('Off permits running Fusion workers and restores exact model/effort without erasing setup', async (t) => {
  const { state, history, run } = await fixture(t);
  await run(text);
  state.model.contextTier = 'long_context';
  state.tasks = [{ type: 'agent', id: 'worker', agentType: `${prefix}fusion-sidekick`, status: 'running' }];
  await run('off');
  assert.equal(state.agent, null);
  assert.equal(state.tasks[0].status, 'running');
  state.tasks.push({ type: 'agent', agentType: 'foreign:fusion-sidekick', status: 'running' });
  await run('off');
  assert.equal(state.agent, null);
  assert.deepEqual(state.model, { modelId: 'p/lead', reasoningEffort: 'high', contextTier: 'long_context' });
  assert.equal((await history.load()).last.lead.model, 'p/lead');
  await run('status');
  assert.equal(state.agent, null);
  state.tasks[0].status = 'idle';
  await run('apply');
  assert.equal(state.agent.id, lead.id);
  assert.equal((await history.load()).recents.lead.length, 1);
});

test('typed model filtering matches every term across names and IDs before explicit selection and Apply', async (t) => {
  const { state, session, history, run } = await fixture(t);
  await run(text);
  state.catalog.push(
    { id: 'p/6.1-fast', name: 'Sol Fast', supportedReasoningEfforts: ['high'] },
    { id: 'p/sol-6.1', name: 'Another model' },
    { id: 'p/sol-6.0', name: 'Sol 6.0' },
    { id: 'p/luna-6.1', name: 'Luna 6.1' },
  );
  session.capabilities.ui = { elicitation: true };
  const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', options => {
    assert.deepEqual(new Set(options), new Set(['p/6.1-fast', 'p/sol-6.1']));
    return 'p/6.1-fast';
  }, 'high', 'Apply this setup'];
  session.ui = pickerUI(answers, [{ query: '  SoL   6.1  ' }]);
  await run();
  assert.equal(answers.length, 0, state.logs.join('\n'));
  assert.deepEqual(state.model, { modelId: 'p/6.1-fast', reasoningEffort: 'high' });
  assert.equal((await history.load()).last.lead.model, 'p/6.1-fast');
});

test('an unmatched filter permits another query and blank input restores all choices without applying a draft', async (t) => {
  const { state, session, history, run } = await fixture(t);
  await run(text);
  const before = structuredClone({ model: state.model, settings: state.settings, history: await history.load() });
  session.capabilities.ui = { elicitation: true };
  const queries = [{ query: 'no-such-model' }, {}];
  const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', options => {
    assert.deepEqual(new Set(options), new Set(['p/lead', 'p/sidekick', 'p/utility', 'p/advisor']));
    return 'p/sidekick';
  }, 'low', 'Cancel'];
  session.ui = pickerUI(answers, queries);
  await run();
  assert.equal(queries.length, 0, state.logs.join('\n'));
  assert.equal(answers.length, 0, state.logs.join('\n'));
  assert.deepEqual({ model: state.model, settings: state.settings, history: await history.load() }, before);
});

test('cancelled/invalid filters and out-of-filter custom selections cannot change the saved setup', async (t) => {
  for (const query of [null, 42, 'lead model']) {
    const { state, session, history, run } = await fixture(t);
    await run(text);
    const before = structuredClone({ model: state.model, settings: state.settings, history: await history.load() });
    session.capabilities.ui = { elicitation: true };
    const chooseOutsideFilter = options => {
      assert.deepEqual(options, ['p/lead']);
      return 'p/sidekick';
    };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model',
      ...(query === null ? [] : [chooseOutsideFilter]), 'Cancel'];
    session.ui = pickerUI(answers, [query === null ? null : { query }]);
    await run();
    assert.deepEqual({ model: state.model, settings: state.settings, history: await history.load() }, before);
    if (query !== null) assert.match(state.logs.at(-1), /invalid|unavailable/i);
  }
});

test('search results remove repeated selection IDs while retaining distinct models with the same name', async (t) => {
  const { state, session, history, run } = await fixture(t);
  await run(text);
  state.catalog.push(
    { id: 'p/sol-6.1', name: 'Sol 6.1' },
    { id: 'p/sol-6.1', name: 'Sol 6.1' },
    { id: 'other/sol-6.1', name: 'Sol 6.1' },
  );
  session.capabilities.ui = { elicitation: true };
  const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', options => {
    assert.deepEqual(options, ['p/sol-6.1', 'other/sol-6.1']);
    return 'other/sol-6.1';
  }, 'Apply this setup'];
  session.ui = pickerUI(answers, [{ query: '6.1' }]);
  await run();
  assert.equal(answers.length, 0, state.logs.join('\n'));
  assert.equal(state.model.modelId, 'other/sol-6.1');
  assert.equal((await history.load()).last.lead.model, 'other/sol-6.1');
});

test('Enter keeps available current submenu choices but a filter/new model does not inherit excluded choices', async (t) => {
  for (const query of ['', 'lead model']) {
    const { state, session, history, run } = await fixture(t);
    for (const model of state.catalog.slice(0, 2)) model.supportedContextTiers = ['default', 'long_context'];
    await run('lead=p/sidekick#high sidekick=p/sidekick#low advisor=none lead-context=long_context');
    session.capabilities.ui = { elicitation: true };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model',
      enter, enter, enter, 'Apply this setup'];
    session.ui = pickerUI(answers, [{ query }]);
    await run();
    assert.equal(answers.length, 0, state.logs.join('\n'));
    const model = query ? 'p/lead' : 'p/sidekick';
    const effort = query ? 'low' : 'high';
    const contextTier = query ? 'default' : 'long_context';
    assert.deepEqual(state.model, { modelId: model, reasoningEffort: effort, contextTier });
    assert.deepEqual((await history.load()).last.lead, { model, effort, contextTier });
  }
});

test('context selection displays distinct context/input token capacities and submits the native tier ID', async (t) => {
  const { state, session, history, run } = await fixture(t);
  state.catalog[0].capabilities.limits = { max_prompt_tokens: 128000, max_output_tokens: 16000, max_context_window_tokens: 144000 };
  state.catalog[0].billing = { token_prices: {
    default: { max_prompt_tokens: 128000 }, long_context: { max_prompt_tokens: 1000000 },
  } };
  await run(text);
  session.capabilities.ui = { elicitation: true };
  const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', 'p/lead', 'high', (_options, field) => {
    const capacities = field.enumNames.map(title => (title.match(/\d[\d,]*/g) ?? []).map(value => Number(value.replaceAll(',', ''))));
    assert.deepEqual(capacities, [[144000, 128000], [1016000, 1000000]]);
    return 'long_context';
  }, 'Apply this setup'];
  session.ui = pickerUI(answers, [{ query: 'lead model' }]);
  await run();
  assert.equal(answers.length, 0, state.logs.join('\n'));
  assert.equal(state.model.contextTier, 'long_context');
  assert.equal((await history.load()).last.lead.contextTier, 'long_context');
});

test('interactive picker changes only a draft until Apply; cancelled selection applies nothing', async (t) => {
  for (const cancel of [true, false]) {
    const { state, session, history, run } = await fixture(t);
    session.capabilities.ui = { elicitation: true };
    const answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', 'p/lead', 'high',
      options => options.find(value => value.startsWith('sidekick:')), 'Choose new model', 'p/sidekick', 'low',
      cancel ? null : 'Apply this setup'];
    session.ui = { select: async (_message, options) => {
      assert.equal(state.agent, null); // Still a draft at every selection, including Apply.
      assert.equal(state.live, undefined);
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(options) : answer;
    } };
    await run();
    if (cancel) {
      assert.equal(state.agent, null);
      assert.equal((await history.load()).last, undefined);
    } else {
      assert.equal(state.agent.id, lead.id);
      assert.equal((await history.load()).recents.sidekick[0].model, 'p/sidekick');
    }
  }
});

test('saved picker never auto-applies; recent choice selection records only that role after Apply', async (t) => {
  const { state, session, history, run } = await fixture(t);
  await run(text);
  await run('off');
  state.catalog.push({ id: 'p/other', supportedReasoningEfforts: ['high'] });
  session.capabilities.ui = { elicitation: true };
  let answers = [null];
  session.ui = { select: async (_message, options) => {
    const answer = answers.shift();
    return typeof answer === 'function' ? answer(options) : answer;
  } };
  await run();
  assert.equal(state.agent, null);
  answers = [options => options.find(value => value.startsWith('lead:')), 'Choose new model', 'p/other', 'high', 'Apply this setup'];
  await run();
  assert.equal(state.model.modelId, 'p/other');
  assert.deepEqual((await history.load()).recents.lead.map(choice => choice.model), ['p/other', 'p/lead']);
  assert.equal((await history.load()).recents.sidekick.length, 1);
  answers = [options => options.find(value => value.startsWith('lead:')), 'p/lead#high', 'Apply this setup'];
  await run();
  assert.equal(state.model.modelId, 'p/lead');
  assert.equal((await history.load()).recents.lead[0].model, 'p/lead');
});

test('interactive advisor none and Off preserve other disabled agents and saved choices', async (t) => {
  const { state, session, history, run } = await fixture(t);
  await run(text.replace('advisor=none', 'advisor=p/advisor#high'));
  session.capabilities.ui = { elicitation: true };
  let answers = [options => options.find(value => value.startsWith('advisor:')), 'None / disabled', 'Apply this setup'];
  session.ui = { select: async (_message, options) => {
    const answer = answers.shift();
    return typeof answer === 'function' ? answer(options) : answer;
  } };
  await run();
  assert.ok(state.live.disabledSubagents.includes(`${prefix}fusion-advisor`));
  assert.ok(state.live.disabledSubagents.includes('unrelated-disabled'));
  assert.equal((await history.load()).recents.advisor[0].model, 'p/advisor');
  answers = ['Turn Fusion off'];
  await run();
  assert.equal(state.agent, null);
  assert.equal((await history.load()).last.advisor, null);
});

test('escaping a submenu preserves the previous draft and allows Apply from the main menu', async (t) => {
  for (const submenu of ['method', 'model', 'effort', 'unmatched recent']) {
    const { state, session, history, run } = await fixture(t);
    await run(text);
    await run('off');
    session.capabilities.ui = { elicitation: true };
    const role = options => options.find(value => value.startsWith('lead:'));
    const abandoned = submenu === 'method' ? [null]
      : submenu === 'model' ? ['Choose new model', null]
        : submenu === 'effort' ? ['Choose new model', 'p/sidekick', null]
          : ['not a recent choice'];
    const answers = [role, 'Choose new model', 'p/lead', 'low', role, ...abandoned, 'Apply this setup'];
    session.ui = { select: async (_message, options) => {
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(options) : answer;
    } };
    await run();
    assert.equal(state.agent?.id, lead.id, submenu);
    assert.deepEqual(state.model, { modelId: 'p/lead', reasoningEffort: 'low' }, submenu);
    assert.equal((await history.load()).last.lead.effort, 'low', submenu);
  }
});

test('headless help and invalid/incomplete text never apply a remembered setup', async (t) => {
  const { state, session, history, run } = await fixture(t);
  session.capabilities.ui = { elicitation: false };
  await run();
  assert.equal(state.agent, null);
  assert.match(state.logs.at(-1), /lead=/);
  await run('sidekick=p/sidekick#low');
  assert.equal(state.agent, null);
  assert.equal((await history.load()).last, undefined);
  await run(text);
  await run('off');
  await run('lead=missing#high');
  assert.equal(state.agent, null);
  assert.equal((await history.load()).last.lead.model, 'p/lead');
  assert.equal((await history.load()).recents.lead.length, 1);
});

test('Off does not depend on worker metadata and restores an unset reasoning effort', async (t) => {
  const { state, run } = await fixture(t);
  await run(text);
  state.tasks = [{ type: 'agent', id: 'unknown', agentType: `${prefix}fusion-sidekick` }];
  state.model = { modelId: 'p/utility' };
  await run('off');
  assert.equal(state.agent, null);
  assert.equal(state.model.modelId, 'p/utility');
  assert.equal(state.model.reasoningEffort, undefined);
});

test('stable packaged agent ID controls settings even when its display name is unqualified', async (t) => {
  const { state, session, run } = await fixture(t);
  state.agents[1].name = 'fusion';
  await run(text.replace('advisor=none', 'advisor=p/advisor#high'));
  assert.equal(state.agent.id, lead.id);
  const hooks = createHooks(() => session);
  assert.match((await hooks.onUserPromptSubmitted({ sessionId: 'root' }, { sessionId: 'root' })).additionalContext, /configured and not disabled/);
});

test('Apply refuses a substituted agent selection without writing worker settings or history', async (t) => {
  const { state, session, history, run } = await fixture(t);
  session.rpc.agent.select = async () => { state.agent = { id: 'fusion', name: 'fusion', source: 'user' }; };
  await run(text);
  assert.equal(state.live, undefined);
  assert.equal((await history.load()).last, undefined);
  assert.match(state.logs.at(-1), /selection.*confirmed/);
});
