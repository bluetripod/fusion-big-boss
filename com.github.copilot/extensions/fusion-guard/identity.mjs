import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Copilot's AgentInfo.path identifies the local definition file. Tying the
// plugin profile to this extension's own installed tree avoids accepting a
// same-named agent supplied by a different plugin.
const packagedLeadPath = fileURLToPath(new URL('../../agents/fusion.agent.md', import.meta.url));
const namespace = 'fusion-big-boss:';
const fusionRoles = new Set(['fusion', 'fusion-sidekick', 'fusion-advisor', 'fusion-reviewer']);

function isPackagedLeadPath(path) {
  try { return realpathSync(path) === realpathSync(packagedLeadPath); }
  catch { return false; }
}

export function canonicalFusionRole(name) {
  if (fusionRoles.has(name)) return name;
  if (typeof name !== 'string' || !name.startsWith(namespace)) return null;
  const role = name.slice(namespace.length);
  return fusionRoles.has(role) ? role : null;
}

export const advisorRoleForLead = (agent) => agent?.source === 'plugin' && agent.id === `${namespace}fusion`
  ? `${namespace}fusion-advisor` : 'fusion-advisor';

export function fusionAgentIdentity(agent) {
  if (agent === null) return 'unrelated'; // the SDK's explicit default-agent selection
  if (agent === undefined) return 'unverified';
  if (agent.source === 'user' && agent.id === 'fusion') return 'fusion'; // loose-profile development
  if (agent.source === 'plugin') {
    if (typeof agent.path === 'string' && isAbsolute(agent.path)
      && isPackagedLeadPath(agent.path)) {
      return canonicalFusionRole(agent.name) === 'fusion' && typeof agent.id === 'string' && agent.id
        ? 'fusion' : 'unverified';
    }
    if (canonicalFusionRole(agent.name) === 'fusion'
      && (typeof agent.path !== 'string' || !isAbsolute(agent.path))) {
      return 'unverified';
    }
    return 'unrelated'; // another plugin with its own explicit definition path
  }
  if (typeof agent.id !== 'string' || !agent.id || typeof agent.source !== 'string') return 'unverified';
  return 'unrelated';
}
