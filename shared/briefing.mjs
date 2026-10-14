import { readFile } from 'node:fs/promises';

const canonicalSkill = new URL('../skills/fusion-delegation/SKILL.md', import.meta.url);
const labels = ['Objective', 'Context / inputs', 'Scope / constraints', 'Guidance', 'Done / stop', 'Return'];

export async function loadBriefing(source = canonicalSkill) {
  const raw = (await readFile(source, 'utf8')).replace(/\r\n/g, '\n');
  const match = /^---\n[\s\S]*?\n---\n([\s\S]+)$/.exec(raw);
  if (!match) throw new Error('Canonical fusion-delegation skill is missing YAML frontmatter or a body.');
  const body = match[1].trim();
  const lines = body.split('\n');

  function section(name) {
    const start = lines.indexOf(`## ${name}`);
    if (start < 0) throw new Error(`Canonical fusion-delegation skill is missing required section: ${name}.`);
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const text = lines.slice(start, next < 0 ? undefined : next).join('\n').trim();
    if (text === `## ${name}`) throw new Error(`Canonical fusion-delegation section is empty: ${name}.`);
    return text;
  }

  const substantive = section('Substantive tasks');
  for (const label of labels) {
    const prefix = `- **${label}:**`;
    if (!substantive.split('\n').some((line) => line.startsWith(prefix) && line.slice(prefix.length).trim())) {
      throw new Error(`Canonical fusion-delegation skill is missing required guidance: ${label}.`);
    }
  }
  const small = section('Small tasks');
  for (const label of ['**Objective**', '**Exact action**', '**Return**']) {
    if (!small.includes(label)) throw new Error(`Canonical fusion-delegation skill is missing required small-task guidance: ${label}.`);
  }
  section('Follow-ups');
  const completion = section('Completion and return');
  for (const label of ['**Status**', '**Result**', '**Evidence / checks**', '**Open items**']) {
    if (!completion.includes(label)) throw new Error(`Canonical fusion-delegation skill is missing required completion and return guidance: ${label}.`);
  }
  return {
    full: body,
    completion,
    reviewer: section('Reviewer contract'),
  };
}
