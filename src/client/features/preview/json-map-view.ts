/**
 * The mind map view of a ```json block, drawn as cards.
 *
 * A container is one card; each member is one named row inside it (`color : #FF0000`), and a member that
 * is itself a container gets a card to the right hung off that row. Geometry is `json-view/layout`'s job;
 * this file paints what it is told and handles the gestures: pan, zoom, fold, the click that opens a
 * member's detail, and the right-click menu.
 *
 * Three things the reference did that a preview of someone's note must not:
 *
 * - It added a `mousemove` and a `mouseup` listener to `window` on every render of the map and removed
 *   neither, so each visit to the tab leaked a pair that kept the previous canvas alive forever. Drag here
 *   is one `pointerdown` on the canvas with pointer capture, which the browser releases for us, and the two
 *   overlays (detail card, menu) attach their outside-click listener only while they are open.
 * - Its wheel handler called `preventDefault()` unconditionally, so a reader whose pointer happened to be
 *   over the map could not scroll the note. Plain wheel scrolls; zoom needs the modifier.
 * - It kept no view state, so the picture jumped back to its origin whenever anything redrew it.
 *
 * The camera therefore lives in {@link JsonMapView}, which the caller owns and hands back on every draw.
 */
import { t } from '../../lib/i18n';
import { escapeHtml } from '../../lib/markdown/renderer';
import type { JsonDocument, JsonNode, JsonPath } from '../../lib/markdown/json-view';
import {
    displayValue,
    formatJsonPath,
    isContainerNode,
    JSON_VIEW_MAX_MAP_NODES,
    layoutJsonMap,
    mapLinkPath,
    pathKey,
    setCollapsed,
    writeJsonNode,
    type MapLayout,
    type MapRow,
    type MapSlot,
} from '../../lib/markdown/json-view';

export interface JsonMapCamera {
    x: number
    y: number
    scale: number
}

/**
 * What the map remembers between draws.
 *
 * `fitted` is why this object exists rather than a `data-` attribute: the first-frame "fit to view" used
 * to be guarded on `!host.dataset.jsonCamera`, and the same function wrote that attribute two lines
 * earlier, so the guard could never pass and a 1200-node map drew at 1:1 with a strip of it on screen.
 */
export interface JsonMapView {
    camera: JsonMapCamera
    fitted: boolean
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
/** A value this long is cut with an ellipsis; the full text is one click away in the detail card. */
const VALUE_LIMIT = 60;
/** The fold handle and the gap after it, which only a branch row pays for. */
const HANDLE_WIDTH = 22;
/** The colour chip and the gap after it, which only a row holding a colour pays for. */
const CHIP_WIDTH = 19;
/** The two 1px borders a card's `box-sizing: border-box` width has to share its rows with. */
const CARD_BORDER = 2;
/** The prose styles set this; the export repeats whatever the host actually computes. */
const DEFAULT_FONT_SIZE = 11.5;
/** How much of the window an inline map may take before it stops growing and the reader pans. */
const INLINE_MAX_HEIGHT = 720;

/**
 * The theme colours the export needs, resolved once per draw.
 *
 * The HTML gets its colours from classes, so only a generated SVG has to name them literally. Reading
 * `getPropertyValue('--syntax-string')` would hand back whatever the theme wrote — `oklch()`, a
 * `color-mix()`, a `var()` chain — and a `.svg` opened in a viewer that predates those is a black map.
 * The canvas rasterizes any colour it accepts, so the file carries sRGB every reader understands.
 */
const SVG_TOKENS = {
    page: '--bg-base',
    card: '--bg-surface',
    edge: '--border-strong',
    text: '--text-primary',
    key: '--syntax-property',
    string: '--syntax-string',
    number: '--syntax-number',
    constant: '--syntax-constant',
    faint: '--text-quaternary',
    label: '--text-secondary',
} as const;

const FALLBACK_COLOUR: Record<keyof typeof SVG_TOKENS, string> = {
    page: '#fafafa',
    card: '#ffffff',
    edge: '#d0d0d0',
    text: '#222222',
    key: '#8d4500',
    string: '#032f62',
    number: '#005cc5',
    constant: '#6f42c1',
    faint: '#999999',
    label: '#57606a',
};

let measureContext: CanvasRenderingContext2D | null = null;

/**
 * One 1×1 canvas, used both to measure a run of text and to ask what a colour actually is.
 *
 * It stays at one pixel because `getImageData` of a full canvas would be a buffer the preview holds for no
 * reason; the font state is re-set on every draw anyway.
 */
function context(): CanvasRenderingContext2D | null {
    if (!measureContext) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        measureContext = canvas.getContext('2d', { willReadFrequently: true });
    }
    return measureContext;
}

interface Measurer {
    width: (text: string) => number
    /** The size the rows paint at, which the export has to repeat for its advances to line up. */
    fontSize: number
    /** `token` as a literal colour an exported SVG may carry, or `fallback` if it cannot be resolved. */
    colour: (token: string, fallback: string) => string
}

function createMeasurer(host: HTMLElement): Measurer {
    const style = getComputedStyle(host);
    const painter = context();
    if (painter)
        painter.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
        width: text => (painter ? painter.measureText(text).width : text.length * 7),
        fontSize: Number.parseFloat(style.fontSize) || DEFAULT_FONT_SIZE,
        colour: (token, fallback) => resolveColour(style.getPropertyValue(token), fallback, painter),
    };
}

/**
 * Whatever the theme wrote, as sRGB — or the fallback.
 *
 * Two tricks here, both measured rather than assumed. The sentinel check tells a rejected colour from an
 * accepted one: assigning a string the canvas cannot parse leaves `fillStyle` exactly as it was, so an
 * unreadable token becomes the fallback rather than an attribute the SVG parser trips over — and because a
 * colour from inside the note travels the same path, an exported map cannot be made to carry a `"` or a `<`
 * in a fill. Reading the pixel back is what gets sRGB: `fillStyle` hands a wide-gamut colour straight back
 * as `oklch(...)`, which a 2016-era viewer shows as black.
 */
const COLOUR_SENTINEL = '#010203';

function resolveColour(raw: string, fallback: string, painter: CanvasRenderingContext2D | null): string {
    const value = raw.trim();
    if (!value)
        return fallback;
    if (!painter)
        return /^#[\da-f]{6}$/i.test(value) ? value : fallback;
    painter.fillStyle = COLOUR_SENTINEL;
    painter.fillStyle = value;
    if (painter.fillStyle === COLOUR_SENTINEL)
        return fallback;
    painter.clearRect(0, 0, 1, 1);
    painter.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = painter.getImageData(0, 0, 1, 1).data;
    if (alpha === 255)
        return `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
    return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(2)})`;
}

/** A `#RRGGBB` is the one value worth painting as well as naming. */
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isColourText(node: JsonNode): boolean {
    return node.kind === 'string' && typeof node.value === 'string' && HEX_COLOUR.test(node.value);
}

/**
 * The text a card lists for one member.
 *
 * A container is named by how much it holds — `{2 keys}`, `[3 items]` — because the reader cannot see the
 * contents from the row and a bare `{2}` reads as a value. `hidden` is what the ceiling left out.
 */
function jsonMapValue(node: JsonNode, hidden: number): string {
    const extra = hidden > 0 ? ` +${hidden}` : '';
    if (node.kind === 'array') {
        const count = node.children?.length ?? 0;
        return `[${t(count === 1 ? 'preview.json_map_item_one' : 'preview.json_map_item_other', { count })}]${extra}`;
    }
    if (node.kind === 'object') {
        const count = node.children?.length ?? 0;
        return `{${t(count === 1 ? 'preview.json_map_key_one' : 'preview.json_map_key_other', { count })}}${extra}`;
    }
    return displayValue(node, VALUE_LIMIT);
}

/** The layout from the last draw, so an export or an overlay does not place the map again. */
const lastLayout = new WeakMap<HTMLElement, { document: JsonDocument, layout: MapLayout, measurer: Measurer }>();

function layoutFrom(measurer: Measurer, document: JsonDocument, keep?: (node: JsonNode, path: JsonPath) => boolean): MapLayout {
    return layoutJsonMap(document.root, {
        maxNodes: JSON_VIEW_MAX_MAP_NODES,
        keep,
        valueFor: (node, hidden) => jsonMapValue(node, hidden),
        // Every row pays the handle column, folded or not: a leaf's key starts on the same vertical line
        // as a branch's, which is only true if the layout sized the card for the spacer it paints.
        measure: row => Math.ceil(measurer.width(row.label))
          + HANDLE_WIDTH
          + (isColourText(row.node) ? CHIP_WIDTH : 0)
          + CARD_BORDER,
    });
}

function applyCamera(host: HTMLElement, camera: JsonMapCamera): void {
    const canvas = host.querySelector<HTMLElement>('[data-json-map-canvas]');
    if (canvas)
        canvas.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    // Both overlays name a place on the canvas, so a camera change retires them rather than drifting.
    host.querySelector('[data-json-detail]')?.remove();
    host.querySelector('[data-json-map-menu]')?.remove();
    releaseOutsideCloser();
}

/**
 * Grows the inline box to the picture, up to a cap.
 *
 * The canvas is absolutely positioned, so the host would otherwise sit at its `min-height` whatever the
 * map needs: a three-card picture left a band of empty dotted field below it, and a forty-row card ran off
 * the bottom with nothing to say so. Full screen is the exception — there the stage owns the height and the
 * map is meant to fill the window.
 */
function sizeHost(host: HTMLElement, layout: MapLayout): void {
    if (host.closest('[data-json-fullscreen-stage]')) {
        host.style.height = '';
        return;
    }
    const cap = Math.max(240, Math.min(INLINE_MAX_HEIGHT, Math.round(window.innerHeight * 0.72)));
    const needed = Math.ceil(layout.height) + 16;
    host.style.height = `${Math.max(200, Math.min(cap, needed))}px`;
}

/**
 * Re-applies the box height the last draw asked for.
 *
 * Entering full screen clears the inline height and leaving puts it back: the block is the same element in
 * both places, and a `height: 552px` carried into a window-sized stage leaves a dotted band under the
 * picture that no amount of fitting removes.
 */
export function resizeJsonMapHost(host: HTMLElement): void {
    const cached = lastLayout.get(host);
    if (cached)
        sizeHost(host, cached.layout);
}

/**
 * Draws the map, or redraws it after a fold, a filter, a pan or a zoom.
 *
 * `view` is the caller's, not ours: it survives the preview replacing this host element, which is what
 * keeps the reader's camera and the fit decision alive across a keystroke in the other pane.
 */
export function renderJsonMap(
    host: HTMLElement,
    document: JsonDocument,
    view: JsonMapView,
    kept?: Set<string> | null,
): void {
    const measurer = createMeasurer(host);
    const keep = kept ? (_node: JsonNode, path: JsonPath) => kept.has(pathKey(path)) : undefined;
    const layout = layoutFrom(measurer, document, keep);
    lastLayout.set(host, { document, layout, measurer });
    const links = layout.links
        .map(link => `<path class="jm-link" d="${mapLinkPath(link)}"/>`)
        .join('');
    const labels = layout.links
        .filter(link => link.label)
        .map(link => `<text class="jm-edge-label" x="${link.x}" y="${link.y}">${escapeHtml(link.label)}</text>`)
        .join('');
    const cards = layout.slots.map(slot => cardHtml(slot, layout)).join('');
    // A filter that matches nothing has to say so: the alternative is a picture of one empty card, which
    // reads as "this document is empty" rather than "nothing in it matched what you typed". The card still
    // counts what the filter hid, so the test is on what it *kept*, not on there being any line at all.
    const nothingKept = Boolean(keep) && layout.slots.every(slot => slot.rows.every(row => row.more));
    host.innerHTML = [
        layout.truncated ? `<p class="json-view-note">${escapeHtml(t('preview.json_map_limit', { max: JSON_VIEW_MAX_MAP_NODES }))}</p>` : '',
        nothingKept ? `<p class="json-view-note">${escapeHtml(t('preview.json_no_matches'))}</p>` : '',
        '<div class="jm-canvas" data-json-map-canvas>',
        `<svg class="jm-links" width="${layout.width}" height="${layout.height}" aria-hidden="true">${links}${labels}</svg>`,
        cards,
        '</div>',
    ].join('');
    // The keyboard pan listens on the host, so the host has to be reachable by Tab. Without this the
    // arrow-key handler was dead code, which is how a "works with the keyboard" claim dies in review.
    host.tabIndex = 0;
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', t('preview.json_view_map'));
    sizeHost(host, layout);
    if (!view.fitted) {
        if (fitJsonMap(host, view))
            view.fitted = true;
        else
            scheduleFit(host, view);
    }
    applyCamera(host, view.camera);
    installMapGestures(host, view);
}

/** A card with nothing to list: a container that holds no members, said plainly. */
function emptyRowHtml(layout: MapLayout): string {
    return `<div class="jm-row jm-row--empty" style="top:${layout.cardPadding}px; height:${layout.rowHeight}px; left:${layout.cardPadding}px; right:${layout.cardPadding}px">`
      + `<span class="jm-empty">${escapeHtml(t('preview.json_empty_container'))}</span></div>`;
}

function cardHtml(slot: MapSlot, layout: MapLayout): string {
    const rows = slot.rows.length > 0
        ? slot.rows.map((row, index) => rowHtml(row, slot, layout, index)).join('')
        : emptyRowHtml(layout);
    return `<div class="jm-card jm-card--${slot.node.kind}${slot.rows.some(row => row.cards.length > 1) ? ' jm-card--fan' : ''}"`
      + ` tabindex="0" role="group" aria-label="${escapeHtml(slot.edgeLabel || t('preview.json_view_map'))}"`
      + ` data-jm-path="${escapeHtml(pathKey(slot.path))}"`
      + ` style="left:${slot.x}px; top:${slot.y - slot.h / 2}px; width:${slot.w}px; height:${slot.h}px">`
      + rows
      + '</div>';
}

function rowHtml(row: MapRow, slot: MapSlot, layout: MapLayout, index: number): string {
    const top = row.y - (slot.y - slot.h / 2) - layout.rowHeight / 2;
    const style = ` style="top:${top}px; height:${layout.rowHeight}px; left:${layout.cardPadding}px; right:${layout.cardPadding}px"`;
    const path = escapeHtml(pathKey(row.path));
    if (row.more) {
        // The card is narrower than the document, and says by how much rather than letting the reader
        // count what is on screen and conclude that is all there is.
        return `<div class="jm-row jm-row--more" data-jm-path="${path}"${style}>`
          + `<span class="jm-more">${escapeHtml(row.value)}</span></div>`;
    }
    const node = row.node;
    const chip = isColourText(node)
        ? `<span class="jm-chip" style="background:${escapeHtml(String(node.value))}"></span>`
        : '';
    const fold = row.branch
        ? `<button type="button" class="jm-fold" data-jm="fold" data-jm-path="${path}"`
          + ` aria-label="${escapeHtml(t(node.collapsed ? 'preview.json_expand' : 'preview.json_fold'))}"`
          + ` aria-expanded="${String(!node.collapsed)}">${node.collapsed ? '+' : '−'}</button>`
        : `<span class="jm-fold jm-fold--none" aria-hidden="true"></span>`;
    const name = row.key ? `<span class="jm-key">${escapeHtml(`${row.key}: `)}</span>` : '';
    return `<div class="jm-row${row.branch ? ' jm-row--branch' : ''}${index > 0 ? ' jm-row--rule' : ''}" data-jm-path="${path}"${style}>`
      + fold
      + name
      + `<span class="jm-value jm-value--${node.kind}">${chip}${escapeHtml(row.value)}</span>`
      + '</div>';
}

/**
 * Pan, zoom and the gestures that open the two overlays.
 *
 * Every listener is on the host, and the drag uses pointer capture. That is safe because the preview hands
 * this function a fresh element on every commit — measured, not assumed: wrapping `addEventListener` counts
 * one `wheel`, one `dblclick` and one `keydown` after four edits and after three different notes.
 */
/** The gestures one host has installed, and how to take them back off again. */
const gestures = new WeakMap<HTMLElement, { view: JsonMapView, off: () => void }>();

function installMapGestures(host: HTMLElement, view: JsonMapView): void {
    if (!host.querySelector('[data-json-map-canvas]'))
        return;
    // A fold or a filter redraws into the *same* host, and `addEventListener` does not replace what is
    // already there: two draws meant two context-menu handlers, and the second one deleted the menu the
    // first had just opened and focused — so the card menu opened and vanished with focus on `<body>`.
    if (gestures.get(host)?.view === view)
        return;
    gestures.get(host)?.off();
    const camera = view.camera;
    let drag: { pointerId: number, x: number, y: number, left: number, top: number } | null = null;

    host.onpointerdown = (event: PointerEvent) => {
        // Text inside an open overlay is there to be selected, not to start a pan; and a press on a card is
        // a press on a member, which the block's own click route answers.
        if ((event.target as Element).closest('.jm-detail, .jm-map-menu, .jm-card'))
            return;
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: camera.x, top: camera.y };
        host.setPointerCapture(event.pointerId);
        host.classList.add('is-dragging');
    };
    host.onpointermove = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId)
            return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        // Under a threshold the pointer is a hand that trembled, not a pan, and moving the camera would
        // also close whatever overlay the reader was reading.
        if (Math.abs(dx) + Math.abs(dy) <= 3)
            return;
        camera.x = drag.left + dx;
        camera.y = drag.top + dy;
        applyCamera(host, camera);
    };
    const release = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId)
            return;
        drag = null;
        host.classList.remove('is-dragging');
        if (host.hasPointerCapture(event.pointerId))
            host.releasePointerCapture(event.pointerId);
    };
    host.onpointerup = release;
    host.onpointercancel = release;

    const wheel = (event: WheelEvent): void => {
        if (!event.ctrlKey && !event.metaKey)
            return;
        event.preventDefault();
        zoomJsonMap(host, view, event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
    };

    const dblclick = (event: MouseEvent): void => {
        const row = (event.target as Element).closest<HTMLElement>('[data-jm-path]');
        const path = row ? parsePath(row.dataset.jmPath) : null;
        if (!path || path.length === 0)
            return;
        event.preventDefault();
        host.dispatchEvent(new CustomEvent('jsonmapopen', { bubbles: true, composed: true, detail: { path, edit: true } }));
    };

    const contextmenu = (event: MouseEvent): void => {
        const anchor = (event.target as Element).closest<HTMLElement>('[data-jm-path]');
        const path = anchor ? parsePath(anchor.dataset.jmPath) : null;
        if (!anchor || !path)
            return;
        event.preventDefault();
        // The press named one member, so the member's menu answers and the block's menu does not: the live
        // preview asks for the note menu from an ancestor of this host, and without stopping here a reader
        // right-clicking a card got *both* — the block menu painted over the card menu, and its search box
        // took the focus the card menu had just asked for. The block menu stays one right-click away on the
        // canvas around the cards, where nothing here claims the gesture.
        event.stopPropagation();
        const cached = lastLayout.get(host);
        if (cached)
            showJsonMapMenu(host, cached.document, path, event.clientX, event.clientY);
    };

    // A right-click's `mousedown` has a default action of its own — moving the caret — and it runs *after*
    // the `contextmenu` handler has finished. Without this, the menu opens, focuses its first item, and the
    // browser then puts the caret back in the editor behind it: a menu that cannot be driven by keyboard.
    // Measured in a real browser, where the block sits inside a `contenteditable` live preview.
    const mousedown = (event: MouseEvent): void => {
        if (event.button === 2 && (event.target as Element).closest('[data-jm-path]'))
            event.preventDefault();
    };

    const keydown = (event: KeyboardEvent): void => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            const card = (event.target as Element).closest<HTMLElement>('.jm-card[data-jm-path]');
            if (!card)
                return;
            const path = parsePath(card.dataset.jmPath);
            if (!path)
                return;
            event.preventDefault();
            const cached = lastLayout.get(host);
            if (cached)
                showJsonDetail(host, cached.document, path, card);
            return;
        }
        const menu = host.querySelector<HTMLElement>('[data-json-map-menu]');
        if (menu?.contains(event.target as Node) && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            moveMapMenuFocus(menu, event.key === 'ArrowDown');
            return;
        }
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            const anchor = (event.target as Element).closest<HTMLElement>('.jm-card[data-jm-path]');
            const cached = lastLayout.get(host);
            if (!anchor || !cached)
                return;
            const path = parsePath(anchor.dataset.jmPath) ?? [];
            event.preventDefault();
            const box = anchor.getBoundingClientRect();
            const own = host.getBoundingClientRect();
            showJsonMapMenu(host, cached.document, path, box.left - own.left, box.bottom - own.top + 2);
            return;
        }
        if (event.key === 'Escape') {
            if (!host.querySelector('[data-json-detail], [data-json-map-menu]'))
                return;
            event.preventDefault();
            closeMapOverlays(host);
            host.focus();
            return;
        }
        if (event.target !== host && !(event.target as Element).closest?.('.jm-card'))
            return;
        const step = event.shiftKey ? 80 : 24;
        if (event.key === 'ArrowLeft')
            camera.x += step;
        else if (event.key === 'ArrowRight')
            camera.x -= step;
        else if (event.key === 'ArrowUp')
            camera.y += step;
        else if (event.key === 'ArrowDown')
            camera.y -= step;
        else
            return;
        event.preventDefault();
        applyCamera(host, camera);
    };

    host.addEventListener('wheel', wheel, { passive: false });
    host.addEventListener('dblclick', dblclick);
    host.addEventListener('mousedown', mousedown);
    host.addEventListener('contextmenu', contextmenu);
    host.addEventListener('keydown', keydown);
    gestures.set(host, {
        view,
        off: () => {
            host.removeEventListener('wheel', wheel);
            host.removeEventListener('dblclick', dblclick);
            host.removeEventListener('mousedown', mousedown);
            host.removeEventListener('contextmenu', contextmenu);
            host.removeEventListener('keydown', keydown);
            host.onpointerdown = null;
            host.onpointermove = null;
            host.onpointerup = null;
            host.onpointercancel = null;
        },
    });
}

function parsePath(raw: string | undefined): JsonPath | null {
    try {
        const parsed: unknown = JSON.parse(raw ?? 'null');
        return Array.isArray(parsed) ? parsed as JsonPath : null;
    }
    catch {
        return null;
    }
}

/**
 * The one listener that dismisses the overlays, installed while either is open.
 *
 * It goes on `document` rather than the host because the reader dismisses a popover by clicking *outside*
 * it, which is usually outside the host as well. It is a single module-level reference, removed on close and
 * on every redraw, so a note full of JSON does not accumulate one per open.
 */
let outsideCloser: ((event: PointerEvent) => void) | null = null;

function releaseOutsideCloser(): void {
    if (!outsideCloser)
        return;
    document.removeEventListener('pointerdown', outsideCloser, true);
    outsideCloser = null;
}

function armOutsideCloser(host: HTMLElement, keep: Selectors): void {
    releaseOutsideCloser();
    outsideCloser = (event: PointerEvent) => {
        const target = event.target as Element;
        if (keep.some(selector => target.closest(selector)))
            return;
        closeMapOverlays(host);
    };
    document.addEventListener('pointerdown', outsideCloser, true);
}

type Selectors = string[];

export function closeMapOverlays(host: HTMLElement): void {
    host.querySelector('[data-json-detail]')?.remove();
    host.querySelector('[data-json-map-menu]')?.remove();
    releaseOutsideCloser();
}

/** Where an overlay lands. `left`/`top` are host-relative; the result is pulled back so it is never half off-screen. */
function placeOverlay(card: HTMLElement, host: HTMLElement, left: number, top: number): void {
    const own = host.getBoundingClientRect();
    card.style.left = '0px';
    card.style.top = '0px';
    const size = card.getBoundingClientRect();
    const maxLeft = Math.max(8, own.width - size.width - 8);
    const maxTop = Math.max(8, own.height - size.height - 8);
    card.style.left = `${Math.round(Math.min(Math.max(8, left), maxLeft))}px`;
    card.style.top = `${Math.round(Math.min(Math.max(8, top), maxTop))}px`;
}

/**
 * The card that opens when a row is clicked: that member's own JSON, and the path that names it.
 *
 * Both are offered for copying because they answer two different questions. The subtree is what a reader
 * pastes into a request; the path is what they type into `jq` or point a colleague at. The subtree text
 * comes from `writeJsonNode`, so an untouched member copies out exactly as the note holds it — `1.0` and a
 * twenty-digit id included.
 */
export function showJsonDetail(host: HTMLElement, document: JsonDocument, path: JsonPath, anchor: HTMLElement): void {
    host.querySelector('[data-json-detail]')?.remove();
    const node = walkTo(document.root, path);
    if (!node)
        return;
    const body = writeJsonNode(document, node);
    const card = host.ownerDocument.createElement('div');
    card.className = 'jm-detail';
    card.dataset.jsonDetail = '';
    card.dataset.jmPath = pathKey(path);
    card.tabIndex = -1;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', t('preview.json_detail_title'));
    const id = `jm-detail-path-${pathKey(path).replace(/[^\w-]/g, '')}`;
    card.innerHTML = [
        '<div class="jm-detail-head">',
        `<span class="jm-detail-title">${escapeHtml(t('preview.json_detail_title'))}</span>`,
        `<span class="jm-detail-kind">${escapeHtml(node.kind)}</span>`,
        `<button type="button" class="jm-detail-close" data-jt="close-detail" aria-label="${escapeHtml(t('common.close'))}">×</button>`,
        '</div>',
        `<pre class="jm-detail-body">${escapeHtml(body)}</pre>`,
        `<label class="jm-detail-label" for="${escapeHtml(id)}">${escapeHtml(t('preview.json_path'))}</label>`,
        `<input id="${escapeHtml(id)}" class="jm-detail-path" readonly value="${escapeHtml(formatJsonPath(path))}">`,
        '<div class="jm-detail-actions">',
        `<button type="button" class="jm-detail-copy" data-jt="copy-value">${escapeHtml(t('preview.json_detail_copy_value'))}</button>`,
        `<button type="button" class="jm-detail-copy" data-jt="copy-path">${escapeHtml(t('preview.json_copy_path'))}</button>`,
        '</div>',
    ].join('');
    host.appendChild(card);
    const box = anchor.getBoundingClientRect();
    const own = host.getBoundingClientRect();
    placeOverlay(card, host, box.right - own.left + 10, box.top - own.top);
    card.focus();
    armOutsideCloser(host, ['.jm-detail', '.jm-card', '.jm-map-menu']);
}

/**
 * The right-click menu: every gesture a reader wants on one card, without leaving the picture.
 *
 * The items are ordinary `[data-jt]` buttons carrying the path they act on, so they reach the same route as
 * the tree's buttons and the detail card's copies — one implementation of each action, not one per surface.
 */
export function showJsonMapMenu(
    host: HTMLElement,
    document: JsonDocument,
    path: JsonPath,
    clientX: number,
    clientY: number,
): void {
    host.querySelector('[data-json-map-menu]')?.remove();
    const node = walkTo(document.root, path);
    if (!node)
        return;
    const own = host.getBoundingClientRect();
    const menu = host.ownerDocument.createElement('div');
    menu.className = 'jm-map-menu';
    menu.dataset.jsonMapMenu = '';
    menu.dataset.jmPath = pathKey(path);
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('preview.json_map_menu'));
    const foldable = isContainerNode(node);
    const items: Array<[string, string, boolean]> = [
        [foldable && node.collapsed ? 'expand-branch' : 'fold-branch', t(foldable ? (node.collapsed ? 'preview.json_expand' : 'preview.json_fold') : 'preview.json_fold_branch'), foldable],
        ['expand-all-map', t('preview.json_expand_all'), true],
        ['fold-all-map', t('preview.json_fold_all'), true],
        ['copy-value', t('preview.json_detail_copy_value'), true],
        ['copy-path', t('preview.json_copy_path'), true],
        ['open-in-tree', t('preview.json_map_reveal'), path.length > 0],
    ];
    menu.innerHTML = items
        .filter(([, , enabled]) => enabled)
        .map(([action, label]) => `<button type="button" role="menuitem" class="jm-map-menu-item" data-jt="${action}" data-jm-path="${escapeHtml(pathKey(path))}">${escapeHtml(label)}</button>`)
        .join('');
    host.appendChild(menu);
    placeOverlay(menu, host, clientX - own.left, clientY - own.top);
    const first = menu.querySelector<HTMLElement>('.jm-map-menu-item');
    first?.focus();
    armOutsideCloser(host, ['.jm-detail', '.jm-card', '.jm-map-menu']);
}

/** Moves the keyboard between menu items with the arrows, the way the app's other menus behave. */
export function moveMapMenuFocus(menu: HTMLElement, forward: boolean): void {
    const items = [...menu.querySelectorAll<HTMLElement>('.jm-map-menu-item')];
    const at = items.findIndex(item => item === document.activeElement);
    const next = items[(at + (forward ? 1 : -1) + items.length) % items.length];
    next?.focus();
}

/** Zooms about a screen point, so the content under the pointer stays under it. */
export function zoomJsonMap(host: HTMLElement, view: JsonMapView, factor: number, clientX?: number, clientY?: number): void {
    const camera = view.camera;
    const next = clampScale(camera.scale * factor);
    const box = host.getBoundingClientRect();
    const px = (clientX ?? box.left + box.width / 2) - box.left;
    const py = (clientY ?? box.top + box.height / 2) - box.top;
    const ratio = next / camera.scale;
    camera.x = px - (px - camera.x) * ratio;
    camera.y = py - (py - camera.y) * ratio;
    camera.scale = next;
    applyCamera(host, camera);
}

function clampScale(value: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Scales and slides the map so all of it fits the box, and says whether it could.
 *
 * Clamped to the same floor the zoom uses: a wide document can ask for a scale of 0.007, which is a picture
 * of nothing. A box of zero is the answer a host gives before the browser has laid it out, and the first
 * draw can happen in exactly that frame — so this declines rather than recording a fit, and the caller
 * retries. Marking the view fitted on a declined attempt is what left a 1200-key card parked at 1:1.
 */
export function fitJsonMap(host: HTMLElement, view: JsonMapView): boolean {
    const box = host.getBoundingClientRect();
    const layout = lastLayout.get(host)?.layout;
    if (!layout || !box.width || !box.height)
        return false;
    const scale = clampScale(Math.min(1, (box.width - 24) / layout.width, (box.height - 24) / layout.height));
    // Written into the caller's object rather than replaced by a new one: the pan closures hold this
    // reference, and a fresh object here means the next drag moves the camera the fit just retired — the
    // picture jumps back to where it stood before the fit. Measured in a browser, where fitting on the way
    // into full screen and then dragging did exactly that.
    const camera = view.camera;
    camera.scale = scale;
    camera.x = (box.width - layout.width * scale) / 2;
    camera.y = (box.height - layout.height * scale) / 2;
    applyCamera(host, camera);
    return true;
}

/**
 * Keeps asking for a frame in which the host has a size, for at most half a second.
 *
 * A `ResizeObserver` would be the other answer and is the wrong one: it holds its targets, so an observer
 * kept at module level would pin every host the preview ever replaced — the same leak the reference shipped
 * with its window listeners. This gives up, and the block's own fit tool remains.
 */
function scheduleFit(host: HTMLElement, view: JsonMapView): void {
    let tries = 0;
    const attempt = (): void => {
        if (view.fitted || !host.isConnected)
            return;
        if (fitJsonMap(host, view) || ++tries > 30)
            view.fitted = true;
        else
            requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
}

export function centerJsonMap(host: HTMLElement, view: JsonMapView): void {
    const layout = lastLayout.get(host)?.layout;
    const box = host.getBoundingClientRect();
    if (!layout || !box.width)
        return;
    view.camera.x = (box.width - layout.width * view.camera.scale) / 2;
    view.camera.y = (box.height - layout.height * view.camera.scale) / 2;
    applyCamera(host, view.camera);
}

/**
 * Folds or opens one branch and redraws.
 *
 * The fold lives on the model rather than on the element because the layout is rebuilt from the model on
 * every draw, and a fold that only existed in the DOM would be undone by the next keystroke anywhere in the
 * note.
 */
export function toggleJsonMapNode(document: JsonDocument, host: HTMLElement, view: JsonMapView, path: JsonPath, kept?: Set<string> | null): void {
    const node = walkTo(document.root, path);
    if (!node)
        return;
    setCollapsed(node, !node.collapsed);
    renderJsonMap(host, document, view, kept);
}

/** Folds or opens every container at once, which is how a reader gets a big document down to one screen. */
export function foldAllJsonMap(document: JsonDocument, host: HTMLElement, view: JsonMapView, collapsed: boolean, kept?: Set<string> | null): void {
    const walk = (node: JsonNode, depth: number): void => {
        if (isContainerNode(node) && depth > 0)
            node.collapsed = collapsed;
        for (const child of node.children ?? [])
            walk(child, depth + 1);
    };
    walk(document.root, 0);
    if (!collapsed)
        document.root.collapsed = false;
    renderJsonMap(host, document, view, kept);
}

function walkTo(root: JsonNode, path: JsonPath): JsonNode | null {
    let node = root;
    for (const segment of path) {
        const children = node.children;
        if (!children)
            return null;
        const next = typeof segment === 'number'
            ? children[segment]
            : children.find(child => child.key === segment);
        if (!next)
            return null;
        node = next;
    }
    return node;
}

/**
 * The map as a standalone SVG document.
 *
 * Built from the layout rather than by serializing the live DOM, because the live DOM is HTML boxes and a
 * stylesheet: a reader exporting the picture wants the picture, and taking the CSS with it would make the
 * file depend on this app's theme to read. The last layout is reused when it is still the one this host
 * drew, so exporting does not measure and place the document a second time.
 */
export function jsonMapSvg(document: JsonDocument, host: HTMLElement, kept?: Set<string> | null): string {
    const cached = lastLayout.get(host);
    const reuse = cached?.document === document ? cached : null;
    const measurer = reuse?.measurer ?? createMeasurer(host);
    const keep = kept ? (_node: JsonNode, path: JsonPath) => kept.has(pathKey(path)) : undefined;
    const layout = reuse?.layout ?? layoutFrom(measurer, document, keep);
    const colour = {
        page: measurer.colour(SVG_TOKENS.page, FALLBACK_COLOUR.page),
        card: measurer.colour(SVG_TOKENS.card, FALLBACK_COLOUR.card),
        edge: measurer.colour(SVG_TOKENS.edge, FALLBACK_COLOUR.edge),
        text: measurer.colour(SVG_TOKENS.text, FALLBACK_COLOUR.text),
        key: measurer.colour(SVG_TOKENS.key, FALLBACK_COLOUR.key),
        string: measurer.colour(SVG_TOKENS.string, FALLBACK_COLOUR.string),
        number: measurer.colour(SVG_TOKENS.number, FALLBACK_COLOUR.number),
        constant: measurer.colour(SVG_TOKENS.constant, FALLBACK_COLOUR.constant),
        faint: measurer.colour(SVG_TOKENS.faint, FALLBACK_COLOUR.faint),
        label: measurer.colour(SVG_TOKENS.label, FALLBACK_COLOUR.label),
    };
    const valueColour = (kind: string): string => kind === 'string'
        ? colour.string
        : kind === 'number'
            ? colour.number
            : kind === 'boolean'
                ? colour.constant
                : kind === 'null'
                    ? colour.faint
                    : colour.text;
    const font = `font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" dominant-baseline="central"`;
    const links = layout.links.map(link => {
        const path = `<path d="${mapLinkPath(link)}" fill="none" stroke="${colour.edge}" stroke-width="1.4"/>`;
        if (!link.label)
            return path;
        return `${path}<text x="${link.x}" y="${link.y}" font-family="ui-monospace, monospace" font-size="11" text-anchor="middle" dominant-baseline="central" fill="${colour.label}">${escapeXml(link.label)}</text>`;
    }).join('');
    const cards = layout.slots.map((slot) => {
        const rows = slot.rows.map((row) => {
            // The same line the HTML lays out, in the same order and with the same advances, so the
            // exported picture is the picture on screen rather than a reinterpretation of it.
            let x = slot.x + layout.cardPadding + 1;
            let mark = '';
            if (row.more)
                return `<text x="${x}" y="${row.y}" ${font} fill="${colour.label}">${escapeXml(row.value)}</text>`;
            if (row.branch)
                mark += `<text x="${x}" y="${row.y}" font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" fill="${colour.label}">${row.node.collapsed ? '+' : '−'}</text>`;
            x += HANDLE_WIDTH;
            if (row.key) {
                const named = `${row.key}: `;
                mark += `<text x="${x}" y="${row.y}" ${font}><tspan fill="${colour.key}">${escapeXml(named)}</tspan></text>`;
                x += measurer.width(named);
            }
            if (isColourText(row.node)) {
                mark += `<rect x="${x}" y="${row.y - 7}" width="14" height="14" rx="3" fill="${measurer.colour(String(row.node.value), '#000000')}"/>`;
                x += CHIP_WIDTH;
            }
            return `${mark}<text x="${x}" y="${row.y}" ${font} fill="${valueColour(row.node.kind)}">${escapeXml(row.value)}</text>`;
        }).join('');
        const frame = slot.rows.length > 0
            ? rows
            : `<text x="${slot.x + layout.cardPadding + 1}" y="${slot.y}" ${font} fill="${colour.label}">${escapeXml(t('preview.json_empty_container'))}</text>`;
        return `<rect x="${slot.x}" y="${slot.y - slot.h / 2}" width="${slot.w}" height="${slot.h}" rx="10" fill="${colour.card}" stroke="${colour.edge}" stroke-width="1"/>${frame}`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}"><rect width="${layout.width}" height="${layout.height}" fill="${colour.page}"/>${links}${cards}</svg>`;
}

/**
 * XML text, escaped.
 *
 * `& < > "` are the ones people remember, and the ones a note can break out of. The control characters are
 * the ones that silently ruin the file: XML 1.0 has no representation at all for U+0000 or most of
 * U+0001–U+001F, so a note holding a NUL — which a paste from a terminal happily produces — made the
 * exported SVG unparseable rather than merely odd-looking. They go to the same replacement character the
 * HTML parser uses.
 */
const XML_ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function escapeXml(value: string): string {
    return value
        .replace(XML_ILLEGAL, '\uFFFD')
        .replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}
