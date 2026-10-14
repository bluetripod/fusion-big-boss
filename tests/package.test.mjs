import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the offline package includes the Pi extension and its transitive local imports', async () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const paths = new Set(JSON.parse(packed.stdout)[0].files.map(file => file.path));
  const pending = ['pi/index.ts'];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    assert.ok(paths.has(path), `Pi cannot load from the package: missing ${path}`);
    const source = await readFile(join(root, path), 'utf8');
    for (const { fileName } of ts.preProcessFile(source).importedFiles) {
      if (fileName.startsWith('.')) pending.push(posix.normalize(posix.join(dirname(path), fileName)));
    }
  }
});
