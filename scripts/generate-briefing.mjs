import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBriefing } from '../shared/briefing.mjs';

const profiles = [
  { path: 'com.github.copilot/agents/fusion.agent.md', kind: 'full', guidance: 'full' },
  { path: 'com.github.copilot/agents/fusion-sidekick.agent.md', kind: 'completion', guidance: 'completion' },
  { path: 'com.github.copilot/agents/fusion-reviewer.agent.md', kind: 'reviewer', guidance: 'reviewer' },
];

function updateSection(profile, kind, guidance, path) {
  const start = `<!-- fusion-delegation:${kind}:start -->\n`;
  const end = `<!-- fusion-delegation:${kind}:end -->`;
  if (profile.split(start).length !== 2 || profile.split(end).length !== 2) {
    throw new Error(`${path}: expected exactly one pair of ${kind} generated-section markers.`);
  }
  const from = profile.indexOf(start) + start.length;
  const to = profile.indexOf(end);
  if (to < from) throw new Error(`${path}: ${kind} generated-section markers are out of order.`);
  return `${profile.slice(0, from)}${guidance}\n${profile.slice(to)}`;
}

async function main(args) {
  let check = false;
  let root = new URL('../', import.meta.url);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--root' && args[i + 1]) root = pathToFileURL(resolve(args[++i]) + sep);
    else throw new Error(`Unknown argument: ${args[i]}. Usage: node scripts/generate-briefing.mjs [--check] [--root directory]`);
  }
  const guidance = await loadBriefing(new URL('skills/fusion-delegation/SKILL.md', root));
  const files = await Promise.all(profiles.map(async ({ path, kind, guidance: form }) => {
    const url = new URL(path, root);
    const original = await readFile(url, 'utf8');
    return { path, url, original, generated: updateSection(original, kind, guidance[form], path) };
  }));
  const stale = files.filter(({ original, generated }) => original !== generated);
  if (check && stale.length) throw new Error(`Stale generated briefing sections: ${stale.map(({ path }) => path).join(', ')}. Run node scripts/generate-briefing.mjs.`);
  if (!check) await Promise.all(stale.map(({ url, generated }) => writeFile(url, generated)));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
