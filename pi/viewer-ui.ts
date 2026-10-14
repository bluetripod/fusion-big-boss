import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DynamicBorder, getSelectListTheme, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { activeState } from './state.ts';
import { detailLines, orderRuns, RunRegistry, runLabel, splitRuns, truncateToWidth, tui, widgetLines, type Run } from './viewer.ts';

type Message = Parameters<typeof splitRuns>[0][number];
// Do not use SessionManager.open here: its loader can repair JSONL files on disk.
export async function persistedRuns(ctx: ExtensionContext, dir: string): Promise<Run[]> {
  const root = ctx.sessionManager.getSessionId();
  const state = activeState(ctx.sessionManager.getBranch());
  const refs = [
    ...state.sidekicks.map(id => ({ id, role: 'sidekick' as const })),
    ...state.advisors.map(id => ({ id, role: 'advisor' as const })),
    ...state.reviewers.map(id => ({ id, role: 'reviewer' as const })),
  ];
  let files;
  try { files = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const runs: Run[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const entries = (await readFile(join(dir, file.name), 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const header = entries[0];
    const ref = refs.find(ref => ref.id === header?.id);
    if (!ref || header.type !== 'session' || header.cwd !== ctx.cwd || header.parentSession !== root) continue;
    const owner = entries.find(entry => entry.type === 'custom' && entry.customType === 'fusion.pi.owner')?.data;
    if (owner?.root !== root || owner.role !== ref.role || (ref.role === 'reviewer' ? owner.caller !== root : (owner.caller ?? root) !== root)) continue;
    runs.push(...splitRuns(entries.filter(entry => entry.type === 'message').map(entry => entry.message as Message), {
      role: ref.role, sessionID: ref.id,
    }));
  }
  return runs;
}

function framedLines(lines: string[], width: number, theme: Theme): string[] {
  const background = theme.getBgAnsi('customMessageBg');
  const box = new tui.Box(0, 0, (line: string) => theme.bg('customMessageBg',
    // Markdown may reset all styles; keep every subsequent span opaque.
    line.replace(/\x1b\[[0-9;:]*m/g, escape => escape + background)));
  const border = new DynamicBorder(line => theme.fg('border', line));
  box.addChild(border);
  box.addChild({ render: () => lines, invalidate() {} });
  box.addChild(border);
  return box.render(width);
}

export function createViewer(registry: RunRegistry) {
  let context: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closeOverlay: (() => void) | undefined;
  let opening = false;
  let generation = 0;
  function refresh() {
    if (!registry.runs.length) {
      if (timer) clearInterval(timer); timer = undefined;
      context?.ui.setWidget?.('fusion-agents', undefined);
      requestRender = undefined;
      closeOverlay?.();
      return;
    }
    if (!context?.hasUI || !context.ui.setWidget) return;
    if (!requestRender) context.ui.setWidget('fusion-agents', terminal => {
      requestRender = () => terminal.requestRender();
      return { render: (width: number) => widgetLines(registry.runs, width), invalidate() {}, dispose() { requestRender = undefined; } };
    }, { placement: 'aboveEditor' });
    if (registry.runs.some(run => run.status === 'running')) {
      if (!timer) { timer = setInterval(() => requestRender?.(), 1000); timer.unref(); }
    } else { if (timer) clearInterval(timer); timer = undefined; }
    requestRender?.();
  }
  registry.listen(refresh);
  return {
    track(ctx: ExtensionContext) { context = ctx; },
    clear() { generation++; registry.clear(); context = undefined; },
    async open(ctx: ExtensionContext, dir: string) {
      if (!ctx.hasUI) { ctx.ui.notify('The subagent viewer requires an interactive terminal.', 'warning'); return; }
      if (opening) return;
      opening = true;
      const sessionID = ctx.sessionManager.getSessionId();
      const epoch = generation;
      try {
        let saved: Run[] = [];
        try { saved = await persistedRuns(ctx, dir); }
        catch (error) { ctx.ui.notify(`Could not read saved subagents: ${String(error)}`, 'warning'); }
        if (generation !== epoch || ctx.sessionManager.getSessionId() !== sessionID) return;
        const allRuns = () => [...saved.filter(old => !registry.runs.some(run => run.sessionID === old.sessionID && run.startedAt === old.startedAt)), ...registry.runs];
        if (!allRuns().length) { ctx.ui.notify('No subagent runs in this session.', 'info'); return; }
        for (;;) {
          const run = await ctx.ui.custom<Run | undefined>((terminal, theme, _keys, done) => {
            let list: any;
            let selected: Run | undefined;
            const stop = registry.listen(() => terminal.requestRender());
            closeOverlay = () => done(undefined);
            return {
              render(width: number) {
                const runs = orderRuns(allRuns());
                const index = Math.max(0, selected ? runs.indexOf(selected) : 0);
                selected = runs[index];
                list = new tui.SelectList(runs.map((run, index) => ({ value: String(index), label: runLabel(run, Date.now(), Math.max(1, width - 4)) })), Math.max(1, Math.min(12, Math.floor(terminal.terminal.rows * 0.7) - 4)), getSelectListTheme());
                list.setSelectedIndex(index);
                list.onSelect = (item: { value: string }) => done(runs[Number(item.value)]);
                list.onCancel = () => done(undefined);
                list.onSelectionChange = (item: { value: string }) => { selected = runs[Number(item.value)]; };
                return framedLines([truncateToWidth('Fusion agents • ↑/↓ Enter • Esc closes', width), ...list.render(width)], width, theme);
              },
              handleInput(data: string) { list?.handleInput(data); terminal.requestRender(); },
              invalidate() { list?.invalidate(); },
              dispose() { stop(); closeOverlay = undefined; },
            };
          }, { overlay: true, overlayOptions: { width: '90%', maxHeight: '70%' } });
          if (!run || generation !== epoch || ctx.sessionManager.getSessionId() !== sessionID) return;
          await ctx.ui.custom<void>((terminal, theme, _keys, done) => {
            let fullOutput = false;
            const content = { render: (width: number) => detailLines(run, width, theme, fullOutput), invalidate() {} };
            const scroll = new tui.ScrollView(content);
            const stop = registry.listen(() => terminal.requestRender());
            closeOverlay = () => done();
            return {
              render(width: number) {
                const lines: string[] = scroll.render(width);
                const height = Math.max(1, Math.floor(terminal.terminal.rows * 0.7) - 4);
                scroll.updateLayout(lines.length, height, () => terminal.requestRender());
                const failed = run.status === 'failed' || run.status === 'aborted';
                const status = theme.fg(failed ? 'error' : run.status === 'done' ? 'success' : 'accent', `${failed ? '✗' : run.status === 'done' ? '✓' : '●'} ${run.status}`);
                const seconds = Math.max(0, Math.floor(((run.endedAt ?? Date.now()) - run.startedAt) / 1000));
                const role = theme.fg('accent', run.role);
                return framedLines([truncateToWidth(`${role} • ${status} • ${seconds}s   ↑/↓ PgUp/PgDn • o output • Esc returns`, width), ...lines.slice(scroll.scrollTop, scroll.scrollTop + height)], width, theme);
              },
              handleInput(data: string) {
                if (tui.matchesKey(data, 'escape')) { done(); return; }
                if (tui.matchesKey(data, 'o')) fullOutput = !fullOutput;
                if (tui.matchesKey(data, 'up')) scroll.scrollBy(-1);
                if (tui.matchesKey(data, 'down')) scroll.scrollBy(1);
                if (tui.matchesKey(data, 'pageUp')) scroll.scrollBy(-scroll.viewportHeight);
                if (tui.matchesKey(data, 'pageDown')) scroll.scrollBy(scroll.viewportHeight);
                terminal.requestRender();
              },
              invalidate() { content.invalidate(); },
              dispose() { stop(); closeOverlay = undefined; },
            };
          }, { overlay: true, overlayOptions: { width: '90%', maxHeight: '70%' } });
          if (generation !== epoch || ctx.sessionManager.getSessionId() !== sessionID || !allRuns().length) return;
        }
      } finally { opening = false; }
    },
  };
}
