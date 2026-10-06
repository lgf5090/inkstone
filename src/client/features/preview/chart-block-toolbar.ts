/**
 * The toolbar a rendered chart carries, as one block family in the preview's toolbar registry: the
 * format its body is written in, the source behind the picture, and an image export. The format control
 * is the one press that writes to the note, so that write lives here rather than in the drawing layer —
 * and it refuses rather than approximates, because a rewrite that quietly changed what a chart means is
 * worse than no rewrite.
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
import {
    blockActionSource,
    closeBlockOverlayFromEvent,
    dismissBlockOverlays,
    openBlockOverlay,
    setBlockOverlay,
    toggleBlockOverlay,
    type BlockActionContext,
    type BlockOverlaySpec,
    type BlockToast,
    type BlockToolbarModule,
    type BlockToolbarOptions,
} from './block-overlay';

const WRAPPER = '.chart-block-wrap';

const OVERLAY_SPEC: BlockOverlaySpec = {
    block: WRAPPER,
    panels: { source: '[data-chart-source]' },
    triggers: { source: '[data-chart-action="toggle-source"]' },
    openClasses: { source: 'is-block-source-open' },
};

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

function toolButton(action: string, label: string, content: string, expanded?: boolean, variant = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chart-tool-btn${variant}`;
    button.dataset.chartAction = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    // A toggle has to state the position it is in *before* it is first pressed, or a screen reader
    // announces a control whose state nobody can hear.
    if (expanded !== undefined)
        button.setAttribute('aria-expanded', String(expanded));
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
 * `chart` is false when the account has charts switched off: the block is showing its own body, so it
 * gets the format toggle only.
 */
export function enhanceChartBlockToolbars(root: HTMLElement, { chart }: BlockToolbarOptions): void {
    root.querySelectorAll<HTMLElement>('[data-chart]').forEach((block) => {
        if (block.closest('.note-embed-body') || block.parentElement?.classList.contains('chart-block-wrap'))
            return;
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-block-wrap';
        block.replaceWith(wrapper);
        wrapper.append(buildHead(block, chart));
        if (chart)
            wrapper.append(buildSourcePanel(block));
        wrapper.append(block);
    });
}

/**
 * Which blocks have their source showing, keyed by the note line the block was drawn at — the same key
 * the preview's other interaction state is kept under, so a chart added above shifts with the rest.
 */
export function chartSourceStates(root: HTMLElement | null): Map<string, boolean> {
    const states = new Map<string, boolean>();
    root?.querySelectorAll<HTMLElement>(WRAPPER).forEach((wrapper, index) => {
        if (!wrapper.querySelector('[data-chart-source]'))
            return;
        const key = wrapper.querySelector<HTMLElement>('[data-chart]')?.dataset.line ?? String(index);
        states.set(key, openBlockOverlay(OVERLAY_SPEC, wrapper) === 'source');
    });
    return states;
}

export function applyChartSourceStates(root: HTMLElement, states: Map<string, boolean>): void {
    root.querySelectorAll<HTMLElement>(WRAPPER).forEach((wrapper, index) => {
        const panel = wrapper.querySelector<HTMLElement>('[data-chart-source]');
        const line = wrapper.querySelector<HTMLElement>('[data-chart]')?.dataset.line ?? String(index);
        const open = states.get(line);
        if (open === undefined || !panel)
            return;
        setBlockOverlay(OVERLAY_SPEC, wrapper, open ? 'source' : null);
    });
}

function exportPng(block: HTMLElement, toast: BlockToast): void {
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

function declined(toast: BlockToast, messageKey: MessageKey, params?: Record<string, string | number>): boolean {
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
export function convertChartFence(
    line: number,
    source: string,
    onEdit: (next: string) => void,
    toast: BlockToast,
): boolean {
    if (!Number.isInteger(line) || line < 0)
        return declined(toast, 'preview.chart_edit_unavailable');
    const fence = chartFenceAt(source, line);
    if (!fence)
        return declined(toast, 'preview.chart_block_moved');
    const target = otherStyle(detectChartMode(fence.body));
    const converted = convertChartBody(fence.body);
    if (!converted.ok) {
        // The size refusal names the ceiling it hit, because the author's next question is what to cut.
        if (converted.reason === 'too-large')
            return declined(toast, CONVERT_MESSAGES[converted.reason], { limit: CHART_BODY_LIMIT_BYTES / 1024 });
        return declined(toast, CONVERT_MESSAGES[converted.reason]);
    }
    const next = applyChartFencePatch(source, fence, { body: converted.body, style: target });
    if (next === null)
        return declined(toast, 'preview.chart_block_moved');
    onEdit(next);
    // A rewrite that leaves styling behind has changed what the block looks like, even though nothing
    // about the data moved and the accent now paints the series. Say it, rather than let the author find out.
    if (converted.dropped > 0)
        toast({ title: t("markdown.chart_convert_styled_dropped", { count: converted.dropped }), tone: 'warning' });
    return true;
}

/**
 * One press of a chart's own tools. Only the format toggle reaches the note, so only it waits for the
 * preview to settle: a reader who is mid-keystroke can still want the body in front of them, or a picture
 * of the chart that is already on the screen.
 */
export function executeChartBlockAction(button: HTMLElement, ctx: BlockActionContext): boolean {
    const wrapper = button.closest<HTMLElement>(WRAPPER);
    const block = wrapper?.querySelector<HTMLElement>('[data-chart]');
    if (!wrapper || !block)
        return true;
    const action = button.dataset.chartAction;
    if (action === 'toggle-source')
        toggleBlockOverlay(OVERLAY_SPEC, wrapper, 'source');
    else if (action === 'export-image')
        exportPng(block, ctx.api.toast);
    else if (action === 'convert-format') {
        const editable = blockActionSource(ctx);
        if (editable)
            convertChartFence(lineOf(block), editable.source, (next) => ctx.api.editContent(editable.noteId, next), ctx.api.toast);
    }
    return true;
}

export const chartToolbar: BlockToolbarModule = {
    enhance: enhanceChartBlockToolbars,
    dismiss: (target) => dismissBlockOverlays(OVERLAY_SPEC, target),
    close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
    handle: (event, target, ctx) => {
        const button = target.closest<HTMLElement>('[data-chart-action]');
        if (!button)
            return false;
        event.preventDefault();
        return executeChartBlockAction(button, ctx);
    },
};
