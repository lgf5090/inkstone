/**
 * The head a ```json block carries, and the routing of every press on it.
 *
 * Deliberately small and free of the model: the parser, the tree and the mind map are fetched the first
 * time a reader opens one of those faces (`./json-view-mount`), so a note full of JSON that is only ever
 * read as text does not download a document model and a layout engine for it. Everything this file can
 * do without them, it does — the tabs, which face is showing, and where a press has to go.
 *
 * The block's own state lives in a module map keyed by the note line it was drawn at, which is the same
 * key the mind map's source panel and the tabs block use, so a JSON block added above shifts the rest
 * with it rather than silently swapping two readers' fold states.
 */
import type { JsonMapView } from './json-map-view';
import { jsonViews, jsonViewsSync } from './json-view-loader';
import { t, type MessageKey } from '../../lib/i18n';
import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer';
import { jsonViewName, type JsonViewName } from '../../lib/markdown/code-options';
import {
    closeBlockOverlayFromEvent,
    dismissBlockOverlays,
    toggleBlockOverlay,
    type BlockActionContext,
    type BlockOverlaySpec,
    type BlockToolbarModule,
    type BlockToolbarOptions,
} from './block-overlay';

export const JSON_BLOCK_SELECTOR = '.code-block[data-json-block]:not(.markdown-example-code)';

const TABS: Array<[JsonViewName, MessageKey]> = [
    ['source', 'preview.json_view_source'],
    ['tree', 'preview.json_view_tree'],
    ['map', 'preview.json_view_map'],
];

const TAB_ICON: Record<JsonViewName, string> = {
    source: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/></svg>',
    tree: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5h6M4 12h10M4 19h6"/><circle cx="18" cy="5" r="2"/><circle cx="18" cy="12" r="2"/></svg>',
    map: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="2" y="9" width="6" height="6" rx="1.5"/><rect x="16" y="3" width="6" height="6" rx="1.5"/><rect x="16" y="15" width="6" height="6" rx="1.5"/><path d="M8 12h4v-6h4M12 12v6h4"/></svg>',
};

const FOLD_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3M7 16v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/><path d="M4 12h16"/></svg>';

const FULLSCREEN_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/></svg>';

const FILTER_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const COPY_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="5" y="5" rx="2"/><path d="M5 9H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1"/></svg>';

const FIT_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>';

const CENTER_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

const ZOOM_IN_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6M8 11h6"/></svg>';

const ZOOM_OUT_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/></svg>';

const EXIT_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

/** What the block remembers between re-renders. `body` says whether the parse can be reused. */
export interface JsonBlockState {
    mode: JsonViewName
    fold: number
    filter: string
    body: string
    /**
     * Fold choices the reader made that differ from the state the block arrived at, as path keys. Only the
     * exceptions are kept, so a 1200-container document does not pay 1200 stringified keys per edit.
     */
    collapsed: Map<string, boolean>
    document: unknown
    /** What the host is currently showing: mode, body and filter. See `draw`. */
    rendered: string
    /** The account's tolerance setting the current parse was made under. */
    tolerant: boolean | undefined
    /**
     * The map's camera, and whether it has been fitted once.
     *
     * This used to live in the host element's `data-` attributes, which the preview throws away on every
     * commit — so the reader's pan was lost on any keystroke, and the first-frame fit guard could never
     * pass because the function that installed it had written the attribute two lines earlier.
     */
    map: JsonMapView
    fullscreen: boolean
}

const states = new Map<string, JsonBlockState>();

/**
 * The block's memory, keyed by note *and* line.
 *
 * The note is part of the key because the map is module-level and a session reads many notes: keyed on the
 * line alone it would retain the parsed tree of every JSON block ever opened, which measured +6.3 MiB
 * across three large notes and never came back down.
 */
export function jsonBlockState(
    block: HTMLElement,
    defaults: { view: JsonViewName, fold: number },
    noteId: string | null = null,
): JsonBlockState {
    const key = `${noteId ?? '-'}:${block.dataset.line ?? ''}`;
    let state = states.get(key);
    if (!state) {
        state = {
            mode: jsonViewName(block.dataset.jsonView ?? '') ?? defaults.view,
            // `fold=0` is the author asking for everything folded; `Number(x) || fallback` reads that
            // zero as "no value given" and hands back the default instead.
            fold: parseFoldAttribute(block.dataset.jsonFold, defaults.fold),
            filter: '',
            body: '',
            collapsed: new Map(),
            document: null,
            rendered: '',
            tolerant: undefined,
            map: { camera: { x: 0, y: 0, scale: 1 }, fitted: false },
            fullscreen: false,
        };
        states.set(key, state);
    }
    return state;
}

function parseFoldAttribute(raw: string | undefined, fallback: number): number {
    const text = (raw ?? '').trim();
    return /^\d{1,3}$/.test(text) ? Math.min(64, Number(text)) : fallback;
}

/**
 * Drops the memory of blocks that are no longer on screen.
 *
 * Called from the mount pass with the lines the note currently has, so closing a note or scrolling past a
 * block eventually releases the tree that was parsed for it.
 */
export function pruneJsonBlockStates(noteId: string | null, lines: Iterable<string>): void {
    const prefix = `${noteId ?? '-'}:`;
    const alive = new Set([...lines].map(line => `${prefix}${line}`));
    for (const key of [...states.keys()]) {
        // Two rules, one pass: another note's block is never coming back on this surface, and this
        // note's block that is no longer on screen has been deleted or moved out from under its line.
        // Only checking the second one is what left the heap climbing across notes.
        if (!key.startsWith(prefix) || !alive.has(key))
            states.delete(key);
    }
}

const OVERLAY_SPEC: BlockOverlaySpec = {
    block: JSON_BLOCK_SELECTOR,
    panels: { filter: '[data-json-filter]' },
    triggers: { filter: '[data-jv="toggle-filter"]' },
    openClasses: { filter: 'is-json-filter-open' },
    materialize: materializeFilter,
};

function materializeFilter(block: HTMLElement): void {
    if (block.querySelector(':scope > [data-json-filter]'))
        return;
    const head = block.querySelector<HTMLElement>(':scope > .code-block-head');
    if (!head)
        return;
    const label = t('preview.json_filter');
    const row = document.createElement('div');
    row.className = 'json-filter';
    row.dataset.jsonFilter = '';
    row.hidden = true;
    row.innerHTML = `<input type="search" class="json-filter-input" data-json-filter-input placeholder="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" maxlength="200">`;
    head.insertAdjacentElement('afterend', row);
}

function tabButton(mode: JsonViewName, active: boolean): string {
    const label = t(TABS.find(([value]) => value === mode)![1]);
    return `<button type="button" class="json-tab${active ? ' is-active' : ''}" data-jv="mode" data-json-mode="${mode}"`
      + ` aria-pressed="${active}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">`
      + `${TAB_ICON[mode]}<span class="json-tab-label">${escapeHtml(label)}</span></button>`;
}

function toolButton(action: string, label: MessageKey, icon: string, extra = '', modifier = ''): string {
    const text = t(label);
    return `<button type="button" class="json-tool${modifier ? ` ${modifier}` : ''}" data-jv="${action}" ${extra}`
      + ` title="${escapeAttr(text)}" aria-label="${escapeAttr(text)}">${icon}</button>`;
}

/** The map's camera and fold tools. They ride on the head rather than on a floating overlay because the
 *  head is the one surface that exists in both the inline block and the full-screen stage, and a reader
 *  who sees a button in the head expects it to be the only place that action lives. */
const MAP_TOOLS: Array<[string, MessageKey, string]> = [
    ['fit', 'preview.json_fit', FIT_ICON],
    ['center', 'preview.json_center', CENTER_ICON],
    ['zoom-out', 'preview.json_zoom_out', ZOOM_OUT_ICON],
    ['zoom-in', 'preview.json_zoom_in', ZOOM_IN_ICON],
];

/** The exports only appear in the full-screen stage: they cost two buttons, and the picture being taken
 *  is the one on the window, which is the only size worth exporting. */
const EXPORT_TOOLS: Array<[string, MessageKey, string]> = [
    ['export-svg', 'preview.json_export_svg', 'SVG'],
    ['export-png', 'preview.json_export_png', 'PNG'],
];

function headToolsHtml(state: JsonBlockState): string {
    const tools = [toolButton('toggle-filter', 'preview.json_filter', FILTER_ICON, `aria-expanded="false" aria-controls="json-filter"`), toolButton('copy', 'preview.json_copy', COPY_ICON)];
    if (state.mode === 'tree')
        tools.unshift(toolButton('fold-all', 'preview.json_fold_all', FOLD_ICON));
    if (state.mode === 'map') {
        if (state.fullscreen) {
            for (const [action, key, glyph] of [...EXPORT_TOOLS].reverse())
                tools.unshift(toolButton(action, key, glyph, '', 'json-tool--text'));
        }
        for (const [action, key, icon] of [...MAP_TOOLS].reverse())
            tools.unshift(toolButton(action, key, icon));
        tools.unshift(toolButton('fold-all-map', 'preview.json_fold_all', FOLD_ICON));
        tools.unshift(toolButton(state.fullscreen ? 'exit-fullscreen' : 'fullscreen',
            state.fullscreen ? 'preview.json_exit_fullscreen' : 'preview.json_fullscreen',
            state.fullscreen ? EXIT_ICON : FULLSCREEN_ICON));
    }
    return `<div class="json-tools">${tools.join('')}</div>`;
}

function tabsHtml(state: JsonBlockState): string {
    return `<div class="json-tabs" role="group" aria-label="${escapeAttr(t('preview.json'))}">${TABS.map(([mode]) => tabButton(mode, mode === state.mode)).join('')}</div>`;
}

/**
 * Builds or rebuilds the head's tabs and tools.
 *
 * Always clears first rather than asking whether a head is already there: the tabs and the tools are
 * two siblings, and a guard that only looks at one of them lets a block that lost it receive a second
 * copy of the other — which is how a block ended up with two "copy JSON" buttons.
 */
function buildHead(block: HTMLElement, state: JsonBlockState): void {
    const head = block.querySelector<HTMLElement>(':scope > .code-block-head');
    if (!head)
        return;
    head.querySelectorAll(':scope > .json-tabs, :scope > .json-tools').forEach(node => node.remove());
    const tools = document.createElement('div');
    tools.innerHTML = `${tabsHtml(state)}${headToolsHtml(state)}`;
    const anchor = head.querySelector('[data-code-collapse], [data-copy]');
    for (const node of [...tools.children])
        head.insertBefore(node, anchor);
}

/**
 * The body the view is drawn from, as the rendered block holds it.
 *
 * Read out of the `<code>` element rather than carried in an attribute: a 200 KB config would otherwise
 * be escaped, sanitized, and re-written into `innerHTML` on every keystroke in the other pane, which is
 * the cost the kanban block pays by keeping its body in a side channel.
 */
export function jsonBlockBody(block: HTMLElement): string {
    return block.querySelector<HTMLElement>(':scope > pre > code')?.textContent ?? '';
}

type MountContext = { sourceNoteId?: string | null, jsonView?: JsonViewName, jsonFold?: number };

/**
 * The most recent full action context each block was pressed with.
 *
 * `enhance` only ever gets the formatter's options — no `api`, no note — while a redraw after a keystroke
 * needs both. The filter box is the one control that redraws without a press behind it, and it is only
 * ever reachable through the trigger that writes this map, so the context it needs is always the one that
 * opened it.
 */
const contexts = new WeakMap<HTMLElement, BlockActionContext>();

/**
 * How long a keystroke waits before the view is rebuilt.
 *
 * Filtering re-lays-out the whole picture, and 1 200 rows measured ~860ms to rebuild; typing at fourteen
 * keys a second against no timer therefore costs more than the reader can see. The debounce is the only
 * reason the box is affordable on a document with a shape to it.
 */
const FILTER_SETTLE_MS = 160;

const filterTimers = new WeakMap<HTMLElement, number>();

/**
 * The one place the filter box's text becomes state.
 *
 * It is delegated from the block rather than bound to the input because the input is materialized lazily
 * (only when the box is first opened) while the block is rebuilt by the preview on every commit — a
 * listener on the input would be attached to an element that does not exist yet, and would be thrown away
 * with the element that did.
 */
function wireFilter(block: HTMLElement): void {
    if (block.dataset.jsonFilterWired)
        return;
    block.dataset.jsonFilterWired = '';
    block.addEventListener('input', (event: Event) => {
        const input = (event.target as Element | null)?.closest?.<HTMLInputElement>('input[data-json-filter-input]');
        if (!input)
            return;
        const ctx = contexts.get(block);
        if (!ctx)
            return;
        const state = jsonBlockState(block, { view: 'source', fold: 2 }, ctx.sourceNoteId);
        state.filter = input.value.slice(0, 200);
        // The redraw guard in `draw` keys on mode|body|filter, so the state write above is what makes the
        // next pass real; clearing the signature is not needed and would defeat the guard for a body edit.
        window.clearTimeout(filterTimers.get(block));
        filterTimers.set(block, window.setTimeout(() => {
            filterTimers.delete(block);
            const warm = jsonViewsSync();
            if (warm)
                warm.mountJsonBlocks([block], ctx);
            else
                void jsonViews().then(module => module.mountJsonBlocks([block], ctx));
        }, FILTER_SETTLE_MS));
    });
}

function mount(block: HTMLElement, ctx: MountContext): void {
    const host = block.querySelector<HTMLElement>(':scope > [data-json-host]');
    if (!host)
        return;
    const state = jsonBlockState(block, { view: ctx.jsonView ?? 'source', fold: ctx.jsonFold ?? 2 }, ctx.sourceNoteId ?? null);
    block.dataset.jsonMode = state.mode;
    host.hidden = state.mode === 'source';
    const pre = block.querySelector<HTMLElement>(':scope > pre');
    if (pre)
        pre.hidden = state.mode !== 'source';
    buildHead(block, state);
    wireFilter(block);
    // A re-render hands the block a fresh head, and the box lives below it: whatever the reader had typed
    // is still the state, so the input has to be told about it or the picture and the box disagree.
    const input = block.querySelector<HTMLInputElement>('input[data-json-filter-input]');
    if (input && input.value !== state.filter)
        input.value = state.filter;
}

/**
 * Re-applies the head after something other than a tab press changed the face — the map's double-click
 * handing a row to the tree is the one case. Without this the tabs keep saying "Mind map" while the body
 * underneath them is a tree.
 */
export function rebuildJsonBlockHead(block: HTMLElement, ctx: BlockActionContext): void {
    contexts.set(block, ctx);
    mount(block, ctx);
}

export function enhanceJsonBlockToolbars(root: HTMLElement, options: BlockToolbarOptions & { sourceNoteId?: string | null }): void {
    root.querySelectorAll<HTMLElement>(JSON_BLOCK_SELECTOR).forEach((block) => {
        if (block.closest('.note-embed-body, .markdown-example-preview'))
            return;
        mount(block, options);
    });
}

function setMode(block: HTMLElement, mode: JsonViewName, ctx: BlockActionContext): void {
    const state = jsonBlockState(block, { view: ctx.jsonView ?? 'source', fold: ctx.jsonFold ?? 2 }, ctx.sourceNoteId ?? null);
    if (state.mode === mode)
        return;
    state.mode = mode;
    mount(block, ctx);
    // The commit pass only runs when the note changes, and opening a face is not a change to it, so the
    // first draw of a freshly chosen face has to be asked for here.
    if (mode === 'source') {
        block.querySelector<HTMLElement>(':scope > [data-json-host]')?.replaceChildren();
        return;
    }
    const warm = jsonViewsSync();
    if (warm)
        warm.mountJsonBlocks([block], ctx);
    else
        void jsonViews().then(module => module.mountJsonBlocks([block], ctx));
}

export const jsonBlockToolbar: BlockToolbarModule = {
    enhance: (root, options) => enhanceJsonBlockToolbars(root, options),
    dismiss: target => dismissBlockOverlays(OVERLAY_SPEC, target),
    close: target => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
    handle: (event, target, ctx) => {
        const block = target.closest<HTMLElement>(JSON_BLOCK_SELECTOR);
        if (!block)
            return false;
        contexts.set(block, ctx);
        const tab = target.closest<HTMLElement>('[data-jv="mode"]');
        if (tab) {
            event.preventDefault();
            setMode(block, jsonViewName(tab.dataset.jsonMode ?? '') ?? 'source', ctx);
            return true;
        }
        const tool = target.closest<HTMLElement>('[data-jv]');
        if (tool) {
            event.preventDefault();
            const action = tool.dataset.jv!;
            if (action === 'toggle-filter') {
                toggleBlockOverlay(OVERLAY_SPEC, block, 'filter');
                if (!block.classList.contains('is-json-filter-open'))
                    return true;
                block.querySelector<HTMLInputElement>('[data-json-filter-input]')?.focus();
                return true;
            }
            void jsonViews().then(module => module.runJsonBlockTool(action, block, ctx));
            return true;
        }
        if (target.closest('[data-json-filter-input]'))
            return true;
        if (target.closest('.json-view, .jt-row, .jm-card, .jm-detail, [data-jt], [data-jm]')) {
            event.preventDefault();
            void jsonViews().then(module => module.routeJsonViewPress(target, block, ctx));
            return true;
        }
        return Boolean(target.closest('[data-json-host]'));
    },
};

