/**
 * The mind map view of a ```json block.
 *
 * The reference drew this with two hardcoded numbers — levels at `depth * 190`, connectors leaving the
 * parent at `parent.x + 160` — which is visible on its own demo page, where `structured editor` is wider
 * than the gap and every line starts inside the box it claims to leave. Geometry therefore comes from
 * `json-view/layout`, and this file only draws what it is told and handles the gestures.
 *
 * Three things the reference did that a preview of someone's note must not:
 *
 * - It added a `mousemove` and a `mouseup` listener to `window` on every render of the map and removed
 *   neither, so each visit to the tab leaked a pair that kept the previous canvas alive forever. Drag
 *   here is one `pointerdown` on the canvas with pointer capture, which the browser releases for us, and
 *   the rest are `addEventListener` on the host — which is a *new* element on every commit, a fact
 *   `leak.cjs` measured rather than assumed.
 * - Its wheel handler called `preventDefault()` unconditionally, so a reader whose pointer happened to be
 *   over the map could not scroll the note. Plain wheel scrolls; zoom needs the modifier.
 * - It kept no view state at all, so the picture jumped back to its origin whenever anything redrew it.
 *
 * The camera therefore lives in {@link JsonMapView}, which the caller owns and hands back on every draw.
 * It used to live in `host.dataset`, and because the preview replaces the host wholesale the reader's pan
 * was silently thrown away by any keystroke — the file's own comment claimed the opposite until it was
 * measured.
 */
import { t } from '../../lib/i18n';
import { escapeHtml } from '../../lib/markdown/renderer';
import type { JsonDocument, JsonNode, JsonPath } from '../../lib/markdown/json-view';
import {
    displaySummary,
    displayValue,
    isContainerNode,
    JSON_VIEW_MAX_MAP_NODES,
    layoutJsonMap,
    mapLinkPath,
    pathKey,
    setCollapsed,
    MAP_MAX_CHILDREN,
    type MapLayout,
} from '../../lib/markdown/json-view';

interface JsonMapCamera {
    x: number
    y: number
    scale: number
}

/**
 * What the map remembers between draws.
 *
 * `fitted` is why this object exists rather than a `data-` attribute: the first-frame "fit to view" used
 * to be guarded on `!host.dataset.jsonCamera`, and the same function wrote that attribute two lines
 * earlier, so the guard could never pass and a 1200-node map drew at 1:1 with 340px of it on screen.
 */
export interface JsonMapView {
    camera: JsonMapCamera
    fitted: boolean
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
/** A label this wide is cut with an ellipsis; the full text stays in the node's own tooltip. */
const LABEL_LIMIT = 46;
/** Node box padding, mirrored by the stylesheet's own border and padding. */
const NODE_CHROME = 22;
const NODE_HEIGHT = 30;

let measureContext: CanvasRenderingContext2D | null = null;

/**
 * A label measurer for one draw.
 *
 * `getComputedStyle` forces a style resolution, and the previous version called it once per node — 1201
 * resolutions for a 1200-key document. The font is read once here and reused, and it is read from a node
 * box rather than from the host so the number matches what will actually be painted.
 */
interface LabelMeasurer {
    measure: (label: string) => { w: number, h: number }
    background: string
    foreground: string
}

function createMeasurer(host: HTMLElement): LabelMeasurer {
    const style = getComputedStyle(host);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if (!measureContext)
        measureContext = document.createElement('canvas').getContext('2d');
    const context = measureContext;
    if (context)
        context.font = font;
    return {
        measure: (label) => {
            const width = context ? context.measureText(label).width : label.length * 7;
            return { w: Math.ceil(width) + NODE_CHROME, h: NODE_HEIGHT };
        },
        background: style.getPropertyValue('--bg-inset').trim() || '#ffffff',
        foreground: style.getPropertyValue('--text-primary').trim() || '#222222',
    };
}

/** What a node prints: `key : value`, with a container showing its shape rather than its contents. */
export function jsonMapLabel(node: JsonNode, depth: number, path: JsonPath, hidden = 0): string {
    // The root needs the same "+N" as any other container: a 120-key config draws 40 of them,
    // and a reader who is not told will read the picture as the whole document.
    if (depth === 0)
        return `root (${node.children?.length ?? 0})${hidden > 0 ? ` +${hidden}` : ''}`;
    const value = isContainerNode(node)
        ? `${displaySummary(node)}${hidden > 0 ? ` +${hidden}` : ''}`
        : displayValue(node, LABEL_LIMIT);
    const key = node.key === null ? String(path[path.length - 1] ?? '') : node.key;
    return `${key} : ${value}`;
}

function applyCamera(host: HTMLElement, camera: JsonMapCamera): void {
    const canvas = host.querySelector<HTMLElement>('[data-json-map-canvas]');
    if (canvas)
        canvas.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
}

/** The layout from the last draw, so an export does not measure and place the whole map a second time. */
const lastLayout = new WeakMap<HTMLElement, { document: JsonDocument, layout: MapLayout }>();

/**
 * Draws the map, or redraws it after a fold, a pan or a zoom.
 *
 * `view` is the caller's, not ours: it survives the preview replacing this host element, which is what
 * keeps the reader's camera and the fit decision alive across a keystroke in the other pane.
 */
export function renderJsonMap(host: HTMLElement, document: JsonDocument, view: JsonMapView): void {
    const measurer = createMeasurer(host);
    const paths = pathIndexFor(document);
    const layout = layoutJsonMap(document.root, {
        maxNodes: JSON_VIEW_MAX_MAP_NODES,
        measure: (node, depth) => measurer.measure(jsonMapLabel(node, depth, paths.get(node) ?? [], hiddenOf(node))),
    });
    lastLayout.set(host, { document, layout });
    const links = layout.slots
        .filter(slot => slot.parent)
        .map(slot => `<path d="${mapLinkPath(slot.parent!, slot)}"/>`)
        .join('');
    const nodes = layout.slots.map(slot => nodeHtml(slot)).join('');
    host.innerHTML = [
        layout.truncated ? `<p class="json-view-note">${escapeHtml(t('preview.json_map_limit', { max: JSON_VIEW_MAX_MAP_NODES }))}</p>` : '',
        '<div class="jm-canvas" data-json-map-canvas>',
        `<svg class="jm-links" width="${layout.width}" height="${layout.height}" aria-hidden="true">${links}</svg>`,
        nodes,
        '</div>',
    ].join('');
    if (!view.fitted) {
        view.fitted = true;
        fitJsonMap(host, view);
    }
    applyCamera(host, view.camera);
    installMapGestures(host, view);
}

/** How many members the drawing left out of a container, mirroring the layout's own ceiling. */
function hiddenOf(node: JsonNode): number {
    return Math.max(0, (node.children?.length ?? 0) - MAP_MAX_CHILDREN);
}

function nodeHtml(slot: { node: JsonNode, path: JsonPath, depth: number, x: number, y: number, w: number, h: number, hiddenChildren: number, collapsed: boolean }): string {
    const label = jsonMapLabel(slot.node, slot.depth, slot.path, slot.hiddenChildren);
    const fold = isContainerNode(slot.node) && (slot.node.children?.length ?? 0) > 0
        ? `<button type="button" class="jm-fold" data-jm="fold" aria-label="${escapeHtml(t(slot.collapsed ? 'preview.json_expand' : 'preview.json_fold'))}" aria-expanded="${String(!slot.collapsed)}">${slot.collapsed ? '+' : '−'}</button>`
        : '';
    return `<div class="jm-node jm-node--${slot.node.kind}${slot.collapsed ? ' is-collapsed' : ''}" data-jm-path="${escapeHtml(pathKey(slot.path))}"`
      + ` style="left:${slot.x}px; top:${slot.y - slot.h / 2}px; width:${slot.w}px; height:${slot.h}px"`
      + ` title="${escapeHtml(label)}" role="button" tabindex="0">`
      + `<span class="jm-label">${escapeHtml(label)}</span>${fold}</div>`;
}

/**
 * The path of every node, indexed once per document.
 *
 * `measure` needs the array index of an element to label it, and asking for it during the walk would make
 * layout quadratic in the number of siblings. The index is built here instead, on the first draw of a
 * document, and reused until the document object changes.
 */
const pathIndexes = new WeakMap<JsonDocument, Map<JsonNode, JsonPath>>();

function pathIndexFor(document: JsonDocument): Map<JsonNode, JsonPath> {
    let index = pathIndexes.get(document);
    if (!index) {
        index = new Map<JsonNode, JsonPath>();
        const walk = (node: JsonNode, path: JsonPath): void => {
            index!.set(node, path);
            (node.children ?? []).forEach((child, position) => {
                walk(child, [...path, node.kind === 'array' ? position : (child.key ?? '')]);
            });
        };
        walk(document.root, []);
        pathIndexes.set(document, index);
    }
    return index;
}

/**
 * Pan, zoom and the double-click that hands a node to the tree.
 *
 * The drag handlers go on `on*` properties and the rest on `addEventListener`, all on the host. That is
 * safe here because the preview hands this function a fresh element on every commit — measured, not
 * assumed: wrapping `addEventListener` counts one `wheel`, one `dblclick` and one `keydown` after four
 * edits and after three different notes.
 */
function installMapGestures(host: HTMLElement, view: JsonMapView): void {
    if (!host.querySelector('[data-json-map-canvas]'))
        return;
    const camera = view.camera;
    let drag: { pointerId: number, x: number, y: number, left: number, top: number } | null = null;

    host.onpointerdown = (event: PointerEvent) => {
        if ((event.target as Element).closest('.jm-node'))
            return;
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: camera.x, top: camera.y };
        host.setPointerCapture(event.pointerId);
        host.classList.add('is-dragging');
    };
    host.onpointermove = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId)
            return;
        camera.x = drag.left + (event.clientX - drag.x);
        camera.y = drag.top + (event.clientY - drag.y);
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
        const node = (event.target as Element).closest<HTMLElement>('[data-jm-path]');
        if (!node)
            return;
        event.preventDefault();
        let path: JsonPath = [];
        try {
            const parsed: unknown = JSON.parse(node.dataset.jmPath ?? '[]');
            if (Array.isArray(parsed))
                path = parsed as JsonPath;
        }
        catch {
            return;
        }
        host.dispatchEvent(new CustomEvent('jsonmapopen', { bubbles: true, composed: true, detail: path }));
    });

    host.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.target !== host && !(event.target as Element).closest?.('.jm-node'))
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
 * Scales and slides the map so all of it fits the box.
 *
 * The result is clamped to the same floor the zoom uses: a 1200-sibling document is 48 022px tall, and
 * fitting that honestly would ask for a scale of 0.007 — a picture of nothing. The reader gets the
 * smallest legible view and pans the rest.
 */
export function fitJsonMap(host: HTMLElement, view: JsonMapView): void {
    const box = host.getBoundingClientRect();
    const layout = lastLayout.get(host)?.layout;
    if (!layout || !box.width || !box.height)
        return;
    const scale = clampScale(Math.min(1, (box.width - 24) / layout.width, (box.height - 24) / layout.height));
    view.camera = {
        scale,
        x: (box.width - layout.width * scale) / 2,
        y: (box.height - layout.height * scale) / 2,
    };
    applyCamera(host, view.camera);
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
 * drew, so exporting does not measure and place 1200 nodes a second time.
 */
export function jsonMapSvg(document: JsonDocument, host: HTMLElement): string {
    const cached = lastLayout.get(host);
    const measurer = createMeasurer(host);
    const layout = cached?.document === document
        ? cached.layout
        : layoutJsonMap(document.root, {
            maxNodes: JSON_VIEW_MAX_MAP_NODES,
            measure: (node, depth) => measurer.measure(jsonMapLabel(node, depth, pathIndexFor(document).get(node) ?? [], hiddenOf(node))),
        });
    // The two colours come from this app's own tokens, and a CSS custom property is a bare value: an
    // unquoted attribute would let anything unexpected in there break out of the SVG instead of it.
    const background = safeColour(measurer.background);
    const foreground = safeColour(measurer.foreground);
    const links = layout.slots
        .filter(slot => slot.parent)
        .map(slot => `<path d="${mapLinkPath(slot.parent!, slot)}" fill="none" stroke="${foreground}" stroke-opacity="0.35" stroke-width="1.5"/>`)
        .join('');
    const nodes = layout.slots.map(slot => [
        '<g>',
        `<rect x="${slot.x}" y="${slot.y - slot.h / 2}" width="${slot.w}" height="${slot.h}" rx="6"`,
        ` fill="${background}" stroke="${isContainerNode(slot.node) ? foreground : 'none'}"/>`,
        `<text x="${slot.x + 11}" y="${slot.y + 4}" font-family="ui-monospace, monospace" font-size="12"`,
        ` fill="${foreground}">${escapeXml(jsonMapLabel(slot.node, slot.depth, slot.path, slot.hiddenChildren))}</text>`,
        '</g>',
    ].join('')).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${links}${nodes}</svg>`;
}

/** A colour a generated SVG may carry, or the fallback. Anything else is not painted. */
function safeColour(value: string): string {
    return /^#[\da-fA-F]{3,8}$/.test(value) || /^(rgb|rgba|hsl|hsla)\(/.test(value) || /^[a-zA-Z]+$/.test(value) ? value : '#000000';
}

/**
 * XML text, escaped.
 *
 * `& < > "` are the ones people remember, and the ones a note can actually break out of. The control
 * characters are the ones that silently ruin the file: XML 1.0 has no representation at all for U+0000
 * or for most of U+0001–U+001F, so a note holding a NUL — which a paste from a terminal happily
 * produces — made the exported SVG unparseable rather than merely odd-looking. They go to the same
 * replacement character the HTML parser uses, so the picture matches the on-screen row.
 */
const XML_ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function escapeXml(value: string): string {
    return value
        .replace(XML_ILLEGAL, '\uFFFD')
        .replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}
