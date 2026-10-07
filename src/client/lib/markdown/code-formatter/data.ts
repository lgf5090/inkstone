import { parseDocument } from 'yaml';
import { clampIndent } from './types';

export function formatYaml(code: string, tabSize: number): string {
  const trimmed = code.trim();
  if (!trimmed) return code;
  try {
    const doc = parseDocument(trimmed, { logLevel: 'silent', prettyErrors: false });
    if (doc.errors.length > 0 || doc.contents === null) return code;
    const out = doc.toString({ indent: clampIndent(tabSize) }).trim();
    return out.length > 0 ? out : code;
  }
  catch {
    return code;
  }
}

function firstTopLevelEquals(line: string): number {
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      inString = ch;
      continue;
    }
    if (ch === '=') return i;
  }

  return -1;
}

export function formatToml(code: string): string {
  const result: string[] = [];
  let multiline: { depth: number, lines: string[] } | null = null;

  const pushBlank = (): void => {
    if (result.length > 0 && result[result.length - 1] !== '') result.push('');
  };

  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();

    if (multiline) {
      multiline.lines.push(trimmed);
      multiline.depth += (raw.match(/[[{]/g) ?? []).length - (raw.match(/[\]}]/g) ?? []).length;
      if (multiline.depth <= 0) {
        result.push(...multiline.lines);
        multiline = null;
      }
      continue;
    }

    if (!trimmed) {
      pushBlank();
      continue;
    }
    if (trimmed.startsWith('#')) {
      result.push(trimmed);
      continue;
    }
    if (trimmed.startsWith('[')) {
      pushBlank();
      result.push(trimmed);
      continue;
    }

    const eq = firstTopLevelEquals(trimmed);
    if (eq === -1) {
      result.push(trimmed);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    const opens = (value.match(/[[{]/g) ?? []).length - (value.match(/[\]}]/g) ?? []).length;
    if (opens > 0) {
      multiline = { depth: opens, lines: [`${key} = ${value}`] };
      continue;
    }
    result.push(`${key} = ${value}`);
  }

  if (multiline) result.push(...multiline.lines);
  return result.join('\n');
}
