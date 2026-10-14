import { canonicalFusionRole } from './identity.mjs';
import { getUserSettings } from './settings.mjs';
import { contextTiers, listModels, reasoningEfforts } from './models.mjs';

export async function roleAvailability(session, targetName) {
  const role = canonicalFusionRole(targetName);
  const label = role?.replace('fusion-', '') ?? 'worker';
  const unavailable = (status, reason) => ({ status, decision: {
    permissionDecision: 'deny',
    permissionDecisionReason: `${reason} ${role === 'fusion-advisor' || role === 'fusion-reviewer'
      ? `${label[0].toUpperCase() + label.slice(1)} is optional: continue normal Fusion work, or ask the user to select its model and effort, set Model enforcement: required, and enable it in /subagents.`
      : `Ask the user to select the ${label} model and effort with Model enforcement: required in /subagents. No substitution or fallback is allowed.`}`,
  } });
  try {
    if (!['fusion-sidekick', 'fusion-advisor', 'fusion-reviewer'].includes(role)) {
      return unavailable('unknown', `Cannot verify the requested ${label} role.`);
    }
    // Native /subagents writes these user settings and applies the same live
    // session override. Read the exact requested key, never a canonical alias.
    const settings = await getUserSettings(session);
    if (!settings?.settings || !Object.hasOwn(settings.settings, 'subagents')) {
      return unavailable('unknown', `Cannot verify effective ${label} settings from the read-only native RPC.`);
    }
    const subagents = settings.settings.subagents?.value;
    if (subagents == null) return unavailable('unconfigured', `The ${label} has no /subagents configuration.`);
    if (typeof subagents !== 'object' || Array.isArray(subagents)
      || subagents.disabledSubagents != null && !Array.isArray(subagents.disabledSubagents)) {
      return unavailable('unknown', `Cannot verify effective ${label} settings from the read-only native RPC.`);
    }
    if (subagents.disabledSubagents?.includes(targetName)) {
      return unavailable('disabled', `The ${label} is disabled in /subagents.`);
    }
    const entry = subagents.agents?.[targetName];
    if (!entry || typeof entry.model !== 'string' || !entry.model || entry.modelPolicy !== 'required') {
      return unavailable('unconfigured', `Cannot confirm the ${label} has a user-selected model and required policy.`);
    }
    const explicit = typeof entry.effortLevel === 'string' && entry.effortLevel
      && entry.effortLevel !== 'inherit' && entry.effortLevel !== 'default';
    if (!explicit && entry.effortLevel !== undefined && entry.effortLevel !== 'default') {
      return unavailable('unconfigured', `${label[0].toUpperCase() + label.slice(1)} effort inherits the parent or is invalid; choose an explicit effort.`);
    }
    // Revalidate availability and supported effort/context without choosing a
    // replacement. Omitted effort is allowed only for confirmed no-effort models.
    const catalog = await listModels(session, 'guard');
    const model = catalog.find(candidate => candidate.id === entry.model);
    if (!model) return unavailable('unconfigured', `The selected ${label} model is unavailable or not confirmed; no fallback was selected.`);
    const supported = reasoningEfforts(model);
    if (supported.length ? !supported.includes(entry.effortLevel)
      : explicit || model.capabilities?.supports?.reasoningEffort === true) {
      return unavailable('unconfigured', `Choose an explicit supported ${label} effort; none was inferred.`);
    }
    if (entry.contextTier !== undefined && !contextTiers(model).includes(entry.contextTier)) {
      return unavailable('unconfigured', `The selected ${label} context tier is unavailable; none was substituted.`);
    }
    return { status: 'available', model: entry.model };
  } catch {
    return unavailable('unknown', `Cannot verify effective ${label} settings from the read-only native RPC.`);
  }
}
