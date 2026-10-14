import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const roles = ['lead', 'sidekick', 'advisor', 'reviewer'];
const empty = () => ({ recents: Object.fromEntries(roles.map(role => [role, []])) });
const choice = (value) => value && typeof value.model === 'string' && value.model.length > 0
  && (value.effort === undefined || typeof value.effort === 'string' && value.effort.length > 0)
  && (value.contextTier === undefined || ['default', 'long_context'].includes(value.contextTier));

export class History {
  constructor(path = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'ai4corp-fusion/copilot-fusion.json')) {
    this.path = path;
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data.recents || roles.some(role => {
        const recent = data.recents[role];
        if (role === 'reviewer' && recent === undefined) return false;
        return !Array.isArray(recent) || recent.length > 3 || !recent.every(choice);
      })) return empty();
      if (data.last && (roles.slice(0, 2).some(role => !choice(data.last[role]))
        || data.last.advisor !== null && !choice(data.last.advisor)
        || data.last.reviewer != null && !choice(data.last.reviewer))) return empty();
      return { recents: Object.fromEntries(roles.map(role => [role, data.recents[role] ?? []])),
        ...(data.last ? { last: Object.fromEntries(roles.map(role => [role, data.last[role] ?? null])) } : {}) };
    } catch { return empty(); }
  }

  async record(setup, selected) {
    const data = await this.load();
    for (const role of roles.filter(role => selected.includes(role))) {
      const value = setup[role];
      if (!value) continue;
      data.recents[role] = [value, ...data.recents[role].filter(old => old.model !== value.model || old.effort !== value.effort
        || old.contextTier !== value.contextTier)].slice(0, 3);
    }
    data.last = Object.fromEntries(roles.map(role => [role, setup[role] ?? null]));
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
      await rename(temp, this.path);
    } finally { await rm(temp, { force: true }); }
  }
}
