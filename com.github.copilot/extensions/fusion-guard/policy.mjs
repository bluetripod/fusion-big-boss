import { extname, isAbsolute } from 'node:path';
import { canonicalFusionRole } from './identity.mjs';

const SHELL_TOOLS = new Set([
  'bash', 'read_bash', 'write_bash', 'list_bash', 'stop_bash',
  'powershell', 'read_powershell', 'write_powershell', 'list_powershell', 'stop_powershell',
  'local_shell',
]);
const SEARCH_TOOLS = new Set(['grep', 'rg', 'glob']);
// Exact native and built-in GitHub MCP names present in the 1.0.95 runtime.
const WEB_TOOLS = new Set(['web_fetch', 'web_search', 'github-mcp-server-web_search', 'github-mcp-server/web_search']);
export const isWebTool = name => WEB_TOOLS.has(name);
const TASK_OVERRIDES = ['model', 'reasoning_effort', 'context_tier'];
const REUSE_SELECTORS = ['agent_id', 'agent_ids', 'sessionID', 'session_id', 'scope'];
const IMAGE_EXTENSIONS = new Set([
  '.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff',
  '.ico', '.avif', '.heic', '.heif', '.jxl', '.svg',
]);
const DELEGATE = 'Use the Fusion sidekick for precisely specified commands or file-location lookups; the lead reads and interprets source.';

const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: `${reason} ${DELEGATE}` });

const hasTaskOverride = (toolName, args) => toolName === 'task' && args !== null
  && typeof args === 'object' && TASK_OVERRIDES.some((key) => key in args);

export const isGuardedTool = (toolName) => SHELL_TOOLS.has(toolName)
  || SEARCH_TOOLS.has(toolName) || WEB_TOOLS.has(toolName)
  || toolName === 'view' || toolName === 'task' || toolName === 'write_agent' || toolName === 'read_agent' || toolName === 'fusion_cancel';

export function decideEvidenceTool({ toolName }) {
  if (SHELL_TOOLS.has(toolName) || SEARCH_TOOLS.has(toolName) || toolName === 'view') return undefined;
  return { permissionDecision: 'deny', permissionDecisionReason: 'Fusion evidence sidekick allows only file-location tools and specified shell/Git/test checks; no source edits or further delegation.' };
}

export function decideTool({ toolName, toolArgs }, file, descendant = false, role) {
  if (descendant && ['fusion-reviewer', 'fusion-advisor'].includes(role) && toolName !== 'view') {
    if (role === 'fusion-reviewer' && toolName === 'skill' || ['write_agent', 'read_agent', 'fusion_cancel'].includes(toolName)) return undefined;
    if (toolName === 'task' && canonicalFusionRole(toolArgs?.agent_type) === 'fusion-sidekick'
      && toolArgs.mode === 'background' && !hasTaskOverride(toolName, toolArgs)
      && !REUSE_SELECTORS.some(key => Object.hasOwn(toolArgs, key))) return undefined;
    return { permissionDecision: 'deny',
      permissionDecisionReason: 'Fusion advisor/reviewer is read-only: bounded text view, permitted native skills and its own evidence sidekick only; no direct shell, search, web or edits.' };
  }
  if (WEB_TOOLS.has(toolName) && descendant && role === 'fusion-sidekick') return undefined;
  if (WEB_TOOLS.has(toolName)) return {
    permissionDecision: 'deny',
    permissionDecisionReason: toolName === 'web_fetch'
       ? 'Fusion URL fetching belongs to the sidekick with a known URL; the lead and advisor do not fetch directly.'
       : 'Fusion web search belongs to the coding sidekick; the lead and evidence roles do not search the web directly.',
  };
  if (SHELL_TOOLS.has(toolName)) return deny('Fusion lead cannot run or inspect shell sessions.');
  if (SEARCH_TOOLS.has(toolName)) return deny('Fusion lead cannot search directly.');
  if (hasTaskOverride(toolName, toolArgs)) return {
    permissionDecision: 'deny',
    permissionDecisionReason: 'Fusion task calls must omit model, reasoning_effort, and context_tier overrides. Configure workers through native /subagents settings instead.',
  };
  if (toolName === 'task') {
    if (descendant) return {
      permissionDecision: 'deny',
      permissionDecisionReason: role
        ? 'Fusion sidekick and advisor cannot delegate to agents.'
        : 'Cannot verify the Fusion descendant role and ancestry; delegation is denied until metadata recovers.',
    };
    if (toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)
      && Object.hasOwn(toolArgs, 'agent_type')) {
        const fresh = !REUSE_SELECTORS.some((key) => Object.hasOwn(toolArgs, key));
        const requestedRole = canonicalFusionRole(toolArgs.agent_type);
        if (fresh && requestedRole === 'fusion-sidekick'
          && toolArgs.mode === 'background') return undefined;
        if ((requestedRole === 'fusion-advisor' && ['sync', 'background'].includes(toolArgs.mode)
          || requestedRole === 'fusion-reviewer' && toolArgs.mode === 'background')
          && fresh) return undefined;
    }
    return deny('Fusion lead task calls require a fresh fusion-sidekick, fusion-advisor, or user-requested fusion-reviewer with mode: background (advisor also supports sync); continue an idle related background worker with write_agent.');
  }
  if (toolName !== 'view') return undefined;

  const args = toolArgs;
  const range = args?.view_range;
  const maxLines = 350;
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || typeof args.path !== 'string' || !isAbsolute(args.path)
    || args.forceReadLargeFiles !== undefined && args.forceReadLargeFiles !== false
    || 'view_range[0]' in args || 'view_range[1]' in args
    || !Array.isArray(range) || range.length !== 2
    || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1])
    || range[0] < 1 || range[1] < range[0] || range[1] - range[0] >= maxLines) {
    return deny(`Fusion ${role === 'fusion-reviewer' ? 'reviewer' : 'lead'} view requires an absolute text-file path and an explicit, finite 1–${maxLines}-line inclusive view_range; forceReadLargeFiles is forbidden.`);
  }
  if (file?.kind !== 'text') return deny(`Fusion ${role === 'fusion-reviewer' ? 'reviewer' : 'lead'} view requires a readable regular text file, not an image or directory.`);
  return undefined;
}

export function isTextSample(path, bytes, atEof = true) {
  if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  if (bytes.includes(0)) return false;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || bytes.subarray(0, 3).toString('ascii') === 'GIF'
    || bytes.subarray(0, 2).toString('ascii') === 'BM'
    || bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    || /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(bytes.toString('utf8'))) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !atEof });
    return !bytes.some((byte) => byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte));
  } catch {
    return false;
  }
}
