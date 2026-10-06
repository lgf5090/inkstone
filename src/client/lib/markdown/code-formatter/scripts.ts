import { indentOf, padAt } from './types';

const DOCKER_INSTRUCTIONS = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'ONBUILD',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
]);

const QUOTED = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g;

function maskQuoted(line: string): string {
  return line.replace(QUOTED, ' ');
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function collapseBlanks(result: string[]): void {
  if (result.length > 0 && result[result.length - 1] !== '') result.push('');
}

export function formatDockerfile(code: string): string {
  const result: string[] = [];
  let continued = false;

  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();

    if (continued) {
      result.push(trimmed);
      continued = trimmed.endsWith('\\');
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(trimmed);
      continue;
    }

    const match = /^([a-zA-Z]+)(\s+.*)?$/.exec(trimmed);
    if (match && DOCKER_INSTRUCTIONS.has(match[1]!.toUpperCase())) {
      result.push(match[1]!.toUpperCase() + (match[2] ? ` ${match[2].trim()}` : ''));
      continued = trimmed.endsWith('\\');
      continue;
    }
    result.push(trimmed);
    continued = trimmed.endsWith('\\');
  }

  return result.join('\n');
}

function shellHeredoc(line: string): string | null {
  const match = /<<-?\s*(['"`]?)(\w+)\1/.exec(line);
  return match ? match[2]! : null;
}

export function formatShell(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const result: string[] = [];
  let depth = 0;
  let heredoc: string | null = null;

  for (const raw of code.split(/\r?\n/)) {
    if (heredoc) {
      result.push(raw);
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      collapseBlanks(result);
      continue;
    }

    const masked = maskQuoted(trimmed);
    const clean = masked.replace(/#[^\r\n]*/g, '').trim();
    const isDedent = /^(elif\b|else\b|fi\b|done\b|esac\b|\}|;;)/.test(clean);
    const currentIndent = isDedent ? Math.max(0, depth - 1) : depth;

    result.push(`${padAt(indent, currentIndent)}${trimmed}`);

    const opens = /(?:^|[;&)]\s*)(then|do)$/.test(clean) || /\{\s*$/.test(clean) || /\bcase\b.*\bin\s*$/.test(clean);
    const closes = /^(fi\b|done\b|esac\b|\}|;;)/.test(clean);
    if (opens && !closes) depth++;
    else if (!opens && closes) depth = Math.max(0, depth - 1);

    heredoc = shellHeredoc(trimmed);
  }

  return result.join('\n');
}

function luaDelta(clean: string): { opens: number, closes: number } {
  const startsElseBranch = /^(else\b|elseif\b)/.test(clean);
  const opens = countMatches(clean, /\b(function|repeat|do)\b/g)
    + countMatches(clean, /\bthen\b/g)
    + countMatches(clean, /[{[]/g);
  const closes = countMatches(clean, /\b(end|until)\b/g) + countMatches(clean, /[}\]]/g);
  return { opens: startsElseBranch ? Math.max(0, opens - 1) : opens, closes };
}

export function formatLua(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const result: string[] = [];
  let depth = 0;

  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      collapseBlanks(result);
      continue;
    }

    const masked = maskQuoted(trimmed);
    const clean = masked.replace(/--(?!\[)[^\r\n]*/g, '').trim();
    if (!clean) {
      result.push(`${padAt(indent, depth)}${trimmed}`);
      continue;
    }

    const isDedent = /^(end\b|until\b|else\b|elseif\b|[}\]])/.test(clean);
    result.push(`${padAt(indent, isDedent ? Math.max(0, depth - 1) : depth)}${trimmed}`);

    const { opens, closes } = luaDelta(clean);
    depth = Math.max(0, depth + opens - closes);
  }

  return result.join('\n');
}

function rubyDelta(clean: string): { opens: number, closes: number } {
  const startsElseBranch = /^(else\b|elsif\b|when\b|rescue\b|ensure\b)/.test(clean);
  const oneLiner = /\bend\b/.test(clean) && !/^end\b/.test(clean);
  const opens = oneLiner
    ? 0
    : (/^(def\b|class\b|module\b|if\b|unless\b|while\b|until\b|for\b|begin\b|case\b)/.test(clean) ? 1 : 0)
      + (/\bdo\s*(\|[^|]*\|)?\s*$/.test(clean) || /\{\s*$/.test(clean) ? 1 : 0);
  const closes = oneLiner ? 0 : (/^end\b/.test(clean) || /^[}\]]/.test(clean) ? 1 : 0);
  return { opens: startsElseBranch ? Math.max(0, opens - 1) : opens, closes };
}

export function formatRuby(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const result: string[] = [];
  let depth = 0;

  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      collapseBlanks(result);
      continue;
    }

    const masked = maskQuoted(trimmed);
    const clean = masked.replace(/#[^\r\n]*/g, '').trim();
    if (!clean) {
      result.push(`${padAt(indent, depth)}${trimmed}`);
      continue;
    }

    const isDedent = /^(end\b|else\b|elsif\b|when\b|rescue\b|ensure\b|[}\]])/.test(clean);
    result.push(`${padAt(indent, isDedent ? Math.max(0, depth - 1) : depth)}${trimmed}`);

    const { opens, closes } = rubyDelta(clean);
    depth = Math.max(0, depth + opens - closes);
  }

  return result.join('\n');
}

export function formatNginx(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const result: string[] = [];
  let depth = 0;

  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      collapseBlanks(result);
      continue;
    }

    const masked = maskQuoted(trimmed);
    const startsWithClose = masked.startsWith('}');
    result.push(`${padAt(indent, startsWithClose ? Math.max(0, depth - 1) : depth)}${trimmed}`);

    depth = Math.max(0, depth + countMatches(masked, /{/g) - countMatches(masked, /}/g));
  }

  return result.join('\n');
}
