import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBriefing } from '../shared/briefing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const generator = fileURLToPath(new URL('../scripts/generate-briefing.mjs', import.meta.url));
const skill = 'skills/fusion-delegation/SKILL.md';
const lead = 'com.github.copilot/agents/fusion.agent.md';
const sidekick = 'com.github.copilot/agents/fusion-sidekick.agent.md';
const reviewer = 'com.github.copilot/agents/fusion-reviewer.agent.md';
const profiles = [lead, sidekick, reviewer];
const run = (...args) => spawnSync(process.execPath, [generator, ...args], { encoding: 'utf8' });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-briefing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const relative of [skill, ...profiles]) {
    await mkdir(join(dir, relative, '..'), { recursive: true });
    await writeFile(join(dir, relative), await readFile(join(root, relative)));
  }
  return dir;
}

test('packaged briefing passes the generator drift check without rewriting profiles', async () => {
  const before = await Promise.all(profiles.map(path => readFile(join(root, path), 'utf8')));
  const result = run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await Promise.all(profiles.map(path => readFile(join(root, path), 'utf8'))), before);
});

test('Copilot coding roles carry the same always-on minimal-solution guidance', async () => {
  const leadProfile = await readFile(join(root, lead), 'utf8');
  const sidekickProfile = await readFile(join(root, sidekick), 'utf8');
  const guidance = (profile) => profile.match(/## Minimal solutions\n[\s\S]*?(?=\n<!-- fusion-delegation:)/)?.[0].trim();
  assert.ok(guidance(leadProfile), 'lead guidance must precede generated briefing');
  assert.equal(guidance(sidekickProfile), guidance(leadProfile));
  assert.match(guidance(leadProfile), /existing code.*standard library.*native platform.*installed dependency/s);
  assert.match(guidance(leadProfile), /validation.*data-loss.*security.*accessibility.*regression check/s);
});

test('--check detects stale guidance without writing to a copied installation', async (t) => {
  const dir = await fixture(t);
  const profile = join(dir, sidekick);
  const stale = (await readFile(profile, 'utf8')).replace('<!-- fusion-delegation:completion:start -->\n', '<!-- fusion-delegation:completion:start -->\nOutdated generated content.\n');
  assert.notEqual(stale, await readFile(profile, 'utf8'));
  await writeFile(profile, stale);
  const result = run('--check', '--root', dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale.*fusion-sidekick\.agent\.md/i);
  assert.equal(await readFile(profile, 'utf8'), stale);
  assert.equal(await readFile(join(dir, lead), 'utf8'), await readFile(join(root, lead), 'utf8'));
});

test('generation updates only marked sections, preserving surrounding policy and line breaks', async (t) => {
  const dir = await fixture(t);
  const profile = join(dir, lead);
  const original = await readFile(profile, 'utf8');
  const changed = original.replace('<!-- fusion-delegation:full:start -->\n', '<!-- fusion-delegation:full:start -->\nOutdated generated guidance.\n');
  const annotated = changed.replace('<!-- fusion-delegation:full:start -->',
    'Handwritten policy immediately before.\n<!-- fusion-delegation:full:start -->')
    + 'Handwritten policy at the end.\n';
  await writeFile(profile, annotated);
  const result = run('--root', dir);
  assert.equal(result.status, 0, result.stderr);
  const updated = await readFile(profile, 'utf8');
  assert.equal(updated, original.replace('<!-- fusion-delegation:full:start -->',
    'Handwritten policy immediately before.\n<!-- fusion-delegation:full:start -->')
    + 'Handwritten policy at the end.\n');
  assert.match(updated, /\n- \*\*Objective:\*\*[^\n]+\n- \*\*Context \/ inputs:\*\*/);
  assert.equal(run('--check', '--root', dir).status, 0);
});

test('incomplete canonical skill fails clearly without rewriting any profile', async (t) => {
  const dir = await fixture(t);
  const canonical = await readFile(join(dir, skill), 'utf8');
  await writeFile(join(dir, skill), canonical.replace('- **Return:** the result', '- **Missing:** the result'));
  const before = await Promise.all(profiles.map((name) => readFile(join(dir, name), 'utf8')));
  const result = run('--root', dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required.*Return/i);
  assert.deepEqual(await Promise.all(profiles.map((name) => readFile(join(dir, name), 'utf8'))), before);
});

test('missing generated-section marker fails before touching another stale profile', async (t) => {
  const dir = await fixture(t);
  const missing = join(dir, lead);
  const stale = join(dir, sidekick);
  await writeFile(missing, (await readFile(missing, 'utf8')).replace('<!-- fusion-delegation:full:end -->', ''));
  await writeFile(stale, (await readFile(stale, 'utf8')).replace('<!-- fusion-delegation:completion:start -->\n', '<!-- fusion-delegation:completion:start -->\nOutdated generated content.\n'));
  const before = await Promise.all([missing, stale].map((path) => readFile(path, 'utf8')));
  const result = run('--root', dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected exactly one pair.*full generated-section markers/i);
  assert.deepEqual(await Promise.all([missing, stale].map((path) => readFile(path, 'utf8'))), before);
});

test('expanded completion prose is regenerated in both copied profiles', async (t) => {
  const dir = await fixture(t);
  const source = join(dir, skill);
  const canonical = await readFile(source, 'utf8');
  const revised = canonical.replace('Stop when the requested evidence and verification are complete.',
      'Finish after the requested evidence and verification are complete.')
    .replace('Workers return **Status**, **Result**, **Evidence / checks**, and **Open items**, omitting empty sections.',
      'Send **Status**, **Result**, **Evidence / checks**, and **Open items** back to the caller, omitting empty sections.')
    .replace('A structured brief is a communication aid, not a reason to reject an otherwise clear request for missing headings.',
      'An extra completion paragraph can evolve independently.\n\nA structured brief is a communication aid, not a reason to reject an otherwise clear request for missing headings.');
  assert.notEqual(revised, canonical);
  await writeFile(source, revised);
  const before = await Promise.all([lead, sidekick].map(path => readFile(join(dir, path), 'utf8')));
  assert.notEqual(run('--check', '--root', dir).status, 0);
  const generated = run('--root', dir);
  assert.equal(generated.status, 0, generated.stderr);
  const after = await Promise.all([lead, sidekick].map(path => readFile(join(dir, path), 'utf8')));
  for (let i = 0; i < before.length; i++) assert.notEqual(after[i], before[i]);
  assert.equal(run('--check', '--root', dir).status, 0);
});

test('missing completion section reports its name instead of omitting worker guidance', async (t) => {
  const dir = await fixture(t);
  const source = join(dir, skill);
  await writeFile(source, (await readFile(source, 'utf8')).replace('## Completion and return', '## Unrelated section'));
  await assert.rejects(loadBriefing(source), /missing required section: Completion and return/);
  const result = run('--check', '--root', dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required section: Completion and return/);
});

test('reviewer guidance changes propagate only to the lead and reviewer generated sections', async (t) => {
  const dir = await fixture(t);
  const source = join(dir, skill);
  const before = await Promise.all(profiles.map(path => readFile(join(dir, path), 'utf8')));
  await writeFile(source, `${await readFile(source, 'utf8')}\nAdditional reviewer guidance for this copied installation.\n`);
  assert.notEqual(run('--check', '--root', dir).status, 0);
  const generated = run('--root', dir);
  assert.equal(generated.status, 0, generated.stderr);
  const after = await Promise.all(profiles.map(path => readFile(join(dir, path), 'utf8')));
  assert.notEqual(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.notEqual(after[2], before[2]);
  assert.equal(run('--check', '--root', dir).status, 0);
});
