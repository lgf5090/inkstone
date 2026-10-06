import { clamp, parseFenceInfo, parseLineSpec } from './fence-info';
import { braceTokens, infoFlag, infoOption, infoTokens, isBraceGroup } from './info-string';

export type CodeTheme = 'auto' | 'light' | 'dark';

export interface CodeBlockOptions {
  title: string;
  lineNumbers: boolean;
  startLine: number;
  highlighted: number[];
  wrap: boolean;
  collapse: number | null;
  theme: CodeTheme;
}

export const CODE_OPTION_DEFAULTS: CodeBlockOptions = {
  title: '',
  lineNumbers: false,
  startLine: 1,
  highlighted: [],
  wrap: false,
  collapse: null,
  theme: 'auto',
};

const LINE_NUMBER_FLAGS = new Set(['line-numbers', 'linenumbers', 'linenos', 'numberlines', 'number-lines', 'show-line-numbers', 'showlinenumbers']);
const HIGHLIGHT_KEYS = new Set(['hl_lines', 'highlight']);
const MANAGED_KEYS = new Set(['title', 'start', 'startfrom', 'wrap', ...HIGHLIGHT_KEYS]);
const MANAGED_FLAGS = new Set([...LINE_NUMBER_FLAGS, 'nowrap', 'wrap', 'collapse']);
const COLLAPSE_LIMIT = 100000;

function isHighlightSpec(token: string): boolean {
  return isBraceGroup(token) && /^\d[\d,\s-]*$/.test(token.slice(1, -1).trim());
}

function isManagedToken(token: string): boolean {
  if (isHighlightSpec(token)) return true;
  if (isBraceGroup(token)) return braceTokens(token).every(isManagedToken);
  const option = infoOption(token);
  if (option) return MANAGED_KEYS.has(option.key) || LINE_NUMBER_FLAGS.has(option.key) || option.key === 'collapse' || option.key === 'theme';
  return MANAGED_FLAGS.has(infoFlag(token));
}

export function readCodeOptions(info: string): CodeBlockOptions {
  const base = parseFenceInfo(info);
  const options: CodeBlockOptions = {
    ...CODE_OPTION_DEFAULTS,
    title: base.title,
    lineNumbers: base.lineNumbers,
    startLine: base.startLine,
    highlighted: [...base.highlightedLines],
  };
  for (const token of infoTokens(info)) {
    const option = infoOption(token);
    const flag = infoFlag(token);
    if (flag === 'wrap') options.wrap = true;
    else if (flag === 'nowrap') options.wrap = false;
    else if (option?.key === 'collapse') options.collapse = parseCollapseValue(option.value);
    else if (option?.key === 'theme') {
      const theme = codeTheme(option.value);
      if (theme) options.theme = theme;
    }
  }
  return options;
}

export function codeTheme(value: string): CodeTheme | null {
  const normalized = value.toLowerCase().replace(/^["']|["']$/g, '').trim();
  return normalized === 'light' || normalized === 'dark' || normalized === 'auto' ? normalized : null;
}

export function parseCollapseValue(value: string): number | null {
  return /^\d{1,6}$/.test(value.trim()) ? clamp(Number(value.trim()), 0, COLLAPSE_LIMIT) : null;
}

function isNumbered(info: string): boolean {
  if (readCodeOptions(info).lineNumbers) return true;
  const leading = infoTokens(info)[0];
  return Boolean(leading) && isBraceGroup(leading!) && braceTokens(leading!).some((token) => LINE_NUMBER_FLAGS.has(infoFlag(token)));
}

export function writeCodeOptions(info: string, next: CodeBlockOptions): string {
  const tokens = infoTokens(info);
  const kept = tokens.filter((token, index) => index === 0 || !isManagedToken(token));
  if (next.lineNumbers) kept.push('line-numbers');
  else if (isNumbered(info)) kept.push('line-numbers=false');
  if (next.title.trim()) kept.push(`title="${next.title.trim().replace(/"/g, "'")}"`);
  if (next.startLine > 1) kept.push(`start=${next.startLine}`);
  if (next.highlighted.length) kept.push(`{${next.highlighted.join(',')}}`);
  if (next.wrap) kept.push('wrap');
  if (next.collapse !== null) kept.push(`collapse=${next.collapse}`);
  if (next.theme !== 'auto') kept.push(`theme=${next.theme}`);
  return kept.join(' ');
}

export function readHighlightInput(value: string): number[] {
  return parseLineSpec(value);
}
