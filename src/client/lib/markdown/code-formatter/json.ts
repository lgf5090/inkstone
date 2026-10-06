import { indentOf } from './types';

type TokenKind = 'open' | 'close' | 'comma' | 'colon' | 'value' | 'comment'

interface Token {
  kind: TokenKind
  text: string
  ownLine: boolean
  lineComment: boolean
}

const CLOSER: Record<string, string> = { '{': '}', '[': ']' };

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);
const STRUCTURAL = new Set(['{', '}', '[', ']', ',', ':']);

function scanQuoted(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return -1;
    i++;
  }
  return -1;
}

function scanLineComment(source: string, start: number): number {
  for (let i = start + 2; i < source.length; i++) {
    if (source[i] === '\n' || source[i] === '\r') return i;
  }
  return source.length;
}

function scanScalar(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (WHITESPACE.has(ch) || STRUCTURAL.has(ch)) break;
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) break;
    i++;
  }
  return i === start ? -1 : i;
}

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let ownLine = true;

  const push = (kind: TokenKind, text: string, lineComment: boolean): void => {
    tokens.push({ kind, text, ownLine, lineComment });
    ownLine = false;
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n' || ch === '\r') {
      ownLine = true;
      i++;
      continue;
    }
    if (WHITESPACE.has(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = scanLineComment(source, i);
      push('comment', source.slice(i, end), true);
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      push('comment', source.slice(i, end + 2), false);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      const end = scanQuoted(source, i);
      if (end === -1) return null;
      push('value', source.slice(i, end), false);
      i = end;
      continue;
    }
    if (ch === '{' || ch === '[') {
      push('open', ch, false);
      i++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      push('close', ch, false);
      i++;
      continue;
    }
    if (ch === ',') {
      push('comma', ch, false);
      i++;
      continue;
    }
    if (ch === ':') {
      push('colon', ch, false);
      i++;
      continue;
    }
    const end = scanScalar(source, i);
    if (end === -1) return null;
    push('value', source.slice(i, end), false);
    i = end;
  }

  return tokens;
}

function bracketsBalance(tokens: Token[]): boolean {
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'open') stack.push(CLOSER[token.text]!);
    else if (token.kind === 'close' && stack.pop() !== token.text) return false;
  }
  return stack.length === 0;
}

function isEmptyContainer(tokens: Token[], index: number): boolean {
  const open = tokens[index];
  const close = tokens[index + 1];
  const after = tokens[index + 2];
  return Boolean(
    open?.kind === 'open'
    && close?.kind === 'close'
    && close.text === CLOSER[open.text]
    && (after === undefined || after.kind === 'comma' || after.kind === 'close'),
  );
}

function isValueStart(token: Token): boolean {
  return token.kind === 'open' || token.kind === 'value';
}

function isValueEnd(token: Token): boolean {
  return token.kind === 'close' || token.kind === 'value';
}

class JsonPrinter {
  private readonly indent: string
  private readonly stack: string[] = [];
  private readonly lines: string[] = [];
  private line = '';
  private filled = false;

  constructor(tokens: Token[], indent: string) {
    this.indent = indent;
    this.print(tokens);
  }

  private pad(): string {
    return this.indent.repeat(Math.max(0, this.stack.length));
  }

  private endLine(): void {
    if (this.filled) this.lines.push(this.line.trimEnd());
    this.line = this.pad();
    this.filled = false;
  }

  private append(text: string): void {
    if (this.filled && !this.line.endsWith(' ')) this.line += ' ';
    this.line += text;
    this.filled = true;
  }

  private print(tokens: Token[]): void {
    let previous: Token | null = null;

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const followsValue = previous !== null && isValueEnd(previous) && isValueStart(token);
      const freshLine = followsValue || (token.ownLine && this.filled);

      if (token.kind === 'comment') {
        if (freshLine || this.filled) this.endLine();
        this.append(token.text);
        if (token.lineComment) this.endLine();
        previous = token;
        continue;
      }

      if (freshLine && token.kind !== 'close' && token.kind !== 'comma') this.endLine();

      if (token.kind === 'open') {
        if (isEmptyContainer(tokens, index)) {
          this.append(token.text + tokens[index + 1]!.text);
          previous = tokens[index + 1]!;
          index++;
          continue;
        }
        this.stack.push(CLOSER[token.text]!);
        this.append(token.text);
        this.endLine();
        previous = token;
        continue;
      }

      if (token.kind === 'close') {
        this.stack.pop();
        this.endLine();
        this.append(token.text);
        previous = token;
        continue;
      }

      if (token.kind === 'comma') {
        this.line = `${this.line.trimEnd()},`;
        this.endLine();
        previous = token;
        continue;
      }

      if (token.kind === 'colon') {
        this.line = `${this.line.trimEnd()}: `;
        previous = token;
        continue;
      }

      this.append(token.text);
      previous = token;
    }

    this.endLine();
  }

  toString(): string {
    return this.lines.join('\n');
  }
}

/**
 * JSON is reformatted by re-emitting its own tokens, never by `JSON.parse` + `JSON.stringify`. A round-trip
 * through a parsed value rewrites the data it is only supposed to re-indent: `1.0` becomes `1`, `1e10` becomes
 * `10000000000`, and an integer past `Number.MAX_SAFE_INTEGER` comes back with different digits. Stripping
 * `//` comments before parsing is no better, because it also eats the `//` of every `"https://…"` value.
 * Scanning instead of parsing keeps every scalar byte for byte and leaves comments where they were written.
 */
export function formatJson(code: string, tabSize: number): string {
  const source = code.trim();
  if (!source) return code;
  const tokens = tokenize(source);
  if (!tokens || !tokens.some((token) => token.kind === 'open')) return code;
  if (!bracketsBalance(tokens)) return code;
  return new JsonPrinter(tokens, indentOf(tabSize)).toString();
}
