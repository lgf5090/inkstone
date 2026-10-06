import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destroyChartInstances, enhancePreview, renderPendingCharts } from './enhance';
import { renderMarkdown } from './renderer';
import { t } from '../i18n';
import { CHART_BODY_LIMIT_BYTES } from './chart/limit';

interface FakeChart {
    destroyed: boolean
    resize: ReturnType<typeof vi.fn>
    destroy: () => void
}

const built: Array<{ canvas: HTMLCanvasElement, config: Record<string, unknown>, instance: FakeChart }> = [];

vi.mock('chart.js/auto', () => ({
    Chart: vi.fn(function construct(this: void, canvas: HTMLCanvasElement, config: Record<string, unknown>) {
        const instance: FakeChart = {
            destroyed: false,
            resize: vi.fn(),
            destroy: () => {
                instance.destroyed = true;
            },
        };
        built.push({ canvas, config, instance });
        return instance;
    }),
}));

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    targets: Element[] = [];
    disconnects = 0;
    constructor(readonly callback: () => void) {
        FakeResizeObserver.instances.push(this);
    }
    observe(target: Element): void {
        this.targets.push(target);
    }
    disconnect(): void {
        this.disconnects++;
    }
}

const TABLE = '| :bar: | Jan | Feb |\n| --- | --- | --- |\n| Shop | 12 | 19 |';
const CONFIG = '{"type":"bar","data":{"labels":["Jan","Feb"],"datasets":[{"label":"Shop","data":[12,19]}]}}';

function chartHost(source: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(source).html;
    document.body.append(host);
    return host;
}

function block(host: HTMLElement): HTMLElement {
    return host.querySelector<HTMLElement>('[data-chart]')!;
}

function stubLayout(width: number, height: number): () => void {
    const restores = ['clientWidth', 'clientHeight'].map((name, index) => {
        const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
        Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: index === 0 ? width : height });
        return () => {
            if (previous)
                Object.defineProperty(HTMLElement.prototype, name, previous);
            else
                delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        };
    });
    return () => restores.forEach((restore) => restore());
}

beforeEach(() => {
    built.length = 0;
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe('drawing a chart block', () => {
    it('constructs one chart on a canvas it made for the block', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(1);
        expect(block(host).contains(built[0]!.canvas)).toBe(true);
        expect(block(host).classList.contains('loading')).toBe(false);
        expect(block(host).hasAttribute('aria-busy')).toBe(false);
    });

    it('reads a table body into the config the JSON body means', async () => {
        const host = chartHost(`\`\`\`chart style=table\n${TABLE}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built[0]!.config).toMatchObject({
            type: 'bar',
            data: { labels: ['Jan', 'Feb'], datasets: [{ label: 'Shop', data: [12, 19] }] },
        });
    });

    it('paints an unstyled series with the accent and leaves a named colour alone', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        const datasets = (built[0]!.config.data as { datasets: Record<string, unknown>[] }).datasets;
        expect(String(datasets[0]!.backgroundColor)).toMatch(/^#[0-9a-f]{6}$/);
        expect(String(datasets[0]!.borderColor)).toMatch(/^#[0-9a-f]{6}$/);
        const named = '{"type":"bar","data":{"labels":["A"],"datasets":[{"label":"s","data":[1],"backgroundColor":"#ff0000"}]}}';
        await renderPendingCharts(chartHost(`\`\`\`chart\n${named}\n\`\`\`\n`), false);
        expect(built[1]!.config.data).toMatchObject({ datasets: [{ backgroundColor: '#ff0000' }] });
    });

    it('re-applies the app axis colours under the note own ticks and grid objects', async () => {
        const themed = '{"type":"bar","data":{"labels":["A"],"datasets":[{"label":"s","data":[1]}]},"options":{"scales":{"x":{"ticks":{"stepSize":5},"grid":{"drawBorder":false}}}}}';
        await renderPendingCharts(chartHost(`\`\`\`chart\n${themed}\n\`\`\`\n`), false);
        const options = built[0]!.config.options as {
            color: string
            scales: { x: { ticks: { color: string, stepSize: number }, grid: { color: string, drawBorder: boolean } } }
        };
        expect(options.scales.x.ticks.stepSize).toBe(5);
        expect(options.scales.x.grid.drawBorder).toBe(false);
        expect(options.scales.x.ticks.color).toBeTruthy();
        expect(options.scales.x.grid.color).toBeTruthy();
    });

    it('hands the engine a legend colour of its own', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, true);
        const options = built[0]!.config.options as { color: string, plugins: { legend: { labels: { color: string } } } };
        expect(options.plugins.legend.labels.color).toBeTruthy();
        expect(options.color).toBeTruthy();
    });

describe('a laid-out container', () => {
    let restore: () => void;

    beforeEach(() => {
        restore = stubLayout(812, 272);
    });
    afterEach(() => restore());

    it('sizes the canvas from the box it was put in, and resizes it from there', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built[0]!.canvas.width).toBe(812);
        expect(built[0]!.canvas.height).toBe(272);
        expect(built[0]!.config).toMatchObject({ options: { responsive: false, maintainAspectRatio: false } });
        expect(FakeResizeObserver.instances).toHaveLength(1);
        expect(FakeResizeObserver.instances[0]!.targets[0]).toBe(built[0]!.canvas.parentElement);
        FakeResizeObserver.instances[0]!.callback();
        expect(built[0]!.instance.resize).toHaveBeenCalledWith(812, 272);
    });
});

    it('falls back to a readable box when the document has no layout, as an export has none', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built[0]!.canvas.width).toBe(640);
        expect(built[0]!.canvas.height).toBe(360);
    });

    it('animates for a reader and holds still for a surface that reads the canvas', async () => {
        const live = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(live, false);
        expect((built[0]!.config.options as Record<string, unknown>).animation).toBeUndefined();
        await renderPendingCharts(chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`), false, { instant: true });
        expect((built[1]!.config.options as Record<string, unknown>).animation).toBe(false);
    });
});

describe('not drawing a chart twice', () => {
    it('skips a block whose body, format and theme have not moved', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(1);
    });

    it('redraws when the theme moves, because the palette is part of what was drawn', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        await renderPendingCharts(host, true);
        expect(built).toHaveLength(2);
    });

    it('re-runs the reader when only the stated format moves, though the body never changed', async () => {
        const host = chartHost(`\`\`\`chart style=table\n${TABLE}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(1);
        block(host).dataset.chartStyle = 'json';
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(1);
        expect(block(host).classList.contains('has-error')).toBe(true);
        block(host).dataset.chartStyle = 'table';
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(2);
    });

    it('draws again on a node that kept the marker but lost the instance', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        host.replaceChildren(host.firstElementChild!.cloneNode(true));
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(2);
    });

    it('leaves an error banner alone while the body that caused it stands', async () => {
        const host = chartHost('```chart\nnot json at all\n```\n');
        await renderPendingCharts(host, false);
        const banner = block(host).querySelector('code');
        await renderPendingCharts(host, false);
        expect(block(host).querySelector('code')).toBe(banner);
        expect(built).toHaveLength(0);
    });
});

describe('a chart that cannot be drawn', () => {
    it('names a style value that is neither format and constructs nothing', async () => {
        const host = chartHost(`\`\`\`chart style=tabel\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(0);
        expect(block(host).classList.contains('has-error')).toBe(true);
        expect(block(host).textContent).toContain(t('markdown.chart_style_unknown'));
    });

    it('answers the table message about a table body, not a JSON one', async () => {
        const host = chartHost(`\`\`\`chart style=table\n| :bar: | a |\n| x | y |\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(block(host).textContent).toContain(t('markdown.chart_table_no_delimiter'));
    });

    it('refuses a kind the engine does not have', async () => {
        const host = chartHost('```chart style=table\n| :nope: | a |\n| --- | --- |\n| r | 1 |\n```\n');
        await renderPendingCharts(host, false);
        expect(block(host).textContent).toContain(t('markdown.chart_kind_unknown'));
    });

    it('refuses a body too large to draw, on the size message rather than a parse one', async () => {
        const host = chartHost(`\`\`\`chart\n${'x'.repeat(CHART_BODY_LIMIT_BYTES + 1)}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(0);
        expect(block(host).classList.contains('has-error')).toBe(true);
        // The catalog is not loaded under test, so t() answers with the key: this pins which message the
        // block chose. The KB figure it carries is pinned where the error is built, in chart/convert.
        expect(block(host).textContent).toContain(t('markdown.chart_body_too_large', { limit: CHART_BODY_LIMIT_BYTES / 1024 }));
        expect(block(host).textContent).not.toContain(t('markdown.chart_convert_invalid_json'));
    });

    it('keeps the author’s own body on screen beside the reason', async () => {
        const host = chartHost('```chart\nnot json at all\n```\n');
        await renderPendingCharts(host, false);
        expect(block(host).querySelector('code')!.textContent).toBe('not json at all\n');
    });

    it('does not let a hostile body become markup in the error banner', async () => {
        const host = chartHost('```chart\n"><img src=x onerror="alert(1)">\n```\n');
        await renderPendingCharts(host, false);
        expect(block(host).querySelector('img, script')).toBeNull();
        expect(block(host).querySelector('code')!.textContent).toContain('onerror');
    });
});

describe('tearing charts down', () => {
    it('destroys the instance and disconnects the observer it installed', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(FakeResizeObserver.instances).toHaveLength(1);
        destroyChartInstances(host);
        expect(built[0]!.instance.destroyed).toBe(true);
        expect(FakeResizeObserver.instances[0]!.disconnects).toBe(1);
    });

    it('lets go of the chart it replaces when a body changes', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        host.innerHTML = renderMarkdown(`\`\`\`chart\n${TABLE}\n\`\`\`\n`).html;
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(2);
    });

    it('re-draws a block whose instance was destroyed even though the marker stands', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        destroyChartInstances(host);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(2);
    });

    it('collects a chart whose block left the document, since nothing else would find it', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        const other = chartHost('Nothing here.\n');
        host.remove();
        await renderPendingCharts(other, false);
        expect(built[0]!.instance.destroyed).toBe(true);
        expect(FakeResizeObserver.instances[0]!.disconnects).toBe(1);
    });

    it('leaves a block that is still on screen and still current alone', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        await renderPendingCharts(host, false);
        expect(built[0]!.instance.destroyed).toBe(false);
        expect(FakeResizeObserver.instances[0]!.disconnects).toBe(0);
    });
});

describe('the chart renderer switch', () => {
    it('shows the body as text and never reaches the drawing pass when off', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await enhancePreview(host, { math: false, mermaid: false, chart: false, dark: false });
        const node = block(host);
        expect(node.classList.contains('chart-source')).toBe(true);
        expect(node.querySelector('canvas')).toBeNull();
        expect(node.dataset.rendered).toBeUndefined();
        expect(node.textContent).toBe(`${CONFIG}\n`);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(0);
    });

    it('draws again when the switch goes back on, with no stale marker in the way', async () => {
        const source = `\`\`\`chart\n${CONFIG}\n\`\`\`\n`;
        const host = chartHost(source);
        await enhancePreview(host, { math: false, mermaid: false, chart: false, dark: false });
        const drawn = chartHost(source);
        await renderPendingCharts(drawn, false);
        expect(built).toHaveLength(1);
        expect(block(drawn).classList.contains('chart-source')).toBe(false);
    });

    it('lets go of a live chart when the switch turns off under it', async () => {
        const host = chartHost(`\`\`\`chart\n${CONFIG}\n\`\`\`\n`);
        await renderPendingCharts(host, false);
        expect(built).toHaveLength(1);
        await enhancePreview(host, { math: false, mermaid: false, chart: false, dark: false });
        expect(built[0]!.instance.destroyed).toBe(true);
        expect(FakeResizeObserver.instances[0]!.disconnects).toBe(1);
        expect(block(host).querySelector('canvas')).toBeNull();
    });
});

describe('a document with no charts in it', () => {
    it('draws nothing and installs no observer', async () => {
        await renderPendingCharts(chartHost('Just a paragraph.\n'), false);
        expect(built).toHaveLength(0);
        expect(FakeResizeObserver.instances).toHaveLength(0);
    });
});
