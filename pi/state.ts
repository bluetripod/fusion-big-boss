import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import { splitContext, validateContext, withContext } from '../shared/context.mjs';

export const roles = ['lead', 'sidekick', 'advisor', 'reviewer'] as const;
export type Role = typeof roles[number];
export type Setup = { lead: string; sidekick: string; advisor?: string; reviewer?: string };
export type Draft = Partial<Record<Role, string | undefined>>;
export type Changes = Partial<Record<Role, string | null>>;
export type Registry = {
  find(provider: string, id: string): Model<any> | undefined;
  getAvailable(): Model<any>[];
  hasConfiguredAuth(model: Model<any>): boolean;
};

export function parseChoice(choice: string) {
  const { choice: identity, context } = splitContext(choice);
  const match = /^([^/\s#]+)\/([^\s#]+)#(off|minimal|low|medium|high|xhigh|max)$/.exec(identity);
  return match ? { provider: match[1], id: match[2], effort: match[3] as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', ...(context !== undefined ? { context } : {}) } : undefined;
}
export function label(ref: NonNullable<ReturnType<typeof parseChoice>>) {
  return withContext(`${ref.provider}/${ref.id}#${ref.effort}`, ref.context);
}
export function resolveChoice(value: string, registry: Registry): { model: Model<any>; effort: NonNullable<ReturnType<typeof parseChoice>>['effort'] } {
  const ref = parseChoice(value);
  if (!ref) throw new Error(`Choose a model and explicit thinking effort: provider/model#effort (got ${JSON.stringify(value)}).`);
  const model = registry.find(ref.provider, ref.id);
  if (!model || !registry.getAvailable().some(m => m.provider === ref.provider && m.id === ref.id)) throw new Error(`Model ${label(ref)} is unavailable; choose again.`);
  if (!model.input.includes('text')) throw new Error(`Model ${label(ref)} cannot take text input.`);
  if (!registry.hasConfiguredAuth(model)) throw new Error(`Model ${label(ref)} has no configured authentication.`);
  if (!getSupportedThinkingLevels(model).includes(ref.effort)) throw new Error(`Thinking effort ${ref.effort} is unavailable for ${ref.provider}/${ref.id}.`);
  validateContext(ref.context, model.contextWindow);
  return { model: ref.context === undefined ? model : { ...model, contextWindow: ref.context }, effort: ref.effort };
}
export function validateSetup(draft: Draft, registry: Registry): Setup {
  if (!draft.lead || !draft.sidekick) throw new Error('Choose both lead and sidekick before Apply.');
  const setup = { lead: draft.lead, sidekick: draft.sidekick, ...(draft.advisor ? { advisor: draft.advisor } : {}), ...(draft.reviewer ? { reviewer: draft.reviewer } : {}) };
  if (splitContext(setup.lead).choice === splitContext(setup.sidekick).choice) throw new Error('Choose different lead and sidekick models/efforts.');
  for (const role of roles) if (setup[role]) resolveChoice(setup[role], registry);
  return setup;
}
export function choose(setup: Draft, changes: Changes): Draft {
  return { ...setup, ...Object.fromEntries(Object.entries(changes).map(([role, value]) => [role, value === null ? undefined : value])) };
}

export type BranchEntry = { type: string; customType?: string; data?: unknown };
export function activeState(entries: readonly BranchEntry[]): { setup?: Setup; sidekicks: string[]; advisors: string[]; reviewers: string[]; disabled: boolean } {
  const state: { setup?: Setup; sidekicks: string[]; advisors: string[]; reviewers: string[]; disabled: boolean } = { sidekicks: [], advisors: [], reviewers: [], disabled: false };
  for (const entry of entries) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === 'fusion.pi.setup') {
      const data = entry.data as Setup;
      if (!data || typeof data.lead !== 'string' || typeof data.sidekick !== 'string') throw new Error('Corrupt Fusion branch setup.');
      state.setup = { lead: data.lead, sidekick: data.sidekick, ...(data.advisor !== undefined ? { advisor: data.advisor } : {}), ...(data.reviewer !== undefined ? { reviewer: data.reviewer } : {}) };
      state.disabled = false;
    } else if (entry.customType === 'fusion.pi.disabled') {
      if (!state.setup) throw new Error('Cannot disable Fusion before setup.');
      state.disabled = true;
    } else if (entry.customType === 'fusion.pi.child') {
      const data = entry.data as { role: string; id: string };
      if (data?.role === 'utility') continue;
      if (!state.setup || !data || typeof data.id !== 'string' || !/^[\w-]{8,100}$/.test(data.id)) throw new Error('Corrupt Fusion child reference.');
      if (data.role === 'sidekick') state.sidekicks.push(data.id);
      else if (data.role === 'advisor') state.advisors.push(data.id);
      else if (data.role === 'reviewer') state.reviewers.push(data.id);
      else throw new Error('Corrupt Fusion child role.');
    }
  }
  return state;
}

type Stored = { version: 1; last?: Setup; recents: Record<Role, string[]> };
const empty = (): Stored => ({ version: 1, recents: { lead: [], sidekick: [], advisor: [], reviewer: [] } });
const pending = new Map<string, Promise<unknown>>();
export class History {
  readonly path: string;
  readonly dir: string;
  constructor(agentDir: string, cwd: string) {
    this.dir = join(agentDir, 'fusion', createHash('sha256').update(cwd).digest('hex'));
    this.path = join(this.dir, 'history.json');
  }
  async load(): Promise<Stored> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
    try {
      const data = JSON.parse(text) as Stored;
      if (data.recents && data.recents.reviewer === undefined) data.recents.reviewer = [];
      if (data.version !== 1 || !data.recents || roles.some(role => !Array.isArray(data.recents[role]) || data.recents[role].length > 3 || data.recents[role].some(value => typeof value !== 'string' || !parseChoice(value)))) throw new Error('invalid data');
      if (data.last && (typeof data.last.lead !== 'string' || typeof data.last.sidekick !== 'string' ||
        roles.some(role => data.last?.[role] !== undefined && (typeof data.last[role] !== 'string' || !parseChoice(data.last[role]))))) throw new Error('invalid last setup');
      return { version: 1, recents: { lead: data.recents.lead, sidekick: data.recents.sidekick, advisor: data.recents.advisor, reviewer: data.recents.reviewer },
        ...(data.last ? { last: { lead: data.last.lead, sidekick: data.last.sidekick, ...(data.last.advisor !== undefined ? { advisor: data.last.advisor } : {}), ...(data.last.reviewer !== undefined ? { reviewer: data.last.reviewer } : {}) } } : {}) };
    } catch { throw new Error(`Corrupt Fusion history at ${this.path}; inspect and repair privately, no changes were written.`); }
  }
  async record(setup: Draft, selected: Partial<Record<Role, boolean>>): Promise<void> {
    const previous = pending.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const data = await this.load();
      for (const role of roles) {
        const value = setup[role];
        if (!selected[role] || !value) continue;
        const normalized = withContext(value, splitContext(value).context);
        data.recents[role] = [value, ...data.recents[role].filter(item => withContext(item, splitContext(item).context) !== normalized)].slice(0, 3);
      }
      if (setup.lead && setup.sidekick) data.last = { lead: setup.lead, sidekick: setup.sidekick, ...(setup.advisor ? { advisor: setup.advisor } : {}), ...(setup.reviewer ? { reviewer: setup.reviewer } : {}) };
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = join(this.dir, `.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.path);
      } finally { await rm(temp, { force: true }); }
    });
    pending.set(this.path, next);
    try { await next; } finally { if (pending.get(this.path) === next) pending.delete(this.path); }
  }
}
