/**
 * The mind map view of a ```json block.
 *
 * The reference drew this with two hardcoded numbers — levels at `depth * 190`, connectors leaving the
 * parent at `parent.x + 160` — which is visible on its own demo page, where `structured editor` is wider
 * than the gap and every line starts inside the box it claims to leave. Geometry therefore comes from
 * `json-view/layout`, and this file only draws what it is told and handles the gestures.
 *
 * Two things the reference did that a preview of someone's note must not:
 *
 * - It added a `mousemove` and a `mouseup` listener to `window` on every render of the map and removed
 *   neither, so each visit to the tab leaked a pair that kept the previous canvas alive forever. Drag
 *   here is one `pointerdown` on the canvas with pointer capture, which the browser releases for us.
 * - Its wheel handler called `preventDefault()` unconditionally, so a reader whose pointer happened to be
 *   over the map could not scroll the note. Plain wheel pans; zoom needs the modifier the rest of the
 *   app already uses for it.
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
} from '../../lib/markdown/json-view';

export interface JsonMapCamera {
    x: number
    y: number
    scale: number
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
/** A label this wide is cut with an ellipsis; the full text stays in the node's own tooltip. */
const LABEL_LIMIT = 46;

/**
 * Node boxes are measured, not guessed.
 *
 * The measure has to come from the same font the stylesheet will paint with, so the canvas is measured
 * once per label rather than estimated from a character count — the reference's `depth * 190` was an
 * estimate, and it is why its levels collided.
 */
let measureContext: CanvasRenderingContext2D | null = null;

function measureFont(host: HTMLElement): string {
    const style = getComputedStyle(host);
    return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function measureLabel(host: HTMLElement, label: string): { w: number, h: number } {
    if (!measureContext) {
        const canvas = document.createElement('canvas');
        measureContext = canvas.getContext('2d');
    }
    const font = measureFont(host);
    if (measureContext && measureContext.font !== font)
        measureContext.font = font;
    const text = measureContext?.measureText(label).width ?? label.length * 7;
    return { w: Math.ceil(text) + 22, h: 30 };
}

/** What a node prints: `key : value`, with a container showing its shape rather than its contents. */
export function jsonMapLabel(node: JsonNode, depth: number, path: JsonPath): string {
    if (depth === 0)
        return `root (${node.children?.length ?? 0})`;
    const value = isContainerNode(node) ? displaySummary(node) : displayValue(node, LABEL_LIMIT);
    const key = node.key === null ? String(path[path.length - 1] ?? '') : node.key;
    return `${key} : ${value}`;
}

function readCamera(host: HTMLElement): JsonMapCamera {
    const raw = host.dataset.jsonCamera ?? '';
    const parts = raw.split(',').map(Number);
    if (parts.length === 3 && parts.every(part => Number.isFinite(part)))
        return { x: parts[0]!, y: parts[1]!, scale: parts[2]! };
    return { x: 0, y: 0, scale: 1 };
}

function writeCamera(host: HTMLElement, camera: JsonMapCamera): void {
    host.dataset.jsonCamera = `${camera.x},${camera.y},${camera.scale}`;
    const canvas = host.querySelector<HTMLElement>('[data-json-map-canvas]');
    if (canvas)
        canvas.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
}

/**
 * Draws the map, or redraws it after a fold.
 *
 * `host` keeps the camera in its own `data-` attribute rather than in a module map, because the preview
 * replaces this element wholesale on every commit and the reader's pan should survive a keystroke in the
 * other pane.
 */
export function renderJsonMap(host: HTMLElement, document: JsonDocument): void {
    const camera = readCamera(host);
    const layout = layoutJsonMap(document.root, {
        maxNodes: JSON_VIEW_MAX_MAP_NODES,
        measure: (node, depth) => measureLabel(host, jsonMapLabel(node, depth, nodePathOf(node, document, depth))),
    });
    const links = layout.slots
        .filter(slot => slot.parent)
        .map(slot => `<path d="${mapLinkPath(slot.parent!, slot)}"/>`)
        .join('');
    const nodes = layout.slots.map(slot => nodeHtml(slot.node, slot.path, slot.depth, slot.x, slot.y, slot.w, slot.h, layout.truncated)).join('');
    host.innerHTML = [
        layout.truncated ? `<p class="json-view-note">${escapeHtml(t('preview.json_map_limit', { max: JSON_VIEW_MAX_MAP_NODES }))}</p>` : '',
        `<div class="jm-canvas" data-json-map-canvas>`,
        `<svg class="jm-links" width="${layout.width}" height="${layout.height}" aria-hidden="true">${links}</svg>`,
        nodes,
        '</div>',
    ].join('');
    host.dataset.jsonExtent = `${layout.width},${layout.height}`;
    writeCamera(host, camera);
    installMapGestures(host, camera);
}

/**
 * The path a slot was drawn from.
 *
 * The layout already carries it; this exists because `measure` runs before a slot does, and the label of
 * an array element needs its index. Walking the tree once per measure would make layout quadratic in the
 * number of siblings, so the document is indexed by node identity the first time it is asked for.
 */
let pathIndex: WeakMap<JsonNode, JsonPath> | null = null;
let pathIndexFor: JsonDocument | null = null;

function nodePathOf(node: JsonNode, document: JsonDocument, depth: number): JsonPath {
    if (depth === 0)
        return [];
    if (pathIndexFor !== document) {
        const map = new WeakMap<JsonNode, JsonPath>();
        const walk = (current: JsonNode, path: JsonPath): void => {
            map.set(current, path);
            (current.children ?? []).forEach((child, index) => {
                walk(child, [...path, current.kind === 'array' ? index : (child.key ?? '')]);
            });
        };
        walk(document.root, []);
        pathIndex = map;
        pathIndexFor = document;
    }
    return pathIndex?.get(node) ?? [];
}

function nodeHtml(
    node: JsonNode,
    path: JsonPath,
    depth: number,
    x: number,
    y: number,
    w: number,
    h: number,
    truncated: boolean,
): string {
    const label = jsonMapLabel(node, depth, path);
    const fold = isContainerNode(node) && (node.children?.length ?? 0) > 0 && !truncated
        ? `<button type="button" class="jm-fold" data-jm="fold" aria-label="${escapeHtml(t(node.collapsed ? 'preview.json_expand' : 'preview.json_fold'))}" aria-expanded="${String(!node.collapsed)}">${node.collapsed ? '+' : '−'}</button>`
        : '';
    return `<div class="jm-node jm-node--${node.kind}${node.collapsed ? ' is-collapsed' : ''}" data-jm-path="${escapeHtml(pathKey(path))}"`
      + ` style="left:${x}px; top:${y - h / 2}px; width:${w}px; height:${h}px"`
      + ` title="${escapeHtml(label)}" role="button" tabindex="0">`
      + `<span class="jm-label">${escapeHtml(label)}</span>${fold}</div>`;
}

/**
 * Pan, zoom and the double-click that hands a node to the tree.
 *
 * Every listener is on the host, and the drag uses pointer capture, so a redraw does not accumulate
 * handlers — the failure mode the reference had, where each visit to the tab left another pair of
 * `window` listeners pointing at a canvas that had already been thrown away.
 */
function installMapGestures(host: HTMLElement, camera: JsonMapCamera): void {
    const canvas = host.querySelector<HTMLElement>('[data-json-map-canvas]');
    if (!canvas)
        return;
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
        writeCamera(host, camera);
    };
    const release = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId)
            return;
        drag = null;
        host.classList.remove('is-dragging');
        if (host.hasPointerCapture(event.pointerId))
            host.releasePointerCapture(event.pointerId);
        writeCamera(host, camera);
    };
    host.onpointerup = release;
    host.onpointercancel = release;

    host.addEventListener('wheel', (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey)
            return;
        event.preventDefault();
        zoomJsonMap(host, event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
    }, { passive: false });

    host.addEventListener('dblclick', (event: MouseEvent) => {
        const node = (event.target as Element).closest<HTMLElement>('[data-jm-path]');
        if (!node)
            return;
        event.preventDefault();
        host.dispatchEvent(new CustomEvent('jsonmapopen', {
            bubbles: true,
            composed: true,
            detail: JSON.parse(node.dataset.jmPath ?? '[]') as JsonPath,
        }));
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
        writeCamera(host, camera);
    });

    if (!host.dataset.jsonCamera)
        fitJsonMap(host);
}

/** Zooms about a screen point, so the content under the pointer stays under it. */
export function zoomJsonMap(host: HTMLElement, factor: number, clientX?: number, clientY?: number): void {
    const camera = readCamera(host);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
    const box = host.getBoundingClientRect();
    const px = (clientX ?? box.left + box.width / 2) - box.left;
    const py = (clientY ?? box.top + box.height / 2) - box.top;
    const ratio = next / camera.scale;
    camera.x = px - (px - camera.x) * ratio;
    camera.y = py - (py - camera.y) * ratio;
    camera.scale = next;
    writeCamera(host, camera);
}

/** Scales and slides the map so all of it fits the box. */
export function fitJsonMap(host: HTMLElement, width = 0, height = 0): void {
    const box = host.getBoundingClientRect();
    const [extentW = 0, extentH = 0] = (host.dataset.jsonExtent ?? '').split(',').map(Number);
    width ||= extentW;
    height ||= extentH;
    if (!width || !height || !box.width || !box.height)
        return;
    const scale = Math.min(MAX_SCALE, Math.min(1, (box.width - 24) / width, (box.height - 24) / height));
    writeCamera(host, {
        scale,
        x: (box.width - width * scale) / 2,
        y: (box.height - height * scale) / 2,
    });
}

export function centerJsonMap(host: HTMLElement): void {
    const canvas = host.querySelector<HTMLElement>('[data-json-map-canvas]');
    if (!canvas)
        return;
    const box = host.getBoundingClientRect();
    const camera = readCamera(host);
    writeCamera(host, {
        ...camera,
        x: (box.width - canvas.offsetWidth * camera.scale) / 2,
        y: (box.height - canvas.offsetHeight * camera.scale) / 2,
    });
}

/**
 * Folds or opens one branch and redraws.
 *
 * The fold lives on the model rather than on the element because the layout is rebuilt from the model on
 * every draw, and a fold that only existed in the DOM would be undone by the next keystroke anywhere in
 * the note.
 */
export function toggleJsonMapNode(document: JsonDocument, host: HTMLElement, path: JsonPath): void {
    const node = walkTo(document.root, path);
    if (!node)
        return;
    setCollapsed(node, !node.collapsed);
    renderJsonMap(host, document);
}

function walkTo(root: JsonNode, path: JsonPath): JsonNode | null {
    let node: JsonNode = root;
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
 * file depend on this app's theme to read.
 */
export function jsonMapSvg(document: JsonDocument, host: HTMLElement): string {
    const layout = layoutJsonMap(document.root, {
        maxNodes: JSON_VIEW_MAX_MAP_NODES,
        measure: (node, depth) => measureLabel(host, jsonMapLabel(node, depth, nodePathOf(node, document, depth))),
    });
    const style = getComputedStyle(host);
    const background = style.getPropertyValue('--bg-inset').trim() || '#ffffff';
    const foreground = style.getPropertyValue('--text-primary').trim() || '#222222';
    const links = layout.slots
        .filter(slot => slot.parent)
        .map(slot => `<path d="${mapLinkPath(slot.parent!, slot)}" fill="none" stroke="${foreground}" stroke-opacity="0.35" stroke-width="1.5"/>`)
        .join('');
    const nodes = layout.slots.map(slot => [
        `<g>`,
        `<rect x="${slot.x}" y="${slot.y - slot.h / 2}" width="${slot.w}" height="${slot.h}" rx="6"`,
        ` fill="${background}" stroke="${slot.node.kind === 'object' || slot.node.kind === 'array' ? foreground : 'none'}"/>`,
        `<text x="${slot.x + 11}" y="${slot.y + 4}" font-family="ui-monospace, monospace" font-size="12"`,
        ` fill="${foreground}">${escapeXml(jsonMapLabel(slot.node, slot.depth, slot.path))}</text>`,
        '</g>',
    ].join('')).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${links}${nodes}</svg>`;
}

function escapeXml(value: string): string {
    return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}
