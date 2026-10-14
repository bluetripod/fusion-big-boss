import { canonicalFusionRole } from './identity.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = new Set(['running', 'idle', ...TERMINAL]);

export function createCancelTool(getSession, roles, hooks) {
  return {
    name: 'fusion_cancel',
    description: 'Request cancellation of one owned Fusion worker and its verified evidence workers. Preserve history and changes; return partial output and distinguish requested cancellation from observed stop.',
    parameters: { type: 'object', properties: { agent_id: { type: 'string', minLength: 1 } },
      required: ['agent_id'], additionalProperties: false },
    handler: async (args, invocation) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || typeof args.agent_id !== 'string' || !args.agent_id.trim()
        || Object.keys(args).some(key => key !== 'agent_id')) throw new Error('Cancellation requires one explicit agent_id only.');
      const session = getSession();
      const root = invocation.sessionId;
      const attached = () => session && getSession() === session && session.sessionId === root && !invocation.signal?.aborted;
      if (!attached()) throw new Error('Fusion session is no longer attached.');
      const caller = await roles.forInvocation(invocation);
      if (!caller) throw new Error('Cannot verify cancellation caller identity from tool-start evidence.');
      const decision = await hooks.onPreToolUse({ sessionId: caller, toolName: 'fusion_cancel', toolArgs: args }, { sessionId: root });
      if (decision?.permissionDecision === 'deny') throw new Error(decision.permissionDecisionReason);
      const { tasks } = await session.rpc.tasks.list();
      const matches = Array.isArray(tasks) ? tasks.filter(task => task?.id === args.agent_id) : [];
      if (matches.length !== 1 || !await roles.forTarget(matches[0], root, tasks, caller)) throw new Error('Cannot verify cancellation target owner/parent.');
      const target = matches[0];
      if (!STATUSES.has(target.status)) throw new Error('Cannot verify cancellation target status.');
      if (!attached()) throw new Error('Fusion session is no longer attached.');
      const finishTarget = hooks.beginCancellation(session, target);
      let targetResult;
      try {
        const descendants = [];
        if (['fusion-advisor', 'fusion-reviewer'].includes(canonicalFusionRole(target.agentType))) {
          const owner = roles.originForTarget(target);
          for (const { task, origin } of roles.evidenceCandidates(target, tasks)) {
            const verified = task && owner && await roles.forTarget(task, root, tasks, owner) === 'fusion-sidekick';
            descendants.push({ task, origin, verified: Boolean(verified) });
          }
        }
        if (!attached()) throw new Error('Fusion session is no longer attached.');

        async function cancel(task, verified = true) {
          const result = { agent_id: task.id, requested: false, confirmedStopped: false, status: task.status };
          if (!verified || !STATUSES.has(task.status)) return { ...result, error: 'Cannot verify evidence worker ownership/status; stop unconfirmed.' };
          if (!attached()) return { ...result, error: 'Fusion session is no longer attached; stop unconfirmed.' };
          let finish;
          try {
            if (task !== target) finish = hooks.beginCancellation(session, task);
            // Recheck immediately before mutation: a recycled task ID must never
            // interrupt a later run or a replacement attachment.
            const current = await session.rpc.tasks.list();
            const same = current.tasks?.filter(item => item?.id === task.id && item.toolCallId === task.toolCallId
              && item.startedAt === task.startedAt && item.activeStartedAt === task.activeStartedAt);
            if (!attached() || same?.length !== 1) throw new Error('Task identity changed before cancellation');
            task = { ...same[0] };
            if (!STATUSES.has(task.status)) throw new Error('Cannot verify cancellation target status');
            if (!TERMINAL.has(task.status)) {
              result.requested = true;
              try {
                const response = await session.rpc.tasks.cancel({ id: task.id });
                result.accepted = response?.cancelled === true;
                if (!result.accepted) result.error = 'Host did not accept cancellation.';
              } catch (error) { result.error = `Cancellation failed: ${error.message}`; }
            }
            // One observation, never wait for worker completion. A host acknowledgement
            // alone does not establish that cooperative interruption has settled.
            let observed = task;
            try {
              if (!attached()) throw new Error('Fusion session is no longer attached');
              const fresh = await session.rpc.tasks.list();
              const found = fresh.tasks?.filter(item => item?.id === task.id && item.toolCallId === task.toolCallId && item.startedAt === task.startedAt);
              if (!attached() || found?.length !== 1) throw new Error('Task no longer uniquely tracked on this attachment');
              observed = found[0];
              result.status = observed.status;
              result.confirmedStopped = TERMINAL.has(observed.status);
            } catch (error) { result.observationError = error.message; }
            const output = observed.result ?? observed.latestResponse;
            result.output = typeof output === 'string' ? output.slice(-8000) : null;
            result.outputTruncated = typeof output === 'string' && output.length > 8000;
            try {
              if (!attached()) throw new Error('Fusion session is no longer attached');
              const { progress } = await session.rpc.tasks.getProgress({ id: task.id });
              if (!attached()) throw new Error('Fusion session is no longer attached');
              result.progress = progress?.type === 'agent' ? {
                latestIntent: progress.latestIntent?.slice(-1000),
                recentActivity: progress.recentActivity.slice(-20).map(line => ({ timestamp: line.timestamp, message: line.message.slice(-1000) })),
              } : null;
              result.progressTruncated = progress?.type === 'agent' && (progress.recentActivity.length > 20
                || progress.latestIntent?.length > 1000 || progress.recentActivity.some(line => line.message.length > 1000));
            } catch (error) { result.progressError = error.message; }
          } catch (error) { result.error = `${error.message}; stop unconfirmed.`; }
          finally { finish?.(result); }
          return result;
        }

        const results = await Promise.all([cancel(target), ...descendants.map(({ task, origin, verified }) => task
          ? cancel(task, verified)
          : { runtime_agent_id: origin, requested: false, confirmedStopped: false, error: 'No tracked task ID for this descendant; stop unconfirmed.' })]);
        targetResult = results[0];
        return { target: targetResult, descendants: results.slice(1),
          note: 'Cooperative cancellation; output/history and file changes are retained. Parent cancellation closes new evidence admission; descendants admitted before the request or lacking tracked IDs may remain unconfirmed. Use read_agent for later status.' };
      } finally { finishTarget(targetResult ?? {}); }
    },
  };
}
