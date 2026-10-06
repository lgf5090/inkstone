/**
 * The toolbar a rendered chart carries: the format its body is written in, the source behind the
 * picture, and an image export. The format control is the only block tool in the preview that writes to
 * the note, so the write lives here rather than in the drawing layer — and it refuses rather than
 * approximates, because a rewrite that quietly changed what a chart means is worse than no rewrite.
 */
import { decodeDataValue } from '../../lib/markdown/data-attr';
import {
    applyChartFencePatch,
    CHART_BODY_LIMIT_BYTES,
    chartFenceAt,
    convertChartBody,
    detectChartMode,
    type ChartConvertFailure,
    type DeclaredStyle,
} from '../../lib/markdown/chart';
import { downloadBlob } from '../../lib/export-note';
import { t, type MessageKey } from '../../lib/i18n';

export interface ChartBlockActionApi {
    /** The note's current text, which the block's recorded line is resolved against. */
    content: string
    /** False while the preview and the note disagree, which is when a write would clobber a keystroke. */
    canWrite: boolean
    onEdit: (next: string) => void
    toast: (message: { title: string, tone?: 'success' | 'warning' | 'danger' }) => void
}

/** Why a body will not write the other way, in the words the author needs to act on. */
const CONVERT_MESSAGES: Record<ChartConvertFailure, MessageKey> = {
    'too-large': 'markdown.chart_body_too_large',
    'unknown-kind': 'markdown.chart_kind_unknown',
    'empty-table': 'markdown.chart_table_empty',
    'too-narrow': 'markdown.chart_table_narrow',
    'bad-mapping': 'markdown.chart_mapping_column',
    'invalid-json': 'markdown.chart_convert_invalid_json',
    'table-syntax': 'markdown.chart_convert_table_syntax',
    'not-a-config': 'markdown.chart_convert_not_config',
    lossy: 'markdown.chart_convert_lossy',
    'series-layout': 'markdown.chart_convert_series_layout',
};

const FORMAT_LABELS: Record<DeclaredStyle, MessageKey> = {
    json: 'preview.chart_format_json',
    table: 'preview.chart_format_table',
};

const CONVERT_LABELS: Record<DeclaredStyle, MessageKey> = {
    json: 'preview.chart_convert_to_json',
    table: 'preview.chart_convert_to_table',
};

const ICONS = {
    source: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18l-6-6 6-6M15 6l6 6-6 6"/></svg>',
    export: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
};

function toolButton(action: string, label: string, content: string, pressed?: boolean, variant = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chart-tool-btn${variant}`;
    button.dataset.chartAction = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    // A toggle has to state the position it is in *before* it is first pressed, or a screen reader
    // announces a control whose state nobody can hear.
    if (pressed !== undefined)
        button.setAttribute('aria-pressed', String(pressed));
    if (variant === '--text')
        button.textContent = content;
    else
        button.innerHTML = content;
    return button;
}

/** The body the renderer encoded onto the block, or '' when the markup carries none. */
function blockSource(block: HTMLElement): string {
    return decodeDataValue(block.dataset.chart);
}

/** The format the control switches *to*: the other one, whichever the body is written in. */
function otherStyle(mode: DeclaredStyle): DeclaredStyle {
    return mode === 'table' ? 'json' : 'table';
}

function buildHead(block: HTMLElement, drawn: boolean): HTMLElement {
    const format = detectChartMode(blockSource(block));
    const head = document.createElement('div');
    head.className = 'chart-block-head';
    const title = document.createElement('span');
    title.className = 'chart-block-title';
    title.textContent = t("preview.chart_title");
    const tools = document.createElement('span');
    tools.className = 'chart-block-tools';
    const buttons: HTMLElement[] = [
        toolButton('convert-format', t(CONVERT_LABELS[otherStyle(format)]), t(FORMAT_LABELS[otherStyle(format)]), undefined, '--text'),
    ];
    // With charts switched off the block already shows its own body, so a panel repeating it would be a
    // second copy to disagree with, and there is no canvas left to rasterize. The format toggle stays:
    // it rewrites the note, which is something a reader can still want while the picture is off.
    if (drawn) {
        buttons.push(toolButton('toggle-source', t("preview.chart_show_source"), ICONS.source, false));
        buttons.push(toolButton('export-image', t("preview.chart_export_image"), ICONS.export));
    }
    tools.append(...buttons);
    head.append(title, tools);
    return head;
}

function buildSourcePanel(block: HTMLElement): HTMLElement {
    const panel = document.createElement('pre');
    panel.className = 'chart-block-source';
    panel.dataset.chartSource = '1';
    panel.hidden = true;
    const code = document.createElement('code');
    code.textContent = blockSource(block);
    panel.append(code);
    return panel;
}

/**
 * Wraps every chart block under a root in its head and source panel. Runs on the staged copy, so the
 * head is part of the markup the preview diffs against and a re-render cannot lose it.
 *
 * `drawn` is false when the account has charts switched off: the block is showing its own body, so it
 * gets the format toggle only.
 */
export function enhanceChartBlockToolbars(root: HTMLElement, { drawn = true }: { drawn?: boolean } = {}): void {
    root.querySelectorAll<HTMLElement>('[data-chart]').forEach((block) => {
        if (block.closest('.note-embed-body') || block.parentElement?.classList.contains('chart-block-wrap'))
            return;
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-block-wrap';
        block.replaceWith(wrapper);
        wrapper.append(buildHead(block, drawn));
        if (drawn)
            wrapper.append(buildSourcePanel(block));
        wrapper.append(block);
    });
}

function sourcePanelOf(block: HTMLElement): HTMLElement | null {
    return block.parentElement?.querySelector<HTMLElement>('[data-chart-source]') ?? null;
}

function triggerOf(block: HTMLElement, action: string): HTMLElement | null {
    return block.parentElement?.querySelector<HTMLElement>(`[data-chart-action="${action}"]`) ?? null;
}

export function toggleChartSource(block: HTMLElement): void {
    const panel = sourcePanelOf(block);
    const trigger = triggerOf(block, 'toggle-source');
    if (!panel || !trigger)
        return;
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    trigger.setAttribute('aria-pressed', String(open));
}

/**
 * Which blocks have their source showing, keyed by the note line the block was drawn at — the same key
 * the preview's other interaction state is kept under, so a chart added above shifts with the rest.
 */
export function chartSourceStates(root: HTMLElement | null): Map<string, boolean> {
    const states = new Map<string, boolean>();
    root?.querySelectorAll<HTMLElement>('.chart-block-wrap').forEach((wrapper, index) => {
        const panel = wrapper.querySelector<HTMLElement>('[data-chart-source]');
        if (!panel)
            return;
        const key = wrapper.querySelector<HTMLElement>('[data-chart]')?.dataset.line ?? String(index);
        states.set(key, !panel.hasAttribute('hidden'));
    });
    return states;
}

export function applyChartSourceStates(root: HTMLElement, states: Map<string, boolean>): void {
    root.querySelectorAll<HTMLElement>('.chart-block-wrap').forEach((wrapper, index) => {
        const block = wrapper.querySelector<HTMLElement>('[data-chart]');
        const panel = wrapper.querySelector<HTMLElement>('[data-chart-source]');
        const trigger = wrapper.querySelector<HTMLElement>('[data-chart-action="toggle-source"]');
        if (!block || !panel || !trigger)
            return;
        const open = states.get(block.dataset.line ?? String(index));
        if (open === undefined || open === !panel.hasAttribute('hidden'))
            return;
        panel.toggleAttribute('hidden', !open);
        trigger.setAttribute('aria-pressed', String(open));
    });
}

function exportPng(block: HTMLElement, toast: ChartBlockActionApi['toast']): void {
    const canvas = block.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas) {
        toast({ title: t("preview.chart_export_empty"), tone: 'warning' });
        return;
    }
    canvas.toBlob((blob) => {
        if (!blob) {
            toast({ title: t("preview.chart_export_failed"), tone: 'warning' });
            return;
        }
        downloadBlob('inkstone-chart.png', blob);
    }, 'image/png');
}

function declined(toast: ChartBlockActionApi['toast'], messageKey: MessageKey, params?: Record<string, string | number>): boolean {
    toast({ title: params === undefined ? t(messageKey) : t(messageKey, params), tone: 'warning' });
    return true;
}

/** The line a rendered block claims to sit on, or NaN when its markup carries none. */
function lineOf(block: HTMLElement): number {
    return Number(block.dataset.line);
}

/**
 * Rewrites the fence as the other format. The block was drawn from the body the renderer encoded, so
 * that is what the fence is looked up by: when the note no longer holds it, nothing is written, in either
 * direction of the mistake.
 */
export function convertChartFence(line: number, api: ChartBlockActionApi): boolean {
    if (!Number.isInteger(line) || line < 0)
        return declined(api.toast, 'preview.chart_edit_unavailable');
    if (!api.canWrite)
        return declined(api.toast, 'preview.the_preview_is_updating_try_again_in_a_moment');
    const fence = chartFenceAt(api.content, line);
    if (!fence)
        return declined(api.toast, 'preview.chart_block_moved');
    const target = otherStyle(detectChartMode(fence.body));
    const converted = convertChartBody(fence.body);
    if (!converted.ok) {
        // The size refusal names the ceiling it hit, because the author's next question is what to cut.
        if (converted.reason === 'too-large')
            return declined(api.toast, CONVERT_MESSAGES[converted.reason], { limit: CHART_BODY_LIMIT_BYTES / 1024 });
        return declined(api.toast, CONVERT_MESSAGES[converted.reason]);
    }
    const next = applyChartFencePatch(api.content, fence, { body: converted.body, style: target });
    if (next === null)
        return declined(api.toast, 'preview.chart_block_moved');
    api.onEdit(next);
    // A rewrite that leaves styling behind has changed what the block looks like, even though nothing
    // about the data moved and the accent now paints the series. Say it, rather than let the author find out.
    if (converted.dropped > 0)
        api.toast({ title: t("markdown.chart_convert_styled_dropped", { count: converted.dropped }), tone: 'warning' });
    return true;
}

/** Returns false when the click belonged to no chart tool, so the caller can keep walking its branches. */
export function handleChartBlockAction(target: HTMLElement, api: ChartBlockActionApi): boolean {
    const button = target.closest<HTMLElement>('[data-chart-action]');
    if (!button)
        return false;
    const block = button.closest<HTMLElement>('.chart-block-wrap')?.querySelector<HTMLElement>('[data-chart]');
    if (!block)
        return true;
    const action = button.dataset.chartAction;
    if (action === 'toggle-source')
        toggleChartSource(block);
    else if (action === 'export-image')
        exportPng(block, api.toast);
    else if (action === 'convert-format')
        convertChartFence(lineOf(block), api);
    else
        return true;
    return true;
}
