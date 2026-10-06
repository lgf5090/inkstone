/**
 * Which columns of a scatter table mean x, y, size and series.
 *
 * The resolution lives beside the syntax rather than beside the drawing engine: a note that says
 * `cherry:mapping` must mean the same picture however it is drawn, and the day those two drift is the
 * day the format toggle starts losing data.
 */
import type { ChartTable } from './table';

/**
 * The header words the syntax documents for a scatter's columns. These are matched against a note's own
 * cells and never rendered, so they are input vocabulary rather than UI copy: a note written in Chinese
 * means the same chart whatever language the reader's interface is in, which is why they cannot come from
 * the locale catalog. `SCATTER_HEADER_WORDS` is named in scripts/check-i18n.mjs as the one place Chinese
 * may sit in `src/client`; every other Han literal still fails that gate.
 */
const SCATTER_HEADER_WORDS = {
    x: ['x', '横坐标'],
    y: ['y', '纵坐标'],
    size: ['size', '大小'],
    series: ['series', 'group', '系列', '分组'],
};

export interface ScatterColumns {
    x: number
    y: number
    /** -1 when no column carries a size, which is what keeps a picture a scatter and not a bubble. */
    size: number
    /** -1 when every point lands in one series. */
    series: number
}

function lowerHeader(table: ChartTable): string[] {
    return table.header.map((cell) => cell.trim().toLowerCase());
}

function mappedColumns(table: ChartTable, mapping: Record<string, unknown>): ScatterColumns | null {
    const header = lowerHeader(table);
    // A column the note did not name is absent, not column zero: the keyword cell leaves an empty header
    // cell behind, and an empty string looked up in that header answers 0 — which handed a mapping of x
    // and y alone a size column and a series column the author never wrote, and drew a bubble nobody
    // asked for.
    const at = (key: string) => {
        const wanted = String(mapping[key] ?? '').trim().toLowerCase();
        return wanted === '' ? -1 : header.indexOf(wanted);
    };
    const x = at('x');
    const y = at('y');
    // A mapping that names a column the header does not have is a mistake in the note, not a hint to
    // fall back: falling back would draw a chart over different columns than the author pointed at.
    if (x < 0 || y < 0)
        return null;
    return { x, y, size: at('size'), series: Math.max(at('series'), at('group')) };
}

/**
 * The documented order — name, x, y, size, series — with the header words the syntax also accepts.
 * The search starts at the second cell because the first one is where the point's name lives.
 *
 * A column the header does not name falls back to its slot in that order rather than to -1: a scatter
 * whose header says `name | temp | sales` means the second and third cells, and reading -1 would have
 * every point land on the same axis position — a picture of nothing, drawn confidently.
 */
function positionalColumns(table: ChartTable): ScatterColumns {
    const header = lowerHeader(table);
    const byWord = (words: string[], whenAbsent: number) => {
        const found = header.findIndex((cell, index) => index > 0 && words.includes(cell));
        return found >= 0 ? found : whenAbsent;
    };
    const namedSeries = header.findIndex((cell, index) => index > 0 && SCATTER_HEADER_WORDS.series.includes(cell));
    return {
        x: byWord(SCATTER_HEADER_WORDS.x, 1),
        y: byWord(SCATTER_HEADER_WORDS.y, 2),
        size: byWord(SCATTER_HEADER_WORDS.size, -1),
        series: namedSeries >= 0 || header.length < 5 ? namedSeries : header.length - 1,
    };
}

export function resolveScatterColumns(table: ChartTable): ScatterColumns | null {
    const mapping = table.options['cherry:mapping'];
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping))
        return mappedColumns(table, mapping as Record<string, unknown>);
    return positionalColumns(table);
}
