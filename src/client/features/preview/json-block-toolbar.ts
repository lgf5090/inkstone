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
import { t, type MessageKey } from '../../lib/i18n';
import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer';
import { jsonViewName, type JsonViewName } from '../../lib/markdown/code-options';
import {
    blockActionSource,
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

/** What the block remembers between re-renders. `body` says whether the parse can be reused. */
export interface JsonBlockState {
    mode: JsonViewName
    fold: number
    filter: string
    body: string
    /** Fold choices the reader made, as path keys, so a re-parse does not fold their work away. */
    collapsed: Map<string, boolean>
    document: unknown
    fullscreen: boolean
}

const states = new Map<string, JsonBlockState>();

export function jsonBlockState(block: HTMLElement, defaults: { view: JsonViewName, fold: number }): JsonBlockState {
    const key = block.dataset.line ?? '';
    let state = states.get(key);
    if (!state) {
        state = {
            mode: jsonViewName(block.dataset.jsonView ?? '') ?? defaults.view,
            fold: Number(block.dataset.jsonFold ?? '') || defaults.fold,
            filter: '',
            body: '',
            collapsed: new Map(),
            document: null,
            fullscreen: false,
        };
        states.set(key, state);
    }
    return state;
}

/** Drops what a note's blocks remembered, for when the note itself goes away. */
export function forgetJsonBlockStates(prefix: string): void {
    for (const key of states.keys()) {
        if (key.startsWith(prefix))
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
      + ` aria-pressed="${active}" title="${escapeAttr(label)}">${TAB_ICON[mode]}<span>${escapeHtml(label)}</span></button>`;
}

function toolButton(action: string, label: MessageKey, icon: string, extra = ''): string {
    const text = t(label);
    return `<button type="button" class="json-tool" data-jv="${action}" ${extra} title="${escapeAttr(text)}" aria-label="${escapeAttr(text)}">${icon}</button>`;
}

function headToolsHtml(state: JsonBlockState): string {
    const tools = [toolButton('toggle-filter', 'preview.json_filter', FILTER_ICON, `aria-expanded="false" aria-controls="json-filter"`), toolButton('copy', 'preview.json_copy', COPY_ICON)];
    if (state.mode === 'tree')
        tools.unshift(toolButton('fold-all', 'preview.json_fold_all', FOLD_ICON));
    if (state.mode === 'map')
        tools.unshift(toolButton('fullscreen', 'preview.json_fullscreen', FULLSCREEN_ICON));
    return `<div class="json-tools">${tools.join('')}</div>`;
}

function tabsHtml(state: JsonBlockState): string {
    return `<div class="json-tabs" role="group" aria-label="${escapeAttr(t('preview.json'))}">${TABS.map(([mode]) => tabButton(mode, mode === state.mode)).join('')}</div>`;
}

function jsonHead(block: HTMLElement): HTMLElement | null {
    return block.querySelector<HTMLElement>(':scope > .json-tabs')?.parentElement ?? null;
}

function buildHead(block: HTMLElement, state: JsonBlockState): void {
    const head = block.querySelector<HTMLElement>(':scope > .code-block-head');
    if (!head || jsonHead(block))
        return;
    const tools = document.createElement('div');
    tools.innerHTML = `${tabsHtml(state)}${headToolsHtml(state)}`;
    const anchor = head.querySelector('[data-code-collapse], [data-copy]');
    for (const node of [...tools.children])
        head.insertBefore(node, anchor);
}

/** Re-draws the head's tabs and tools after a mode change, which is the only thing that alters them. */
function refreshHead(block: HTMLElement, state: JsonBlockState): void {
    block.querySelectorAll(':scope > .code-block-head > .json-tabs, :scope > .code-block-head > .json-tools').forEach(node => node.remove());
    buildHead(block, state);
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

function mount(block: HTMLElement, ctx: MountContext): void {
    const host = block.querySelector<HTMLElement>(':scope > [data-json-host]');
    if (!host)
        return;
    const state = jsonBlockState(block, { view: ctx.jsonView ?? 'source', fold: ctx.jsonFold ?? 2 });
    block.dataset.jsonMode = state.mode;
    host.hidden = state.mode === 'source';
    const pre = block.querySelector<HTMLElement>(':scope > pre');
    if (pre)
        pre.hidden = state.mode !== 'source';
    if (jsonHead(block))
        refreshHead(block, state);
    else
        buildHead(block, state);
}

export function enhanceJsonBlockToolbars(root: HTMLElement, options: BlockToolbarOptions & { sourceNoteId?: string | null }): void {
    root.querySelectorAll<HTMLElement>(JSON_BLOCK_SELECTOR).forEach((block) => {
        if (block.closest('.note-embed-body, .markdown-example-preview'))
            return;
        mount(block, options);
    });
}

function setMode(block: HTMLElement, mode: JsonViewName, ctx: BlockActionContext): void {
    const state = jsonBlockState(block, { view: ctx.jsonView ?? 'source', fold: ctx.jsonFold ?? 2 });
    if (state.mode === mode)
        return;
    state.mode = mode;
    mount(block, ctx);
    // The commit pass only runs when the note changes, and opening a face is not a change to it, so the
    // first draw of a freshly chosen face has to be asked for here.
    if (mode !== 'source') {
        const host = block.querySelector<HTMLElement>(':scope > [data-json-host]');
        if (host)
            void import('./json-view-mount').then(module => module.mountJsonBlocks([block], ctx));
    }
}

/**
 * Writes a new body into the fence the block came from.
 *
 * The fence is located against the *committed* text, not the live editor buffer, and the whole write is
 * declined when they disagree — the same rule the code block's own settings follow, so a rewrite cannot
 * land on a line the reader has since moved.
 */
export function commitJsonBlock(block: HTMLElement, body: string, ctx: BlockActionContext): boolean {
    const editable = blockActionSource(ctx);
    if (!editable)
        return false;
    const line = Number(block.dataset.line);
    if (!Number.isInteger(line) || line < 0) {
        ctx.api.toast({ title: t('preview.json_edit_unavailable'), tone: 'warning' });
        return false;
    }
    void import('./json-view-mount').then(module => module.writeJsonBlock(block, body, ctx));
    return true;
}

export const jsonBlockToolbar: BlockToolbarModule = {
    enhance: (root, options) => enhanceJsonBlockToolbars(root, options),
    dismiss: target => dismissBlockOverlays(OVERLAY_SPEC, target),
    close: target => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
    handle: (event, target, ctx) => {
        const block = target.closest<HTMLElement>(JSON_BLOCK_SELECTOR);
        if (!block)
            return false;
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
            void import('./json-view-mount').then(module => module.runJsonBlockTool(action, block, ctx));
            return true;
        }
        if (target.closest('[data-json-filter-input]'))
            return true;
        if (target.closest('.json-view, .jt-row, .jm-node, [data-jt], [data-jm]')) {
            event.preventDefault();
            void import('./json-view-mount').then(module => module.routeJsonViewPress(target, block, ctx));
            return true;
        }
        return Boolean(target.closest('[data-json-host]'));
    },
};

/** The block's remembered face, for the surfaces that redraw a block outside the enhance pass. */
export function jsonBlockMode(block: HTMLElement): JsonViewName {
    return states.get(block.dataset.line ?? '')?.mode ?? 'source';
}

export function setJsonBlockFullscreen(block: HTMLElement, fullscreen: boolean): void {
    const state = jsonBlockState(block, { view: 'source', fold: 2 });
    state.fullscreen = fullscreen;
}
