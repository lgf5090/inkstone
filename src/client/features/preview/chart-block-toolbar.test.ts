import { describe, expect, it, vi } from 'vitest';
import {
    applyChartSourceStates,
    chartSourceStates,
    chartToolbar,
    enhanceChartBlockToolbars,
} from './chart-block-toolbar';
import type { BlockActionContext } from './block-overlay';

const press = (button: HTMLElement, ctx: BlockActionContext) => chartToolbar.handle({ preventDefault: () => {} }, button, ctx);
import { renderMarkdown } from '../../lib/markdown/renderer';
import { patchChildren } from './Preview';
import { encodeDataValue } from '../../lib/markdown/data-attr';
import { t } from '../../lib/i18n';

const TABLE_BODY = '| :bar:{"title": "Tally"} | Jan | Feb |\n| --- | --- | --- |\n| Shop A | 12 | 19 |';
const CONFIG_BODY = '{"type":"bar","data":{"labels":["Jan","Feb"],"datasets":[{"label":"Shop A","data":[12,19]}]},"options":{"plugins":{"title":{"display":true,"text":"Tally"}}}}';

function noteWith(body: string, info = 'chart'): string {
    return `\`\`\`${info}\n${body}\n\`\`\`\n`;
}

function blockIn(note: string): { host: HTMLElement, block: HTMLElement } {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(note).html;
    enhanceChartBlockToolbars(host, { chart: true });
    const block = host.querySelector<HTMLElement>('[data-chart]')!;
    return { host, block };
}

function api(note: string, writable = true) {
    const onEdit = vi.fn();
    const toast = vi.fn();
    return {
        onEdit,
        toast,
        api: {
            // The preview resolves a block's line against the text it was built from, so the two are the
            // same note until a keystroke lands that the rendered surface has not caught up with.
            content: writable ? note : `${note}\n# typed while the preview was behind\n`,
            sourceNoteId: 'n1',
            committedSourceRef: { current: note },
            api: { editContent: (_noteId: string, next: string) => onEdit(next), toast },
        } satisfies BlockActionContext,
    };
}

function convertButton(block: HTMLElement): HTMLElement {
    return block.parentElement!.querySelector<HTMLElement>('[data-chart-action="convert-format"]')!;
}

describe('the head a chart block is given', () => {
    it('states the format the press will switch to, not the one it is in', () => {
        const { block } = blockIn(noteWith(TABLE_BODY, 'chart style=table'));
        const button = block.parentElement!.querySelector<HTMLElement>('[data-chart-action="convert-format"]')!;
        expect(button.textContent).toBe(t('preview.chart_format_json'));
        expect(button.title).toBe(t('preview.chart_convert_to_json'));
    });

    it('offers a table to a block written as JSON', () => {
        const { block } = blockIn(noteWith(CONFIG_BODY));
        const button = block.parentElement!.querySelector<HTMLElement>('[data-chart-action="convert-format"]')!;
        expect(button.textContent).toBe(t('preview.chart_format_table'));
    });

    it('wraps the block once, and keeps the block itself addressable', () => {
        const { host, block } = blockIn(noteWith(CONFIG_BODY));
        enhanceChartBlockToolbars(host, { chart: true });
        expect(host.querySelectorAll('.chart-block-wrap')).toHaveLength(1);
        expect(block.parentElement).toBe(host.querySelector('.chart-block-wrap'));
        expect(block.parentElement!.previousElementSibling).toBeNull();
    });

    it('leaves a chart inside an embedded note alone', () => {
        const host = document.createElement('div');
        host.innerHTML = `<div class="note-embed-body">${renderMarkdown(noteWith(CONFIG_BODY)).html}</div>`;
        enhanceChartBlockToolbars(host, { chart: true });
        expect(host.querySelectorAll('.chart-block-wrap')).toHaveLength(0);
    });
});

describe('the source panel', () => {
    it('shows the body the block was drawn from, and toggles its own button', () => {
        const { host } = blockIn(noteWith(TABLE_BODY, 'chart style=table'));
        const button = host.querySelector<HTMLElement>('[data-chart-action="toggle-source"]')!;
        const panel = host.querySelector<HTMLElement>('[data-chart-source]')!;
        const wrap = host.querySelector<HTMLElement>('.chart-block-wrap')!;
        expect(panel.hasAttribute('hidden')).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(wrap.classList.contains('is-block-source-open')).toBe(false);
        expect(panel.textContent).toBe(`${TABLE_BODY}\n`);
        press(button, api('').api);
        expect(panel.hasAttribute('hidden')).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(wrap.classList.contains('is-block-source-open')).toBe(true);
        press(button, api('').api);
        expect(panel.hasAttribute('hidden')).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(wrap.classList.contains('is-block-source-open')).toBe(false);
    });
});

describe('writing the note back from the toolbar', () => {
    it('rewrites a table as JSON and restates the format in one edit', () => {
        const note = noteWith(TABLE_BODY, 'chart style=table');
        const { block } = blockIn(note);
        const { api: a, onEdit, toast } = api(note);
        press(convertButton(block), a);
        expect(toast).not.toHaveBeenCalled();
        expect(onEdit).toHaveBeenCalledTimes(1);
        const next = onEdit.mock.calls[0][0] as string;
        expect(next.startsWith('```chart style=json\n')).toBe(true);
        expect(next.trimEnd().endsWith('```')).toBe(true);
        expect(JSON.parse(next.replace('```chart style=json\n', '').trimEnd().replace(/\n`+$/, ''))).toEqual({
            type: 'bar',
            data: { labels: ['Jan', 'Feb'], datasets: [{ label: 'Shop A', data: [12, 19] }] },
            options: { plugins: { title: { display: true, text: 'Tally' } } },
        });
    });

    it('rewrites JSON as a table the same note can read back', () => {
        const note = noteWith(CONFIG_BODY);
        const { block } = blockIn(note);
        const { api: a, onEdit } = api(note);
        press(convertButton(block), a);
        expect(onEdit).toHaveBeenCalledTimes(1);
        const next = onEdit.mock.calls[0][0] as string;
        // The keyword cell re-serializes its configuration, so the compact spelling is what a toggle writes.
        expect(next).toBe(`${'`'.repeat(3)}chart style=table\n| :bar:{"title":"Tally"} | Jan | Feb |\n| --- | --- | --- |\n| Shop A | 12 | 19 |\n${'`'.repeat(3)}\n`);
    });

    it('counts the styling a table cannot carry in the warning it gives', () => {
        const styled = '{"type":"bar","data":{"labels":["A"],"datasets":[{"label":"s","data":[1],"backgroundColor":"#123456","borderWidth":2}]}}';
        const note = noteWith(styled);
        const { block } = blockIn(note);
        const { api: a, onEdit, toast } = api(note);
        press(convertButton(block), a);
        expect(onEdit).toHaveBeenCalledTimes(1);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][0]).toMatchObject({ tone: 'warning' });
        expect(toast.mock.calls[0][0].title).toBe(t('markdown.chart_convert_styled_dropped', { count: 2 }));
    });

    it('refuses a config whose series sit on different axes, and writes nothing', () => {
        const twoAxes = '{"type":"bar","data":{"labels":["A"],"datasets":[{"label":"s","data":[1]},{"label":"t","data":[2],"yAxisID":"y1"}]}}';
        const note = noteWith(twoAxes);
        const { block } = blockIn(note);
        const { api: a, onEdit, toast } = api(note);
        press(convertButton(block), a);
        expect(onEdit).not.toHaveBeenCalled();
        expect(toast.mock.calls[0][0].title).toBe(t('markdown.chart_convert_series_layout'));
    });

    it('refuses while the preview and the note disagree', () => {
        const note = noteWith(TABLE_BODY, 'chart style=table');
        const { block } = blockIn(note);
        const { api: a, onEdit, toast } = api(note, false);
        press(convertButton(block), a);
        expect(onEdit).not.toHaveBeenCalled();
        expect(toast.mock.calls[0][0].title).toBe(t('preview.the_preview_is_updating_try_again_in_a_moment'));
    });

    it('refuses when the line the block was drawn at no longer opens a chart fence', () => {
        const note = noteWith(TABLE_BODY, 'chart style=table');
        const { block } = blockIn(note);
        const { api: a, onEdit, toast } = api('```js\nconst replaced = 1\n```\n');
        press(convertButton(block), a);
        expect(onEdit).not.toHaveBeenCalled();
        expect(toast.mock.calls[0][0].title).toBe(t('preview.chart_block_moved'));
    });

    it('refuses rather than write the fence that happens to sit on the line the block left', () => {
        const note = noteWith(TABLE_BODY, 'chart style=table');
        const { block } = blockIn(note);
        const { api: a, onEdit, toast } = api(`intro\n\n${note}`);
        press(convertButton(block), a);
        expect(onEdit).not.toHaveBeenCalled();
        expect(toast.mock.calls[0][0].title).toBe(t('preview.chart_block_moved'));
    });
});

describe('exporting a chart as an image', () => {
    it('warns rather than downloading a picture that was never drawn', () => {
        const { block } = blockIn(noteWith(CONFIG_BODY));
        const { api: a, toast } = api('');
        press(block.parentElement!.querySelector('[data-chart-action="export-image"]') as HTMLElement, a);
        expect(toast.mock.calls[0][0].title).toBe(t('preview.chart_export_empty'));
    });

    it('hands a drawn canvas to the download', () => {
        const { host, block } = blockIn(noteWith(CONFIG_BODY));
        const canvas = document.createElement('canvas');
        const toBlob = vi.fn((cb: (blob: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })));
        canvas.toBlob = toBlob;
        block.append(canvas);
        const createObjectURL = vi.fn(() => 'blob:stub');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
        press(host.querySelector('[data-chart-action="export-image"]') as HTMLElement, api('').api);
        expect(toBlob).toHaveBeenCalledOnce();
        expect(createObjectURL).toHaveBeenCalledOnce();
        vi.unstubAllGlobals();
    });

    it('says so when the browser gives back no image', () => {
        const { block } = blockIn(noteWith(CONFIG_BODY));
        const canvas = document.createElement('canvas');
        canvas.toBlob = (cb: (blob: Blob | null) => void) => cb(null);
        block.append(canvas);
        const { api: a, toast } = api('');
        press(block.parentElement!.querySelector('[data-chart-action="export-image"]') as HTMLElement, a);
        expect(toast.mock.calls[0][0].title).toBe(t('preview.chart_export_failed'));
    });
});

describe('the block an unrelated click belongs to', () => {
    it('answers false so the preview can keep walking its own branches', () => {
        const { host } = blockIn(noteWith(CONFIG_BODY));
        expect(press(host.querySelector('.chart-block-title')!, api('').api)).toBe(false);
    });

    it('ignores a tool whose block is no longer in the wrapper', () => {
        const { host, block } = blockIn(noteWith(CONFIG_BODY));
        const button = host.querySelector<HTMLElement>('[data-chart-action="toggle-source"]')!;
        block.remove();
        const { onEdit, toast } = api('');
        expect(press(button, api('').api)).toBe(true);
        expect(onEdit).not.toHaveBeenCalled();
        expect(toast).not.toHaveBeenCalled();
    });
});

describe('a body that arrived through the markup rather than a fence', () => {
    it('reads the format off the encoded body even when the note states none', () => {
        const host = document.createElement('div');
        host.innerHTML = `<div class="chart-block" data-line="0" data-chart="${encodeDataValue(TABLE_BODY)}"></div>`;
        enhanceChartBlockToolbars(host, { chart: true });
        const button = host.querySelector<HTMLElement>('[data-chart-action="convert-format"]')!;
        expect(button.textContent).toBe(t('preview.chart_format_json'));
    });
});

describe('the live chart subtree across a preview re-render', () => {
    const FENCE = '`'.repeat(3);

    function staged(note: string): HTMLElement {
        const host = document.createElement('div');
        host.innerHTML = renderMarkdown(note).html;
        enhanceChartBlockToolbars(host, { chart: true });
        return host;
    }

    /** The live host after a chart was drawn, with the drawn canvas and marker the render pass leaves. */
    function drawn(note: string): HTMLElement {
        const host = staged(note);
        const block = host.querySelector<HTMLElement>('[data-chart]')!;
        block.dataset.rendered = 'sig-1';
        block.classList.remove('loading');
        block.classList.add('has-error');
        block.append(document.createElement('canvas'));
        return host;
    }

    it('keeps the drawn subtree of a block whose body did not change', () => {
        const note = `${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}\n`;
        const live = drawn(note);
        patchChildren(live, staged(note));
        const block = live.querySelector<HTMLElement>('[data-chart]')!;
        expect(block.querySelector('canvas')).not.toBeNull();
        expect(block.dataset.rendered).toBe('sig-1');
    });

    // A format toggle changes how many lines a block above occupies, which moves this one. The line is
    // what the toolbar resolves its write against, so a preserved subtree must still take the new line —
    // holding the old one made the next press report a block that had not moved at all.
    it('re-stamps the line a shift moved, even though the block itself is unchanged', () => {
        const second = `${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}`;
        const before = `# T\n\n${FENCE}chart\n{"type":"bar"}\n${FENCE}\n\n${second}\n`;
        const after = `# T\n\n${FENCE}chart style=json\n| :pie: | a |\n| --- | --- |\n| r | 1 |\n${FENCE}\n\n${second}\n`;
        const live = drawn(before);
        const blocks = () => [...live.querySelectorAll<HTMLElement>('[data-chart]')];
        expect(blocks()[1]!.dataset.line).toBe('6');
        expect(staged(after).querySelectorAll<HTMLElement>('[data-chart]')[1]!.dataset.line).toBe('8');
        blocks()[1]!.dataset.rendered = 'sig-1';
        blocks()[1]!.classList.add('has-error');
        blocks()[1]!.append(document.createElement('canvas'));
        patchChildren(live, staged(after));
        const kept = blocks()[1]!;
        expect(kept.dataset.line).toBe('8');
        expect(kept.dataset.rendered).toBe('sig-1');
        expect(kept.querySelector('canvas')).not.toBeNull();
    });

    it('drops the marker when the body changed, so the block draws again', () => {
        const live = drawn(`${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}\n`);
        patchChildren(live, staged(`${FENCE}chart style=table\n| :bar: | other |\n| --- | --- |\n| r | 1 |\n${FENCE}\n`));
        const block = live.querySelector<HTMLElement>('[data-chart]')!;
        expect(block.dataset.rendered).toBeUndefined();
        expect(block.querySelector('canvas')).toBeNull();
    });

    it('drops the marker when only the stated format changed', () => {
        const live = drawn(`${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}\n`);
        patchChildren(live, staged(`${FENCE}chart style=json\n${TABLE_BODY}\n${FENCE}\n`));
        expect(live.querySelector<HTMLElement>('[data-chart]')!.dataset.rendered).toBeUndefined();
    });

    // The note text is identical whether the renderer switch is on or off, so the class is the only thing
    // that says the block must stop being a canvas. Preserving the drawn subtree here left an off switch
    // with the chart still on screen — which no unit test of the switch itself could see.
    // The panel a reader opened lives on the live host, while the markup the next swap diffs against is
    // built fresh and shut. Restoring the state onto the staged copy is what keeps all three of the class,
    // the attribute and the aria state in step — a copy that agreed on the body but not on the open panel
    // would snap it shut under the reader.
    it('keeps an open source panel open across the swap', () => {
        const note = `${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}\n`;
        const live = drawn(note);
        const toggle = live.querySelector<HTMLElement>('[data-chart-action="toggle-source"]')!;
        press(toggle, api(note).api);
        expect(live.querySelector('.chart-block-wrap')!.classList.contains('is-block-source-open')).toBe(true);
        const staging = staged(note);
        applyChartSourceStates(staging, chartSourceStates(live));
        patchChildren(live, staging);
        expect(live.querySelector('.chart-block-wrap')!.classList.contains('is-block-source-open')).toBe(true);
        expect(live.querySelector('[data-chart-source]')!.hasAttribute('hidden')).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('leaves a panel shut when the state map says it was shut', () => {
        const note = `${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}\n`;
        const live = drawn(note);
        const staging = staged(note);
        applyChartSourceStates(staging, chartSourceStates(live));
        expect(staging.querySelector('.chart-block-wrap')!.classList.contains('is-block-source-open')).toBe(false);
        expect(staging.querySelector('[data-chart-source]')!.hasAttribute('hidden')).toBe(true);
    });

    it('replaces a drawn chart with the source view when the renderer switch goes off', () => {
        const note = `${FENCE}chart style=table\n${TABLE_BODY}\n${FENCE}\n`;
        const live = drawn(note);
        const off = staged(note);
        const block = off.querySelector<HTMLElement>('[data-chart]')!;
        block.classList.remove('loading');
        block.classList.add('chart-source');
        block.append(document.createElement('code'));
        patchChildren(live, off);
        const kept = live.querySelector<HTMLElement>('[data-chart]')!;
        expect(kept.querySelector('canvas')).toBeNull();
        expect(kept.classList.contains('chart-source')).toBe(true);
    });
});

describe('the head a chart block is given when charts are switched off', () => {
    function offHead(note: string): HTMLElement {
        const host = document.createElement('div');
        host.innerHTML = renderMarkdown(note).html;
        enhanceChartBlockToolbars(host, { chart: false });
        return host;
    }

    it('keeps the format toggle, which still rewrites the note', () => {
        const host = offHead(`${'`'.repeat(3)}chart style=table\n${TABLE_BODY}\n${'`'.repeat(3)}\n`);
        const buttons = [...host.querySelectorAll<HTMLElement>('[data-chart-action]')].map((b) => b.dataset.chartAction);
        expect(buttons).toEqual(['convert-format']);
    });

    it('shows no source panel, because the block is already showing its body', () => {
        const host = offHead(`${'`'.repeat(3)}chart\n${CONFIG_BODY}\n${'`'.repeat(3)}\n`);
        expect(host.querySelector('[data-chart-source]')).toBeNull();
        expect(host.querySelector('[data-chart-action="export-image"]')).toBeNull();
    });

    it('still writes the other format from that head', () => {
        const note = `${'`'.repeat(3)}chart style=table\n${TABLE_BODY}\n${'`'.repeat(3)}\n`;
        const host = offHead(note);
        const { api: a, onEdit, toast } = api(note);
        press(host.querySelector('[data-chart-action="convert-format"]') as HTMLElement, a);
        expect(toast).not.toHaveBeenCalled();
        expect(onEdit.mock.calls[0][0] as string).toContain('```chart style=json');
    });

    it('brings all three tools back when it is drawn', () => {
        const host = document.createElement('div');
        host.innerHTML = renderMarkdown(`${'`'.repeat(3)}chart\n${CONFIG_BODY}\n${'`'.repeat(3)}\n`).html;
        enhanceChartBlockToolbars(host, { chart: true });
        expect([...host.querySelectorAll('[data-chart-action]')]).toHaveLength(3);
        expect(host.querySelector('[data-chart-source]')).not.toBeNull();
    });
});
