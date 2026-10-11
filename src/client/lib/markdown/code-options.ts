import { clamp, parseFenceInfo, parseLineSpec } from './fence-info';
import { braceTokens, infoFlag, infoOption, infoTokens, isBraceGroup } from './info-string';

export type CodeTheme = 'auto' | 'light' | 'dark';

/** Which of a JSON block's faces the preview opens with. */
export type JsonViewName = 'source' | 'tree' | 'map';

export const JSON_VIEWS: readonly JsonViewName[] = ['source', 'tree', 'map'];

export function jsonViewName(value: string): JsonViewName | null {
  const normalized = value.toLowerCase().replace(/^["']|["']$/g, '').trim();
  return (JSON_VIEWS as readonly string[]).includes(normalized) ? normalized as JsonViewName : null;
}

export interface CodeBlockOptions {
  title: string;
  lineNumbers: boolean;
  startLine: number;
  highlighted: number[];
  wrap: boolean;
  collapse: number | null;
  theme: CodeTheme;
  /** Empty when the block follows the account's default rather than saying for itself. */
  jsonView: JsonViewName | '';
  /** How deep the JSON tree and map arrive folded; null leaves the setting in charge. */
  jsonFold: number | null;
  /** A block the reader has opted out of editing, whatever the surface allows. */
  jsonReadonly: boolean;
}

export const CODE_OPTION_DEFAULTS: CodeBlockOptions = {
  title: '',
  lineNumbers: false,
  startLine: 1,
  highlighted: [],
  wrap: false,
  collapse: null,
  theme: 'auto',
  jsonView: '',
  jsonFold: null,
  jsonReadonly: false,
};

const LINE_NUMBER_FLAGS = new Set(['line-numbers', 'linenumbers', 'linenos', 'numberlines', 'number-lines', 'show-line-numbers', 'showlinenumbers']);
const HIGHLIGHT_KEYS = new Set(['hl_lines', 'highlight']);
const MANAGED_KEYS = new Set(['title', 'start', 'startfrom', 'wrap', 'json-fold', 'json-readonly', ...HIGHLIGHT_KEYS]);
const MANAGED_FLAGS = new Set([...LINE_NUMBER_FLAGS, 'nowrap', 'wrap', 'collapse', 'json-readonly']);
const COLLAPSE_LIMIT = 100000;
/** How deep a JSON tree may be asked to arrive folded. Past the parser's own ceiling it means "all". */
const JSON_FOLD_LIMIT = 64;

function isHighlightSpec(token: string): boolean {
  return isBraceGroup(token) && /^\d[\d,\s-]*$/.test(token.slice(1, -1).trim());
}

function isManagedToken(token: string): boolean {
  if (isHighlightSpec(token)) return true;
  if (isBraceGroup(token)) return braceTokens(token).every(isManagedToken);
  const option = infoOption(token);
  if (option) {
    const key = option.key.toLowerCase();
    return MANAGED_KEYS.has(key) || LINE_NUMBER_FLAGS.has(key) || key === 'collapse' || key === 'theme'
      || key === 'view' || key === 'fold';
  }
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
    const key = option?.key.toLowerCase() ?? '';
    if (flag === 'wrap') options.wrap = true;
    else if (flag === 'nowrap') options.wrap = false;
    else if (key === 'collapse') options.collapse = parseCollapseValue(option!.value);
    else if (key === 'theme') {
      const theme = codeTheme(option!.value);
      if (theme) options.theme = theme;
    }
    else if (key === 'view' || key === 'json-view') {
      const view = jsonViewName(option!.value);
      if (view) options.jsonView = view;
    }
    else if (key === 'fold' || key === 'json-fold') options.jsonFold = parseFoldValue(option!.value);
    else if (key === 'json-readonly') options.jsonReadonly = option!.value.toLowerCase() !== 'false';
    else if (flag === 'json-readonly') options.jsonReadonly = true;
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

export function parseFoldValue(value: string): number | null {
  return /^\d{1,3}$/.test(value.trim()) ? clamp(Number(value.trim()), 0, JSON_FOLD_LIMIT) : null;
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
  if (next.jsonView) kept.push(`view=${next.jsonView}`);
  if (next.jsonFold !== null) kept.push(`fold=${next.jsonFold}`);
  if (next.jsonReadonly) kept.push('json-readonly');
  return kept.join(' ');
}

export function readHighlightInput(value: string): number[] {
  return parseLineSpec(value);
}
