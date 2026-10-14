import { createSupervisor } from '../../../shared/supervision.mjs';
import { canonicalFusionRole, fusionAgentIdentity } from './identity.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const workerRoles = new Set(['fusion-sidekick', 'fusion-advisor', 'fusion-reviewer']);
const sameTask = (a, b) => a?.id === b?.id && a?.toolCallId === b?.toolCallId && a?.startedAt === b?.startedAt;
const bounded = value => typeof value === 'string' ? value.slice(-2048) : undefined;

export function createWorkerSupervision(getSession, roles, isCancelling, timerOptions = {}) {
  const session = getSession();
  const root = session?.sessionId;
  let generation = 0;
  let enabled = false;
  let subscriptions = [];
  let limitationLogged = false;
  let sampled = new Map();
  const pending = new Map();
  const live = token => enabled && token === generation && getSession() === session && session?.sessionId === root;

  function pause() {
    enabled = false;
    generation++;
    supervisor.stop();
    pending.clear();
    sampled.clear();
  }

  async function current(token) {
    if (!live(token)) return false;
    const { agent } = await session.rpc.agent.getCurrent();
    if (!live(token)) return false;
    if (fusionAgentIdentity(agent) !== 'fusion') {
      pause();
      return false;
    }
    return true;
  }

  async function registry(token) {
    if (!await current(token) || !live(token)) return [];
    const { tasks } = await session.rpc.tasks.list();
    if (!live(token)) return [];
    if (!Array.isArray(tasks)) throw new Error('Fusion worker task metadata unavailable.');
    const owned = [];
    for (const task of tasks) {
      if (task?.type !== 'agent' || !workerRoles.has(canonicalFusionRole(task.agentType)) || terminal.has(task.status)) continue;
      const owner = await roles.ownerForTarget(task, root, tasks);
      if (!live(token)) return [];
      if (owner) owned.push({ task: { ...task }, owner });
    }
    // An idle leaf has finished its job. An idle owner still awaiting evidence
    // remains visible, but is never eligible for a progress request.
    const active = owned.filter(({ task }) => task.status !== 'idle');
    for (let changed = true; changed;) {
      changed = false;
      for (const record of owned) {
        if (active.includes(record) || !active.some(child =>
          roles.configurationForOrigin(child.owner)?.callId === record.task.toolCallId)) continue;
        active.push(record);
        changed = true;
      }
    }
    return active;
  }

  async function sample() {
    const token = generation;
    const owned = await registry(token);
    const observations = [];
    const next = new Map();
    for (const { task, owner } of owned) {
      let progress;
      try { ({ progress } = await session.rpc.tasks.getProgress({ id: task.id })); } catch { /* Unknown progress is not quiet proof. */ }
      if (!live(token)) return [];
      const last = Array.isArray(progress?.recentActivity) ? progress.recentActivity.at(-1) : undefined;
      const known = ['running', 'idle'].includes(task.status) && progress?.type === 'agent' && Array.isArray(progress.recentActivity);
      observations.push({
        id: task.id, owner, task,
        startedAt: Date.parse(task.startedAt),
        status: ['running', 'idle'].includes(task.status) ? task.status : 'unknown',
        activity: last?.message || progress?.latestIntent || (task.latestResponse ? 'responding' : undefined),
        version: known ? JSON.stringify([task.toolCallId, task.startedAt, bounded(last?.timestamp),
          bounded(last?.message), bounded(progress.latestIntent), bounded(task.latestResponse)]) : undefined,
        requestable: task.status === 'running' && task.executionMode === 'background' && !isCancelling(task),
      });
      if (!next.has(owner)) next.set(owner, []);
      next.get(owner).push({ task, owner });
    }
    if (!live(token)) return [];
    sampled = next;
    return observations;
  }

  async function request(observation, message) {
    const token = generation;
    const owned = await registry(token);
    const record = owned.find(({ task, owner }) => sameTask(task, observation.task) && owner === observation.owner);
    if (!record || !await current(token)) return false;
    if (record.owner !== root) {
      const configuration = roles.configurationForOrigin(record.owner);
      const parent = owned.find(({ task, owner }) => owner === root && task.toolCallId === configuration?.callId
        && ['fusion-advisor', 'fusion-reviewer'].includes(canonicalFusionRole(task.agentType)));
      if (!parent || !['running', 'idle'].includes(parent.task.status) || isCancelling(parent.task)) return false;
    }
    if (record.task.status !== 'running' || record.task.executionMode !== 'background' || isCancelling(record.task)) return false;
    const result = await session.rpc.tasks.sendMessage({ id: record.task.id, message,
      ...(record.owner !== root ? { fromAgentId: record.owner } : {}) });
    return live(token) && result?.sent === true;
  }

  async function notify(owner, text) {
    const token = generation;
    if (!live(token) || pending.has(owner)) return;
    const admission = { admitted: false, consumed: new Set() };
    pending.set(owner, admission);
    let sent = false;
    try {
      const owned = await registry(token);
      const previous = sampled.get(owner);
      if (!live(token) || !previous?.length || !previous.every(record => owned.some(fresh =>
        sameTask(record.task, fresh.task) && record.owner === fresh.owner))) return;
      if (owner === root) {
        if (!await current(token) || !live(token)) return;
        admission.messageId = await session.send({ prompt: text, mode: 'enqueue' });
        sent = live(token);
      } else {
        const configuration = roles.configurationForOrigin(owner);
        if (!['fusion-advisor', 'fusion-reviewer'].includes(configuration?.role)) return;
        const matches = owned.filter(({ task, owner: parent }) => parent === root && task.toolCallId === configuration.callId
          && canonicalFusionRole(task.agentType) === configuration.role);
        if (matches.length !== 1) return;
        const { task } = matches[0];
        if (!['running', 'idle'].includes(task.status) || isCancelling(task) || !live(token)) return;
        if (task.executionMode !== 'background') {
          if (task.executionMode === 'sync' && !limitationLogged && typeof session.log === 'function') {
            limitationLogged = true;
            await session.log('Fusion supervision: native messages cannot reach a foreground (sync) advisor/reviewer owner.');
          }
          return;
        }
        if (!await current(token) || !live(token) || isCancelling(task)
          || roles.configurationForOrigin(owner)?.callId !== task.toolCallId) return;
        const result = await session.rpc.tasks.sendMessage({ id: task.id, message: text });
        sent = live(token) && result?.sent === true;
      }
      if (sent) {
        admission.admitted = true;
        if (owner === root && admission.consumed.has(admission.messageId)) pending.delete(owner);
      }
    } finally {
      if (!sent && pending.get(owner) === admission) pending.delete(owner);
    }
  }

  const supervisor = createSupervisor({ ...timerOptions, sample, request, notify });

  function consumed(event) {
    if (!live(generation)) return;
    const owner = event.agentId ?? root;
    const admission = pending.get(owner);
    if (!admission) return;
    if (owner !== root) {
      if (event.type === 'assistant.turn_start' && admission.admitted) pending.delete(owner);
      return;
    }
    const messageId = event.type === 'user.message' && event.data?.turnId
      ? event.data.messageId : event.type === 'assistant.message' ? event.data?.originatingMessageId : undefined;
    if (!messageId) return;
    if (!admission.admitted) admission.consumed.add(messageId);
    else if (messageId === admission.messageId) pending.delete(owner);
  }

  function start() {
    if (!session || getSession() !== session || session.sessionId !== root) return;
    if (!subscriptions.length && typeof session.on === 'function') {
      subscriptions = [session.on('subagent.started', start), session.on('session.shutdown', stop),
        session.on('tool.execution_start', event => {
          if (['task', 'write_agent'].includes(event.data?.toolName)) start();
        }),
        ...['assistant.turn_start', 'user.message', 'assistant.message'].map(type => session.on(type, consumed))];
    }
    enabled = true;
    supervisor.start();
  }

  function stop() {
    pause();
    subscriptions.forEach(off => off());
    subscriptions = [];
  }

  return { start, stop, check: () => supervisor.tick() };
}
