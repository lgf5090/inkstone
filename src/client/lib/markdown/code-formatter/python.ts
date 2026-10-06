import { indentOf } from './types';

interface PyToken {
  type: 'code' | 'string' | 'comment'
  text: string
}

interface PyState {
  marker: string | null
}

function findClosing(line: string, from: number, marker: string): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line.startsWith(marker, i)) return i + marker.length;
    i++;
  }
  return -1;
}

function tokenizeLine(line: string, state: PyState): { tokens: PyToken[], insideAtStart: boolean, stillInside: boolean } {
  const insideAtStart = state.marker !== null;
  const tokens: PyToken[] = [];
  let i = 0;
  let code = '';

  const flushCode = (): void => {
    if (code) {
      tokens.push({ type: 'code', text: code });
      code = '';
    }
  };

  if (state.marker) {
    const end = findClosing(line, 0, state.marker);
    if (end === -1) return { tokens: [{ type: 'string', text: line }], insideAtStart, stillInside: true };
    tokens.push({ type: 'string', text: line.slice(0, end) });
    state.marker = null;
    i = end;
  }

  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '#') {
      flushCode();
      tokens.push({ type: 'comment', text: line.slice(i) });
      i = line.length;
      break;
    }
    if (ch === '"' || ch === '\'') {
      const marker = line.startsWith('"""', i) ? '"""' : line.startsWith('\'\'\'', i) ? '\'\'\'' : ch;
      const end = findClosing(line, i + marker.length, marker);
      flushCode();
      if (end === -1) {
        tokens.push({ type: 'string', text: line.slice(i) });
        if (marker.length === 3) state.marker = marker;
        i = line.length;
        break;
      }
      tokens.push({ type: 'string', text: line.slice(i, end) });
      i = end;
      continue;
    }
    code += ch;
    i++;
  }

  flushCode();
  return { tokens, insideAtStart, stillInside: state.marker !== null };
}

function spaceCode(code: string): string {
  let s = code;
  s = s.replace(/([a-zA-Z0-9_$\])])\s*(==|!=|<=|>=|\+=|-=|\*=|\/\/=|\*\*=|%=|\/\/|\*\*|->)\s*([a-zA-Z0-9_$'"([{])/g, '$1 $2 $3');
  s = s.replace(/([a-zA-Z0-9_$\])])\s*([<>])\s*([a-zA-Z0-9_$'"([{])/g, '$1 $2 $3');
  s = s.replace(/([a-zA-Z0-9_$\])])\s*=\s*([a-zA-Z0-9_$'"([{])/g, (match, p1, p2, offset) => {
    const before = s.slice(Math.max(0, offset - 1), offset);
    const after = s.slice(offset + match.length, offset + match.length + 1);
    if (/[<>=!+\-*/%]/.test(before) || after === '=') return match;
    return `${p1} = ${p2}`;
  });
  s = s.replace(/,\s*/g, ', ');
  s = s.replace(/([a-zA-Z0-9_$'"])\s*:\s*([a-zA-Z0-9_$'"([{])/g, '$1: $2');
  s = s.replace(/\s+/g, ' ');
  return s;
}

function formatLineContent(line: string): string {
  const tokens = tokenizeLine(line, { marker: null }).tokens;
  const parts: string[] = [];
  for (const token of tokens) parts.push(token.type === 'code' ? spaceCode(token.text) : token.text);
  return parts.join('').trim();
}

function collapseBlanks(result: string[]): void {
  if (result.length > 0 && result[result.length - 1] !== '') result.push('');
}

function formatWithExistingIndent(rawLines: string[], base: number, indent: string): string {
  const state: PyState = { marker: null };
  const result: string[] = [];

  for (const rawLine of rawLines) {
    const { insideAtStart } = tokenizeLine(rawLine, state);
    if (!rawLine.trim()) {
      collapseBlanks(result);
      continue;
    }
    if (insideAtStart) {
      result.push(rawLine);
      continue;
    }
    const origin = rawLine.search(/\S/);
    const level = origin > 0 ? Math.max(1, Math.round(origin / base)) : 0;
    result.push(`${indent.repeat(level)}${formatLineContent(rawLine.trim())}`);
  }

  return result.join('\n');
}

function formatFlat(rawLines: string[], indent: string): string {
  const state: PyState = { marker: null };
  const result: string[] = [];
  const blockStack: number[] = [];
  let depth = 0;

  for (const rawLine of rawLines) {
    const { insideAtStart } = tokenizeLine(rawLine, state);
    const trimmed = rawLine.trim();
    if (!trimmed) {
      collapseBlanks(result);
      continue;
    }
    if (insideAtStart) {
      result.push(rawLine);
      continue;
    }

    const isElse = /^(elif\b|else:|except\b|finally:)/.test(trimmed);
    const lineIndent = isElse && blockStack.length > 0 ? blockStack[blockStack.length - 1]! : depth;
    result.push(`${indent.repeat(lineIndent)}${formatLineContent(trimmed)}`);

    const clean = formatLineContent(trimmed);
    if (clean.endsWith(':')) {
      blockStack.push(lineIndent);
      depth = lineIndent + 1;
      continue;
    }
    if (/^(return\b|pass\b|break\b|raise\b|continue\b)/.test(clean) && blockStack.length > 0) {
      depth = blockStack[blockStack.length - 1]!;
    }
  }

  return result.join('\n');
}

function detectBase(rawLines: string[]): number {
  let min = 0;
  for (const line of rawLines) {
    const indent = line.search(/\S/);
    if (indent > 0 && (min === 0 || indent < min)) min = indent;
  }
  return min > 0 ? min : 4;
}

export function formatPython(code: string, tabSize: number): string {
  const rawLines = code.split(/\r?\n/);
  const indent = indentOf(tabSize);
  const hasIndent = rawLines.some((line) => line.search(/\S/) > 0);
  return hasIndent ? formatWithExistingIndent(rawLines, detectBase(rawLines), indent) : formatFlat(rawLines, indent);
}
