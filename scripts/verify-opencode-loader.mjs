#!/usr/bin/env node
// Exercise OpenCode's real local-directory loader on a private server. No prompts or inference.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [source, expected = 'active'] = process.argv.slice(2);
if (!source || !isAbsolute(source) || !['active', 'missing'].includes(expected)) {
  console.error('Usage: node scripts/verify-opencode-loader.mjs /absolute/plugin/path [active|missing]');
  process.exitCode = 2;
} else {
  const root = await mkdtemp(join(tmpdir(), 'opencode/fusion-loader-'));
  const configDir = join(root, 'config', 'opencode');
  const location = join(root, 'location');
  await mkdir(configDir, { recursive: true });
  await mkdir(location);
  const config = join(configDir, 'opencode.jsonc');
  await writeFile(config, `${JSON.stringify({ plugins: [source] }, null, 2)}\n`);

  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));

  const env = { ...process.env,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache') };
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: location, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let password;
  let started = false;
  let ended = false;
  let spawnError;
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (line.startsWith('server password ')) password = line.slice('server password '.length);
      else if (line.startsWith('server listening on ')) started = true;
      else if (/(failed to load plugin|error)/i.test(line)) lines.push(line.slice(0, 300));
    });
  }
  child.on('error', (error) => { spawnError = error; ended = true; });
  child.on('exit', () => { ended = true; });

  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  try {
    for (let attempt = 0; attempt < 40 && (!started || !password) && !ended; attempt++) await pause(250);
    if (spawnError) throw new Error(`could not start opencode: ${spawnError.code ?? spawnError.message}`);
    if (!started || !password) throw new Error('private server did not announce its address and password');
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const get = async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    };
    const documents = await get('/api/config');
    if (!documents.some((entry) => entry.path === config && entry.info?.plugins?.includes(source))) {
      throw new Error('isolated config was not discovered');
    }
    let plugins = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await get('/api/plugin');
      plugins = result.data.filter((item) => item.id === 'fusion-mode');
      if (plugins.length) break;
      await pause(1000);
    }
    const commands = (await get('/api/command')).data.filter((item) => item.name === 'fusion-models');
    const ok = expected === 'active'
      ? plugins.length === 1 && plugins[0].state?.status === 'active'
        && resolve(plugins[0].source?.path ?? '') === join(source, 'index.ts') && commands.length === 1
      : plugins.length === 0 && commands.length === 0;
    console.log(JSON.stringify({ source, expected, plugin: plugins.map(({ id, state, source: origin }) =>
      ({ id, state: state?.status, path: origin?.path })), fusionModelsCommands: commands.length,
      isolated: root, verified: ok }, null, 2));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'private loader verification failed');
    for (const line of lines) console.error(line.replace(/server password \S+/g, 'server password <REDACTED>'));
    process.exitCode = 1;
  } finally {
    password = undefined;
    if (!ended) child.kill('SIGTERM');
    for (let attempt = 0; attempt < 20 && !ended; attempt++) await pause(100);
    if (!ended) child.kill('SIGKILL');
  }
}
