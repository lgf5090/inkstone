import { indentOf } from './types';

interface LineToken {
  type: 'code' | 'string' | 'comment' | 'regex'
  text: string
}

interface ScanState {
  inBlockComment: boolean
  inTemplateLiteral: boolean
}

const REGEX_BEFORE: Set<string> = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await', 'case', 'do', 'else']);
const REGEX_STARTERS: Set<string> = new Set(['(', '=', ',', ':', '[', '!', '&', '|', '{', '}', ';', '?', '+', '-', '*', '%', '^', '~']);

function trailingWord(line: string, before: number): string {
  let i = before;
  while (i > 0 && /[\w$]/.test(line[i - 1]!)) i--;
  return line.slice(i, before);
}

/**
 * A slash opens a comment or a regex depending on what came before it, and the two
 * failures are asymmetric: reading a regex that opens with an escaped star as a block
 * comment puts the formatter inside a comment that never closes, so every line below it
 * is copied verbatim and the block silently stops being formatted. Division is therefore
 * the default, and a regex is only recognised where a value can start.
 */
function regexMayStart(line: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = line[i]!;
    if (ch === ' ' || ch === '\t') continue;
    if (/[\w$]/.test(ch)) return REGEX_BEFORE.has(trailingWord(line, i + 1));
    return REGEX_STARTERS.has(ch);
  }
  return true;
}

function scanRegexToken(line: string, start: number): { token: LineToken, nextIndex: number } | null {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let end = i + 1;
      while (end < line.length && /[a-z]/i.test(line[end]!)) end++;
      return { token: { type: 'regex', text: line.slice(start, end) }, nextIndex: end };
    }
    i++;
  }
  return null;
}

function scanStringToken(line: string, start: number, quote: string): { token: LineToken, nextIndex: number, closed: boolean } {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line[i] === quote) {
      return { token: { type: 'string', text: line.slice(start, i + 1) }, nextIndex: i + 1, closed: true };
    }
    i++;
  }
  return { token: { type: 'string', text: line.slice(start) }, nextIndex: line.length, closed: false };
}

function scanCommentToken(line: string, start: number): { token: LineToken, nextIndex: number, closed: boolean } {
  if (line[start + 1] === '/') {
    return { token: { type: 'comment', text: line.slice(start) }, nextIndex: line.length, closed: true };
  }
  const end = line.indexOf('*/', start + 2);
  if (end !== -1) {
    return { token: { type: 'comment', text: line.slice(start, end + 2) }, nextIndex: end + 2, closed: true };
  }
  return { token: { type: 'comment', text: line.slice(start) }, nextIndex: line.length, closed: false };
}

function resumeMultiLineState(line: string, state: ScanState): { tokens: LineToken[], startIndex: number, stillActive: boolean } {
  if (state.inBlockComment) {
    const end = line.indexOf('*/');
    if (end === -1) return { tokens: [{ type: 'comment', text: line }], startIndex: line.length, stillActive: true };
    state.inBlockComment = false;
    return { tokens: [{ type: 'comment', text: line.slice(0, end + 2) }], startIndex: end + 2, stillActive: false };
  }

  if (state.inTemplateLiteral) {
    const scan = scanStringToken(line, -1, '`');
    if (!scan.closed) return { tokens: [{ type: 'string', text: line }], startIndex: line.length, stillActive: true };
    state.inTemplateLiteral = false;
    return { tokens: [{ type: 'string', text: line.slice(0, scan.nextIndex) }], startIndex: scan.nextIndex, stillActive: false };
  }

  return { tokens: [], startIndex: 0, stillActive: false };
}

function scanSpecialToken(line: string, index: number): { token: LineToken, nextIndex: number, blockComment: boolean, template: boolean } | null {
  const ch = line[index]!;
  const next = line[index + 1];
  if (ch === '/' && (next === '/' || next === '*')) {
    const scan = scanCommentToken(line, index);
    return { token: scan.token, nextIndex: scan.nextIndex, blockComment: !scan.closed, template: false };
  }
  if (ch === '/' && next !== '/' && next !== '*' && regexMayStart(line, index)) {
    const scan = scanRegexToken(line, index);
    if (scan) return { token: scan.token, nextIndex: scan.nextIndex, blockComment: false, template: false };
  }
  if (ch === '\'' || ch === '"' || ch === '`') {
    const scan = scanStringToken(line, index, ch);
    return { token: scan.token, nextIndex: scan.nextIndex, blockComment: false, template: !scan.closed && ch === '`' };
  }
  return null;
}

function tokenizeLine(line: string, state: ScanState): { tokens: LineToken[], insideAtStart: boolean, stillActive: boolean } {
  const insideAtStart = state.inBlockComment || state.inTemplateLiteral;
  const resumed = resumeMultiLineState(line, state);
  if (resumed.stillActive) return { tokens: resumed.tokens, insideAtStart, stillActive: true };

  const tokens = [...resumed.tokens];
  let i = resumed.startIndex;
  let codeBuffer = '';

  const flushCode = (): void => {
    if (codeBuffer) {
      tokens.push({ type: 'code', text: codeBuffer });
      codeBuffer = '';
    }
  };

  while (i < line.length) {
    const special = scanSpecialToken(line, i);
    if (special) {
      flushCode();
      tokens.push(special.token);
      if (special.blockComment) state.inBlockComment = true;
      if (special.template) state.inTemplateLiteral = true;
      i = special.nextIndex;
      continue;
    }
    codeBuffer += line[i]!;
    i++;
  }

  flushCode();
  return { tokens, insideAtStart, stillActive: state.inBlockComment || state.inTemplateLiteral };
}

function scanStates(rawLines: string[]): boolean[] {
  const state: ScanState = { inBlockComment: false, inTemplateLiteral: false };
  return rawLines.map((line) => {
    const { insideAtStart } = tokenizeLine(line, state);
    return insideAtStart;
  });
}

function spaceOperatorsInCode(code: string): string {
  let s = code;
  s = s.replace(/([a-zA-Z0-9_$\])])\s*(===|!==|==|!=|<=|>=|=>|\+=|-=|\*=|\/=|%=|&&|\|\|)\s*([a-zA-Z0-9_$'"`([{])/g, '$1 $2 $3');
  s = s.replace(/([a-zA-Z0-9_$\])])\s*=\s*([a-zA-Z0-9_$'"`([{])/g, (match, p1, p2, offset) => {
    const before = s.slice(Math.max(0, offset - 1), offset);
    const after = s.slice(offset + match.length, offset + match.length + 1);
    if (/[<>=!+\-*/%]/.test(before) || after === '=') return match;
    return `${p1} = ${p2}`;
  });
  s = s.replace(/,\s*/g, ', ');
  s = s.replace(/;\s*([^\s;])/g, '; $1');
  s = s.replace(/([a-zA-Z0-9_$])\s*:\s*([a-zA-Z0-9_$'"`([{])/g, (match, p1, p2, offset) => {
    const prevChar = s[offset - 1];
    const nextChar = s[offset + match.length];
    if (prevChar === ':' || nextChar === ':') return match;
    const linePrefix = s.slice(0, offset);
    if (linePrefix.includes('?')) return `${p1} : ${p2}`;
    return `${p1}: ${p2}`;
  });
  s = s.replace(/\s+/g, ' ');
  return s;
}

function canSplitAtBoundary(line: string, index: number, current: string): boolean {
  const rest = line.slice(index).trimStart();
  const boundary = /^(return\b|throw\b|[a-zA-Z_$][a-zA-Z0-9_$]*\s*(?:\+=|-=|\*=|\/=|=)\s*)/.exec(rest);
  if (!boundary || !current.trim()) return false;

  const curTrim = current.trim();
  const last = curTrim.slice(-1);
  const isEnded = /^[0-9'"`\])]/.test(last) || curTrim.endsWith('true') || curTrim.endsWith('false');
  return isEnded && !/^(if|while|for|switch)\b/.test(curTrim);
}

function isDeclarationLine(trimmed: string): boolean {
  if (!/^(const|let|var|export|import)\b/.test(trimmed)) return false;
  if (trimmed.includes(';')) return false;
  return !/^(const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=.*?(?:\s+(?:return|throw)\s+.*)$/.test(trimmed);
}

function scanCharInStatementSplit(ch: string, nextCh: string | undefined, inStr: string | null): { inStr: string | null, append: string, advance: number } {
  if (inStr) {
    if (ch === '\\') return { inStr, append: ch + (nextCh ?? ''), advance: 1 };
    return { inStr: ch === inStr ? null : inStr, append: ch, advance: 0 };
  }
  if (ch === '\'' || ch === '"' || ch === '`') return { inStr: ch, append: ch, advance: 0 };
  return { inStr: null, append: ch, advance: 0 };
}

function splitCorruptedStatements(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || /^(if|while|for|switch|catch)\b/.test(trimmed) || isDeclarationLine(trimmed)) return [trimmed];

  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inStr: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const scanned = scanCharInStatementSplit(ch, line[i + 1], inStr);
    inStr = scanned.inStr;
    current += scanned.append;
    i += scanned.advance;
    if (inStr || scanned.advance > 0) continue;

    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);

    if (ch === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    if (depth === 0 && /\s/.test(ch) && canSplitAtBoundary(line, i, current)) {
      parts.push(current.trim());
      current = '';
      i += line.slice(i).length - line.slice(i).trimStart().length - 1;
    }
  }

  if (current.trim()) parts.push(current);
  return parts.length > 0 ? parts : [line];
}

function countBrackets(text: string): { open: number, close: number } {
  let open = 0;
  let close = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '[' || ch === '(') open++;
    else if (ch === '}' || ch === ']' || ch === ')') close++;
  }
  return { open, close };
}

function structuralBrackets(tokens: LineToken[]): { open: number, close: number } {
  let open = 0;
  let close = 0;
  for (const token of tokens) {
    if (token.type !== 'code') continue;
    const counts = countBrackets(token.text);
    open += counts.open;
    close += counts.close;
  }
  return { open, close };
}

function formatSingleLine(tokens: LineToken[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    parts.push(token.type === 'code' ? spaceOperatorsInCode(token.text) : token.text);
  }
  return parts.join('').trim();
}

export function formatCStyle(code: string, tabSize: number): string {
  const indent = indentOf(tabSize);
  const rawLines = code.split(/\r?\n/);
  const inside = scanStates(rawLines);

  const linesToFormat: string[] = [];
  rawLines.forEach((raw, index) => {
    if (inside[index]) {
      linesToFormat.push(raw);
      return;
    }
    for (const part of splitCorruptedStatements(raw)) linesToFormat.push(part);
  });

  const result: string[] = [];
  let depth = 0;
  const state: ScanState = { inBlockComment: false, inTemplateLiteral: false };

  for (const line of linesToFormat) {
    const carried = state.inBlockComment || state.inTemplateLiteral;
    const { tokens, stillActive } = tokenizeLine(line, state);

    if (carried && stillActive) {
      result.push(line);
      continue;
    }

    const formatted = formatSingleLine(tokens);
    if (!formatted) {
      if (result.length > 0 && result[result.length - 1] !== '') result.push('');
      continue;
    }

    const counts = structuralBrackets(tokens);
    const startsClose = /^[}\])]|^(else\b|catch\b|finally\b)/.test(formatted);
    const lineIndent = startsClose ? Math.max(0, depth - 1) : depth;

    result.push(`${indent.repeat(lineIndent)}${formatted}`);
    depth = Math.max(0, depth + counts.open - counts.close);
  }

  return result.join('\n');
}
