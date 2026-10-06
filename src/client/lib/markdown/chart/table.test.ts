import { describe, expect, it } from 'vitest';
import { CHART_TABLE_MESSAGES, ChartTableError, isChartTableBody, parseChartKeyword, readChartTable, writeChartTable, type ChartTableReason } from './table';

/** The line-chart example, taken from the reference table-chart demo with its labels in ASCII. */
const LINE_TABLE = [
    '| :line:{"title": "Tally"} | Header1 | Header2 | Header3 | Header4 |',
    '| ------ | ------ | ------ | ------ | ------ |',
    '| Sample1 | 11 | 11 | 4 | 33 |',
    '| Sample2 | 112 | 111 | 22 | 222 |',
    '| Sample3 | 333 | 142 | 311 | 11 |',
].join('\n');

const PIE_TABLE = [
    '| :pie:{"title": "Fruit"} | Value |',
    '| ------ | ------ |',
    '| Apple | 40 |',
    '| Banana | 30 |',
].join('\n');

describe('chart table bodies', () => {
    it('reads a chart table by its keyword cell and nothing else', () => {
        expect(isChartTableBody(LINE_TABLE)).toBe(true);
        expect(isChartTableBody('{"type": "bar"}')).toBe(false);
        expect(isChartTableBody('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(false);
    });

    it('accepts a keyword with no configuration, as the reference syntax does', () => {
        expect(parseChartKeyword(':bar:')).toEqual({ kind: 'bar', options: {} });
        expect(parseChartKeyword(':bar:{"title": "x"}')?.options).toEqual({ title: 'x' });
        expect(parseChartKeyword(' :bar: { "title": "x" } ')).not.toBeNull();
    });

    it('refuses a cell that does not name a chart', () => {
        expect(parseChartKeyword('Header1')).toBeNull();
        expect(parseChartKeyword(':line:extra')).toBeNull();
    });

    it('consumes the keyword cell so the header keeps its shape', () => {
        const table = readChartTable(LINE_TABLE);
        expect(table.kind).toBe('line');
        expect(table.options).toEqual({ title: 'Tally' });
        expect(table.header).toEqual(['', 'Header1', 'Header2', 'Header3', 'Header4']);
        expect(table.rows[0]).toEqual(['Sample1', '11', '11', '4', '33']);
    });

    it('pads a short row the way a rendered table pads it', () => {
        expect(readChartTable(`${PIE_TABLE}\n| Orange |`).rows[2]).toEqual(['Orange', '']);
    });

    it('unescapes a pipe a cell carried', () => {
        const table = readChartTable('| :bar: | a |\n| --- | --- |\n| x \\| y | 1 |');
        expect(table.rows[0][0]).toBe('x | y');
    });

    it('drops a prototype key a hand-written cell could name', () => {
        const table = readChartTable('| :bar:{"__proto__": {"polluted": true}, "title": "t"} | a |\n| --- | --- |\n| r | 1 |');
        expect(table.options).toEqual({ title: 't' });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('reports a configuration it cannot read instead of drawing without it', () => {
        expect(() => readChartTable('| :bar:{"title": } | a |\n| --- | --- |')).toThrow(ChartTableError);
        expect(() => readChartTable('| :bar: | a |')).toThrow('no-header');
        expect(() => readChartTable('| bar | a |\n| --- | --- |')).toThrow('no-keyword');
        expect(() => readChartTable('| :bar: | a |\n| x | y |\n| 1 | 2 |')).toThrow('no-delimiter');
    });

    it('names every reason a block has to put into words', () => {
        const keys: ChartTableReason[] = ['no-header', 'no-keyword', 'no-delimiter', 'bad-json'];
        expect(keys.map((reason) => CHART_TABLE_MESSAGES[reason])).toEqual([
            'markdown.chart_table_no_header',
            'markdown.chart_table_no_keyword',
            'markdown.chart_table_no_delimiter',
            'markdown.chart_table_bad_options',
        ]);
    });

    it('writes a table back out that reads as the same table', () => {
        const table = readChartTable(LINE_TABLE);
        expect(readChartTable(writeChartTable(table))).toEqual(table);
    });

    it('keeps a keyword with no options bare', () => {
        expect(writeChartTable({ kind: 'bar', options: {}, header: ['', 'a'], rows: [['r', '1']] })).toBe('| :bar: | a |\n| --- | --- |\n| r | 1 |');
    });

    it('keeps a pipe inside a cell out of the column layout it writes', () => {
        const table = readChartTable('| :bar: | a |\n| --- | --- |\n| x \\| y | 1 |');
        expect(writeChartTable(table)).toBe('| :bar: | a |\n| --- | --- |\n| x \\| y | 1 |');
    });
});
