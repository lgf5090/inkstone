/**
 * Reading a chart fence body whichever format it is written in, and rewriting it as the other one.
 *
 * The rewrite is the whole of what the toolbar's format control does: it never changes what the block
 * draws, only how the note says it. Both directions therefore refuse rather than approximate — a
 * conversion that quietly dropped a second axis would leave the note drawing a different chart than the
 * one the author was looking at when they pressed it.
 */
import { detectChartMode, resolveChartMode } from './body';
import { ChartConfigError, chartConfigToTable, tableToChartConfig } from './config';
import { ChartBodyTooLargeError } from './limit';
import { parseChartJson } from './json';
import { ChartTableError, readChartTable, writeChartTable } from './table';
import type { DeclaredStyle } from './style';

/** Why a body cannot be written the other way. Every caller turns this into a sentence. */
export type ChartConvertFailure =
    | 'too-large'
    | 'invalid-json'
    | 'table-syntax'
    | 'not-a-config'
    | 'unknown-kind'
    | 'series-layout'
    | 'lossy'
    | 'too-narrow'
    | 'bad-mapping'
    | 'empty-table';

export type ChartConversion = { ok: true, body: string, dropped: number } | { ok: false, reason: ChartConvertFailure };

/** The config a chart fence means, from a JSON body or from a table one, as the note states it. */
export function readChartBody(raw: string, style: DeclaredStyle | null = null): Record<string, unknown> {
    return resolveChartMode(raw, style) === 'table' ? tableToChartConfig(readChartTable(raw)) : parseChartJson(raw);
}

function failure(err: unknown): ChartConversion {
    if (err instanceof ChartBodyTooLargeError)
        return { ok: false, reason: 'too-large' };
    if (err instanceof ChartConfigError)
        return { ok: false, reason: err.reason };
    if (err instanceof ChartTableError)
        return { ok: false, reason: 'table-syntax' };
    return { ok: false, reason: 'invalid-json' };
}

/** The body written the other way round, from the format the block is currently in. */
export function convertChartBody(raw: string): ChartConversion {
    try {
        if (detectChartMode(raw) === 'table')
            return { ok: true, body: JSON.stringify(readChartBody(raw), null, 2), dropped: 0 };
        const converted = chartConfigToTable(parseChartJson(raw));
        if (!converted.ok)
            return converted;
        return { ok: true, body: writeChartTable(converted.table), dropped: converted.dropped };
    }
    catch (err) {
        return failure(err);
    }
}
