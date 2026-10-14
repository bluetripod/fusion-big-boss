import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext, FileEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import { summarizeUsage, type UsageRecord } from '../shared/usage.mjs';

export async function collectUsage(ctx: ExtensionContext, dir: string) {
  const root = ctx.sessionManager.getSessionId();
  const sessions = new Map<string, readonly SessionEntry[]>([[root, ctx.sessionManager.getEntries()]]);
  const children = new Map<string, { parent: string; entries: SessionEntry[] }>();
  const notes: string[] = [];
  let files: Dirent[];
  try { files = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
  // Read only: SessionManager.open can repair files. Do not count result-message copies of child usage.
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    try {
      const text = await readFile(join(dir, file.name), 'utf8');
      const lines = text.split('\n');
      const entries: FileEntry[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try { entries.push(JSON.parse(lines[index])); }
        catch (error) {
          if (index !== lines.length - 1) throw error;
          notes.push('An unfinished child history write was omitted; totals may be incomplete.');
        }
      }
      const header = entries[0];
      if (header?.type !== 'session' || header.cwd !== ctx.cwd || !header.parentSession) continue;
      const owner = entries.find(entry => entry?.type === 'custom' && entry.customType === 'fusion.pi.owner');
      const marker = owner?.type === 'custom' ? owner.data as { root?: string; caller?: string; role?: string } | undefined : undefined;
      if (marker?.root !== header.parentSession || (marker.caller ?? marker.root) !== header.parentSession
        || !['sidekick', 'advisor', 'reviewer'].includes(marker.role ?? '')) continue;
      children.set(header.id, { parent: header.parentSession, entries: entries.filter((entry): entry is SessionEntry => !!entry && entry.type !== 'session') });
    } catch {
      notes.push('A child history could not be read; totals may be incomplete.');
    }
  }
  for (const id of sessions.keys()) {
    for (const [child, data] of children) if (data.parent === id && !sessions.has(child)) sessions.set(child, data.entries);
  }
  const records: UsageRecord[] = [];
  const expected = new Set<string>();
  for (const entries of sessions.values()) {
    for (const entry of entries) {
      if (entry.type === 'custom' && ['fusion.pi.child', 'fusion.pi.evidence-sidekick'].includes(entry.customType)) {
        const id = (entry.data as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string') expected.add(id);
      }
      let model = 'Unattributed', usage, priced = false;
      if (entry.type === 'message' && entry.message.role === 'assistant' || entry.type === 'usage') {
        const source = entry.type === 'usage' ? entry : entry.message;
        if (!('provider' in source)) continue;
        const id = 'responseModel' in source ? source.responseModel ?? source.model : source.model;
        model = `${source.provider}/${id}`;
        usage = source.usage;
        const native = ctx.modelRegistry.find(source.provider, id);
        priced = !!native && Object.values(native.cost).some(value => value > 0);
      } else if (entry.type === 'compaction' || entry.type === 'branch_summary') usage = entry.usage;
      else if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName !== 'fusion_delegate') usage = entry.message.usage;
      if (!usage) continue;
      records.push({ model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        cost: usage.cost?.total > 0 || priced ? usage.cost?.total : undefined });
    }
  }
  const missing = [...expected].filter(id => !sessions.has(id)).length;
  if (missing) notes.push(`${missing} referenced subagent session(s) unavailable; totals are partial.`);
  return { sessions: sessions.size, report: summarizeUsage(records), notes: [...new Set(notes)] };
}
