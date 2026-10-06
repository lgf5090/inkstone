import { describe, expect, it } from 'vitest';
import { convertChartBody, readChartBody } from './convert';
import { parseChartJson } from './json';
import { readChartTable } from './table';

const BAR_TABLE = '| :bar:{"title": "Tally"} | Jan | Feb |\n| --- | --- | --- |\n| Shop A | 12 | 19 |\n| Shop B | 5 | 9 |';
const BAR_CONFIG = JSON.stringify({
    type: 'bar',
    data: { labels: ['Jan', 'Feb'], datasets: [{ label: 'Shop A', data: [12, 19] }, { label: 'Shop B', data: [5, 9] }] },
    options: { plugins: { title: { display: true, text: 'Tally' } } },
}, null, 2);

describe('reading a chart body whichever format it is written in', () => {
    it('means the same config from either door', () => {
        expect(readChartBody(BAR_TABLE)).toEqual(readChartBody(BAR_CONFIG));
    });

    it('runs the reader the note states, so a broken table gets a table message', () => {
        const broken = '| :bar: | A |\n| x | y |';
        expect(() => readChartBody(broken, 'table')).toThrow(/no-delimiter/);
        expect(() => readChartBody(broken, 'json')).toThrow(SyntaxError);
    });

    it('tolerates the comments and trailing commas a copied config arrives with', () => {
        const copied = '{ /* a chart */ "type": "bar", "data": {"labels":["A"],"datasets":[{"data":[1]}]}, }';
        expect(parseChartJson(copied)).toMatchObject({ type: 'bar' });
    });

    it('refuses a prototype key a hand-written body could name', () => {
        const polluted = parseChartJson('{"type":"bar","__proto__":{"polluted":true}}');
        // `in` answers through the prototype chain, so it is the own property and the prototype itself
        // that have to be checked.
        expect(Object.prototype.hasOwnProperty.call(polluted, '__proto__')).toBe(false);
        expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('rewriting a chart body as the other format', () => {
    it('writes a table as JSON that converts back to the same table', () => {
        const toConfig = convertChartBody(BAR_TABLE);
        expect(toConfig.ok).toBe(true);
        if (!toConfig.ok)
            return;
        expect(toConfig.dropped).toBe(0);
        const back = convertChartBody(toConfig.body);
        expect(back.ok).toBe(true);
        if (!back.ok)
            return;
        expect(readChartTable(back.body)).toEqual(readChartTable(BAR_TABLE));
    });

    it('writes JSON as a table and reports nothing left behind', () => {
        const converted = convertChartBody(BAR_CONFIG);
        expect(converted.ok && converted.dropped).toBe(0);
        expect(converted.ok && readChartTable(converted.body)).toEqual(readChartTable(BAR_TABLE));
    });

    it('counts the styling a table cannot carry so the caller can say it out loud', () => {
        const styled = JSON.stringify({
            type: 'bar',
            data: { labels: ['A'], datasets: [{ label: 's', data: [1], backgroundColor: '#123456', borderWidth: 2 }] },
        });
        const converted = convertChartBody(styled);
        expect(converted).toMatchObject({ ok: true, dropped: 2 });
    });

    it('names a body it cannot write the other way', () => {
        expect(convertChartBody('{"data": {"datasets": [{}]}}')).toEqual({ ok: false, reason: 'not-a-config' });
        expect(convertChartBody('{"type": "heatmap", "data": {"datasets": [{}]}}')).toEqual({ ok: false, reason: 'unknown-kind' });
        expect(convertChartBody('not json at all')).toEqual({ ok: false, reason: 'invalid-json' });
        expect(convertChartBody('| :bar: | A |\n| x |\n')).toMatchObject({ ok: false, reason: 'table-syntax' });
    });

    it('refuses rather than approximate a config with two axes', () => {
        const twoAxes = JSON.stringify({
            type: 'bar',
            data: { labels: ['A'], datasets: [{ label: 's', data: [1] }, { label: 't', data: [2], yAxisID: 'y1' }] },
        });
        expect(convertChartBody(twoAxes)).toEqual({ ok: false, reason: 'series-layout' });
    });
});
