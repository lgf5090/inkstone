import DOMPurify from 'dompurify';
import { PURIFY_CONFIG } from './renderer';
import { decodeDataValue } from './data-attr';
import { exampleSplitTracks, isVerticalExampleLayout, parseExampleRatio } from './example-split';
// The two kanban entry points come from their own modules, not from `./kanban`: the index re-exports
// the React board, and a surface that only draws a still must not pull 24k lines of UI into its chunk.
import { renderStaticKanbans, type KanbanSnapshotShape } from './kanban/static';
import { showKanbanSourceAll } from './kanban/view';
import { MAX_PANEL_COLUMNS, isTrackValue } from './panel-options';
import { t, type MessageKey } from "../i18n";
import { getLocale } from "../i18n";
import { renderStaticMindmaps } from './mindmap/static';
import { showMindmapSourceAll } from './mindmap/view';
import { highlightWithPrism } from './prism';
import {
    ChartBodyTooLargeError,
    ChartConfigError,
    ChartTableError,
    CHART_SLICE_KINDS,
    CHART_TABLE_MESSAGES,
    chartPalette,
    chartPaletteKey,
    parseStyleValue,
    readChartBody,
    styleSignature,
    type ChartConfigReason,
    type StyleRead,
} from './chart';

const OPTIONAL_RENDERER_LOAD_TIMEOUT_MS = 15000;

function directElementChild(parent: HTMLElement, tagName: string): HTMLElement | null {
    for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
        if (node.tagName === tagName)
            return node as HTMLElement;
    }
    return null;
}

const GEOMETRY_MAX = 4000;

function geometryPx(raw: string | undefined, fallback: number): number {
    const parsed = Number((raw ?? '').trim());
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.min(GEOMETRY_MAX, Math.round(parsed));
}

function geometryPercent(raw: string | undefined): number {
    const parsed = Number((raw ?? '').trim().replace('%', ''));
    if (!Number.isFinite(parsed))
        return 0;
    return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * The prose whitelist strips inline styles, so the geometry a reader configured arrives as data
 * attributes and is painted here. An export keeps the stylesheet defaults instead.
 */
export function applyPropertyGeometry(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-pp-cover-width]').forEach((node) => {
        node.style.setProperty('--pp-cover-width', `${geometryPx(node.dataset.ppCoverWidth, 200)}px`);
    });
    root.querySelectorAll<HTMLElement>('[data-pp-banner-height]').forEach((node) => {
        node.style.height = `${geometryPx(node.dataset.ppBannerHeight, 150)}px`;
        const position = node.dataset.ppBannerPosition;
        const image = node.querySelector<HTMLElement>('.pp-banner-image');
        if (position !== undefined && image)
            image.style.objectPosition = `center ${geometryPercent(position)}%`;
    });
    root.querySelectorAll<HTMLElement>('[data-pp-icon-size]').forEach((node) => {
        node.style.setProperty('--pp-icon-size', `${geometryPx(node.dataset.ppIconSize, 64)}px`);
    });
    root.querySelectorAll<HTMLElement>('[data-pp-percent]').forEach((node) => {
        node.style.setProperty('--pp-percent', `${geometryPercent(node.dataset.ppPercent)}%`);
    });
}

export function decorateCodeBlock(block: HTMLElement): void {
    const pre = block.querySelector<HTMLElement>('pre');
    const code = pre?.querySelector<HTMLElement>('code');
    if (!pre || !code)
        return;
    let lines = [...code.querySelectorAll<HTMLElement>(':scope > .line')];
    if (!lines.length) {
        const values = splitNodesAtNewlines([...code.childNodes]);
        if ((code.textContent ?? '').endsWith('\n'))
            values.pop();
        code.replaceChildren();
        values.forEach((value, index) => {
            const line = document.createElement('span');
            line.className = 'line';
            line.append(...value);
            if (!line.textContent)
                line.textContent = ' ';
            code.append(line);
            if (index < values.length - 1)
                code.append('\n');
        });
        lines = [...code.querySelectorAll<HTMLElement>(':scope > .line')];
    }
    const start = Math.max(1, Number(block.dataset.codeStart) || 1);
    const highlighted = new Set((block.dataset.highlightLines ?? '')
        .split(',')
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0));
    const numbered = block.dataset.lineNumbers === 'true';
    block.classList.toggle('has-line-numbers', numbered);
    decoratedLineCounts.set(block, lines.length);
    lines.forEach((line, index) => {
        line.dataset.lineNumber = String(start + index);
        line.classList.toggle('highlighted', highlighted.has(index + 1));
    });
}

function splitNodesAtNewlines(nodes: Node[]): Node[][] {
    const lines: Node[][] = [[]];
    for (const node of nodes) {
        const parts = splitNodeAtNewlines(node);
        lines[lines.length - 1]!.push(...parts[0]!);
        for (let index = 1; index < parts.length; index++)
            lines.push(parts[index]!);
    }
    return lines;
}

function splitNodeAtNewlines(node: Node): Node[][] {
    if (node.nodeType === Node.TEXT_NODE)
        return (node.textContent ?? '').split('\n').map((text) => [document.createTextNode(text)]);
    if (!(node instanceof HTMLElement))
        return [[node.cloneNode(true)]];
    return splitNodesAtNewlines([...node.childNodes]).map((children) => {
        const clone = node.cloneNode(false) as HTMLElement;
        clone.append(...children);
        return [clone];
    });
}

const codeHighlightCache = new Map<string, { html: string; language: string } | null>();
const decoratedLineCounts = new WeakMap<HTMLElement, number>();

/**
 * The split ratio is a runtime number and the prose whitelist strips inline styles, so the grid's
 * tracks are handed to CSS as custom properties instead. A column split can be a real track list —
 * the prose column has a definite width, so `45fr 55fr` divides exactly what it says.
 *
 * A row split cannot. The block's height is whatever its two panels' content needs, so dividing
 * that sum proportionally always inflates the shorter panel: a five-line source beside a thirty-line
 * output at 6:4 measured 800px of empty panel. Rows therefore get the ratio as a ceiling on each
 * panel (`--ex-a` / `--ex-b`), which shrinks a generous pane into its own scrollbox and never adds
 * a pixel of blank. One axis is written and the other cleared, so a block that switches between a
 * row split and a column split cannot keep reading the stale one.
 */
export function applyExampleSplits(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.markdown-example-grid[data-example-layout]').forEach((grid) => {
        const ratio = parseExampleRatio(grid.dataset.exampleRatio ?? '');
        if (!ratio)
            return;
        grid.style.removeProperty('--ex-cols');
        grid.style.removeProperty('--ex-rows');
        grid.style.removeProperty('--ex-a');
        grid.style.removeProperty('--ex-b');
        if (isVerticalExampleLayout(grid.dataset.exampleLayout ?? '')) {
            grid.style.setProperty('--ex-a', String(ratio[0]));
            grid.style.setProperty('--ex-b', String(ratio[1]));
        }
        else {
            // `rl` moves the first panel to the right with `order`, and grid auto-placement follows
            // that order, so the track list has to be reversed to keep the ratio naming the two
            // panels of the pair rather than the left and right halves of the block.
            const reversed = grid.dataset.exampleLayout === 'rl';
            grid.style.setProperty('--ex-cols', exampleSplitTracks(reversed ? [ratio[1], ratio[0]] : ratio));
        }
    });
}

/**
 * Column track sizes are the one thing a header states that CSS cannot read out of an attribute:
 * `attr()` does not work for grid tracks, and the prose whitelist strips inline styles from rendered
 * markup. So the header writes a `data-cols-tracks` value and this runs after sanitization to hand it
 * to the stylesheet as a custom property — the same route the example split takes for its ratio.
 *
 * The value is re-checked here rather than trusted from the renderer, because this is the one place it
 * becomes a CSS declaration.
 */
export function applyPanelColumnTracks(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.markdown-cols[data-cols-tracks]').forEach((grid) => {
        const tracks = (grid.dataset.colsTracks ?? '').trim().split(/\s+/);
        // Re-checked rather than trusted from the renderer: one track describes no grid, and a list
        // longer than the stylesheet draws tracks for would leave columns without one.
        if (tracks.length < 2 || tracks.length > MAX_PANEL_COLUMNS)
            return;
        if (!tracks.every((track) => isTrackValue(track)))
            return;
        grid.style.setProperty('--panel-cols-tracks', tracks.join(' '));
    });
}

async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
    await Promise.all([...root.querySelectorAll<HTMLElement>('.code-block')].map(async (block) => {
        const pre = directElementChild(block, 'PRE');
        const code = pre ? directElementChild(pre, 'CODE') : null;
        if (!code)
            return;
        const source = (code.textContent ?? '').replace(/\n$/, '');
        const lang = block.dataset.lang ?? '';
        const key = `${lang}\u0000${source}`;
        let highlighted = codeHighlightCache.get(key);
        if (highlighted === undefined) {
            try {
                highlighted = await highlightWithPrism(source, lang);
                if (codeHighlightCache.size >= 250) {
                    const first = codeHighlightCache.keys().next().value;
                    if (first) codeHighlightCache.delete(first);
                }
                codeHighlightCache.set(key, highlighted);
            }
            catch (err) {
                code.textContent = source;
                console.warn(t("markdown.inkstone_code_highlighting_failed_showing_plain_text"), err);
                decorateCodeBlock(block);
                return;
            }
        }
        if (highlighted) {
            code.innerHTML = highlighted.html;
            code.classList.add(`language-${highlighted.language}`);
        }
        else {
            code.textContent = source;
        }
        decorateCodeBlock(block);
    }));
}
let generatedCodeBlockId = 0;

/**
 * How many lines this block folds beyond: its own `collapse=` when it wrote one (0 meaning it never
 * folds), otherwise the preview's setting. A block states its own preference because the note is
 * what a reader shares, while the setting is only this account's default.
 */
function blockCollapseThreshold(block: HTMLElement, fallback: number): number {
    const own = block.dataset.codeCollapseAt;
    if (own === undefined || own === '')
        return fallback;
    const value = Number(own);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function configureCodeBlockCollapsing(root: HTMLElement, collapseLines: number): void {
    const fallback = Number.isInteger(collapseLines) && collapseLines >= 8 ? collapseLines : 0;
    root.querySelectorAll<HTMLElement>('.code-block:not(.markdown-example-code)').forEach((block) => {
        const threshold = blockCollapseThreshold(block, fallback);
        const button = block.querySelector<HTMLButtonElement>('[data-code-collapse]');
        const pre = directElementChild(block, 'PRE');
        const known = decoratedLineCounts.get(block);
        const lineCount = known === undefined ? block.querySelectorAll<HTMLElement>(':scope pre code > .line').length : known;
        const wasExpanded = block.classList.contains('is-code-expanded');
        block.classList.remove('is-code-collapsed', 'is-code-expanded');
        delete block.dataset.codeCollapseLines;
        delete block.dataset.codeLineCount;
        delete block.dataset.codeCollapseMaxHeight;
        if (pre)
            pre.style.maxHeight = '';
        button?.remove();
        if (!threshold || lineCount <= threshold)
            return;
        const head = block.querySelector<HTMLElement>(':scope > .code-block-head');
        if (!head)
            return;
        block.dataset.codeCollapseLines = String(threshold);
        block.dataset.codeLineCount = String(lineCount);
        block.classList.add(wasExpanded ? 'is-code-expanded' : 'is-code-collapsed');
        const maxHeight = `${threshold * 1.56 + 1.5}em`;
        block.dataset.codeCollapseMaxHeight = maxHeight;
        if (pre)
            pre.style.maxHeight = wasExpanded ? '' : maxHeight;
        const codeId = pre?.id || `ink-code-${++generatedCodeBlockId}`;
        if (pre)
            pre.id = codeId;
        const toggle = document.createElement('button');
        toggle.className = 'code-collapse';
        toggle.type = 'button';
        toggle.dataset.codeCollapse = '1';
        toggle.setAttribute('aria-controls', codeId);
        toggle.setAttribute('aria-expanded', String(wasExpanded));
        toggle.textContent = wasExpanded
            ? t('markdown.collapse_code')
            : t('markdown.show_more_code', { count: lineCount - threshold });
        head.insertBefore(toggle, head.querySelector('[data-copy]'));
    });
}
export function toggleCodeBlockCollapse(button: HTMLButtonElement): void {
    const block = button.closest<HTMLElement>('.code-block');
    if (!block)
        return;
    const expanded = block.classList.toggle('is-code-expanded');
    block.classList.toggle('is-code-collapsed', !expanded);
    const pre = block.querySelector<HTMLElement>(':scope > pre');
    if (pre)
        pre.style.maxHeight = expanded ? '' : block.dataset.codeCollapseMaxHeight ?? '';
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded
        ? t('markdown.collapse_code')
        : t('markdown.show_more_code', {
            count: Math.max(0, Number(block.dataset.codeLineCount) - Number(block.dataset.codeCollapseLines)),
        });
}
interface KatexLike {
    renderToString: (tex: string, options?: Record<string, unknown>) => string;
}
let katexPromise: Promise<KatexLike> | null = null;
const mathCache = new Map<string, string>();
async function getKatex(): Promise<KatexLike | null> {
    if (!katexPromise) {
        const loading = withTimeout((async () => {
            const mod = await import('../katex-loader')
            const katex = (mod.default ?? mod) as unknown as KatexLike
            return katex
        })(), OPTIONAL_RENDERER_LOAD_TIMEOUT_MS, t("markdown.math_rendering_timed_out_while_loading"));
        katexPromise = loading;
        void loading.catch((err) => {
            if (katexPromise === loading)
                katexPromise = null;
            console.warn(t("markdown.inkstone_math_rendering_failed_to_load"), err);
        });
    }
    try {
        return await katexPromise;
    }
    catch {
        return null;
    }
}
export async function renderMath(root: HTMLElement | Document): Promise<void> {
    const pending = [...root.querySelectorAll<HTMLElement>('[data-math]')]
        .filter((node) => !node.dataset.rendered)
        .map((node) => {
        const source = decodeDataValue(node.dataset.math);
        const display = node.classList.contains('math-block');
        return { node, source, display, key: `${display ? 'block' : 'inline'}\u0000${source}` };
    });
    for (let index = pending.length - 1; index >= 0; index--) {
        const item = pending[index]!;
        const cached = mathCache.get(item.key);
        if (!cached)
            continue;
        item.node.innerHTML = cached;
        item.node.classList.remove('math-source');
        item.node.dataset.rendered = '1';
        pending.splice(index, 1);
    }
    if (!pending.length)
        return;
    const katex = await getKatex();
    if (!katex) {
        pending.forEach(({ node, source, display }) => showMathSource(node, source, display));
        return;
    }
    for (const { node, source, display, key } of pending) {
        try {
            const html = DOMPurify.sanitize(katex.renderToString(source, {
                displayMode: display,
                throwOnError: false,
                errorColor: 'var(--danger)',
                strict: false,
                trust: false,
                output: 'html',
            }));
            remember(mathCache, key, html, 160);
            node.innerHTML = html;
            node.classList.remove('math-source');
            node.dataset.rendered = '1';
        }
        catch (err) {
            node.innerHTML = `<code class="math-error">${escapeHtml(source)}</code>`;
            node.dataset.rendered = '1';
            void err;
        }
    }
}
function showMathSource(root: HTMLElement): void;
function showMathSource(node: HTMLElement, source: string, display: boolean): void;
function showMathSource(target: HTMLElement, source?: string, display?: boolean): void {
    if (source === undefined) {
        target.querySelectorAll<HTMLElement>('[data-math]').forEach((node) => {
            showMathSource(node, decodeDataValue(node.dataset.math), node.classList.contains('math-block'));
        });
        return;
    }
    delete target.dataset.rendered;
    target.classList.add('math-source');
    target.textContent = display ? `$$\n${source}\n$$` : `$${source}$`;
}
type MermaidApi = typeof import('mermaid').default;
type MermaidTheme = 'dark' | 'default';
const MERMAID_LOAD_TIMEOUT_MS = 15000;
const MERMAID_RENDER_TIMEOUT_MS = 10000;
const MERMAID_CANCELLED = Symbol('mermaid-cancelled');
let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidTheme: 'dark' | 'default' | null = null;
let mermaidSeq = 0;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
const mermaidCache = new Map<string, string>();
async function getMermaid(): Promise<MermaidApi> {
    if (!mermaidPromise) {
        const loading = withTimeout(import('mermaid').then((mod) => mod.default), MERMAID_LOAD_TIMEOUT_MS, t("markdown.diagram_rendering_timed_out_while_loading"));
        mermaidPromise = loading;
        void loading.catch((err) => {
            if (mermaidPromise === loading)
                mermaidPromise = null;
            console.warn(t("markdown.inkstone_diagram_rendering_failed_to_load"), err);
        });
    }
    return mermaidPromise;
}
function initializeMermaid(mermaid: MermaidApi, theme: MermaidTheme): void {
    if (mermaidTheme !== theme) {
        mermaidTheme = theme;
        mermaid.initialize({
            startOnLoad: false,
            theme,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() ||
                'system-ui, sans-serif',
            themeVariables: {
                fontSize: '13px',
                background: 'transparent',
            },
        });
    }
}
function createMermaidRenderHost(): HTMLDivElement {
    const host = document.createElement('div');
    host.dataset.mermaidRenderHost = '1';
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        visibility: 'hidden',
        pointerEvents: 'none',
        zIndex: '-1',
    });
    document.body.append(host);
    return host;
}
function mermaidKey(source: string, dark: boolean): string {
    return `${dark ? 'dark' : 'light'}\u0000${source}`;
}
function hydrateCachedMermaid(root: HTMLElement, dark: boolean): void {
    root.querySelectorAll<HTMLElement>('[data-mermaid]').forEach((node) => {
        if (node.dataset.rendered === currentSignature(node, dark))
            return;
        const cached = mermaidCache.get(mermaidKey(mermaidSource(node), dark));
        if (cached)
            applyMermaidSvg(node, cached, dark);
    });
}
function showMermaidSource(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-mermaid]').forEach((node) => {
        node.classList.remove('loading');
        node.classList.add('mermaid-source');
        node.removeAttribute('aria-busy');
        const code = document.createElement('code');
        code.textContent = mermaidSource(node);
        node.replaceChildren(code);
    });
}
export interface MermaidRenderHooks<T = unknown> {
    isCurrent?: () => boolean;
    beforeUpdate?: () => T;
    afterUpdate?: (snapshot: T) => void;
}
export async function renderPendingMermaid<T = unknown>(root: HTMLElement | Document, dark: boolean, hooks: MermaidRenderHooks<T> = {}): Promise<void> {
    const isCurrent = () => hooks.isCurrent?.() !== false;
    const pending = [...root.querySelectorAll<HTMLElement>('[data-mermaid]')]
        .filter((node) => node.dataset.rendered !== currentSignature(node, dark))
        .map((node) => {
        const source = mermaidSource(node);
        return { node, source, key: mermaidKey(source, dark) };
    });
    for (const { node, source, key } of pending) {
        if (!isCurrent())
            return;
        try {
            const svg = await queueMermaidRender(key, source, dark, () => {
                return (isCurrent() &&
                    root.contains(node) &&
                    mermaidSource(node) === source &&
                    node.dataset.rendered !== currentSignature(node, dark));
            });
            if (!isCurrent() ||
                !root.contains(node) ||
                mermaidSource(node) !== source ||
                node.dataset.rendered === currentSignature(node, dark)) {
                continue;
            }
            updateMermaidNode(hooks, () => applyMermaidSvg(node, svg, dark));
        }
        catch (err) {
            if (err === MERMAID_CANCELLED || !isCurrent() || !root.contains(node))
                return;
            if (mermaidSource(node) !== source)
                continue;
            updateMermaidNode(hooks, () => showMermaidError(node, err, source));
        }
    }
}
// Layered on the shared config so its forbidden tag and attribute lists keep applying.
// style is the only exception: mermaid paints SVG with inline styles and CSS blocks,
// and DOMPurify sanitises the declarations themselves.
const MERMAID_SVG_PURIFY_CONFIG = {
    ...PURIFY_CONFIG,
    ADD_TAGS: [...PURIFY_CONFIG.ADD_TAGS, 'foreignObject', 'use'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: PURIFY_CONFIG.FORBID_TAGS.filter((tag) => tag !== 'style'),
    FORBID_ATTR: PURIFY_CONFIG.FORBID_ATTR.filter((attr) => attr !== 'style'),
};
function queueMermaidRender(key: string, source: string, dark: boolean, isCurrent: () => boolean): Promise<string> {
    const task = mermaidRenderQueue.then(async () => {
        const cached = mermaidCache.get(key);
        if (cached)
            return cached;
        if (!isCurrent())
            throw MERMAID_CANCELLED;
        const mermaid = await getMermaid();
        if (!isCurrent())
            throw MERMAID_CANCELLED;
        initializeMermaid(mermaid, dark ? 'dark' : 'default');
        const renderHost = createMermaidRenderHost();
        try {
            const { svg } = await withTimeout(mermaid.render(`ink-mermaid-${++mermaidSeq}`, source, renderHost), MERMAID_RENDER_TIMEOUT_MS, t("markdown.diagram_rendering_timed_out_check_the_diagram_or_try_again_later"));
            const sanitized = DOMPurify.sanitize(svg, MERMAID_SVG_PURIFY_CONFIG);
            remember(mermaidCache, key, sanitized, 60);
            return sanitized;
        }
        finally {
            renderHost.remove();
        }
    });
    mermaidRenderQueue = task.then(() => undefined, () => undefined);
    return task;
}
function applyMermaidSvg(node: HTMLElement, svg: string, dark: boolean): void {
    node.innerHTML = svg;
    node.classList.remove('loading', 'mermaid-source', 'has-error');
    node.setAttribute('aria-busy', 'false');
    node.dataset.rendered = currentSignature(node, dark);
}
function showMermaidError(node: HTMLElement, err: unknown, source: string): void {
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-error';
    const message = document.createElement('span');
    message.className = 'mermaid-error-message';
    const detail = err instanceof Error ? err.message : String(err);
    message.textContent = detail.slice(0, 500);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mermaid-retry';
    retry.dataset.mermaidRetry = '1';
    retry.textContent = t("common.retry");
    const code = document.createElement('code');
    code.textContent = source;
    wrap.append(message, retry, code);
    node.replaceChildren(wrap);
    node.classList.remove('loading', 'mermaid-source');
    node.classList.add('has-error');
    node.setAttribute('aria-busy', 'false');
    delete node.dataset.rendered;
}
export function resetMermaidNode(node: HTMLElement): void {
    delete node.dataset.rendered;
    node.classList.remove('has-error', 'mermaid-source');
    node.classList.add('loading');
    node.setAttribute('aria-busy', 'true');
    node.textContent = t("markdown.redrawing_chart");
}
function updateMermaidNode<T>(hooks: MermaidRenderHooks<T>, update: () => void): void {
    if (!hooks.beforeUpdate) {
        update();
        return;
    }
    const snapshot = hooks.beforeUpdate();
    update();
    hooks.afterUpdate?.(snapshot);
}
function currentSignature(node: HTMLElement, dark: boolean): string {
    const source = mermaidSource(node);
    return `${dark ? 'd' : 'l'}:${source.length}:${shortHash(source)}`;
}
function mermaidSource(node: HTMLElement): string {
    return decodeDataValue(node.dataset.mermaid);
}

/**
 * Chart.js blocks. A chart is the one block whose rendered form is not markup: the picture is pixels on
 * a canvas plus a live instance, and neither survives being serialized or cloned. Everything below follows
 * from that — the instance is kept on the node, the signature check refuses to trust the marker attribute
 * on its own, and a block leaving the document has its instance destroyed by hand.
 */
interface ChartInstance {
    destroy: () => void
    resize: (width: number, height: number) => void
}

interface ChartHolder extends HTMLElement {
    __chartInstance?: ChartInstance
    __chartObserver?: ResizeObserver
}

/** The axis and legend greys, held here because chart.js paints text from a colour string, not from CSS. */
const CHARTJS_TEXT_COLORS = { dark: '#94a3b8', light: '#64748b' } as const;

/**
 * The box a chart gets when its container has no layout to measure — an exported note is parsed into a
 * detached document, where every client box reads 0. chart.js's own default is 300×150, which is too
 * small to read a printed chart, so the block asks for the box it would have had in the page.
 */
const CHART_UNMEASURED = { width: 640, height: 360 };

/** Why a body means no chart this fence can draw, in the words the author can act on. */
const CHART_CONFIG_MESSAGES: Record<ChartConfigReason, MessageKey> = {
    'unknown-kind': 'markdown.chart_kind_unknown',
    'empty-table': 'markdown.chart_table_empty',
    'too-narrow': 'markdown.chart_table_narrow',
    'bad-mapping': 'markdown.chart_mapping_column',
};

let chartJsPromise: Promise<typeof import('chart.js/auto')> | null = null;

async function getChartJs(): Promise<typeof import('chart.js/auto')> {
    if (!chartJsPromise) {
        const loading = withTimeout(import('chart.js/auto'), OPTIONAL_RENDERER_LOAD_TIMEOUT_MS, t("markdown.diagram_rendering_timed_out_while_loading"));
        chartJsPromise = loading;
        void loading.catch((err) => {
            // A failed chunk load must not be cached: one offline moment would leave every chart in
            // every note drawing an error for the rest of the session.
            if (chartJsPromise === loading)
                chartJsPromise = null;
            console.warn(t("markdown.chart_rendering_failed"), err);
        });
    }
    return chartJsPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every chart this module has drawn and not let go of. A block deleted from the note leaves no trace in
 * the document for a later pass to find, so the registry is how an instance and its ResizeObserver get
 * collected before the host itself is thrown away.
 */
const liveCharts = new Set<ChartHolder>();

function destroyChartInstance(node: HTMLElement): void {
    const holder = node as ChartHolder;
    liveCharts.delete(holder);
    holder.__chartObserver?.disconnect();
    delete holder.__chartObserver;
    const existing = holder.__chartInstance;
    if (existing) {
        existing.destroy();
        delete holder.__chartInstance;
    }
}

/** Lets go of any chart whose block has left the document. */
function pruneDetachedCharts(): void {
    for (const node of [...liveCharts]) {
        if (!node.isConnected)
            destroyChartInstance(node);
    }
}

/** Tears every chart under a root down. The preview calls it when a host is thrown away, since a removed
 * node never runs its own teardown and both the instance and its observer would outlive the note. */
export function destroyChartInstances(root: HTMLElement | null): void {
    root?.querySelectorAll<HTMLElement>('[data-chart]').forEach((node) => {
        destroyChartInstance(node);
    });
}

function chartErrorMessage(err: unknown): string {
    if (err instanceof ChartBodyTooLargeError)
        return t("markdown.chart_body_too_large", { limit: err.limitKb });
    if (err instanceof ChartConfigError)
        return t(CHART_CONFIG_MESSAGES[err.reason]);
    if (err instanceof ChartTableError)
        return t(CHART_TABLE_MESSAGES[err.reason]);
    // The only thing in this path that parses JSON is the config reader, so a SyntaxError here is the
    // body not being readable — and the engine's own sentence about it is one the note's language has.
    if (err instanceof SyntaxError)
        return t("markdown.chart_convert_invalid_json");
    return err instanceof Error ? err.message : String(err);
}

/** Built from nodes rather than a markup string: the failing body is the author's own text and goes in
 * verbatim, so it must never be re-parsed as HTML on its way back out. */
function markChartError(node: HTMLElement, message: string, raw: string, signature: string): void {
    destroyChartInstance(node);
    node.classList.remove('loading');
    node.classList.add('has-error');
    node.removeAttribute('aria-busy');
    const wrap = document.createElement('div');
    wrap.className = 'chart-error';
    const banner = document.createElement('span');
    banner.className = 'chart-error-message';
    banner.textContent = `${t("markdown.chart_rendering_failed")}: ${message}`;
    const code = document.createElement('code');
    code.textContent = raw;
    wrap.append(banner, code);
    node.replaceChildren(wrap);
    node.dataset.rendered = signature;
}

// Re-applies the app's axis colors under the user's own ticks/grid objects.
function themedScales(userScales: Record<string, unknown>, textColor: string, gridColor: string): Record<string, unknown> {
    const scales: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(userScales)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const scaleObj = val as Record<string, unknown>;
            scales[key] = {
                ...scaleObj,
                ticks: { color: textColor, ...(scaleObj.ticks as object || {}) },
                grid: { color: gridColor, ...(scaleObj.grid as object || {}) },
            };
        }
    }
    return scales;
}

/**
 * Colours the series the note left uncoloured. chart.js's own default palette is a rainbow nobody chose
 * for this page, so an unstyled dataset takes the accent ramp instead — but a note that named its own
 * colours keeps them, because that is a statement about the data, not an omission.
 *
 * A slice chart is the exception that inverts the rule: it has *one* dataset whose categories are the
 * rows, so a colour per dataset paints every slice identically and a pie of 35/20/15 becomes a disc.
 * There the palette is handed over one entry per slice, which is what chart.js reads for arc fills.
 * `borderColor` is deliberately left alone there, so the arcs keep the library's own hairline between
 * them — matching the border to the fill would weld the slices into one shape again.
 */
function themedDatasets(datasets: unknown, palette: string[], type: string): unknown {
    if (!Array.isArray(datasets))
        return datasets;
    const sliced = CHART_SLICE_KINDS.includes(type);
    return datasets.map((raw, index) => {
        if (!isRecord(raw))
            return raw;
        const next: Record<string, unknown> = { ...raw };
        if (sliced) {
            if (next.backgroundColor === undefined)
                next.backgroundColor = Array.from({ length: Math.max(Array.isArray(raw.data) ? raw.data.length : 1, 1) },
                    (_, point) => palette[point % palette.length]);
            return next;
        }
        const colour = palette[index % palette.length];
        if (next.backgroundColor === undefined)
            next.backgroundColor = colour;
        if (next.borderColor === undefined)
            next.borderColor = colour;
        return next;
    });
}

function chartThemeColors(dark: boolean): { text: string, grid: string } {
    return {
        text: CHARTJS_TEXT_COLORS[dark ? 'dark' : 'light'],
        grid: dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
    };
}

function buildChartConfig(config: Record<string, unknown>, dark: boolean, instant: boolean): Record<string, unknown> {
    const { text, grid } = chartThemeColors(dark);
    const palette = chartPalette(dark);
    const data = isRecord(config.data) ? config.data : null;
    const userOptions = isRecord(config.options) ? config.options : {};
    const userScales = isRecord(userOptions.scales) ? userOptions.scales : {};
    const userPlugins = isRecord(userOptions.plugins) ? userOptions.plugins : {};
    const scales = themedScales(userScales, text, grid);
    const options: Record<string, unknown> = {
        maintainAspectRatio: false,
        color: text,
        ...userOptions,
        ...(Object.keys(scales).length > 0 ? { scales } : {}),
        plugins: {
            legend: { labels: { color: text } },
            ...userPlugins,
        },
        // The size is handed in below, so the library must not measure the box again — and it has to
        // lose the note's own `responsive`, because a responsive chart re-measures a transform-scaled or
        // un-laid-out container and draws at the wrong size.
        responsive: false,
        devicePixelRatio: window.devicePixelRatio,
    };
    // A surface that reads the canvas instead of a pair of eyes — the exported note — draws with no
    // entrance animation: chart.js animates towards its data, so a canvas sampled while an animation runs
    // is blank or partial.
    if (instant)
        options.animation = false;
    const next: Record<string, unknown> = { ...config, options };
    if (data)
        next.data = { ...data, datasets: themedDatasets(data.datasets, palette, String(config.type ?? '')) };
    return next;
}

/** The size to draw at: the container's own box when it has one, and the printed-chart box when not. */
function chartSize(container: HTMLElement): { width: number, height: number } {
    const width = Math.round(container.clientWidth);
    const height = Math.round(container.clientHeight);
    return width > 0 && height > 0 ? { width, height } : CHART_UNMEASURED;
}

// A layout change (a narrower window, the sidebar opening) resizes the container, and with `responsive`
// off nothing else would notice, so the canvas would keep a size its box no longer has.
function watchChartSize(node: HTMLElement, container: HTMLElement, instance: ChartInstance): void {
    if (typeof ResizeObserver === 'undefined')
        return;
    const observer = new ResizeObserver(() => {
        const size = chartSize(container);
        instance.resize(size.width, size.height);
    });
    observer.observe(container);
    (node as ChartHolder).__chartObserver = observer;
}

/**
 * A chart is "already drawn" only when what is on screen still belongs to this body. The marker alone is
 * not enough: it is an attribute, so it survives being cloned into a fresh subtree while the canvas pixels
 * and the instance do not — trusting the marker alone showed an empty chart box wherever it was mounted
 * from a copy. An error banner is the exception, because its text really is in the markup.
 */
function chartIsCurrent(node: HTMLElement, signature: string): boolean {
    const holder = node as ChartHolder;
    return node.dataset.rendered === signature &&
        (Boolean(holder.__chartInstance) || node.classList.contains('has-error'));
}

async function renderChartNode(
    root: HTMLElement,
    node: HTMLElement,
    raw: string,
    style: StyleRead,
    signature: string,
    dark: boolean,
    instant: boolean,
): Promise<void> {
    if (style.invalid !== null) {
        markChartError(node, t("markdown.chart_style_unknown"), raw, signature);
        return;
    }
    let config: Record<string, unknown>;
    try {
        config = readChartBody(raw, style.style);
    }
    catch (err: unknown) {
        markChartError(node, chartErrorMessage(err), raw, signature);
        return;
    }
    try {
        const chartModule = await getChartJs();
        const Chart = chartModule.Chart ?? (chartModule as unknown as { default: typeof chartModule.Chart }).default;
        if (!root.contains(node))
            return;
        destroyChartInstance(node);
        node.classList.remove('loading', 'has-error');
        node.removeAttribute('aria-busy');
        const container = document.createElement('div');
        container.className = 'chart-canvas-holder';
        const canvas = document.createElement('canvas');
        canvas.className = 'chart-canvas';
        container.appendChild(canvas);
        node.replaceChildren(container);
        const size = chartSize(container);
        canvas.width = size.width;
        canvas.height = size.height;
        const instance = new Chart(canvas, buildChartConfig(config, dark, instant) as never);
        (node as ChartHolder).__chartInstance = instance;
        liveCharts.add(node as ChartHolder);
        watchChartSize(node, container, instance);
        node.dataset.rendered = signature;
    }
    catch (err: unknown) {
        if (!root.contains(node))
            return;
        markChartError(node, chartErrorMessage(err), raw, signature);
    }
}

/**
 * Shows a chart block's own body instead of drawing it, for an account that turned charts off. The
 * instance is let go first: a block going quiet while its chart still lives would keep a canvas and a
 * ResizeObserver pointed at text that replaced them. The marker is dropped so switching the setting back
 * on draws again rather than finding the block already "rendered".
 */
function showChartSource(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-chart]').forEach((node) => {
        destroyChartInstance(node);
        node.classList.remove('loading', 'has-error');
        node.classList.add('chart-source');
        node.removeAttribute('aria-busy');
        const code = document.createElement('code');
        code.textContent = decodeDataValue(node.dataset.chart);
        node.replaceChildren(code);
        delete node.dataset.rendered;
    });
}

/**
 * Draws every chart block under a root. `instant` is for the surfaces whose canvas is read rather than
 * looked at — an exported document — where an entrance animation is a picture of nothing at all.
 */
export async function renderPendingCharts(root: HTMLElement, dark: boolean, { instant = false }: { instant?: boolean } = {}): Promise<void> {
    pruneDetachedCharts();
    // Read off the document once rather than per block: the accent is switchable per account and the
    // palette leans on the light mode, so a key that carried only the light mode would let a chart keep
    // the colours it read before the accent moved — and the blocks in one note all see the same answer.
    const paletteKey = chartPaletteKey(dark);
    for (const node of [...root.querySelectorAll<HTMLElement>('[data-chart]')]) {
        // A block showing its body was told so by the renderer switch, and this pass is not the one that
        // decides that. Carrying the refusal on the node means a caller that forgets to check the setting
        // cannot draw over it.
        if (node.classList.contains('chart-source'))
            continue;
        const raw = decodeDataValue(node.dataset.chart);
        const style = parseStyleValue(node.dataset.chartStyle ?? null);
        // The stated format is in the key for the same reason the accent is: which reader runs is not
        // written anywhere in the body's text.
        const signature = `${paletteKey}:${raw.length}:${shortHash(raw)}:${styleSignature(style)}`;
        if (chartIsCurrent(node, signature))
            continue;
        await renderChartNode(root, node, raw, style, signature, dark, instant);
    }
}

/**
 * A canvas is pixels rather than markup, and an exported document is serialized out of `innerHTML`, where
 * a canvas carries nothing at all. So a chart drawn for an export is replaced with a picture of itself and
 * the instance is let go.
 */
export function bakeChartsToImages(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-chart]').forEach((node) => {
        const canvas = node.querySelector('canvas');
        destroyChartInstance(node);
        if (!canvas)
            return;
        let src = '';
        try {
            src = canvas.toDataURL('image/png');
        }
        catch {
            return;
        }
        const image = document.createElement('img');
        image.className = 'chart-export-image';
        image.alt = '';
        image.src = src;
        canvas.replaceWith(image);
        node.classList.remove('loading');
        node.setAttribute('aria-busy', 'false');
    });
}

export interface EnhanceOptions {
    math: boolean;
    mermaid: boolean;
    chart: boolean;
    /**
     * How this surface treats ```kanban blocks. A board is a React root that needs a host to live in,
     * so 'live' means "someone else mounts it" and enhance touches nothing; 'snapshot' draws the still
     * that a serialized or printed surface can carry; 'source' leaves the fence's own text, which is
     * what a surface that can do neither must show rather than a placeholder that never resolves.
     */
    kanban: 'live' | 'snapshot' | 'source';
    /**
     * Which still `snapshot` draws. The list is what a card and a share page can carry in the room they
     * have; a surface that is read from across a room — a projector — owes the reader which column a
     * card sits in, because that is part of what the card says. Only read when `kanban` is 'snapshot',
     * so the channel answer stays the one `tests/kanban-render-channel.test.ts` checks.
     */
    kanbanShape?: KanbanSnapshotShape;
    /**
     * How this surface treats ```mindmap blocks. `live` means the caller mounts a writable map itself
     * from the committed markup, so this pass must leave the placeholder alone; `snapshot` draws a
     * picture in its place, for a surface that cannot host an instance; `source` shows the fence body,
     * for a surface that has no room for either. Required rather than optional because a caller that
     * forgets it would silently leave a block sitting in its loading state forever.
     */
    mindmap: 'live' | 'snapshot' | 'source';
    dark: boolean;
    codeBlockCollapseLines?: number;
}
export async function enhancePreview(root: HTMLElement, options: EnhanceOptions): Promise<void> {
    applyPropertyGeometry(root);
    if (options.kanban === 'snapshot')
        renderStaticKanbans(root, options.kanbanShape ?? 'list');
    else if (options.kanban === 'source')
        showKanbanSourceAll(root);
    if (options.mermaid) {
        hydrateCachedMermaid(root, options.dark);
        const hasPendingDiagram = [...root.querySelectorAll<HTMLElement>('[data-mermaid]')].some((node) => node.dataset.rendered !== currentSignature(node, options.dark));
        if (hasPendingDiagram)
            void getMermaid().catch(() => { });
    }
    else {
        showMermaidSource(root);
    }
    // The chart library is only ever reached from the draw pass, so declining here means the chunk is
    // never fetched — which is the whole point of the switch, and why it is decided before anything asks
    // for a picture.
    if (!options.chart)
        showChartSource(root);
    // A block that is neither mounted live nor drawn here would keep saying "Rendering mind map…"
    // forever, because nothing else on this surface ever touches it.
    if (options.mindmap === 'source')
        showMindmapSourceAll(root);
    if (!options.math)
        showMathSource(root);
    await Promise.allSettled([
        highlightCodeBlocks(root),
        options.math ? renderMath(root) : Promise.resolve(),
        // The snapshot is drawn from an offscreen instance and exported, so it is the one mind map
        // path that reaches the library from this pass. A surface that serializes the markup
        // afterwards (an export) has to wait for it.
        options.mindmap === 'snapshot'
            ? renderStaticMindmaps(root, { dark: options.dark, locale: getLocale() })
            : Promise.resolve(),
    ]);
    configureCodeBlockCollapsing(root, options.codeBlockCollapseLines ?? 24);
    applyExampleSplits(root);
    applyPanelColumnTracks(root);
}
export function invalidateMermaidTheme(root: HTMLElement | null): void {
    root?.querySelectorAll<HTMLElement>('[data-mermaid]').forEach((node) => {
        delete node.dataset.rendered;
    });
}
function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
    if (cache.has(key))
        cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
        const oldest = cache.keys().next().value as K | undefined;
        if (oldest === undefined)
            break;
        cache.delete(oldest);
    }
}
function shortHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then((value) => {
            window.clearTimeout(timer);
            resolve(value);
        }, (err) => {
            window.clearTimeout(timer);
            reject(err);
        });
    });
}
