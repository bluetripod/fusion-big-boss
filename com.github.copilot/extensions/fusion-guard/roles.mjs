// Correlate runtime subagent.started.agentId with the hook's originating
// sessionId. Task-registry IDs are not runtime session IDs.
import { canonicalFusionRole } from './identity.mjs';

const ROLES = new Set(['fusion-sidekick', 'fusion-advisor', 'fusion-reviewer']);
const TYPES = ['subagent.started', 'tool.execution_start'];

export function createRoleResolver(getSession) {
  let rootId;
  let attachedSession;
  let ready = false;
  const starts = new Map();
  const calls = new Map();
  const conflictedStarts = new Set();
  const conflictedCalls = new Set();
  const reviewerOrigins = new Set();
  const advisorOrigins = new Set();
  const sidekickOrigins = new Set();
  let subscribed;
  let pendingRefresh;

  function receive(event) {
    if (event?.type === 'subagent.started') {
      const id = event.agentId;
      const data = event.data;
      if (typeof id !== 'string' || !id || !data) return;
      if (canonicalFusionRole(data.agentType) === 'fusion-reviewer'
        || canonicalFusionRole(data.agentName) === 'fusion-reviewer') reviewerOrigins.add(id);
      if (canonicalFusionRole(data.agentType) === 'fusion-advisor'
        || canonicalFusionRole(data.agentName) === 'fusion-advisor') advisorOrigins.add(id);
      if (canonicalFusionRole(data.agentType) === 'fusion-sidekick'
        || canonicalFusionRole(data.agentName) === 'fusion-sidekick') sidekickOrigins.add(id);
      const role = data.agentType === data.agentName && ROLES.has(canonicalFusionRole(data.agentType))
        ? canonicalFusionRole(data.agentType) : null;
      const record = { role, name: data.agentType, model: data.model,
        parentId: data.parentId ?? null, callId: data.toolCallId, mode: data.executionMode };
      const old = starts.get(id);
      if (old && JSON.stringify(old) !== JSON.stringify(record)) conflictedStarts.add(id);
      else if (!old) starts.set(id, record);
    } else if (event?.type === 'tool.execution_start') {
      if (!['task', 'fusion_cancel'].includes(event.data?.toolName)) return;
      const id = event.data?.toolCallId;
      if (typeof id !== 'string' || !id) return;
      const record = { agentId: event.agentId ?? null, name: event.data.toolName };
      const old = calls.get(id);
      if (old && JSON.stringify(old) !== JSON.stringify(record)) conflictedCalls.add(id);
      else if (!old) calls.set(id, record);
    }
  }

  function subscribe(session) {
    if (attachedSession !== session || rootId !== session.sessionId) {
      subscribed?.forEach((off) => off());
      starts.clear(); calls.clear(); conflictedStarts.clear(); conflictedCalls.clear();
      reviewerOrigins.clear();
      advisorOrigins.clear();
      sidekickOrigins.clear();
      rootId = session.sessionId;
      attachedSession = session;
      ready = false;
      pendingRefresh = undefined;
      subscribed = [session.on('subagent.started', receive), session.on('tool.execution_start', receive)];
    }
  }

  async function refresh(session) {
    if (session !== attachedSession || typeof session.rpc?.eventLog?.read !== 'function') return false;
    if (pendingRefresh?.session === session) return pendingRefresh.promise;
    ready = false;
    const replay = (async () => {
      let cursor;
      try {
        do {
          const page = await session.rpc.eventLog.read({ ...(cursor !== undefined ? { cursor } : {}),
            types: TYPES, max: 1000, includeEphemeral: false });
          if (session !== attachedSession || page?.cursorStatus !== 'ok' || !Array.isArray(page.events)
            || typeof page.cursor !== 'string' || typeof page.hasMore !== 'boolean'
            || page.hasMore && page.cursor === cursor) return false;
          for (const event of page.events) receive(event);
          cursor = page.cursor;
          if (!page.hasMore) { ready = true; return true; }
        } while (true);
      } catch {
        return false;
      }
    })();
    const pending = { session, promise: replay };
    pendingRefresh = pending;
    try {
      return await replay;
    } finally {
      if (pendingRefresh === pending) pendingRefresh = undefined;
    }
  }

  function validatedRole(id, tasks = []) {
    if (conflictedStarts.has(id)) return null;
    const record = starts.get(id);
    if (!record?.role || typeof record.callId !== 'string') return null;
    if (record.mode !== 'background' && !(record.role === 'fusion-advisor' && record.mode === 'sync')) return null;
    const call = calls.get(record.callId);
    if (!call || conflictedCalls.has(record.callId) || call.name !== 'task') return null;
    if (record.parentId === null && call.agentId === null) return record.role;
    const parent = starts.get(call.agentId);
    if (record.role !== 'fusion-sidekick' || !['fusion-reviewer', 'fusion-advisor'].includes(parent?.role)
      || validatedRole(call.agentId) !== parent.role) return null;
    const matches = tasks.filter(task => task?.id === record.parentId && task.type === 'agent'
      && task.toolCallId === parent.callId && canonicalFusionRole(task.agentType) === parent.role);
    return matches.length === 1 ? record.role : null;
  }

  async function forOrigin(origin, root) {
    const session = getSession();
    if (session !== attachedSession || rootId !== root || origin === root) return null;
    if (!ready || !validatedRole(origin)) await refresh(session);
    if (!ready || getSession() !== session || attachedSession !== session || rootId !== root) return null;
    if (validatedRole(origin)) return validatedRole(origin);
    try {
      const { tasks } = await session.rpc.tasks.list();
      return getSession() === session && attachedSession === session && rootId === root && Array.isArray(tasks) ? validatedRole(origin, tasks) : null;
    } catch { return null; }
  }

  async function ownerForTarget(task, root, tasks) {
    const session = getSession();
    if (session !== attachedSession || rootId !== root || task?.type !== 'agent'
      || !Array.isArray(tasks) || tasks.filter(item => item?.id === task.id).length !== 1) return null;
    if (!ready || ![...starts.values()].some(start => start.callId === task.toolCallId)) await refresh(session);
    if (!ready || getSession() !== session || attachedSession !== session || rootId !== root) return null;
    const matches = [...starts].filter(([id, start]) => !conflictedStarts.has(id) && start.callId === task.toolCallId
      && validatedRole(id, tasks) === canonicalFusionRole(task.agentType));
    return matches.length === 1 ? calls.get(matches[0][1].callId).agentId ?? root : null;
  }

  async function forTarget(task, root, tasks, owner = root) {
    return await ownerForTarget(task, root, tasks) === owner ? canonicalFusionRole(task.agentType) : null;
  }

  async function forInvocation(invocation) {
    const session = getSession();
    const root = invocation.sessionId;
    if (session !== attachedSession || rootId !== root || !await refresh(session)) return null;
    if (getSession() !== session || attachedSession !== session || rootId !== root) return null;
    const call = calls.get(invocation.toolCallId);
    // agentId is optional in the SDK, so absence alone is not proof of a root call.
    if (!call || call.name !== 'fusion_cancel' || conflictedCalls.has(invocation.toolCallId)
      || call.agentId !== (invocation.agentId ?? null)) return null;
    return call.agentId ?? root;
  }

  function evidenceCandidates(parent, tasks) {
    const owner = originForTarget(parent);
    return [...starts].filter(([, start]) => start.parentId === parent.id
      || owner && calls.get(start.callId)?.agentId === owner).flatMap(([origin, start]) => {
      const matches = tasks.filter(task => task?.type === 'agent' && task.toolCallId === start.callId);
      return matches.length ? matches.map(task => ({ task, origin })) : [{ origin }];
    });
  }

  function originForTarget(task) {
    const matches = [...starts].filter(([, start]) => start.callId === task.toolCallId);
    return matches.length === 1 ? matches[0][0] : null;
  }

  // A reviewer-shaped start never grants access, but retains its read-only
  // boundary if replay/ancestry later becomes unavailable or contradictory.
  const isReviewerOrigin = (origin, root) => getSession() === attachedSession && rootId === root && reviewerOrigins.has(origin);
  const isAdvisorOrigin = (origin, root) => getSession() === attachedSession && rootId === root && advisorOrigins.has(origin);
  const isSidekickOrigin = (origin, root) => getSession() === attachedSession && rootId === root && sidekickOrigins.has(origin);
  const configurationForOrigin = (origin) => starts.get(origin);
  const hasFusionOrigins = root => getSession() === attachedSession && rootId === root
    && (sidekickOrigins.size > 0 || advisorOrigins.size > 0 || reviewerOrigins.size > 0);
  const isEvidenceOrigin = (origin, root) => getSession() === attachedSession && rootId === root
    && starts.has(origin)
    && (reviewerOrigins.has(calls.get(starts.get(origin)?.callId)?.agentId) || advisorOrigins.has(calls.get(starts.get(origin)?.callId)?.agentId));
  return { subscribe, refresh, forOrigin, forTarget, ownerForTarget, forInvocation, evidenceCandidates, originForTarget,
    isReviewerOrigin, isAdvisorOrigin, isSidekickOrigin, isEvidenceOrigin, configurationForOrigin, hasFusionOrigins };
}
