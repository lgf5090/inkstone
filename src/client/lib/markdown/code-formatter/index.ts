import { resolveCategory, clampIndent, type FormatterCategory } from './types';
import { formatCStyle } from './c-style';
import { formatMarkup } from './markup';
import { formatStyles } from './styles';
import { formatSql, type SqlKeywordCase } from './sql';
import { formatJson } from './json';
import { formatYaml, formatToml } from './data';
import { formatPython } from './python';
import { formatShell, formatLua, formatRuby, formatDockerfile, formatNginx } from './scripts';
import { formatMermaid, formatDiff, formatMarkdown, formatGeneric } from './diagrams';
import { formatTable } from './table';

/**
 * The ceiling on the body one press may rewrite. Every formatter here is linear per line, but they are all
 * driven from a click on a block a reader did not write: a shared note hands one author's text to another
 * person's main thread, and a fence can be pasted as well as typed. The number sits far above any block a
 * person reads in a note, so it refuses a blob rather than a big example.
 */
export const CODE_FORMAT_LIMIT_BYTES = 512 * 1024;

export type FormatFailure = 'empty' | 'too-large' | 'unchanged' | 'failed';

export interface FormatResult {
  ok: boolean
  text: string
  reason?: FormatFailure
}

export interface FormatOptions {
  tabSize: number
  sqlKeywordCase?: SqlKeywordCase
}

interface Context {
  tab: number
  sqlKeywordCase: SqlKeywordCase
}

function looksLikeTable(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim().length > 0);
  return lines.length >= 2 && lines[0]!.includes('|') && lines[1]!.includes('|');
}

function formatChart(code: string, ctx: Context): string {
  const trimmed = code.trim();
  if (looksLikeTable(trimmed)) return formatTable(trimmed);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return formatJson(trimmed, ctx.tab);
  return formatCStyle(trimmed, ctx.tab);
}

function formatOutlineOrJson(code: string, ctx: Context): string {
  const trimmed = code.trim();
  return trimmed.startsWith('{') ? formatJson(trimmed, ctx.tab) : formatMarkdown(trimmed);
}

const FORMATTERS: Record<FormatterCategory, (code: string, ctx: Context) => string> = {
  'c-style': (code, ctx) => formatCStyle(code, ctx.tab),
  html: (code, ctx) => formatMarkup(code, ctx.tab, true),
  xml: (code, ctx) => formatMarkup(code, ctx.tab, false),
  css: (code, ctx) => formatStyles(code, ctx.tab),
  sql: (code, ctx) => formatSql(code, ctx.sqlKeywordCase),
  json: (code, ctx) => formatJson(code, ctx.tab),
  yaml: (code, ctx) => formatYaml(code, ctx.tab),
  toml: (code) => formatToml(code),
  python: (code, ctx) => formatPython(code, ctx.tab),
  shell: (code, ctx) => formatShell(code, ctx.tab),
  lua: (code, ctx) => formatLua(code, ctx.tab),
  ruby: (code, ctx) => formatRuby(code, ctx.tab),
  dockerfile: (code) => formatDockerfile(code),
  nginx: (code, ctx) => formatNginx(code, ctx.tab),
  mermaid: (code, ctx) => formatMermaid(code, ctx.tab),
  diff: (code) => formatDiff(code),
  markdown: (code) => formatMarkdown(code),
  table: (code) => formatTable(code),
  slides: (code) => formatMarkdown(code),
  chart: formatChart,
  mindmap: formatOutlineOrJson,
  kanban: formatOutlineOrJson,
  excalidraw: (code, ctx) => formatJson(code, ctx.tab),
  generic: (code) => formatGeneric(code),
};

export function formatCodeResult(code: string, language: string, options: FormatOptions): FormatResult {
  if (!code.trim()) return { ok: false, text: code, reason: 'empty' };
  if (code.length > CODE_FORMAT_LIMIT_BYTES) return { ok: false, text: code, reason: 'too-large' };

  const ctx: Context = {
    tab: clampIndent(options.tabSize),
    sqlKeywordCase: options.sqlKeywordCase ?? 'upper',
  };

  const formatter = FORMATTERS[resolveCategory(language)];
  let formatted: string;
  try {
    formatted = formatter(code, ctx).replace(/\s+$/, '');
  }
  catch {
    return { ok: false, text: code, reason: 'failed' };
  }

  if (!formatted.trim() || formatted === code) return { ok: false, text: code, reason: 'unchanged' };
  if (formatted.length > CODE_FORMAT_LIMIT_BYTES) return { ok: false, text: code, reason: 'too-large' };
  return { ok: true, text: formatted };
}

export function formatCode(code: string, language: string, tabSize = 2, sqlKeywordCase: SqlKeywordCase = 'upper'): string {
  return formatCodeResult(code, language, { tabSize, sqlKeywordCase }).text;
}
