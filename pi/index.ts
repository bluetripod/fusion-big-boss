import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, type Usage } from '@earendil-works/pi-ai';
import { loadBriefing } from '../shared/briefing.mjs';
import { contextLabel, contextOptions, splitContext, withContext } from '../shared/context.mjs';
import { activeState, choose, History, label, parseChoice, resolveChoice, roles, validateSetup, type Changes, type Draft, type Role } from './state.ts';
import { assertChildRequest, allowedLeadCall, delegateSchema, LiveWorkers, openOwned, resultText, runChild, textResult, waitForTurn, workerDescription, workerSchema, type ChildRole, type Launch, type WorkerTurn } from './worker.ts';
import { RunRegistry, runStatus } from './viewer.ts';
import { createViewer } from './viewer-ui.ts';
import { collectUsage } from './usage.ts';
import { formatUsage } from '../shared/usage.mjs';

const minimal = 'For implementation, understand the request and trace relevant code before choosing a solution. Reuse existing code first, then standard library/native platform features, then installed dependencies. Prefer the smallest clear root-cause change; never omit requested behavior, trust-boundary validation, data-loss protection, security, accessibility, or a useful regression check.';
const leadPrompt = `Fusion lead: own interpretation, the plan, consequential decisions, security judgment, review and final answer. Assess whether the next decision needs source evidence, then read and interpret focused text yourself (explicit offset >=1, limit 1..350). Reuse sufficient current context without ritual reads. File-location lookups specify roots and concrete filenames/symbols/patterns; workers return locations only, not excerpts or analysis. You may implement directly, including multi-file changes; file count alone never requires delegation. Delegate only fully specified coding changes with target files/symbols, exact desired changes, constraints and checks, or exact Git/check commands and approved known-URL retrieval jobs. Supply inputs, actions, completion and stop conditions; keep ambiguous exploration, diagnosis and next actions here. The user alone selects every role model/effort/context budget via /fusion; no fallback. Use background sidekicks only when precise handoffs are likely to save time or cost. Omit sessionID for a new independent worker; pass its explicit confirmed sessionID for related continuation. Multiple sidekicks share the user's selected sidekick model, effort and context budget, with one task per session at a time. Independent specified jobs may run concurrently; coordinate non-conflicting writes and stable-tree checks. The optional advisor reads source and may use its own independent evidence-only sidekicks, but never codes or owns the decision. Invoke the optional reviewer ONLY WHEN THE USER ASKS for Fusion reviewer code review, never automatically after coding or fixes. Prepare a frozen-source packet and delegate in background; retain confirmed same-change review context, fresh for unrelated work. Missing-evidence follow-ups stay within that review; a separate review/re-review needs another request. Advisor/reviewer evidence sidekicks remain read-only and separate from coding workers; the reviewer retains one persistent evidence sidekick. Use bounded read and edit/write; no direct shell/search.\n\n${minimal}`;
const displayChoice = (value?: string) => { const ref = value && parseChoice(value); return ref ? label(ref) : value ?? 'off'; };
const choices = (setup?: Draft) => roles.map(role => `${role}: ${displayChoice(setup?.[role])}`).join(', ');
const token = (ctx: ExtensionContext) => {
  const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === 'fusion.pi.setup');
  return entry?.id;
};
const rootDir = (agentDir: string, cwd: string, root: string) => join(agentDir, 'fusion', createHash('sha256').update(cwd).digest('hex'), 'children', root);

export function parseModelsArgs(args: string): Changes {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('Usage: /fusion-models provider/model#effort provider/model#effort [advisor=provider/model#effort|off] [reviewer=provider/model#effort|off].');
  const changes: Changes = { lead: parts[0], sidekick: parts[1] };
  for (const part of parts.slice(2)) {
    const match = /^(advisor|reviewer)=(.+)$/.exec(part);
    const role = match?.[1] as 'advisor' | 'reviewer';
    if (!match || changes[role] !== undefined) throw new Error(`Unknown or repeated Fusion option: ${part}`);
    changes[role] = match[2] === 'off' ? null : match[2];
  }
  return changes;
}

export function createFusion(pi: ExtensionAPI, launch: (options: Launch) => ReturnType<typeof runChild> = runChild, agentDir = getAgentDir()) {
  const inFlight = new Map<string, Set<AbortController>>();
  const running = new Set<Promise<unknown>>();
  const turns = new Map<string, WorkerTurn>();
  const configuring = new Set<string>();
  let generation = 0;
  const runs = new RunRegistry();
  const workers = new LiveWorkers();
  const viewer = createViewer(runs);
  const openAgents = (ctx: ExtensionContext) => viewer.open(ctx, rootDir(agentDir, ctx.cwd, ctx.sessionManager.getSessionId()));
  pi.registerCommand('usage', { description: 'Recorded session and Fusion subagent usage by model', handler: async (_args, ctx) => {
    try {
      const result = await collectUsage(ctx, rootDir(agentDir, ctx.cwd, ctx.sessionManager.getSessionId()));
      ctx.ui.notify(formatUsage(result.report, result.sessions, result.notes), 'info');
    } catch (error) { ctx.ui.notify(`Usage unavailable: ${String(error)}`, 'error'); }
  } });
  pi.registerCommand('fusion-agents', { description: 'View live and finished subagent runs', handler: async (_args, ctx) => { await openAgents(ctx); } });
  pi.registerShortcut?.('alt+a', { description: 'View Fusion subagents', handler: openAgents });
  const briefing = loadBriefing();
  function current(ctx: ExtensionContext) { return activeState(ctx.sessionManager.getBranch()); }
  function root(ctx: ExtensionContext) { return ctx.sessionManager.getSessionId(); }
  function active(ctx: ExtensionContext) { const state = current(ctx); return !!state.setup && !state.disabled; }
  function matchesLead(ctx: ExtensionContext, choice: string) {
    return !!ctx.model && `${ctx.model.provider}/${ctx.model.id}#${pi.getThinkingLevel()}` === splitContext(choice).choice;
  }
  function checkLead(ctx: ExtensionContext, choice: string) {
    if (!matchesLead(ctx, choice)) throw new Error('Lead model or effort no longer matches the user-applied Fusion setup; reapply /fusion.');
    if (ctx.model?.contextWindow !== resolveChoice(choice, ctx.modelRegistry).model.contextWindow) throw new Error('Lead context budget changed; reapply /fusion before continuing.');
  }
  async function restoreContext(ctx: ExtensionContext, native = false) {
    const state = current(ctx), chosen = state.setup?.lead;
    if (!chosen || !ctx.model || state.disabled && !native) return;
    const ref = parseChoice(chosen), useNative = native;
    if (useNative ? ctx.model.provider !== ref?.provider || ctx.model.id !== ref.id : !matchesLead(ctx, chosen)) return;
    const lead = resolveChoice(useNative ? splitContext(chosen).choice : chosen, ctx.modelRegistry);
    if (ctx.model?.contextWindow === lead.model.contextWindow) return;
    if (!ctx.isIdle() || configuring.has(root(ctx))) throw new Error('Lead context budget changed; finish the running turn before restoring /fusion.');
    const oldModel = ctx.model!, oldEffort = pi.getThinkingLevel();
    const effort = useNative ? oldEffort : lead.effort;
    try {
      if (!await pi.setModel({ ...lead.model })) throw new Error('Failed to restore lead context budget: authentication unavailable.');
      pi.setThinkingLevel(effort);
      if (ctx.model?.provider !== lead.model.provider || ctx.model.id !== lead.model.id || ctx.model.contextWindow !== lead.model.contextWindow || pi.getThinkingLevel() !== effort) throw new Error('Lead context budget was clamped or substituted; reapply /fusion.');
    } catch (error) {
      if (!await pi.setModel(oldModel)) throw new Error('Fusion context restoration failed and previous lead model could not be restored.');
      pi.setThinkingLevel(oldEffort);
      throw error;
    }
  }
  function refreshStatus(ctx: ExtensionContext) {
    const state = current(ctx);
    ctx.ui.setStatus('fusion', state.setup ? `Fusion: ${state.disabled ? 'off' : 'on'}` : undefined);
  }
  const restoreBranch = async (_event: unknown, ctx: ExtensionContext) => {
    refreshStatus(ctx);
    try { await restoreContext(ctx); } catch (error) { ctx.ui.notify(String(error), 'error'); }
  };
  pi.on('session_start', restoreBranch);
  pi.on('session_tree', restoreBranch);
  const history = (ctx: ExtensionContext) => new History(agentDir, ctx.cwd);
  async function abortAll() {
    generation++;
    for (const controllers of inFlight.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...running]);
    viewer.clear();
  }
  pi.on('session_before_switch', abortAll);
  pi.on('session_before_fork', abortAll);
  pi.on('session_before_tree', abortAll);
  pi.on('session_shutdown', abortAll);

  async function apply(ctx: ExtensionCommandContext, draft: Draft, selected: Partial<Record<Role, boolean>>) {
    const id = root(ctx);
    if (!ctx.isIdle()) throw new Error('Wait for the running root turn to finish before applying Fusion setup.');
    if (configuring.has(id)) throw new Error('Fusion setup is already being applied for this root.');
    if (inFlight.get(id)?.size) throw new Error('Wait for active children to finish before changing Fusion setup.');
    configuring.add(id);
    try {
      const setup = validateSetup(draft, ctx.modelRegistry);
      const oldModel = ctx.model, oldEffort = pi.getThinkingLevel();
      const lead = resolveChoice(setup.lead, ctx.modelRegistry);
      try {
        if (!await pi.setModel(lead.model)) throw new Error('Failed to set lead model: authentication unavailable.');
        pi.setThinkingLevel(lead.effort);
        if (ctx.model?.provider !== lead.model.provider || ctx.model.id !== lead.model.id || ctx.model.contextWindow !== lead.model.contextWindow || pi.getThinkingLevel() !== lead.effort) throw new Error('Lead model/effort/context budget was clamped or substituted; setup not applied.');
        await history(ctx).record(setup, selected);
        pi.appendEntry('fusion.pi.setup', setup);
        refreshStatus(ctx);
        ctx.ui.notify(`Fusion active: ${choices(setup)}`, 'info');
      } catch (error) {
        if (oldModel) { if (!await pi.setModel(oldModel)) throw new Error('Fusion setup failed and previous lead model could not be restored.'); pi.setThinkingLevel(oldEffort); }
        throw error;
      }
    } finally { configuring.delete(id); }
  }

  async function pick(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) { ctx.ui.notify('Use /fusion-models in a noninteractive client.', 'warning'); return; }
    const stored = await history(ctx).load();
    const start = current(ctx).setup ?? stored.last;
    let draft: Draft = { ...start };
    const selected: Partial<Record<Role, boolean>> = {};
    async function pickContext(role: Role, value: string) {
      const ref = parseChoice(value);
      const native = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!native) throw new Error('Model is no longer available; choose again.');
      const defaultLabel = `Default (${contextLabel(native.contextWindow)})`;
      const budgets = contextOptions(native.contextWindow);
      const answer = await ctx.ui.select(`Choose ${role} context budget (local compaction target, not a pricing tier; Escape discards setup)`, [defaultLabel, ...budgets.map(contextLabel)]);
      return answer === undefined ? undefined : withContext(value, answer === defaultLabel ? undefined : budgets.find(budget => answer === contextLabel(budget)));
    }
    for (;;) {
      const state = current(ctx);
      const action = await ctx.ui.select(state.disabled ? 'Fusion is off in this session' : 'Fusion setup (Escape discards all changes)', [
        ...(state.setup && !state.disabled ? ['Turn Fusion off'] : []),
        ...(state.setup && state.disabled ? ['Enable saved Fusion setup'] : []),
        ...roles.map(role => `${role}: ${displayChoice(draft[role])}`), 'Use last setup', 'Apply this setup',
      ]);
      if (!action) return;
      if (action === 'Turn Fusion off') {
        if (!ctx.isIdle() || inFlight.get(root(ctx))?.size || configuring.has(root(ctx))) throw new Error('Finish or stop active Fusion work before turning Fusion off.');
        await restoreContext(ctx, true);
        pi.appendEntry('fusion.pi.disabled', {});
        refreshStatus(ctx);
        ctx.ui.notify('Fusion is off in this session. Native context restored for the unchanged lead model/effort; conversation and saved setup are unchanged.', 'info');
        return;
      }
      if (action === 'Enable saved Fusion setup') {
        await apply(ctx, state.setup!, {});
        return;
      }
      if (action === 'Use last setup') {
        if (!stored.last) { ctx.ui.notify('No last setup exists.', 'warning'); continue; }
        draft = { ...stored.last }; for (const role of roles) selected[role] = !!draft[role]; continue;
      }
      if (action === 'Apply this setup') { await apply(ctx, draft, selected); return; }
      const role = roles.find(name => action.startsWith(`${name}:`));
      if (!role) continue;
      const recents = stored.recents[role].map(value => {
        try { resolveChoice(value, ctx.modelRegistry); return displayChoice(value); }
        catch { return `${displayChoice(value)} (unavailable)`; }
      });
      const option = await ctx.ui.select(`Choose ${role} (Escape discards setup)${role === 'reviewer' ? '; prefer a different model family from lead/author, not merely provider or size (advice only)' : ''}`, [...recents, 'Choose new model', ...(draft[role] ? ['Change context budget'] : []), ...(role === 'advisor' || role === 'reviewer' ? [`Turn ${role} off`] : [])]);
      if (!option) return;
      if (option === `Turn ${role} off`) { draft = choose(draft, { [role]: null }); selected[role] = true; continue; }
      if (option === 'Change context budget') {
        const value = await pickContext(role, draft[role]!);
        if (value === undefined) return;
        try { resolveChoice(value, ctx.modelRegistry); draft = choose(draft, { [role]: value }); selected[role] = true; }
        catch (error) { ctx.ui.notify(String(error), 'warning'); }
        continue;
      }
      if (option === 'Choose new model') {
        const filter = await ctx.ui.input(`${role} model search (provider/model or substring)`, 'Search available models');
        if (filter === undefined) return;
        const matches = ctx.modelRegistry.getAvailable().filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 100);
        if (!matches.length) { ctx.ui.notify('No matching models; try another search.', 'warning'); continue; }
        const item = await ctx.ui.select(`Choose ${role} model (up to 100 matches)`, matches.map(model => `${model.provider}/${model.id}`));
        if (!item) return;
        const slash = item.indexOf('/');
        const model = ctx.modelRegistry.find(item.slice(0, slash), item.slice(slash + 1));
        if (!model) { ctx.ui.notify('Model is no longer available.', 'warning'); continue; }
        const effort = await ctx.ui.select(`Choose ${role} effort`, getSupportedThinkingLevels(model));
        if (!effort) return;
        const value = await pickContext(role, `${item}#${effort}`);
        if (value === undefined) return;
        try { resolveChoice(value, ctx.modelRegistry); draft = choose(draft, { [role]: value }); selected[role] = true; }
        catch (error) { ctx.ui.notify(String(error), 'warning'); }
      } else {
        if (option.endsWith(' (unavailable)')) { ctx.ui.notify('Unavailable recent; choose a new model instead.', 'warning'); continue; }
        try { resolveChoice(option, ctx.modelRegistry); draft = choose(draft, { [role]: option }); selected[role] = true; }
        catch (error) { ctx.ui.notify(String(error), 'warning'); }
      }
    }
  }
  pi.registerCommand('fusion', { description: 'Choose and explicitly apply Fusion role models, efforts and context budgets', handler: async (_args, ctx) => { try { await pick(ctx); } catch (error) { ctx.ui.notify(String(error), 'error'); } } });
  pi.registerCommand('fusion-models', { description: 'Explicit text setup: /fusion-models <lead> <sidekick> [advisor=...] [reviewer=...]; append @100k for a local context budget', handler: async (args, ctx) => { try { await apply(ctx, choose(current(ctx).setup ?? {}, parseModelsArgs(args)), { lead: true, sidekick: true, ...(args.includes('advisor=') ? { advisor: true } : {}), ...(args.includes('reviewer=') ? { reviewer: true } : {}) }); } catch (error) { ctx.ui.notify(String(error), 'error'); } } });
  function reviewerPreflight(ctx: ExtensionContext, sessionID?: string) {
    const id = root(ctx), state = current(ctx);
    if (ctx.sessionManager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.owner')) throw new Error('Only the root lead can request a reviewer; nested agents are not allowed.');
    if (configuring.has(id)) throw new Error('Fusion setup is being applied; wait for Apply.');
    if (!state.setup || state.disabled) throw new Error('Fusion must be active in this branch before review.');
    if (!state.setup.reviewer) throw new Error('Fusion reviewer not configured. Ask the user to use /fusion; never choose a fallback.');
    checkLead(ctx, state.setup.lead);
    resolveChoice(state.setup.reviewer, ctx.modelRegistry);
    if (sessionID) {
      if (!state.reviewers.includes(sessionID)) throw new Error('Reviewer ID must be a confirmed direct review child of this root.');
      openOwned(ctx.cwd, rootDir(agentDir, ctx.cwd, id), sessionID, id, 'reviewer');
    }
  }

  pi.on('before_agent_start', async (event, ctx) => {
    if (!active(ctx)) return;
    event.systemPromptOptions.sections['fusion_role'] = `${leadPrompt}\n\n${(await briefing).full}\n\nUse fusion_worker to inspect, message or cancel your own running workers by confirmed sessionID. Wrap-up is an ordinary message asking for findings, changed paths, checks, blockers and unfinished work; there is no special action or timer. Sidekick and reviewer delegation requires background: true. Same-session continuations wait for the prior task; independent reviewers may run concurrently. Use background: true for advisor consultations when you need to retain control; foreground remains available. Messages are admitted, not confirmed read; cancellation is cooperative, not rollback.`;
    // This SDK hook cannot cancel a start; never repair cap drift by mutating a streaming model.
    try { await restoreContext(ctx); checkLead(ctx, current(ctx).setup!.lead); }
    catch (error) { ctx.ui.notify(String(error), 'error'); }
  });
  pi.on('input', async (_event, ctx) => {
    if (!active(ctx)) return;
    const chosen = current(ctx).setup?.lead;
    if (!chosen) return;
    if (!matchesLead(ctx, chosen)) {
      ctx.ui.notify('Fusion lead model or effort changed outside /fusion. Reapply the human choices with /fusion before prompting; no fallback was selected.', 'error');
      return { action: 'handled' as const };
    }
    try { await restoreContext(ctx); }
    catch (error) { ctx.ui.notify(String(error), 'error'); return { action: 'handled' as const }; }
  });
  pi.on('tool_call', (event, ctx) => active(ctx) ? allowedLeadCall(event.toolName, event.input) : undefined);
  pi.on('tool_result', (event, ctx) => {
    if (active(ctx) && event.toolName === 'read' && event.content.some(part => part.type === 'image')) {
      return { content: [{ type: 'text' as const, text: 'Images are not available to the Fusion lead; delegate to a scoped child.' }], isError: true };
    }
  });


  function delegate(ctx: ExtensionContext, role: ChildRole, task: string, background: boolean, resume: string | undefined, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Delegation was cancelled before it started.');
    const id = root(ctx);
    if (configuring.has(id)) throw new Error('Fusion setup is being applied; wait for Apply to complete before delegation.');
    const initial = current(ctx);
    if (initial.disabled) throw new Error('Fusion is off in this session. Re-enable it with /fusion before delegating.');
    const setup = initial.setup;
    if (!setup) throw new Error('Fusion not active in this branch. Ask the user to use /fusion.');
    const choice = setup[role];
    if (!choice) throw new Error(`Fusion ${role} not configured. Ask the user to use /fusion; never choose a fallback.`);
    checkLead(ctx, setup.lead);
    const anchor = token(ctx);
    const epoch = generation;
    let reservation = resume ? `${id}/${resume}` : undefined;
    const previous = reservation ? turns.get(reservation) : undefined;
    if (role === 'sidekick' && resume) {
      if (!initial.sidekicks.includes(resume)) throw new Error('Sidekick ID must be a confirmed child of this root.');
    } else if (role === 'advisor' && resume) {
      if (!initial.advisors.includes(resume)) throw new Error('Advisor ID must be a confirmed direct consultation child of this root.');
    } else if (role === 'reviewer') {
      reviewerPreflight(ctx, resume);
    }
    const controller = new AbortController();
    if (!inFlight.has(id)) inFlight.set(id, new Set());
    inFlight.get(id)!.add(controller);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const canConfirm = () => generation === epoch && root(ctx) === id && token(ctx) === anchor;
    const childDir = rootDir(agentDir, ctx.cwd, id);
    viewer.track(ctx);
    const run = runs.add(role, task);
    let resolveStart: (value: string) => void = () => {};
    let rejectStart: (reason: unknown) => void = () => {};
    const started = new Promise<string>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    if (!background) void started.catch(() => {});
    const work = (async () => {
      try {
        const instructions = await briefing;
        await waitForTurn(previous, controller);
        if (!canConfirm() || configuring.has(id) || !active(ctx)) throw new Error('Parent root, branch or setup changed; queued delegation discarded.');
        const state = current(ctx);
        const owned = role === 'sidekick' ? state.sidekicks : role === 'advisor' ? state.advisors : state.reviewers;
        if (resume && !owned.includes(resume)) throw new Error('Worker must still be a confirmed child of this root/branch.');
        checkLead(ctx, setup.lead);
        resolveChoice(choice, ctx.modelRegistry);
        if (role !== 'sidekick') resolveChoice(setup.sidekick, ctx.modelRegistry);
        if (role === 'reviewer') reviewerPreflight(ctx, resume);
        const data = await launch({ cwd: ctx.cwd, root: id, dir: childDir, agentDir, role, choice, task, resume, signal: controller.signal,
          sidekickChoice: setup.sidekick, workers,
          registry: ctx.modelRegistry, briefing: role === 'reviewer' ? instructions.reviewer : instructions.completion,
          onStarted: childID => {
            if (background) signal?.removeEventListener('abort', cancel);
            if (!resume) { reservation = `${id}/${childID}`; turns.set(reservation, { work, signal: controller.signal }); }
            run.sessionID = childID; resolveStart(childID);
          },
          onSessionReady: (session, steer) => { runs.attach(run, session); workers.attach(id, run, session, controller, canConfirm, steer); },
          onConfirmed: childID => {
            // Before-navigation hooks drain workers while the original branch is
            // still current. Retain history flushed by abort, but never deliver it.
            if (root(ctx) !== id || token(ctx) !== anchor) return;
            if (!resume) pi.appendEntry('fusion.pi.child', { role, id: childID });
          },
        });
        if (!canConfirm()) throw new Error('Parent root or branch changed; child completion discarded.');
        if (controller.signal.aborted) throw new Error('Cancellation requested; child run ended.');
        runs.finish(run, data.text);
        return { text: `${role} sessionID: ${data.id}\n${await resultText(data.text, childDir)}`, usage: data.usage };
      } catch (error) {
        runs.finish(run, undefined, error, controller.signal.aborted);
        rejectStart(error);
        throw error;
      } finally {
        if (run.sessionID) workers.release(run.sessionID);
        signal?.removeEventListener('abort', cancel);
        const set = inFlight.get(id); set?.delete(controller); if (!set?.size) inFlight.delete(id);
        if (reservation && turns.get(reservation)?.signal === controller.signal) turns.delete(reservation);
      }
    })();
    if (reservation) turns.set(reservation, { work, signal: controller.signal });
    running.add(work);
    void work.finally(() => running.delete(work)).catch(() => {});
    if (background) {
      // Background usage cannot be included in the already-finished initiating tool result.
      const deliver = async (text: string, usage?: Usage) => {
        if (!canConfirm()) return;
        await restoreContext(ctx);
        if (!canConfirm()) return;
        checkLead(ctx, setup.lead);
        pi.sendMessage({ customType: 'fusion.pi.background-result', content: text, display: true, details: { role, usage } }, { triggerTurn: true, deliverAs: 'followUp' });
        ctx.ui.notify(`Fusion ${role} background result delivered to the lead.`, 'info');
      };
      const completion = work.then(value => deliver(value.text, value.usage), error => deliver(`Fusion ${role} ${controller.signal.aborted ? 'cancellation requested; run ended' : 'failed'}: ${String(error)}\n${runStatus(run)}`));
      void completion.catch(error => ctx.ui.notify(`Could not deliver Fusion background result: ${String(error)}`, 'error'));
      return started.then(childID => ({ text: `Fusion ${role} started in background; sessionID: ${childID}. Result will arrive in this conversation.`, usage: undefined }));
    }
    return work;
  }

  pi.registerTool({ name: 'fusion_worker', label: 'Fusion worker controls', description: workerDescription, parameters: workerSchema,
    async execute(_callID, params, _signal, _update, ctx) {
      if (ctx.sessionManager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.owner')) throw new Error('Only the root lead can use these controls; nested callers use their own evidence controls.');
      if (!active(ctx)) throw new Error('Fusion must be active in this branch.');
      return textResult(await workers.control(params, root(ctx), id => {
        const state = current(ctx);
        const role = state.sidekicks.includes(id) ? 'sidekick' : state.advisors.includes(id) ? 'advisor' : state.reviewers.includes(id) ? 'reviewer' : undefined;
        if (!role) throw new Error('Worker must be a confirmed direct child of this root/branch.');
        return openOwned(ctx.cwd, rootDir(agentDir, ctx.cwd, root(ctx)), id, root(ctx), role);
      }));
    },
  });

  pi.registerTool({ name: 'fusion_delegate', label: 'Fusion delegation', description: 'Start independent sidekicks with background: true only for fully specified coding, location-only file lookups or exact command/retrieval jobs; keep ambiguous exploration and diagnosis in the lead. Omit sessionID for a new worker; pass an explicit confirmed sessionID for related continuation, serialized behind its prior task. All sidekicks share the user-selected model/effort/context; coordinate non-conflicting writes and stable-tree checks. Optional read-only advisor supports background: true to retain control, or foreground (default), and may use its own independent background evidence sidekicks. Use fusion_worker for status, steering messages and cancellation while work runs. Invoke reviewer with background: true ONLY WHEN THE USER ASKS for Fusion reviewer code review, never automatically after coding or fixes; prepare a frozen-source packet and select confirmed same-change context, fresh for unrelated work. Independent reviewers may run concurrently. Advisor/reviewer cannot code; their evidence jobs return directly to them. Each reviewer retains one persistent evidence sidekick. Separate review/re-review needs another request. No model selection via arguments.', parameters: delegateSchema,
    async execute(_callId, params, signal, _update, ctx) {
      assertChildRequest(params.role, params);
      const message = await delegate(ctx, params.role, params.task, params.background ?? params.role !== 'advisor', params.sessionID, signal);
      return textResult(message.text, message.usage);
    },
  });
}

export default createFusion;
