/**
 * The mind map view of a ```json block, drawn as cards.
 *
 * A container is one card; each member is a line inside it; only a member that is itself a container gets
 * a card to the right, and the name that produced it is written on the connector instead of being repeated
 * at the head of the child's box. Geometry is `json-view/layout`'s job; this file paints what it is told
 * and handles the gestures.
 *
 * Three things the reference did that a preview of someone's note must not:
 *
 * - It added a `mousemove` and a `mouseup` listener to `window` on every render of the map and removed
 *   neither, so each visit to the tab leaked a pair that kept the previous canvas alive forever. Drag
 *   here is one `pointerdown` on the canvas with pointer capture, which the browser releases for us.
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
    displaySummary,
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
const HANDLE_WIDTH = 20;
/** The colour swatch and the gap after it, which only a row holding a colour pays for. */
const SWATCH_WIDTH = 17;
/**
 * The two 1px borders a card's `box-sizing: border-box` width has to share its rows with.
 *
 * The layout sizes a card as `widest row + 2 × padding`; the stylesheet positions rows inside the border,
 * so leaving the border out of the arithmetic makes the widest row of every card ellipsize. Measured in a
 * browser at exactly these numbers, not inferred.
 */
const CARD_BORDER = 2;
/** The prose styles set this; the export repeats whatever the host actually computes. */
const DEFAULT_FONT_SIZE = 11.5;

/**
 * The theme colours the export needs, resolved once per draw.
 *
 * The HTML gets its colours from classes, so only a generated SVG has to name them literally. Reading
 * `getPropertyValue('--syntax-string')` would hand back whatever the theme wrote — `oklch()`, a
 * `color-mix()`, a `var()` chain — and a `.svg` opened in a viewer that predates those is a black map.
 * The canvas serializes any colour it accepts back to `#rrggbb` in sRGB, so the file carries a colour
 * every reader understands and still matches the theme the reader is looking at.
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
    label: '--text-tertiary',
} as const;

const FALLBACK_COLOUR: Record<keyof typeof SVG_TOKENS, string> = {
    page: '#fafafa',
    card: '#ffffff',
    edge: '#d0d0d0',
    text: '#222222',
    key: '#005cc5',
    string: '#0a7d33',
    number: '#b75f00',
    constant: '#8250df',
    faint: '#999999',
    label: '#666666',
};

/**
 * One 1×1 canvas, used both to measure a run of text and to ask what a colour actually is.
 *
 * It stays at one pixel because `getImageData` of a full canvas would be a buffer the preview holds for
 * no reason; the font state is re-set on every draw anyway.
 */
let measureContext: CanvasRenderingContext2D | null = null;

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
    /** `token` as a literal `#rrggbb` an exported SVG may carry, or `fallback` if it cannot be resolved. */
    colour: (token: string, fallback: string) => string
}

/**
 * A measurer for one draw.
 *
 * `getComputedStyle` forces a style resolution, so the font is read once per draw rather than once per
 * row — the version before this one asked the browser 1201 times for a 1200-node document. It is read
 * from the host, which carries the mono font the rows inherit, so a row is measured in the type it
 * paints in.
 */
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
 * value from inside the note travels the same path, an exported map cannot be made to carry a `"` or a `<`
 * in a fill. And reading the pixel back is what gets hex: `fillStyle` hands a wide-gamut colour straight
 * back as `oklch(...)`, which a modern browser paints fine but a 2016-era viewer shows as black, so the
 * exported file would depend on the reader's software as much as the live view depends on this app's theme.
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

/** The text a card lists for one member: a container by its size, a scalar by its value. */
function jsonMapValue(node: JsonNode, hidden: number): string {
    if (isContainerNode(node))
        return `${displaySummary(node)}${hidden > 0 ? ` +${hidden}` : ''}`;
    return displayValue(node, VALUE_LIMIT);
}

function applyCamera(host: HTMLElement, camera: JsonMapCamera): void {
    const canvas = host.querySelector<HTMLElement>('[data-json-map-canvas]');
    if (canvas)
        canvas.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    // A detail card belongs to the row it was opened from. Every camera change is a place where that row
    // stops being where the card says it is, so the card goes with the movement rather than drifting.
    host.querySelector('[data-json-detail]')?.remove();
}

/** The layout from the last draw, so an export or a detail card does not place the map again. */
const lastLayout = new WeakMap<HTMLElement, { document: JsonDocument, layout: MapLayout, measurer: Measurer }>();

/**
 * Draws the map, or redraws it after a fold, a pan or a zoom.
 *
 * `view` is the caller's, not ours: it survives the preview replacing this host element, which is what
 * keeps the reader's camera and the fit decision alive across a keystroke in the other pane.
 */
export function renderJsonMap(host: HTMLElement, document: JsonDocument, view: JsonMapView): void {
    const measurer = createMeasurer(host);
    const layout = layoutFrom(measurer, document);
    lastLayout.set(host, { document, layout, measurer });
    const links = layout.links
        .map(link => `<path class="jm-link" d="${mapLinkPath(link)}"/>`)
        .join('');
    const labels = layout.links
        .filter(link => link.label)
        .map(link => `<text class="jm-edge-label" x="${link.x}" y="${link.y}">${escapeHtml(link.label)}</text>`)
        .join('');
    const cards = layout.slots.map(slot => cardHtml(slot, layout)).join('');
    host.innerHTML = [
        layout.truncated ? `<p class="json-view-note">${escapeHtml(t('preview.json_map_limit', { max: JSON_VIEW_MAX_MAP_NODES }))}</p>` : '',
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
    if (!view.fitted) {
        if (fitJsonMap(host, view))
            view.fitted = true;
        else
            scheduleFit(host, view);
    }
    applyCamera(host, view.camera);
    installMapGestures(host, view);
}

function layoutFrom(measurer: Measurer, document: JsonDocument): MapLayout {
    return layoutJsonMap(document.root, {
        maxNodes: JSON_VIEW_MAX_MAP_NODES,
        valueFor: (node, hidden) => jsonMapValue(node, hidden),
        measure: row => Math.ceil(measurer.width(row.label))
          + (row.branch ? HANDLE_WIDTH : 0)
          + (isColourText(row.node) ? SWATCH_WIDTH : 0)
          + CARD_BORDER,
    });
}

/** A card with nothing to list: a container that holds no members, said plainly. */
function emptyRowHtml(layout: MapLayout): string {
    return `<div class="jm-row jm-row--empty" style="top:${layout.cardPadding}px; height:${layout.rowHeight}px">`
      + `<span class="jm-empty">${escapeHtml(t('preview.json_empty_container'))}</span></div>`;
}

function cardHtml(slot: MapSlot, layout: MapLayout): string {
    const rows = slot.rows.length > 0
        ? slot.rows.map(row => rowHtml(row, slot, layout)).join('')
        : emptyRowHtml(layout);
    return `<div class="jm-card jm-card--${slot.node.kind}"`
      + ` tabindex="0" role="group" aria-label="${escapeHtml(slot.edgeLabel || t('preview.json_view_map'))}"`
      + ` data-jm-path="${escapeHtml(pathKey(slot.path))}"`
      + ` style="left:${slot.x}px; top:${slot.y - slot.h / 2}px; width:${slot.w}px; height:${slot.h}px">`
      + rows
      + '</div>';
}

function rowHtml(row: MapRow, slot: MapSlot, layout: MapLayout): string {
    const top = row.y - (slot.y - slot.h / 2) - layout.rowHeight / 2;
    const style = ` style="top:${top}px; height:${layout.rowHeight}px; left:${layout.cardPadding}px; right:${layout.cardPadding}px"`;
    if (row.more) {
        // The card is narrower than the document, and says by how much rather than letting the reader
        // count what is on screen and conclude that is all there is.
        return `<div class="jm-row jm-row--more" data-jm-path="${escapeHtml(pathKey(row.path))}"${style}>`
          + `<span class="jm-more">${escapeHtml(row.value)}</span></div>`;
    }
    const node = row.node;
    const swatch = isColourText(node)
        ? `<span class="jm-swatch" style="background:${escapeHtml(String(node.value))}"></span>`
        : '';
    const fold = row.branch
        ? `<button type="button" class="jm-fold" data-jm="fold" data-jm-path="${escapeHtml(pathKey(row.path))}"`
          + ` aria-label="${escapeHtml(t(node.collapsed ? 'preview.json_expand' : 'preview.json_fold'))}"`
          + ` aria-expanded="${String(!node.collapsed)}">${node.collapsed ? '+' : '−'}</button>`
        : '';
    // The layout leaves `key` empty for exactly the rows whose name it put on a connector, so the painter
    // printing whatever is there cannot duplicate the name — and cannot lose it on a folded branch either.
    // The ` : ` is part of the key span rather than a node of its own so the row paints the same character
    // run the card was measured from; a separator element would add advances the layout never counted.
    const name = row.key
        ? `<span class="jm-key">${escapeHtml(`${row.key} : `)}</span>`
        : '';
    return `<div class="jm-row${row.branch ? ' jm-row--branch' : ''}" data-jm-path="${escapeHtml(pathKey(row.path))}"${style}>`
      + fold
      + name
      + `<span class="jm-value jm-value--${node.kind}">${swatch}${escapeHtml(row.value)}</span>`
      + '</div>';
}

/**
 * Pan, zoom and the click that opens a row's detail card.
 *
 * Every listener is on the host, and the drag uses pointer capture. That is safe because the preview hands
 * this function a fresh element on every commit — measured, not assumed: wrapping `addEventListener`
 * counts one `wheel`, one `dblclick` and one `keydown` after four edits and after three different notes.
 */
function installMapGestures(host: HTMLElement, view: JsonMapView): void {
    if (!host.querySelector('[data-json-map-canvas]'))
        return;
    const camera = view.camera;
    let drag: { pointerId: number, x: number, y: number, left: number, top: number } | null = null;

    host.onpointerdown = (event: PointerEvent) => {
        // Text inside an open detail card is there to be selected, not to start a pan; and a press on a
        // card is a press on a member, which the block's own click route answers.
        if ((event.target as Element).closest('.jm-detail, .jm-card'))
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
        // also close whatever card the reader was reading.
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

    host.addEventListener('wheel', (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey)
            return;
        event.preventDefault();
        zoomJsonMap(host, view, event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
    }, { passive: false });

    host.addEventListener('dblclick', (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-jm-path]');
        const path = row ? parsePath(row.dataset.jmPath) : null;
        if (!path || path.length === 0)
            return;
        event.preventDefault();
        host.dispatchEvent(new CustomEvent('jsonmapopen', { bubbles: true, composed: true, detail: path }));
    });

    host.addEventListener('keydown', (event: KeyboardEvent) => {
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
        if (event.key === 'Escape') {
            if (!host.querySelector('[data-json-detail]'))
                return;
            event.preventDefault();
            closeJsonDetail(host);
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
 * The card that opens when a row is clicked: that member's own JSON, and the path that names it.
 *
 * Both are offered for copying because they answer two different questions. The subtree is what a reader
 * pastes into a request; the path is what they type into `jq` or point a colleague at. The subtree text
 * comes from `writeJsonNode`, so an untouched member copies out exactly as the note holds it — `1.0` and
 * a twenty-digit id included.
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
    // The path rides on the card so the two copy buttons resolve their text from the press itself: a note
    // can hold two ```json blocks, and text parked on a module slot would be whichever card opened last.
    card.dataset.jmPath = pathKey(path);
    card.tabIndex = -1;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', t('preview.json_detail_title'));
    const box = anchor.getBoundingClientRect();
    const own = host.getBoundingClientRect();
    card.style.left = `${Math.min(Math.max(8, box.right - own.left + 10), Math.max(8, own.width - 280))}px`;
    card.style.top = `${Math.min(Math.max(8, box.top - own.top), Math.max(8, own.height - 140))}px`;
    const id = `jm-detail-path-${pathKey(path).replace(/[^\w-]/g, '')}`;
    card.innerHTML = [
        '<div class="jm-detail-head">',
        `<span class="jm-detail-title">${escapeHtml(t('preview.json_detail_title'))}</span>`,
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
    card.focus();
}

export function closeJsonDetail(host: HTMLElement): void {
    host.querySelector('[data-json-detail]')?.remove();
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
 * Clamped to the same floor the zoom uses: a wide document can ask for a scale of 0.007, which is a
 * picture of nothing. The reader gets the smallest legible view and pans the rest.
 *
 * A box of zero is the answer a host gives before the browser has laid it out, and the first draw can
 * happen in exactly that frame — so this declines rather than recording a fit, and the caller retries.
 * Marking the view fitted on a declined attempt is what left a 1200-key card parked at 1:1 with 1 084px
 * of it in a 340px window.
 */
export function fitJsonMap(host: HTMLElement, view: JsonMapView): boolean {
    const box = host.getBoundingClientRect();
    const layout = lastLayout.get(host)?.layout;
    if (!layout || !box.width || !box.height)
        return false;
    const scale = clampScale(Math.min(1, (box.width - 24) / layout.width, (box.height - 24) / layout.height));
    view.camera = {
        scale,
        x: (box.width - layout.width * scale) / 2,
        y: (box.height - layout.height * scale) / 2,
    };
    applyCamera(host, view.camera);
    return true;
}

/**
 * Keeps asking for a frame in which the host has a size, for at most half a second.
 *
 * A `ResizeObserver` would be the other answer and is the wrong one: it holds its targets alive, so an
 * observer kept at module level would pin every host the preview ever replaced — the same leak the
 * reference shipped with its window listeners. This gives up, and the block's own fit tool remains.
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
 * every draw, and a fold that only existed in the DOM would be undone by the next keystroke anywhere in
 * the note.
 */
export function toggleJsonMapNode(document: JsonDocument, host: HTMLElement, view: JsonMapView, path: JsonPath): void {
    const node = walkTo(document.root, path);
    if (!node)
        return;
    setCollapsed(node, !node.collapsed);
    renderJsonMap(host, document, view);
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
export function jsonMapSvg(document: JsonDocument, host: HTMLElement): string {
    const cached = lastLayout.get(host);
    const reuse = cached?.document === document ? cached : null;
    const measurer = reuse?.measurer ?? createMeasurer(host);
    const layout = reuse?.layout ?? layoutFrom(measurer, document);
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
    const links = layout.links.map((link) => {
        const path = `<path d="${mapLinkPath(link)}" fill="none" stroke="${colour.edge}" stroke-width="1.4"/>`;
        if (!link.label)
            return path;
        return `${path}<text x="${link.x}" y="${link.y}" font-family="ui-monospace, monospace" font-size="11" text-anchor="middle" dominant-baseline="central" fill="${colour.label}">${escapeXml(link.label)}</text>`;
    }).join('');
    const cards = layout.slots.map((slot) => {
        const rows = slot.rows.map((row) => {
            // The same line the HTML lays out, in the same order and with the same advances, so the
            // exported picture is the picture on screen rather than a reinterpretation of it.
            // One pixel further in than the layout's own padding, because the HTML card paints its rows
            // inside a 1px border and the export has to land on the same column.
            let x = slot.x + layout.cardPadding + 1;
            let mark = '';
            if (row.more)
                return `<text x="${x}" y="${row.y}" font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" dominant-baseline="central" fill="${colour.label}">${escapeXml(row.value)}</text>`;
            if (row.branch) {
                mark += `<text x="${x}" y="${row.y}" font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" fill="${colour.label}">${row.node.collapsed ? '+' : '−'}</text>`;
                x += HANDLE_WIDTH;
            }
            if (row.key) {
                const name = `${row.key} : `;
                mark += `<text x="${x}" y="${row.y}" font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" dominant-baseline="central">`
                  + `<tspan fill="${colour.key}">${escapeXml(row.key)}</tspan><tspan fill="${colour.text}"> : </tspan></text>`;
                x += measurer.width(name);
            }
            if (isColourText(row.node)) {
                mark += `<rect x="${x}" y="${row.y - 6}" width="12" height="12" rx="2" fill="${measurer.colour(String(row.node.value), '#000000')}"/>`;
                x += SWATCH_WIDTH;
            }
            return `${mark}<text x="${x}" y="${row.y}" font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" dominant-baseline="central" fill="${valueColour(row.node.kind)}">${escapeXml(row.value)}</text>`;
        }).join('');
        const frame = slot.rows.length > 0
            ? rows
            : `<text x="${slot.x + layout.cardPadding + 1}" y="${slot.y}" font-family="ui-monospace, monospace" font-size="${measurer.fontSize}" dominant-baseline="central" fill="${colour.label}">${escapeXml(t('preview.json_empty_container'))}</text>`;
        return `<rect x="${slot.x}" y="${slot.y - slot.h / 2}" width="${slot.w}" height="${slot.h}" rx="9" fill="${colour.card}" stroke="${colour.edge}" stroke-width="1"/>${frame}`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}"><rect width="${layout.width}" height="${layout.height}" fill="${colour.page}"/>${links}${cards}</svg>`;
}

/**
 * XML text, escaped.
 *
 * `& < > "` are the ones people remember, and the ones a note can break out of. The control characters
 * are the ones that silently ruin the file: XML 1.0 has no representation at all for U+0000 or most of
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
