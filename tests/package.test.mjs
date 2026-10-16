import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { Host } from '@opencode/plugin/host';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the offline package includes native OpenCode and Pi entrypoints and their local imports', async () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const paths = new Set(JSON.parse(packed.stdout)[0].files.map(file => file.path));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const entrypoints = Host.resolve({ directory: root, name: manifest.name });
  assert.ok(entrypoints.server, 'OpenCode must discover the packaged server plugin');
  assert.ok(entrypoints.tui, 'OpenCode must discover the packaged TUI plugin');
  const pending = [...manifest.pi.extensions, ...Object.values(entrypoints).filter(Boolean)
    .map(path => relative(root, path.startsWith('file:') ? fileURLToPath(path) : path))]
    .map(path => posix.normalize(path));
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    assert.ok(paths.has(path), `Cannot load from the package: missing ${path}`);
    const source = await readFile(join(root, path), 'utf8');
    for (const { fileName } of ts.preProcessFile(source).importedFiles) {
      if (fileName.startsWith('.')) {
        const local = posix.normalize(posix.join(dirname(path), fileName));
        pending.push(paths.has(local) ? local : `${local}.ts`);
      }
    }
  }
});
