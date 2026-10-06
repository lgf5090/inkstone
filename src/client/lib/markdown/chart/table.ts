/**
 * The table body a ```chart fence can carry instead of a JSON config: a markdown table whose first
 * header cell names the chart and optionally configures it (`| :bar:{"title": "Tally"} | … |`), which
 * is the shape Cherry's table-chart syntax uses.
 *
 * Only the *text* ↔ *model* half lives here. What a model means for a drawing engine is decided by
 * that engine (./config), so the syntax stays readable without importing one.
 */
import { assertChartBodySize } from './limit';
import type { MessageKey } from '../../i18n';

/**
 * The keyword cell, taken from Cherry verbatim: `:kind:` with an optional `{…}` configuration beside
 * it. `\w+` is ASCII-only on purpose — a kind is an engine's own name, not a label.
 */
export const CHART_KEYWORD_RE = /^:(\w+):(?:[ ]*{(.*?)}[ ]*)?$/;

/** A cell written `{"title": "x"}` reaches JSON.parse as `"title": "x"`, so it goes back wrapped. */
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * A hand-written configuration is data, and `__proto__` is a way of reaching the object every other
 * object shares. Every parser that reads one runs its keys through this.
 */
export function safeReviver(key: string, value: unknown): unknown {
    return UNSAFE_KEYS.includes(key) ? undefined : value;
}

export interface ChartKeyword {
    kind: string
    options: Record<string, unknown>
}

/** The table as written: the keyword's own cell is consumed, so `header[0]` is `''`. */
export interface ChartTable {
    kind: string
    options: Record<string, unknown>
    header: string[]
    rows: string[][]
}

/** Why a body is not a usable chart table. Every caller turns this into the block's error state. */
export type ChartTableReason = 'no-header' | 'no-keyword' | 'no-delimiter' | 'bad-json';

/**
 * The reason in the words the author can act on. The key lives beside the failure rather than in the
 * message because the block's banner is what a reader of a Chinese note sees, and a parser that threw
 * English into it would put one untranslated sentence on every broken table.
 */
export const CHART_TABLE_MESSAGES: Record<ChartTableReason, MessageKey> = {
    'no-header': 'markdown.chart_table_no_header',
    'no-keyword': 'markdown.chart_table_no_keyword',
    'no-delimiter': 'markdown.chart_table_no_delimiter',
    'bad-json': 'markdown.chart_table_bad_options',
};

export class ChartTableError extends Error {
    constructor(readonly reason: ChartTableReason) {
        super(reason);
    }
}

interface SplitCellState {
    current: string
    isEscaped: boolean
}

function splitCellChar(state: SplitCellState, cells: string[], char: string): void {
    if (state.isEscaped) {
        state.current += char;
        state.isEscaped = false;
        return;
    }
    if (char === '\\') {
        state.current += char;
        state.isEscaped = true;
        return;
    }
    if (char === '|') {
        cells.push(state.current.trim());
        state.current = '';
        return;
    }
    state.current += char;
}

/** The cells of a markdown table row, with `\|` held together and outer pipes dropped. */
function splitTableRow(line: string): string[] {
    const cells: string[] = [];
    const state: SplitCellState = { current: '', isEscaped: false };
    const trimmed = line.trim();
    let str = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    if (str.endsWith('|') && !str.endsWith('\\|'))
        str = str.slice(0, -1);
    for (const char of str)
        splitCellChar(state, cells, char);
    cells.push(state.current.trim());
    return cells;
}

function isDelimiterRow(line: string): boolean {
    const cells = splitTableRow(line);
    if (cells.length === 0)
        return false;
    return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function unescapeCell(cell: string): string {
    return cell.replace(/\\([\\|])/g, '$1');
}

function escapeCell(cell: string): string {
    return cell.replace(/\|/g, '\\|').trim();
}

function firstLine(body: string): string {
    for (const line of body.split('\n')) {
        if (line.trim().length > 0)
            return line;
    }
    return '';
}

/**
 * Whether a fence body is *meant* to be a chart table. Structural only, because the renderer asks on
 * every keystroke: an unparseable table still reads as a table, so its error surfaces where the
 * config is actually read.
 */
export function isChartTableBody(body: string): boolean {
    const line = firstLine(body);
    if (!line.includes('|'))
        return false;
    return CHART_KEYWORD_RE.test(splitTableRow(line)[0] ?? '');
}

/**
 * Cherry re-wraps the cell's own braces and refuses a prototype key, because the configuration is
 * authored by hand and round-trips through a DOM attribute. Malformed JSON is an error here rather
 * than the silent `{}` Cherry answers with: a dropped title is a wrong picture, and the block can
 * say so.
 */
export function parseChartKeyword(cell: string): ChartKeyword | null {
    const match = CHART_KEYWORD_RE.exec(cell.trim());
    if (!match)
        return null;
    const inner = match[2]?.trim();
    return { kind: match[1]!, options: inner ? parseKeywordOptions(inner) : {} };
}

function parseKeywordOptions(inner: string): Record<string, unknown> {
    const text = `{${inner}}`;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text, safeReviver);
    }
    catch {
        throw new ChartTableError('bad-json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new ChartTableError('bad-json');
    return parsed as Record<string, unknown>;
}

export function formatKeywordCell(keyword: ChartKeyword): string {
    const keys = Object.keys(keyword.options);
    return keys.length === 0 ? `:${keyword.kind}:` : `:${keyword.kind}:${JSON.stringify(keyword.options)}`;
}

/** Reads a chart table out of fence text. Ragged rows are padded, the way a rendered table pads them. */
export function readChartTable(body: string): ChartTable {
    assertChartBodySize(body);
    const lines = body.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2)
        throw new ChartTableError('no-header');
    const keyword = parseChartKeyword(splitTableRow(lines[0]!)[0] ?? '');
    if (!keyword)
        throw new ChartTableError('no-keyword');
    if (!isDelimiterRow(lines[1]!))
        throw new ChartTableError('no-delimiter');
    const header = splitTableRow(lines[0]!).map(unescapeCell);
    header[0] = '';
    const width = header.length;
    const rows = lines.slice(2).map((line) => pad(splitTableRow(line).map(unescapeCell), width));
    return { kind: keyword.kind, options: keyword.options, header, rows };
}

function pad(cells: string[], width: number): string[] {
    const row = [...cells];
    while (row.length < width)
        row.push('');
    return row.slice(0, width);
}

/**
 * The table text for a model. Unpadded: a body a toggle wrote should read like one a person typed, and
 * trailing spaces inside every cell would show up in the note as whitespace the editor keeps.
 */
export function writeChartTable(table: ChartTable): string {
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    return [
        line([formatKeywordCell(table), ...table.header.slice(1).map(escapeCell)]),
        line(table.header.map(() => '---')),
        ...table.rows.map((row) => line(row.map(escapeCell))),
    ].join('\n');
}

/** The number a cell means: thousands separators allowed, anything unreadable is zero. */
export function cellNumber(cell: string | undefined): number {
    const value = Number.parseFloat(String(cell ?? '').replace(/,/g, ''));
    return Number.isFinite(value) ? value : 0;
}
