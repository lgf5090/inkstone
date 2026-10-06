/**
 * The toolbar a rendered mind map carries, as one block family in the preview's toolbar registry:
 * the format its body is written in, the source behind the picture, a palette, a fit, a full screen
 * view and an image export.
 *
 * The head is built here rather than in the renderer so that only a surface which mounts a live map
 * offers controls at all: a share page, an embedded note and an exported document get the picture or
 * its source, never a button with nothing behind it. It goes *inside* the block, because every head
 * helper in `lib/markdown/mindmap/view` is resolved from the block element — which is what the
 * registry keeps a handle on across re-renders.
 *
 * Three of the presses write to the note (format, palette, and through the full screen overlay the
 * outline exports), and each resolves the fence against the committed text rather than the live
 * editor buffer, so a rewrite that would land on a stale line declines instead of guessing.
 */
import { downloadBlob, safeFileName } from '../../lib/export-note';
import {
    fitMindmapBlock,
    MINDMAP_NATIVE_FULLSCREEN_SELECTOR,
    MINDMAP_NODE_LINK_ATTR,
    mindmapBody,
    openMindmapSession,
    retryMindmap,
    type MindmapMode,
} from '../../lib/markdown/mindmap';
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
} from './block-overlay';

const WRAPPER = '.mindmap-block-wrap';
const BLOCK = '[data-mindmap]';
const HEAD = '.mindmap-block-head';
const SOURCE_PANEL = '[data-mindmap-source]';
const SOURCE_TRIGGER = '[data-mindmap-action="toggle-source"]';

const OVERLAY_SPEC: BlockOverlaySpec = {
    block: WRAPPER,
    panels: { source: SOURCE_PANEL },
    triggers: { source: SOURCE_TRIGGER },
    openClasses: { source: 'is-block-source-open' },
    materialize: materializeSource,
};

const ICONS = {
    source: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18l-6-6 6-6M15 6l6 6-6 6"/></svg>',
    export: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    fit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/></svg>',
    fullscreen: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/></svg>',
};

const FORMAT_LABELS: Record<MindmapMode, MessageKey> = {
    json: 'preview.mindmap_mode_json',
    outline: 'preview.mindmap_mode_outline',
};

const CONVERT_LABELS: Record<MindmapMode, MessageKey> = {
    json: 'preview.mindmap_convert_json',
    outline: 'preview.mindmap_convert_outline',
};

function toolButton(action: string, label: string, content: string, expanded?: boolean, variant = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mindmap-tool-btn${variant}`;
    button.dataset.mindmapAction = action;
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

/** The block's own head, or the one the toolbar layer gave it. */
function headOf(block: HTMLElement): HTMLElement | null {
    return block.querySelector<HTMLElement>(HEAD);
}

function otherMode(mode: MindmapMode): MindmapMode {
    return mode === 'json' ? 'outline' : 'json';
}

/** The format the renderer stamped on the block, which is the one its body was read as. */
function blockMode(block: HTMLElement): MindmapMode {
    return block.dataset.mindmapMode === 'outline' ? 'outline' : 'json';
}

function buildHead(block: HTMLElement): HTMLElement {
    const mode = blockMode(block);
    const head = document.createElement('div');
    head.className = 'mindmap-block-head';
    const title = document.createElement('span');
    title.className = 'mindmap-block-title';
    title.textContent = t('preview.mindmap');
    const badge = document.createElement('span');
    badge.className = 'mindmap-block-mode';
    badge.textContent = t(FORMAT_LABELS[mode]);
    const tools = document.createElement('span');
    tools.className = 'mindmap-block-tools';
    const convert = toolButton('convert-format', t(CONVERT_LABELS[otherMode(mode)]), t(FORMAT_LABELS[otherMode(mode)]), undefined, '--text');
    const palette = toolButton('theme-pick', t('preview.mindmap_theme'), t('preview.mindmap_theme_auto'), false, '--text');
    palette.setAttribute('data-mindmap-theme-pick', '');
    palette.setAttribute('aria-haspopup', 'menu');
    palette.className = 'mindmap-block-theme';
    tools.append(
        convert,
        palette,
        toolButton('toggle-source', t('preview.mindmap_show_source'), ICONS.source, false),
        toolButton('export-image', t('preview.mindmap_export_png'), ICONS.export),
        toolButton('fit', t('preview.mindmap_fit'), ICONS.fit),
        toolButton('fullscreen', t('preview.mindmap_fullscreen'), ICONS.fullscreen),
    );
    head.append(title, badge, tools);
    return head;
}

/** Built the first time the panel is asked for: a note of many maps pays for none it never opens. */
function materializeSource(wrapper: HTMLElement): void {
    if (wrapper.querySelector(SOURCE_PANEL))
        return;
    const block = wrapper.querySelector<HTMLElement>(BLOCK);
    if (!block)
        return;
    const panel = document.createElement('pre');
    panel.className = 'mindmap-block-source';
    panel.dataset.mindmapSource = '1';
    panel.hidden = true;
    const code = document.createElement('code');
    code.textContent = mindmapBody(block);
    panel.append(code);
    wrapper.append(panel);
}

function enhanceMindmapBlockToolbars(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>(BLOCK).forEach((block) => {
        // A map mirrored into an embedded note or a markdown example never gets a live instance here,
        // so it gets no head either — see `isMindmapWritableHere`.
        if (block.closest('.note-embed-body, .markdown-example-preview') || headOf(block))
            return;
        const wrapper = document.createElement('div');
        wrapper.className = 'mindmap-block-wrap';
        block.replaceWith(wrapper);
        block.prepend(buildHead(block));
        wrapper.append(block);
    });
}

/**
 * Which blocks have their source showing, keyed by the note line the block was drawn at — the same key
 * the preview's other interaction state is kept under, so a map added above shifts with the rest.
 */
export function mindmapSourceStates(root: HTMLElement | null): Map<string, boolean> {
    const states = new Map<string, boolean>();
    root?.querySelectorAll<HTMLElement>(WRAPPER).forEach((wrapper, index) => {
        if (!wrapper.querySelector(SOURCE_PANEL))
            return;
        const key = wrapper.querySelector<HTMLElement>(BLOCK)?.dataset.line ?? String(index);
        states.set(key, openBlockOverlay(OVERLAY_SPEC, wrapper) === 'source');
    });
    return states;
}

export function applyMindmapSourceStates(root: HTMLElement, states: Map<string, boolean>): void {
    root.querySelectorAll<HTMLElement>(WRAPPER).forEach((wrapper, index) => {
        const line = wrapper.querySelector<HTMLElement>(BLOCK)?.dataset.line ?? String(index);
        const open = states.get(line);
        if (open === undefined)
            return;
        setBlockOverlay(OVERLAY_SPEC, wrapper, open ? 'source' : null);
    });
}

function declined(toast: BlockToast, messageKey: MessageKey): boolean {
    toast({ title: t(messageKey), tone: 'warning' });
    return true;
}

/**
 * Rewrites the fence as the other format, from the map that is on screen rather than from the note:
 * a topic typed a moment ago may not have been written back yet, and converting the older body would
 * quietly take it back out. The same write path the map's own edits use carries it.
 */
function convertFormat(block: HTMLElement, toast: BlockToast): boolean {
    const session = openMindmapSession(block);
    if (!session || !session.isReady() || !session.isEditable())
        return declined(toast, 'preview.mindmap_edit_unavailable');
    const target = otherMode(session.mode());
    const previous = session.serialize(session.mode());
    const next = session.serialize(target);
    if (previous === null || next === null)
        return declined(toast, 'preview.mindmap_render_failed');
    const result = session.apply(next);
    if (result !== 'written' && result !== 'moved')
        return declined(toast, 'preview.mindmap_source_moved');
    toast({
        title: t('preview.mindmap_convert_done', { format: t(FORMAT_LABELS[target]) }),
        action: { label: t('common.undo'), run: () => session.apply(previous) },
        duration: 5000,
    });
    return true;
}

async function exportPng(block: HTMLElement, toast: BlockToast): Promise<void> {
    const session = openMindmapSession(block);
    if (!session) {
        toast({ title: t('preview.mindmap_export_failed'), tone: 'warning' });
        return;
    }
    const blob = await session.exportPng();
    if (!blob) {
        toast({ title: t('preview.mindmap_export_failed'), tone: 'warning' });
        return;
    }
    downloadBlob(`${safeFileName(session.title()) || 'mindmap'}.png`, blob);
}

function executeMindmapBlockAction(button: HTMLElement, ctx: BlockActionContext): boolean {
    const wrapper = button.closest<HTMLElement>(WRAPPER);
    const block = wrapper?.querySelector<HTMLElement>(BLOCK);
    if (!wrapper || !block)
        return true;
    const action = button.dataset.mindmapAction;
    if (action === 'toggle-source') {
        // Refresh on the way in as well as through the re-render: the map's own write is debounced,
        // so a reader who presses the button a moment after dragging a node should not see the body
        // that write has already replaced.
        wrapper.querySelector<HTMLElement>(`${SOURCE_PANEL} > code`)?.replaceChildren(mindmapBody(block));
        toggleBlockOverlay(OVERLAY_SPEC, wrapper, 'source');
    }
    else if (action === 'export-image')
        void exportPng(block, ctx.api.toast);
    else if (action === 'fit')
        fitMindmapBlock(block);
    else if (action === 'convert-format') {
        if (blockActionSource(ctx))
            convertFormat(block, ctx.api.toast);
    }
    else if (action === 'theme-pick')
        ctx.mindmap?.themeMenu(block);
    else if (action === 'fullscreen')
        ctx.mindmap?.fullscreen(block);
    else if (button.hasAttribute('data-mindmap-retry'))
        void retryMindmap(block);
    return true;
}

/** The selectors this family answers to, one of them the library's own rather than ours. */
const MINDMAP_PRESS_SELECTOR = `[data-mindmap-action], [data-mindmap-retry], ${MINDMAP_NATIVE_FULLSCREEN_SELECTOR}`;

export const mindmapToolbar: BlockToolbarModule = {
    enhance: (root) => enhanceMindmapBlockToolbars(root),
    dismiss: (target) => dismissBlockOverlays(OVERLAY_SPEC, target),
    close: (target) => closeBlockOverlayFromEvent(OVERLAY_SPEC, target),
    handle: (event, target, ctx) => {
        const block = target.closest<HTMLElement>(BLOCK);
        if (!block)
            return false;
        const press = target.closest<HTMLElement>(MINDMAP_PRESS_SELECTOR);
        if (press) {
            event.preventDefault();
            // The library's toolbar has a full screen button of its own; its native request is switched
            // off in the registry, and the press lands here so both buttons open the same overlay.
            if (press.matches(MINDMAP_NATIVE_FULLSCREEN_SELECTOR))
                ctx.mindmap?.fullscreen(block);
            else
                return executeMindmapBlockAction(press, ctx);
            return true;
        }
        // A node that is a link to another note carries the same `data-wikilink` a prose link does, so
        // it is handed to the preview's wiki navigation below rather than swallowed with the canvas.
        if (target.closest(`[${MINDMAP_NODE_LINK_ATTR}]`))
            return false;
        // Everything else inside the canvas belongs to the library: a node would otherwise be read as
        // a preview anchor, and an image inside a node would open the lightbox over the map.
        return Boolean(target.closest('[data-mindmap-canvas]'));
    },
};
