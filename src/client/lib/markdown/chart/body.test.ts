import { describe, expect, it } from 'vitest';
import { applyChartFencePatch, chartFenceAt, detectChartMode, resolveChartMode } from './body';

const FENCE = '`'.repeat(3);
const JSON_BODY = '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}';
const TABLE = '| :bar: | A |\n| --- | --- |\n| s | 1 |';

function note(open = `${FENCE}chart`, eol = '\n'): string {
    return [`${open}`, JSON_BODY, FENCE].join(eol) + eol;
}

describe('a chart fence', () => {
    it('names its format by the body alone', () => {
        expect(detectChartMode(JSON_BODY)).toBe('json');
        expect(detectChartMode(TABLE)).toBe('table');
        expect(detectChartMode(`  \n${TABLE}`)).toBe('table');
        // A table whose delimiter row is broken is still a table: inference reads the first cell.
        expect(detectChartMode('| :bar: | A |\n| s | 1 |')).toBe('table');
    });

    it('reads the format the note states instead of the one the body implies', () => {
        expect(resolveChartMode(JSON_BODY, null)).toBe('json');
        expect(resolveChartMode(TABLE, null)).toBe('table');
        expect(resolveChartMode(TABLE, 'json')).toBe('json');
        expect(resolveChartMode(JSON_BODY, 'table')).toBe('table');
    });

    it('finds its own fence by the line the block was stamped with', () => {
        expect(chartFenceAt(note(), 0)).toEqual({ line: 0, body: JSON_BODY, info: 'chart' });
        expect(chartFenceAt(note(`${FENCE}chartjs style=table`), 0)).toEqual({ line: 0, body: JSON_BODY, info: 'chartjs style=table' });
        expect(chartFenceAt(note(), 1)).toBeNull();
        expect(chartFenceAt(`${FENCE}js\n1\n${FENCE}\n`, 0)).toBeNull();
    });

    it('rewrites the body, the stated format, or both in one edit', () => {
        const bodyOnly = [`${FENCE}chart`, TABLE, FENCE].join('\n') + '\n';
        expect(applyChartFencePatch(note(), chartFenceAt(note(), 0)!, { body: TABLE })).toBe(bodyOnly);
        const styleOnly = [`${FENCE}chart style=json`, JSON_BODY, FENCE].join('\n') + '\n';
        expect(applyChartFencePatch(note(), chartFenceAt(note(), 0)!, { style: 'json' })).toBe(styleOnly);
        const both = [`${FENCE}chart style=table`, TABLE, FENCE].join('\n') + '\n';
        const jsonStated = [`${FENCE}chart style=json`, JSON_BODY, FENCE].join('\n') + '\n';
        expect(applyChartFencePatch(jsonStated, chartFenceAt(jsonStated, 0)!, { body: TABLE, style: 'table' })).toBe(both);
    });

    it('keeps a CRLF note that way when it rewrites one', () => {
        const crlf = [`${FENCE}chart style=json`, JSON_BODY, `${FENCE}`].join('\r\n') + '\r\n';
        const next = applyChartFencePatch(crlf, chartFenceAt(crlf, 0)!, { body: TABLE, style: 'table' });
        expect(next).toBe([`${FENCE}chart style=table`, TABLE.split('\n').join('\r\n'), FENCE].join('\r\n') + '\r\n');
    });

    it('restates the format without touching the body', () => {
        const stated = [`${FENCE}chart style=table`, JSON_BODY, FENCE].join('\n') + '\n';
        const restated = [`${FENCE}chart style=json`, JSON_BODY, FENCE].join('\n') + '\n';
        expect(applyChartFencePatch(stated, chartFenceAt(stated, 0)!, { style: 'json' })).toBe(restated);
    });

    it('declines to write when the fence no longer holds the body it was drawn from', () => {
        const fence = chartFenceAt(note(), 0)!;
        expect(applyChartFencePatch(`${FENCE}chart\n{"type":"line"}\n${FENCE}\n`, fence, { style: 'table' })).toBeNull();
    });

    it('follows a fence the note moved down a line', () => {
        const fence = chartFenceAt(note(), 0)!;
        const shifted = `intro\n${note()}`;
        const next = applyChartFencePatch(shifted, fence, { style: 'json' });
        expect(next).toBe(`intro\n${FENCE}chart style=json\n${JSON_BODY}\n${FENCE}\n`);
    });

    it('declines when two fences could both be the one it was drawn from', () => {
        const fence = chartFenceAt(note(), 0)!;
        const doubled = `${note()}x\n${note()}`;
        expect(applyChartFencePatch(doubled, { ...fence, line: 99 }, { style: 'json' })).toBeNull();
    });
});
