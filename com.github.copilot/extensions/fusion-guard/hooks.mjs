import { open, stat } from 'node:fs/promises';
import { decideTool, decideEvidenceTool, isGuardedTool, isTextSample, isWebTool } from './policy.mjs';
import { containsGitCommand } from '../../../shared/git-command.mjs';
import { createRoleResolver } from './roles.mjs';
import { advisorRoleForLead, canonicalFusionRole, fusionAgentIdentity } from './identity.mjs';
import { createCommands } from './commands.mjs';
import { roleAvailability } from './availability.mjs';
import { createCancelTool } from './cancel.mjs';
import { createWorkerSupervision } from './supervision.mjs';

const COMMAND_TOOLS = new Set(['bash', 'powershell', 'local_shell', 'write_bash', 'write_powershell']);
const gitFromInput = (input) => COMMAND_TOOLS.has(input.toolName)
  && containsGitCommand(input.toolArgs?.[input.toolName.startsWith('write_') ? 'input' : 'command']);
const denyGit = () => ({
  permissionDecision: 'deny',
  permissionDecisionReason: 'Cannot verify this Fusion caller as the sidekick; Git commands are denied until role/ancestry metadata recovers.',
});

const unavailableDecision = (lastKnownFusion, taskOverride = false, descendant = false) => ({
  permissionDecision: 'deny',
  permissionDecisionReason: (lastKnownFusion
    ? 'Cannot verify the active agent: last confirmed role was Fusion. This foreground tool is temporarily denied; retry after agent metadata recovers or repair the CLI connection. Delegate to the sidekick if available.'
    : 'Cannot verify the selected agent for this foreground session yet. This tool is temporarily denied until identity becomes available; retry after agent metadata recovers or repair the CLI connection.')
    + (taskOverride ? ' Use native /subagents settings for model and effort; omit task model, reasoning_effort, and context_tier overrides.' : '')
    + (descendant ? ' Cannot verify whether this descendant delegation belongs to the Fusion tree; retry after root identity recovers.' : ''),
});

const denyFollowup = (reason) => ({
  permissionDecision: 'deny',
  permissionDecisionReason: `${reason} Retry with an explicit agent_id for a confirmed, same-caller Fusion worker after task metadata recovers.`,
});

// SDK TaskStatus: idle waits for input; completed/failed/cancelled are terminal.
const TASK_STATUSES = new Set(['running', 'idle', 'completed', 'failed', 'cancelled']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function checkWorkerStatus(tasks) {
  for (const task of tasks) {
    if (!TASK_STATUSES.has(task.status)) return denyFollowup(`Cannot verify worker status for agent_id: ${task.id}.`);
    if (TERMINAL_STATUSES.has(task.status)) return denyFollowup(`Worker ${task.id} is terminal; native write_agent accepts only running or idle background agents. Start a new task and carry forward needed evidence.`);
    if (task.executionMode && task.executionMode !== 'background') return denyFollowup('Native write_agent supports background workers only.');
  }
}

const checkRoleConfiguration = async (session, targetName) => (await roleAvailability(session, targetName)).decision;
const advisorContext = {
  disabled: 'Fusion advisor: disabled in /subagents. Continue without consulting it. The user can toggle it there.',
  available: 'Fusion advisor: configured and not disabled in /subagents; optional. Use only the user-selected model and effort.',
  unconfigured: 'Fusion advisor: not configured for consultation in /subagents. Continue ordinary Fusion work without it.',
  unknown: 'Fusion advisor: status unavailable from /subagents settings. Continue ordinary Fusion work without consulting it; do not guess.',
};

function requestedAgentIds(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const selectors = ['agent_id', 'agent_ids', 'scope'].filter((key) => Object.hasOwn(args, key));
  if (selectors.length !== 1 || selectors[0] === 'scope') return null;
  const ids = selectors[0] === 'agent_id' ? [args.agent_id] : args.agent_ids;
  if (!Array.isArray(ids) || ids.length === 0
    || ids.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(ids).size !== ids.length) return null;
  return ids;
}

export async function inspectTextTarget(path, fs = { stat, open }) {
  try {
    const info = await fs.stat(path);
    if (!info.isFile()) return { kind: info.isDirectory() ? 'directory' : 'unreadable' };
    const file = await fs.open(path, 'r');
    try {
      const sample = Buffer.alloc(4096 + 3);
      const { bytesRead } = await file.read(sample, 0, sample.length, 0);
      const atEof = bytesRead < sample.length || info.size === bytesRead;
      return { kind: isTextSample(path, sample.subarray(0, bytesRead), atEof) ? 'text' : 'image' };
    } finally {
      await file.close();
    }
  } catch {
    return { kind: 'unreadable' };
  }
}

export function createHooks(getSession, inspect = inspectTextTarget, roles = createRoleResolver(getSession)) {
  let rootSessionId;
  let attachment;
  let lastKnownFusion;
  const pendingSidekicks = new Map();
  const cancellations = new Map();
  const writes = new Map();
  let subscriptions = [];
  let supervision;

  const sameTask = (a, b) => a?.id === b?.id && a?.toolCallId === b?.toolCallId && a?.startedAt === b?.startedAt;
  const cancellationFor = task => {
    const record = cancellations.get(task?.id);
    return record && sameTask(record.task, task) ? record : undefined;
  };
  const cancellationDecision = () => denyFollowup('Worker cancellation was requested; no further evidence work or running-worker messages are admitted.');

  function syncAttachment() {
    const session = getSession();
    const root = session?.sessionId;
    if (attachment !== session || rootSessionId !== root) {
      supervision?.stop();
      attachment = session;
      rootSessionId = root;
      lastKnownFusion = undefined;
      pendingSidekicks.clear();
      cancellations.clear(); writes.clear();
      subscriptions.forEach(off => off());
      // A successful native continuation reopens admission. Correlate its exact
      // execution with the cancellation generation, never an old post-hook reply.
      subscriptions = typeof session?.on === 'function' ? [session.on('tool.execution_start', event => {
        if (getSession() !== session || event.data?.toolName !== 'write_agent') return;
        const record = cancellations.get(event.data.arguments?.agent_id);
        if (record && !record.pending) writes.set(event.data.toolCallId, record);
      }), session.on('tool.execution_complete', event => {
        if (getSession() !== session) return;
        const record = writes.get(event.data?.toolCallId);
        writes.delete(event.data?.toolCallId);
        if (event.data?.success && record && cancellations.get(record.task.id) === record) cancellations.delete(record.task.id);
      })] : [];
      supervision = createWorkerSupervision(getSession, roles, task => Boolean(cancellationFor(task)));
      supervision.start();
    }
    return session;
  }
  syncAttachment();

  async function checkEvidenceCaller(session, origin, root) {
    const caller = roles.configurationForOrigin(origin);
    const available = await roleAvailability(session, caller?.name);
    if (getSession() !== session || session.sessionId !== root) return denyFollowup('Fusion session is no longer attached.');
    if (available.decision) return available.decision;
    const { tasks } = await session.rpc.tasks.list();
    if (!Array.isArray(tasks)) return denyFollowup('Cannot verify evidence caller task metadata.');
    const matches = tasks.filter(task => task?.type === 'agent' && task.toolCallId === caller?.callId);
    if (matches.length !== 1) return denyFollowup('Cannot verify evidence caller task identity.');
    const task = matches[0];
    if (cancellationFor(task) || task?.status === 'cancelled') return cancellationDecision();
    if (!['running', 'idle'].includes(task.status)) return denyFollowup('Evidence caller task is terminal or its status cannot be verified.');
    if ((task?.resolvedModel ?? caller?.model) !== available.model) return denyFollowup('Evidence caller model no longer matches the user-selected model, or cannot be verified.');
    if (getSession() !== session || session.sessionId !== root) return denyFollowup('Fusion session is no longer attached.');
  }

  function checkCallerCancellation(origin, tasks) {
    const caller = roles.configurationForOrigin(origin);
    const task = tasks.find(task => task?.toolCallId === caller?.callId);
    if ([...cancellations.values()].some(record => record.task.toolCallId === caller?.callId)
      || task?.status === 'cancelled') return cancellationDecision();
  }

  async function freshSidekick(session, root, targetName, owner = root, singleton = false) {
    const previous = singleton ? pendingSidekicks.get(owner) : undefined;
    const reservation = previous ?? {};
    if (singleton) pendingSidekicks.set(owner, reservation); // Reserve before any asynchronous registry checks.
    let admitted = false;
    try {
      const { tasks } = await session.rpc.tasks.list();
      if (!Array.isArray(tasks)) return denyFollowup('Cannot verify sidekick task metadata.');
      for (const task of tasks) {
        if (task?.type !== 'agent' || canonicalFusionRole(task.agentType) !== 'fusion-sidekick') continue;
        if (!TASK_STATUSES.has(task.status)) return denyFollowup('Cannot verify sidekick task status.');
        if (TERMINAL_STATUSES.has(task.status)) continue;
        const taskOwner = await roles.ownerForTarget(task, root, tasks);
        if (!taskOwner) {
          return denyFollowup('Cannot verify the existing sidekick owner/parent.');
        }
        if (!singleton || taskOwner !== owner) continue;
        // Start evidence and a tracked, continuable task replace the pending claim.
        pendingSidekicks.delete(owner);
        return denyFollowup(`Continue the persistent sidekick with write_agent and agent_id: ${task.id}; do not start another sidekick.`);
      }
      if (previous) return denyFollowup('A Fusion sidekick launch is pending; wait for its start or tool outcome.');
      const configuration = await checkRoleConfiguration(session, targetName);
      if (configuration) return configuration;
      if (getSession() !== session || session.sessionId !== root) return denyFollowup('Fusion session is no longer attached.');
      if (owner !== root) {
        const stopped = checkCallerCancellation(owner, tasks);
        if (stopped) return stopped;
      }
      admitted = true;
      return undefined;
    } catch {
      return denyFollowup('Cannot verify sidekick task metadata.');
    } finally {
      if (singleton && !admitted && !previous && pendingSidekicks.get(owner) === reservation) pendingSidekicks.delete(owner);
    }
  }

  const sidekickOutcome = (input, invocation) => {
    if (invocation.sessionId === rootSessionId
      && input.toolName === 'task' && canonicalFusionRole(input.toolArgs?.agent_type) === 'fusion-sidekick') {
      // Includes launch failures and successful tool results without a child start.
      pendingSidekicks.delete(input.sessionId);
    }
  };
  return {
    dispose: () => {
      supervision?.stop();
      subscriptions.forEach(off => off());
      subscriptions = [];
    },
    onSessionEnd: (input, invocation) => {
      if (input.sessionId !== rootSessionId || invocation.sessionId !== rootSessionId) return;
      supervision?.stop();
      subscriptions.forEach(off => off());
      subscriptions = [];
    },
    beginCancellation: (session, task) => {
      if (getSession() !== session || attachment !== session) throw new Error('Fusion session is no longer attached.');
      if (cancellationFor(task)?.pending) throw new Error('Worker cancellation is already pending; inspect its status before retrying.');
      const record = { task: { ...task }, pending: true };
      cancellations.set(task.id, record);
      return result => {
        if (getSession() !== session || attachment !== session || cancellations.get(task.id) !== record) return;
        record.pending = false;
        if (!result.accepted && !result.confirmedStopped) cancellations.delete(task.id);
      };
    },
    onSessionStart: () => { syncAttachment(); },
    onPostToolUse: sidekickOutcome,
    onPostToolUseFailure: sidekickOutcome,
    onUserPromptSubmitted: async (input, invocation) => {
      if (input.sessionId !== invocation.sessionId) return undefined;
      try {
        const session = syncAttachment();
        if (session?.sessionId !== invocation.sessionId) return undefined;
        const { agent } = await session.rpc.agent.getCurrent();
        if (getSession() !== session || session.sessionId !== invocation.sessionId) return undefined;
        if (fusionAgentIdentity(agent) !== 'fusion') return undefined;
        const { status } = await roleAvailability(session, advisorRoleForLead(agent));
        return { additionalContext: advisorContext[status] };
      } catch {
        return undefined;
      }
    },
    onPreToolUse: async (input, invocation) => {
      // SDK input.sessionId is the originating runtime session; invocation is
      // the attached root. Never treat a task-registry ID as a child session ID.
      const descendant = input.sessionId !== invocation.sessionId;
      const gitCommand = descendant && gitFromInput(input);
      const attached = syncAttachment();
      const role = descendant ? await roles.forOrigin(input.sessionId, invocation.sessionId) : undefined;
      if (getSession() !== attached || attached?.sessionId !== invocation.sessionId) return denyFollowup('Fusion session is no longer attached.');
      const reviewerOrigin = role === 'fusion-reviewer' || descendant && roles.isReviewerOrigin?.(input.sessionId, invocation.sessionId);
      const advisorOrigin = role === 'fusion-advisor' || descendant && roles.isAdvisorOrigin?.(input.sessionId, invocation.sessionId);
      const evidenceOrigin = descendant && roles.isEvidenceOrigin?.(input.sessionId, invocation.sessionId);
      const sidekickOrigin = role === 'fusion-sidekick' || descendant && roles.isSidekickOrigin?.(input.sessionId, invocation.sessionId);
      if (descendant && role && !reviewerOrigin && !advisorOrigin && !evidenceOrigin && (!isGuardedTool(input.toolName)
        || input.toolName !== 'task' && input.toolName !== 'write_agent' && input.toolName !== 'read_agent'
          && input.toolName !== 'fusion_cancel' && !isWebTool(input.toolName) && !gitCommand)) return undefined;
      if (!descendant && !isGuardedTool(input.toolName)) return undefined;
      let session;
      try {
        session = attached;
        if (session?.sessionId !== invocation.sessionId) throw new Error('Foreground session unavailable');
        const { agent } = await session.rpc.agent.getCurrent();
        if (getSession() !== session || session.sessionId !== invocation.sessionId) throw new Error('Foreground session detached');
        const identity = fusionAgentIdentity(agent);
        if (identity === 'unverified') {
          lastKnownFusion = true; // ambiguous Fusion-shaped identity fails closed
          throw new Error('Incomplete selected-agent metadata');
        }
        lastKnownFusion = identity === 'fusion';
      } catch {
        return unavailableDecision(lastKnownFusion, input.toolName === 'task', descendant);
      }
      if (evidenceOrigin) {
        if (role !== 'fusion-sidekick') return { permissionDecision: 'deny', permissionDecisionReason: 'Cannot verify Fusion evidence sidekick ownership; all tools are denied until metadata recovers.' };
        return decideEvidenceTool(input);
      }
      if (reviewerOrigin || advisorOrigin) {
        if (!['fusion-reviewer', 'fusion-advisor'].includes(role)) return { permissionDecision: 'deny', permissionDecisionReason: 'Cannot verify the Fusion advisor/reviewer role and ancestry; tools are denied until metadata recovers.' };
        const preliminary = decideTool(input, input.toolName === 'view' ? { kind: 'text' } : undefined, true, role);
        if (preliminary) return preliminary;
        if (input.toolName === 'task') {
          if (!lastKnownFusion) return denyFollowup('Fusion is off; new evidence delegation is disabled.');
          try {
            const caller = await checkEvidenceCaller(session, input.sessionId, invocation.sessionId);
            if (caller) return caller;
          } catch { return denyFollowup('Cannot verify evidence caller configuration.'); }
          return freshSidekick(session, invocation.sessionId, input.toolArgs.agent_type, input.sessionId, role === 'fusion-reviewer');
        }
        if (['write_agent', 'read_agent', 'fusion_cancel'].includes(input.toolName)) {
          const ids = requestedAgentIds(input.toolArgs);
          if (!ids || ids.length !== 1 || !Object.hasOwn(input.toolArgs, 'agent_id')) return denyFollowup('Evidence requires one explicit owned sidekick agent_id.');
          if (['model', 'reasoning_effort', 'context_tier'].some(key => Object.hasOwn(input.toolArgs, key))) return denyFollowup('Evidence must omit model/effort/context overrides.');
          try {
            const { tasks } = await session.rpc.tasks.list();
            const matches = Array.isArray(tasks) ? tasks.filter(task => task?.id === ids[0]) : [];
            if (matches.length !== 1 || await roles.forTarget(matches[0], invocation.sessionId, tasks, input.sessionId) !== 'fusion-sidekick') return denyFollowup('Cannot verify the caller\'s own evidence sidekick owner/parent.');
            if (input.toolName === 'write_agent') {
              if (!lastKnownFusion) return denyFollowup('Fusion is off; new evidence jobs are disabled.');
              const status = checkWorkerStatus(matches);
              if (status) return status;
              if (matches[0].status === 'idle') {
                const caller = await checkEvidenceCaller(session, input.sessionId, invocation.sessionId);
                if (caller) return caller;
                const config = await checkRoleConfiguration(session, matches[0].agentType);
                if (config) return config;
              }
              const stopped = checkCallerCancellation(input.sessionId, tasks);
              if (stopped) return stopped;
              const cancellation = cancellationFor(matches[0]);
              if (cancellation && (cancellation.pending || matches[0].status !== 'idle')) return cancellationDecision();
            }
            if (getSession() !== session || session.sessionId !== invocation.sessionId) return denyFollowup('Fusion review session is no longer attached.');
            return undefined;
          } catch { return denyFollowup('Cannot verify evidence task metadata.'); }
        }
        if (input.toolName !== 'view') return undefined;
        return decideTool(input, await inspect(input.toolArgs.path), true, role);
      }
      if (!lastKnownFusion && !sidekickOrigin && input.toolName !== 'fusion_cancel') {
        if (input.toolName === 'write_agent' && roles.hasFusionOrigins(invocation.sessionId)) {
          try {
            const ids = requestedAgentIds(input.toolArgs);
            const { tasks } = await session.rpc.tasks.list();
            if (!Array.isArray(tasks)) return denyFollowup('Cannot verify retained Fusion workers while Fusion is off.');
            for (const task of tasks) {
              if ((!ids || ids.includes(task.id)) && await roles.ownerForTarget(task, invocation.sessionId, tasks)) {
                return denyFollowup('Fusion is off; messages and continuations to retained Fusion workers are disabled.');
              }
            }
            if (getSession() !== session || session.sessionId !== invocation.sessionId) return denyFollowup('Fusion session is no longer attached.');
          } catch { return denyFollowup('Cannot verify retained Fusion workers while Fusion is off.'); }
        }
        return undefined;
      }

      if (descendant) {
        if (!role) return {
          permissionDecision: 'deny',
          permissionDecisionReason: 'Cannot verify the Fusion descendant role and ancestry; tools are denied until metadata recovers.',
        };
        if (['write_agent', 'read_agent', 'fusion_cancel'].includes(input.toolName)) {
          return { permissionDecision: 'deny', permissionDecisionReason: 'Fusion sidekick and advisor cannot delegate, continue, or read other agents.' };
        }
        if (gitCommand) return role === 'fusion-sidekick' ? undefined : denyGit();
        return decideTool(input, undefined, true, role);
      }

      if (input.toolName === 'task') {
        const decision = decideTool(input);
        if (decision) return decision;
        if (canonicalFusionRole(input.toolArgs.agent_type) === 'fusion-sidekick') {
          return freshSidekick(session, invocation.sessionId, input.toolArgs.agent_type);
        }
        const configuration = await checkRoleConfiguration(session, input.toolArgs.agent_type);
        if (configuration) return configuration;
        if (getSession() !== session || session.sessionId !== invocation.sessionId) return denyFollowup('Fusion session is no longer attached.');
        return undefined;
      }

      if (['write_agent', 'read_agent', 'fusion_cancel'].includes(input.toolName)) {
        const ids = requestedAgentIds(input.toolArgs);
        if (!ids) return denyFollowup('Fusion lead write_agent requires one explicit agent_id or a nonempty explicit agent_ids list; broadcast and ambiguous selectors are denied.');
        if (input.toolName !== 'read_agent' && (ids.length !== 1 || !Object.hasOwn(input.toolArgs, 'agent_id'))) return denyFollowup('Worker messages and cancellation require one explicit agent_id.');
        if (input.toolName !== 'read_agent' && ['model', 'reasoning_effort', 'context_tier'].some(key => Object.hasOwn(input.toolArgs, key))) return denyFollowup('Worker controls must omit model, reasoning_effort, and context_tier overrides.');
        try {
          const { tasks } = await session.rpc.tasks.list();
          if (!Array.isArray(tasks)) return denyFollowup('Cannot verify the target worker identities from task metadata.');
          const matches = ids.map((id) => tasks.filter((task) => task?.id === id));
          if (matches.some((target) => target.length !== 1 || target[0].type !== 'agent'
            || !['fusion-sidekick', 'fusion-advisor', 'fusion-reviewer'].includes(canonicalFusionRole(target[0].agentType)))) {
            return denyFollowup('Cannot confirm that every target worker has an allowed Fusion role from task metadata.');
          }
          if (input.toolName === 'write_agent') {
            const decision = checkWorkerStatus(matches.map(([task]) => task));
            if (decision) return decision;
          }
          for (const [task] of matches) {
            const role = canonicalFusionRole(task.agentType);
            if (role === 'fusion-sidekick' && await roles.forTarget(task, invocation.sessionId, tasks) !== 'fusion-sidekick') return denyFollowup('Cannot verify the lead\'s own coding sidekick; do not borrow advisor/reviewer evidence workers.');
            if (role === 'fusion-advisor' && await roles.forTarget(task, invocation.sessionId, tasks) !== 'fusion-advisor') return denyFollowup('Cannot verify the advisor owner/parent.');
            if (role === 'fusion-reviewer' && await roles.forTarget(task, invocation.sessionId, tasks) !== 'fusion-reviewer') return denyFollowup('Cannot verify the reviewer owner/parent.');
            if (input.toolName === 'write_agent') {
              if (task.status === 'idle') {
                const decision = await checkRoleConfiguration(session, task.agentType);
                if (decision) return decision;
              }
              const cancellation = cancellationFor(task);
              if (cancellation && (cancellation.pending || task.status !== 'idle')) return cancellationDecision();
            }
          }
          if (getSession() !== session || session.sessionId !== invocation.sessionId) return denyFollowup('Fusion session is no longer attached.');
          return undefined;
        } catch {
          return denyFollowup('Cannot verify the target worker identities: task metadata is unavailable.');
        }
      }

      const preliminary = decideTool(input, input.toolName === 'view' ? { kind: 'text' } : undefined);
      if (input.toolName !== 'view' || preliminary) return preliminary;
      return decideTool(input, await inspect(input.toolArgs.path));
    },
  };
}

export async function registerExtension(joinSession, inspect = inspectTextTarget) {
  let session;
  const roles = createRoleResolver(() => session);
  const hooks = createHooks(() => session, inspect, roles);
  session = await joinSession({ hooks, commands: createCommands(() => session),
    tools: [createCancelTool(() => session, roles, hooks)] });
  hooks.onSessionStart();
  roles.subscribe(session);
  await roles.refresh(session);
  return session;
}
