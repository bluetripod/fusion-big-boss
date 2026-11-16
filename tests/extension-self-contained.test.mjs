import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionDirectory = fileURLToPath(new URL('../com.github.copilot/extensions/fusion-guard/', import.meta.url));
const sharedSupervision = fileURLToPath(new URL('../shared/supervision.mjs', import.meta.url));

async function withCopiedExtension(run) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-self-contained-'));
  try {
    const folder = join(root, 'com.github.copilot', 'extensions', 'fusion-guard');
    await cp(extensionDirectory, folder, { recursive: true });
    return await run({ root, folder });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('copied Copilot extension modules resolve their imports without the repository', () => withCopiedExtension(async ({ folder }) => {
  const files = (await readdir(folder)).filter(name => name.endsWith('.mjs') && name !== 'extension.mjs');
  assert.ok(files.length > 0);
  for (const file of files) {
    await import(pathToFileURL(join(folder, file)).href);
  }
}));

test('copied identity recognizes the packaged lead without the agents folder', () => withCopiedExtension(async ({ root, folder }) => {
  const { fusionAgentIdentity } = await import(pathToFileURL(join(folder, 'identity.mjs')).href);
  const agent = {
    source: 'plugin',
    id: 'fusion-big-boss:fusion',
    name: 'fusion-big-boss:fusion',
    path: join(root, 'com.github.copilot', 'agents', 'fusion.agent.md'),
  };
  assert.equal(fusionAgentIdentity(agent), 'fusion');
}));

test('copied identity keeps a same-named agent from another plugin unrelated', () => withCopiedExtension(async ({ root, folder }) => {
  const { fusionAgentIdentity } = await import(pathToFileURL(join(folder, 'identity.mjs')).href);
  const agent = {
    source: 'plugin',
    id: 'fusion-big-boss:fusion',
    name: 'fusion-big-boss:fusion',
    path: join(root, 'other-plugin', 'agents', 'fusion.agent.md'),
  };
  assert.equal(fusionAgentIdentity(agent), 'unrelated');
}));

test('Copilot supervisor-core copy matches shared supervision source', async () => {
  const copy = await readFile(join(extensionDirectory, 'supervisor-core.mjs'));
  const source = await readFile(sharedSupervision);
  assert.ok(copy.equals(source), 'Copy shared/supervision.mjs to com.github.copilot/extensions/fusion-guard/supervisor-core.mjs');
});
