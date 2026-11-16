// Bounded routing check, not a shell sandbox. Scripts and arbitrary executables can invoke Git.
const OPERATORS = new Set([';', '|', '||', '&', '&&', '(', ')', '{', '}', '\n']);
const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'time', 'nice', 'nohup', 'xargs', 'if', '!', 'not']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);

/** @param {string} command */
function tokenize(command) {
  const tokens = [];
  let word = '';
  let quote = '';
  let quoted = false;
  const nested = [];
  const push = () => { if (word) tokens.push({ value: word, quoted }); word = ''; quoted = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") { quoted = true; word += command[++i] ?? ''; continue; }
    if (ch === quote) { quote = ''; continue; }
    if (quote === "'") { word += ch; continue; }
    if (quote === '"' && ch === "'") { word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue; }
    if (ch === '`' || ch === '$' && command[i + 1] === '(') {
      const isDollar = ch === '$';
      const end = command.indexOf(isDollar ? ')' : '`', i + (isDollar ? 2 : 1));
      if (end < 0) return { tokens, nested, ambiguous: /\bgit\b/i.test(command) };
      nested.push(command.slice(i + (isDollar ? 2 : 1), end));
      word += 'substitution';
      i = end;
      continue;
    }
    if (!quote && (/\s/.test(ch) || ';|&(){}<>'.includes(ch))) {
      push();
      if (';|&(){}<>'.includes(ch) || ch === '\n') {
        const pair = command.slice(i, i + 2);
        if (pair === '||' || pair === '&&') { tokens.push({ value: pair, syntax: true }); i++; }
        else tokens.push({ value: ch, syntax: true });
      }
      continue;
    }
    word += ch;
  }
  if (quote) return { tokens, nested, ambiguous: /\bgit\b/i.test(command) };
  push();
  return { tokens, nested, ambiguous: false };
}

/**
 * @param {unknown} command
 * @param {number} [depth]
 * @returns {boolean}
 */
export function containsGitCommand(command, depth = 0) {
  if (typeof command !== 'string') return false;
  if (depth > 5) return /\bgit\b/i.test(command);
  const { tokens, nested, ambiguous } = tokenize(command);
  if (ambiguous || nested.some((part) => containsGitCommand(part, depth + 1))) return true;
  let atStart = true;
  let wrapped = false;
  for (let i = 0; i < tokens.length; i++) {
    const { value, syntax, quoted } = tokens[i];
    // Braces are shell reserved words only at a command boundary; elsewhere
    // they can be ordinary arguments, such as `echo { git status }`.
    if (syntax && OPERATORS.has(value) && (atStart || value !== '{' && value !== '}')) {
      atStart = true; wrapped = false; continue;
    }
    if (atStart && !quoted && (value === 'then' || value === 'do')) continue;
    if (!atStart) continue;
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) continue;
    const executable = value.replace(/^(?:\.\/)+/, '');
    if (/(?:^|[/\\])git(?:\.exe)?$/i.test(executable)) return true;
    const basename = executable.split(/[/\\]/).at(-1);
    if (WRAPPERS.has(basename)) { wrapped = true; continue; }
    if (wrapped && ['-u', '-g', '-C', '--user', '--group', '--chdir'].includes(value)) { i++; continue; }
    if (wrapped && value.startsWith('-')) continue;
    if (SHELLS.has(basename)) {
      const flags = tokens[i + 1]?.value;
      if (flags && (/^-[a-z]*c[a-z]*$/i.test(flags) || /^\/c$/i.test(flags) || /^-command$/i.test(flags))) {
        const script = tokens[i + 2]?.value;
        if (script && containsGitCommand(script, depth + 1)) return true;
      }
    }
    atStart = false;
  }
  return false;
}
