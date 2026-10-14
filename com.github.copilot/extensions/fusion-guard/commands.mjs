import { isDeepStrictEqual } from 'node:util';
import { canonicalFusionRole, fusionAgentIdentity } from './identity.mjs';
import { History, roles } from './state.mjs';
import { getUserSettings, setUserSettings } from './settings.mjs';
import { contextLimits, contextTiers, listModels, reasoningEfforts } from './models.mjs';

const usage = '/fusion lead=<model>#<effort> sidekick=<model>#<effort> [advisor=<model>#<effort>|advisor=none] [reviewer=<model>#<effort>|reviewer=none] [lead-context=default|long_context] (also sidekick-context, advisor-context, reviewer-context); /fusion apply | off | status';
const label = (choice) => choice ? `${choice.model}${choice.effort ? `#${choice.effort}` : ''}${choice.contextTier ? ` (context: ${choice.contextTier})` : ''}` : 'none';
const summary = (setup) => roles.map(role => `${role}: ${label(setup[role])}`).join(' · ');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const agentDiagnostics = (agents) => JSON.stringify(Array.isArray(agents) ? agents.map(agent => ({
  id: typeof agent?.id === 'string' ? agent.id : undefined,
  name: typeof agent?.name === 'string' ? agent.name : undefined,
  source: typeof agent?.source === 'string' ? agent.source : undefined,
  pathPresent: typeof agent?.path === 'string',
})) : { agentsType: typeof agents });

export function parseModelsArgs(args) {
  const changes = {};
  const seen = new Set();
  for (const token of args.trim().split(/\s+/)) {
    const context = /^(lead|sidekick|advisor|reviewer)-context=(default|long_context)$/.exec(token);
    if (context) {
      const [, role, contextTier] = context;
      if (seen.has(`${role}-context`)) throw new Error(`Duplicate context: ${role}.`);
      seen.add(`${role}-context`);
      changes[role] = { ...changes[role], contextTier };
      continue;
    }
    const match = /^(lead|sidekick|advisor|reviewer)=([^#\s=]+)(?:#([^#\s=]+))?$/.exec(token);
    if (!match) throw new Error(`Invalid or unknown setup argument: ${token}. ${usage}`);
    const [, role, model, effort] = match;
    if (seen.has(role)) throw new Error(`Duplicate role: ${role}.`);
    seen.add(role);
    if (model === 'none') {
      if (!['advisor', 'reviewer'].includes(role) || effort) throw new Error('Only advisor=none or reviewer=none may disable a role.');
      changes[role] = null;
    } else changes[role] = { ...changes[role], model, ...(effort ? { effort } : {}) };
  }
  for (const role of ['advisor', 'reviewer']) {
    if (seen.has(`${role}-context`) && changes[role]?.model === undefined && seen.has(role)) {
      throw new Error(`${role} none cannot have a context tier.`);
    }
  }
  return changes;
}

async function selectChoice(session, message, options, current, titles) {
  let value;
  if (typeof session.ui.elicitation === 'function') {
    const result = await session.ui.elicitation({ message, requestedSchema: {
      type: 'object', properties: { selection: { type: 'string', title: message, enum: options,
        ...(titles ? { enumNames: titles } : {}), ...(options.includes(current) ? { default: current } : {}) } },
      required: ['selection'],
    } });
    if (result.action !== 'accept') return;
    value = result.content?.selection;
  } else {
    const ordered = options.includes(current) ? [current, ...options.filter(option => option !== current)] : options;
    value = await session.ui.select(titles ? `${message}\n${titles.join('\n')}` : message, ordered);
  }
  if (value == null || value === '') return;
  return value;
}

async function switchModel(session, snapshot) {
  const result = await session.rpc.model.switchTo({ modelId: snapshot.modelId,
    reasoningEffort: snapshot.reasoningEffort ?? null, contextTier: snapshot.contextTier,
    ...(snapshot.autoTier ? { autoTier: snapshot.autoTier } : {}), requireAvailable: true });
  if (result.deferred || result.status && !['applied', 'unchanged'].includes(result.status)
    || result.persistenceError) throw new Error(`Model switch ${result.deferred ? 'deferred' : result.status ?? 'failed'}: ${result.message ?? result.persistenceError ?? 'not confirmed'}. Retry after the session is idle; setup was not recorded.`);
  const current = await session.rpc.model.getCurrent();
  if (current.modelId !== snapshot.modelId || current.reasoningEffort !== snapshot.reasoningEffort
    || snapshot.contextTier !== undefined && current.contextTier !== snapshot.contextTier
    || snapshot.autoTier !== undefined && current.autoTier !== snapshot.autoTier) {
    throw new Error('Model/effort/context changed or was substituted; setup was not recorded.');
  }
}

async function requireNoRunningWorkers(session) {
  const { tasks } = await session.rpc.tasks.list();
  if (!Array.isArray(tasks)) throw new Error('Cannot verify Fusion worker status; retry after task metadata recovers.');
  for (const task of tasks) {
    if (task?.type !== 'agent' || !['fusion-sidekick', 'fusion-advisor', 'fusion-reviewer'].includes(canonicalFusionRole(task.agentType))) continue;
    if (!['running', 'idle', 'completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('Cannot verify Fusion worker status; retry after task metadata recovers.');
    if (task.status === 'running') throw new Error(`Fusion worker ${task.id} is running; finish or stop it before changing Fusion setup.`);
  }
}

export function createCommands(getSession, history = new History()) {
  let busy = false;

  function attached(context) {
    const session = getSession();
    if (!session || session.sessionId !== context.sessionId) {
      throw new Error('Fusion command session is no longer attached.');
    }
    return session;
  }

  async function apply(session, setup, selected) {
    const models = await listModels(session, 'apply');
    for (const role of roles) {
      const choice = setup[role];
      if (!choice && ['advisor', 'reviewer'].includes(role)) continue;
      const model = models?.find(model => model.id === choice?.model);
      if (!model) throw new Error(`Choose an available ${role} model; ${choice?.model ?? role} is missing. No fallback was selected.`);
      const supported = reasoningEfforts(model);
      if (!supported.length && model.capabilities?.supports?.reasoningEffort === true) {
        throw new Error(`Reasoning support is advertised for ${choice.model}, but selectable efforts are missing. Report the CLI version; no effort was inferred.`);
      }
      if (supported.length ? !supported.includes(choice.effort) : choice.effort !== undefined) {
        throw new Error(`Choose an explicit supported ${role} effort for ${choice.model}.`);
      }
      if (choice.contextTier !== undefined && !contextTiers(model).includes(choice.contextTier)) {
        throw new Error(`Unsupported ${role} context tier for ${choice.model}; no context tier was substituted.`);
      }
    }
    const { agents } = await session.rpc.agent.list();
    const candidates = Array.isArray(agents) ? agents.filter(agent => agent?.id === 'ai4corp-fusion-bigg-boss:fusion') : [];
    if (candidates.length !== 1 || candidates[0].source !== 'plugin' || fusionAgentIdentity(candidates[0]) !== 'fusion') {
      throw new Error(`Cannot identify the packaged Fusion lead agent; no other agent was selected. Agent discovery: ${agentDiagnostics(agents)}. Report the CLI version and this identity-only diagnostic.`);
    }
    const lead = candidates[0];
    const managed = await session.rpc.managedSettings.get();
    if (managed.failClosed || !Array.isArray(managed.managedKeys)) throw new Error('Cannot verify managed settings; setup was not applied.');
    // A managed model is an overridable startup default; native switching still
    // enforces model availability and must confirm the exact requested choice.
    if (managed.managedKeys.some(key => key === 'subagents' || key.startsWith('subagents.'))) {
      throw new Error('Subagents settings are managed; ask the administrator instead of overwriting policy.');
    }
    await requireNoRunningWorkers(session);
    const { settings } = await getUserSettings(session);
    if (!object(settings) || !Object.hasOwn(settings, 'subagents')) throw new Error('Cannot read native subagents settings; no settings were written.');
    const previous = settings.subagents.value ?? {};
    if (!object(previous) || previous.agents != null && !object(previous.agents)
      || previous.disabledSubagents != null && (!Array.isArray(previous.disabledSubagents)
        || previous.disabledSubagents.some(name => typeof name !== 'string'))) throw new Error('Native subagents settings are malformed; no settings were written.');
    const subagents = { ...previous, agents: { ...previous.agents }, disabledSubagents: [...(previous.disabledSubagents ?? [])] };
    for (const role of roles.slice(1)) {
      const name = `${lead.id}-${role}`;
      const choice = setup[role];
      subagents.disabledSubagents = subagents.disabledSubagents.filter(disabled => disabled !== name);
      if (!choice) subagents.disabledSubagents.push(name);
      else subagents.agents[name] = { ...subagents.agents[name], model: choice.model,
        modelPolicy: 'required', effortLevel: choice.effort ?? 'default',
        ...(choice.contextTier !== undefined ? { contextTier: choice.contextTier } : {}) };
    }
    await session.rpc.agent.select({ name: lead.id });
    const current = (await session.rpc.agent.getCurrent()).agent;
    if (current?.id !== lead.id || current.source !== 'plugin' || fusionAgentIdentity(current) !== 'fusion') {
      throw new Error(`Packaged Fusion agent selection was not confirmed. Selected identity: ${agentDiagnostics([current])}.`);
    }
    await switchModel(session, { modelId: setup.lead.model, reasoningEffort: setup.lead.effort, contextTier: setup.lead.contextTier });
    const result = await setUserSettings(session, { subagents });
    if (result != null && (!Array.isArray(result.shadowedKeys) || result.shadowedKeys.includes('subagents'))) {
      throw new Error('Subagents settings are shadowed by legacy config.json or the write could not be confirmed. Live settings and history were not applied; the persisted write may have landed. Resolve the shadow before retrying.');
    }
    const verified = await getUserSettings(session);
    if (!isDeepStrictEqual(verified?.settings?.subagents?.value, subagents)) {
      throw new Error('Subagents settings read-back did not confirm the requested values. Live settings and history were not applied; the persisted write may have landed. Inspect native settings before retrying.');
    }
    await session.rpc.tools.updateSubagentSettings({ subagents });
    await history.record(setup, selected);
    await session.log(`Fusion applied: ${summary(setup)}`);
  }

  async function off(session) {
    if (fusionAgentIdentity((await session.rpc.agent.getCurrent()).agent) !== 'fusion') {
      await session.log('Fusion is already off; saved setup is unchanged.');
      return;
    }
    const model = await session.rpc.model.getCurrent();
    if (!model.modelId) throw new Error('Cannot preserve the current model; Fusion was not turned off.');
    await session.rpc.agent.deselect();
    if ((await session.rpc.agent.getCurrent()).agent !== null) throw new Error('Default agent selection was not confirmed.');
    const after = await session.rpc.model.getCurrent();
    if (after.modelId !== model.modelId || after.reasoningEffort !== model.reasoningEffort
      || after.contextTier !== model.contextTier || after.autoTier !== model.autoTier) await switchModel(session, model);
    await session.log('Fusion off: default agent selected; model/effort and saved setup retained. Apply explicitly to enable Fusion again.');
  }

  async function chooseModel(session, role, current) {
    const models = await listModels(session, 'picker');
    for (;;) {
      let query = '';
      if (typeof session.ui.elicitation === 'function') {
        const result = await session.ui.elicitation({
          message: `Filter ${role} models (e.g. sol 6.1; blank shows all)`,
          requestedSchema: { type: 'object', properties: { query: { type: 'string', title: 'Search models' } } },
        });
        if (result.action !== 'accept') return;
        query = result.content?.query ?? '';
      }
      if (typeof query !== 'string') throw new Error('Model filter response is invalid; no model was selected.');
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matches = models.filter(model => {
        const text = `${model.id} ${typeof model.name === 'string' ? model.name : ''}`.toLowerCase();
        return terms.every(term => text.includes(term));
      });
      if (!matches.length) {
        await session.log('No models match that filter; try another search.');
        continue;
      }
      const id = await selectChoice(session, `Choose ${role} model`, [...new Set(matches.map(model => model.id))], current);
      if (!id) return;
      const model = matches.find(model => model.id === id);
      if (!model) throw new Error('Selected model is unavailable or does not match the filter.');
      return model;
    }
  }

  async function pick(session, saved) {
    const draft = { advisor: null, reviewer: null, ...saved.last };
    const selected = new Set();
    const active = fusionAgentIdentity((await session.rpc.agent.getCurrent()).agent) === 'fusion';
    for (;;) {
      const action = await session.ui.select(`Fusion setup (draft): ${summary(draft)}`, [
        ...(active ? ['Turn Fusion off'] : []),
        ...roles.map(role => `${role}: ${label(draft[role])}`), 'Apply this setup', 'Cancel',
      ]);
      if (!action || action === 'Cancel') return;
      if (action === 'Turn Fusion off') return off(session);
      if (action === 'Apply this setup') return apply(session, draft, [...selected]);
      const role = roles.find(role => action.startsWith(`${role}:`));
      if (!role) continue;
      const recent = saved.recents[role];
      const method = await selectChoice(session, `Choose ${role}${role === 'reviewer' ? ' (optional; prefer a different model family from lead/author where practical; recommendation only)' : ''}`, [
        ...recent.map(label), 'Choose new model', ...(['advisor', 'reviewer'].includes(role) ? ['None / disabled'] : []),
      ], draft[role] ? label(draft[role]) : 'None / disabled');
      if (!method) continue;
      if (method === 'None / disabled') draft[role] = null;
      else if (method === 'Choose new model') {
        const model = await chooseModel(session, role, draft[role]?.model);
        if (!model) continue;
        const id = model.id;
        const supported = reasoningEfforts(model);
        if (!supported.length && model.capabilities?.supports?.reasoningEffort === true) {
          throw new Error('Reasoning support is advertised but selectable efforts are missing; report the CLI version.');
        }
        const current = draft[role]?.model === id ? draft[role] : undefined;
        const effort = supported.length ? await selectChoice(session, `Choose ${role} reasoning effort`, supported, current?.effort) : undefined;
        if (supported.length && !effort) continue;
        const tiers = contextTiers(model);
        const titles = tiers.map(tier => {
          const { inputTokens, contextTokens } = contextLimits(model, tier);
          const name = tier === 'default' ? 'Default' : 'Long context';
          const context = contextTokens ? `${contextTokens.toLocaleString('en-US')}-token context` : 'context limit not reported';
          const input = inputTokens ? `max input ${inputTokens.toLocaleString('en-US')} tokens` : 'input limit not reported';
          return `${name} — ${context}; ${input}`;
        });
        const contextTier = tiers.length ? await selectChoice(session, `Choose ${role} context length`, tiers, current?.contextTier, titles) : undefined;
        if (tiers.length && !contextTier) continue;
        draft[role] = { model: id, ...(effort ? { effort } : {}), ...(contextTier ? { contextTier } : {}) };
      } else {
        const choice = recent.find(choice => label(choice) === method);
        if (!choice) continue;
        draft[role] = choice;
      }
      selected.add(role);
    }
  }

  return [{ name: 'fusion', description: 'Choose and apply Fusion models, or off/status', handler: async (context) => {
    const session = attached(context);
    if (busy) { await session.log('Fusion setup is already open or being applied; finish it first.'); return; }
    busy = true;
    try {
      const args = context.args.trim();
      const saved = await history.load();
      if (args === 'off') return await off(session);
      if (args === 'status') {
        const active = fusionAgentIdentity((await session.rpc.agent.getCurrent()).agent) === 'fusion';
        await session.log(`Fusion ${active ? 'on' : 'off'}; saved setup: ${saved.last ? summary(saved.last) : 'none'}`);
        return;
      }
      if (args === 'apply') return await apply(session, saved.last ?? {}, []);
      if (args) {
        const changes = parseModelsArgs(args);
        const setup = { advisor: null, reviewer: null, ...saved.last };
        for (const [role, change] of Object.entries(changes)) {
          setup[role] = change === null ? null : { ...(change.model ? {} : setup[role]), ...change };
        }
        return await apply(session, setup, Object.keys(changes));
      }
      const interactive = session.capabilities?.ui?.elicitation;
      if (interactive === true || interactive === undefined && typeof session.ui?.select === 'function') return await pick(session, saved);
      await session.log(usage);
    } catch (error) {
      await session.log(`Fusion command failed: ${error.message} Host RPC changes are not transactional; inspect status before retrying.`);
    } finally { busy = false; }
  } }];
}
