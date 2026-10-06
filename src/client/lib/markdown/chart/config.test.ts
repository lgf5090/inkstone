import { describe, expect, it } from 'vitest';
import { ChartConfigError, chartConfigToTable, tableToChartConfig } from './config';
import { writeChartTable, type ChartTable } from './table';

function table(kind: string, header: string[], rows: string[][], options: Record<string, unknown> = {}): ChartTable {
    return { kind, options, header, rows };
}

const AXIS = table('bar', ['', 'A', 'B', 'C'], [['Votes', '12', '19', '7']]);
const PIE = table('pie', ['', 'Value'], [['Apple', '40'], ['Banana', '30']]);
const SCATTER = table('scatter', ['', 'x', 'y', 'series'], [
    ['A1', '10', '20', 'one'],
    ['A2', '15', '25', 'one'],
    ['B1', '12', '18', 'two'],
]);

describe('a chart table as a chart.js config', () => {
    it('puts the categories in the header and one series per row', () => {
        expect(tableToChartConfig(AXIS)).toEqual({
            type: 'bar',
            data: { labels: ['A', 'B', 'C'], datasets: [{ label: 'Votes', data: [12, 19, 7] }] },
        });
    });

    it('reads a slice chart from its rows, not its header', () => {
        expect(tableToChartConfig(PIE)).toEqual({
            type: 'pie',
            data: { labels: ['Apple', 'Banana'], datasets: [{ data: [40, 30] }] },
        });
    });

    it('groups a scatter by its series column and leaves the categories out', () => {
        expect(tableToChartConfig(SCATTER)).toEqual({
            type: 'scatter',
            data: {
                datasets: [
                    { label: 'one', data: [{ x: 10, y: 20, name: 'A1' }, { x: 15, y: 25, name: 'A2' }] },
                    { label: 'two', data: [{ x: 12, y: 18, name: 'B1' }] },
                ],
            },
        });
    });

    it('draws a bubble chart when a size column is read', () => {
        const config = tableToChartConfig(table('scatter', ['', 'x', 'y', 'size'], [['a', '1', '2', '5']]));
        expect(config.type).toBe('bubble');
        expect((config.data as { datasets: { data: unknown[] }[] }).datasets[0].data[0]).toEqual({ x: 1, y: 2, name: 'a', r: 5 });
    });

    it('takes the column mapping over the column order', () => {
        const mapped = table('scatter', ['', 'X', 'Y', 'Size', 'Series'], [['a', '1', '2', '5', 'g']], {
            'cherry:mapping': { x: 'X', y: 'Y', size: 'Size', series: 'Series' },
        });
        expect(tableToChartConfig(mapped).type).toBe('bubble');
        expect((tableToChartConfig(mapped).data as { datasets: { label: string }[] }).datasets[0].label).toBe('g');
    });

    // The keyword is matched case-insensitively, but the engine's name is camelCase: `:polarArea:` used to
    // answer unknown-kind because the lowercased spelling was looked up in a list holding the camelCase one.
    it('reads a camelCase kind whichever way the note spells it', () => {
        for (const written of ['polarArea', 'polararea', 'POLARAREA']) {
            const config = tableToChartConfig(table(written, ['', 'Value'], [['Apple', '12'], ['Banana', '30']]));
            expect(config.type, written).toBe('polarArea');
            expect(config.data, written).toEqual({ labels: ['Apple', 'Banana'], datasets: [{ data: [12, 30] }] });
        }
    });

    it('reads a mapping that names only the axes as a plain scatter', () => {
        const mapped = table('scatter', ['', 'temp', 'sales'], [['a', '20', '3'], ['b', '30', '7']], {
            'cherry:mapping': { x: 'temp', y: 'sales' },
        });
        const config = tableToChartConfig(mapped);
        expect(config.type).toBe('scatter');
        expect(config.data).toEqual({ datasets: [{ data: [{ x: 20, y: 3, name: 'a' }, { x: 30, y: 7, name: 'b' }] }] });
    });

    it('refuses a mapping whose x or y column the header does not name', () => {
        const mapped = table('scatter', ['', 'a', 'b'], [['r', '1', '2']], { 'cherry:mapping': { x: 'nope', y: 'b' } });
        expect(() => tableToChartConfig(mapped)).toThrow(ChartConfigError);
    });

    it('treats the last of five unnamed columns as the series', () => {
        const wide = table('scatter', ['', 'a', 'b', 'c', 'd'], [['n', '1', '2', '3', 'g1'], ['m', '4', '5', '6', 'g2']]);
        const datasets = (tableToChartConfig(wide).data as { datasets: { label: string }[] }).datasets;
        expect(datasets.map((set) => set.label)).toEqual(['g1', 'g2']);
    });

    it('reads a series column the header calls group', () => {
        const named = table('scatter', ['', 'x', 'y', 'group'], [['a', '1', '2', 'g']]);
        const datasets = (tableToChartConfig(named).data as { datasets: { label: string }[] }).datasets;
        expect(datasets.map((set) => set.label)).toEqual(['g']);
    });

    // A header that names nothing still has the documented order: name, x, y. Reading the absent column
    // as -1 put every point on the same axis position and drew a confident picture of nothing.
    it('falls back to the documented column order when the header names no axis', () => {
        const plain = table('scatter', ['', 'name', 'temp', 'sales'], [['a', '20', '3'], ['b', '30', '7']]);
        expect(tableToChartConfig(plain).data).toEqual({
            datasets: [{ data: [{ x: 20, y: 3, name: 'a' }, { x: 30, y: 7, name: 'b' }] }],
        });
    });

    it('carries the keyword title into the title plugin and passes anything else through', () => {
        const config = tableToChartConfig(table('line', ['', 'A'], [['s', '1']], { title: 'Trend', spanGaps: true }));
        expect(config.options).toEqual({ spanGaps: true, plugins: { title: { display: true, text: 'Trend' } } });
    });

    it('refuses a kind it does not draw, an empty table and a header with no value column', () => {
        expect(() => tableToChartConfig(table('nope', ['', 'a'], [['r', '1']]))).toThrow(/unknown-kind/);
        expect(() => tableToChartConfig(table('bar', ['', 'a'], []))).toThrow(/empty-table/);
        expect(() => tableToChartConfig(table('bar', [''], []))).toThrow(/too-narrow/);
    });
});

describe('a chart.js config as a chart table', () => {
    it('keeps several series as several rows', () => {
        const converted = chartConfigToTable({ type: 'bar', data: { labels: ['A'], datasets: [{ label: 's', data: [1] }, { label: 't', data: [2] }] } });
        expect(converted.ok && converted.table.rows).toEqual([['s', '1'], ['t', '2']]);
    });

    it('writes back the table a bar config came from', () => {
        const converted = chartConfigToTable(tableToChartConfig(AXIS));
        expect(converted.ok && converted.table).toEqual(AXIS);
    });

    it('writes a camelCase kind back in its own spelling', () => {
        const converted = chartConfigToTable({ type: 'polarArea', data: { labels: ['Apple', 'Banana'], datasets: [{ data: [12, 30] }] } });
        expect(converted.ok).toBe(true);
        if (converted.ok)
            expect(converted.table.kind).toBe('polarArea');
    });

    it('writes a slice chart with an unnamed value column', () => {
        const converted = chartConfigToTable(tableToChartConfig(PIE));
        expect(converted.ok && converted.table.header).toEqual(['', '']);
        expect(converted.ok && converted.table.rows).toEqual([['Apple', '40'], ['Banana', '30']]);
    });

    it('keeps a scatter round trip whole', () => {
        const converted = chartConfigToTable(tableToChartConfig(SCATTER));
        expect(converted.ok && converted.table).toEqual(SCATTER);
    });

    it('declines a config a table cannot hold', () => {
        const lossy = [
            { type: 'bar', data: { labels: [1], datasets: [{ label: 's', data: [1] }] } },
            { type: 'bar', data: { labels: ['A', 'B'], datasets: [{ label: 's', data: [1] }] } },
            { type: 'bar', data: { labels: ['A'], datasets: [{ data: [1] }] } },
            { type: 'pie', data: { labels: ['A'], datasets: [{ label: 'x', data: [1] }] } },
            { type: 'radialBar', data: { labels: [], datasets: [] } },
            'not an object',
        ];
        for (const config of lossy)
            expect(chartConfigToTable(config).ok).toBe(false);
    });

    // The keyword cell carries arbitrary configuration, so `options` beyond a title has a table home after
    // all — refusing it was what made an ordinary chart.js example unwritable as a table.
    it('carries the config options through the keyword cell and back', () => {
        const config = {
            type: 'bar',
            data: { labels: ['Jan', 'Feb'], datasets: [{ label: 'Revenue', data: [12, 19] }] },
            options: { responsive: true, plugins: { legend: { position: 'top' } } },
        };
        const converted = chartConfigToTable(config);
        expect(converted.ok).toBe(true);
        if (!converted.ok)
            return;
        expect(converted.table.options).toEqual(config.options);
        expect(tableToChartConfig(converted.table)).toEqual(config);
    });

    it('keeps a title object the cell did not write', () => {
        const options = { plugins: { title: { display: false, text: 'x', color: 'red' } } };
        const converted = chartConfigToTable({ type: 'bar', data: { labels: ['A'], datasets: [{ label: 's', data: [1] }] }, options });
        expect(converted.ok && converted.table.options).toEqual(options);
    });

    // A series colour has no table cell, and the accent is what paints a table's series — so the rewrite
    // leaves the styling out and counts what it left, rather than refusing over something that changes
    // nothing about the numbers.
    it('leaves a series styling behind and counts what it left out', () => {
        const styled = {
            type: 'bar',
            data: {
                labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
                datasets: [{ label: 'Revenue ($k)', data: [12, 19, 15, 25, 22, 30], backgroundColor: 'rgba(54, 162, 235, 0.5)', borderColor: 'rgb(54, 162, 235)', borderWidth: 1 }],
            },
            options: { responsive: true, plugins: { legend: { position: 'top' } } },
        };
        const converted = chartConfigToTable(styled);
        expect(converted.ok && converted.dropped).toBe(3);
        expect(converted.ok && converted.table.rows).toEqual([['Revenue ($k)', '12', '19', '15', '25', '22', '30']]);
        expect(converted.ok && tableToChartConfig(converted.table)).toEqual({
            type: 'bar',
            data: { labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], datasets: [{ label: 'Revenue ($k)', data: [12, 19, 15, 25, 22, 30] }] },
            options: { responsive: true, plugins: { legend: { position: 'top' } } },
        });
        expect(chartConfigToTable({ type: 'scatter', data: { datasets: [{ data: [{ x: 1, y: 2, pointStyle: 'cross' }] }] } })).toMatchObject({ ok: true, dropped: 1 });
    });

    it('refuses to move a series off the axis its numbers sit on', () => {
        const twoAxes = {
            type: 'bar',
            data: { labels: ['A'], datasets: [{ label: 's', data: [1] }, { label: 't', data: [2], yAxisID: 'y1' }] },
        };
        expect(chartConfigToTable(twoAxes)).toEqual({ ok: false, reason: 'series-layout' });
    });

    it('accepts a title and nothing else beside it', () => {
        const converted = chartConfigToTable({
            type: 'line',
            data: { labels: ['A'], datasets: [{ label: 's', data: [1] }] },
            options: { plugins: { title: { display: true, text: 'Trend' } } },
        });
        expect(converted.ok && converted.table.options).toEqual({ title: 'Trend' });
        expect(converted.ok && writeChartTable(converted.table)).toContain(':line:{"title":"Trend"}');
    });
});
