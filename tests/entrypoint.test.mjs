import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('extension entrypoint actually joins and installs an enforcing pre-tool hook', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-guard-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = join(dir, 'loader.mjs');
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@github/copilot-sdk/extension') return {
      url: 'data:text/javascript,export const joinSession = globalThis.__joinSession', shortCircuit: true,
    };
    return nextResolve(specifier, context);
  }\n`);
  const run = `
    import assert from 'node:assert/strict';
    let joins = 0;
    let hooks;
    let commands;
    const notices = [];
    globalThis.__joinSession = async (config) => {
      joins++;
      hooks = config.hooks;
      commands = config.commands;
      return { sessionId: 'root', on: () => () => {}, log: async message => notices.push(message),
        connection: { sendRequest: async method => {
          assert.equal(method, 'user.settings.get');
          return { settings: { subagents: { value: { agents: {
            'ai4corp-fusion-bigg-boss:fusion-reviewer': { model: 'reviewer', effortLevel: 'high', modelPolicy: 'required' },
          } } } } };
        } }, rpc: {
        model: { list: async () => ({ list: [{ id: 'reviewer', supportedReasoningEfforts: ['high'] }] }) },
        eventLog: { read: async () => ({ events: [], cursor: 'end', hasMore: false, cursorStatus: 'ok' }) },
        agent: { getCurrent: async () => ({ agent: {
          id: 'ai4corp-fusion-bigg-boss:fusion', name: 'ai4corp-fusion-bigg-boss:fusion',
          source: 'plugin', path: process.argv[2],
        } }) },
      } };
    };
    await import(process.argv[1]);
    assert.equal(joins, 1, 'entrypoint must call joinSession');
    assert.equal(typeof hooks?.onPreToolUse, 'function');
    const result = await hooks.onPreToolUse(
      { sessionId: 'root', toolName: 'bash', toolArgs: { command: 'npm test' } },
      { sessionId: 'root' });
    assert.equal(result?.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /Fusion lead cannot run/);
    await commands.find(command => command.name === 'fusion').handler({ sessionId: 'root', args: 'status' });
    assert.match(notices.at(-1), /Fusion on/);
    const review = () => hooks.onPreToolUse(
      { sessionId: 'root', toolName: 'task', toolArgs: { agent_type: 'ai4corp-fusion-bigg-boss:fusion-reviewer', mode: 'background' } },
      { sessionId: 'root' });
    assert.equal(await review(), undefined, 'entrypoint must support direct configured reviewer delegation');
  `;
  const entrypoint = new URL('../com.github.copilot/extensions/fusion-guard/extension.mjs', import.meta.url).href;
  const profile = fileURLToPath(new URL('../com.github.copilot/agents/fusion.agent.md', import.meta.url));
  const result = spawnSync(process.execPath,
    ['--experimental-loader', loader, '--input-type=module', '-e', run, entrypoint, profile],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, XDG_STATE_HOME: join(dir, 'state') } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
