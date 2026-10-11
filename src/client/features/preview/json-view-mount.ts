/**
 * The lazy half of the JSON preview: the reader, the two faces, and every press that needs them.
 *
 * Nothing in this file is reachable from the start-up bundle — `json-block-toolbar.ts` fetches it the
 * first time a reader opens the structure or mind-map face of a block, which is the same arrangement the
 * mind map has with its drawing library. A note full of JSON that is only ever read as text pays nothing.
 */
import { t } from '../../lib/i18n';
import { applyFencePatchAtSource, fenceAt } from '../../lib/markdown/fence-edit';
import type { JsonDocument, JsonFailure, JsonNode, JsonPath } from '../../lib/markdown/json-view';
import {
    collapseToDepth,
    formatJsonPath,
    parseJsonDocument,
    pathKey,
    reindentJsonDocument,
    validateJsonDocument,
} from '../../lib/markdown/json-view';
import type { JsonViewControl } from './json-tree-view';
import {
    applyJsonAction,
    expandJsonNode,
    foldAllJsonTree,
    jsonFilterKept,
    renderJsonTree,
    revealJsonPath,
} from './json-tree-view';
import {
    centerJsonMap,
    fitJsonMap,
    jsonMapSvg,
    renderJsonMap,
    toggleJsonMapNode,
    zoomJsonMap,
} from './json-map-view';
import { jsonBlockBody, jsonBlockState, type JsonBlockState } from './json-block-toolbar';
import type { BlockActionContext } from './block-overlay';

const JSON_LANGUAGES = ['json', 'jsonc', 'json5'];

/** The host element a view is drawn into, and the block it belongs to. */
function hostOf(block: HTMLElement): HTMLElement | null {
    return block.querySelector<HTMLElement>(':scope > [data-json-host]');
}

function pathOf(target: Element): JsonPath {
    const row = target.closest<HTMLElement>('[data-path], [data-jm-path], [data-jt-node]');
    if (!row)
        return [];
    try {
        const parsed: unknown = JSON.parse(row.dataset.path ?? row.dataset.jmPath ?? row.dataset.jtNode ?? '[]');
        return Array.isArray(parsed) ? parsed as JsonPath : [];
    }
    catch {
        return [];
    }
}

/**
 * The parse for one block, reused while its body is the text it was read from.
 *
 * Reusing it is what makes a fold survive the re-render that the next keystroke in the other pane causes:
 * the fold state lives on the model, and re-parsing would hand back a model that has never heard of it.
 */
function documentFor(block: HTMLElement, state: JsonBlockState): { document: JsonDocument | null, failure: JsonFailure | null } {
    const body = jsonBlockBody(block);
    const cached = state.document as JsonDocument | null;
    if (cached && state.body === body)
        return { document: cached, failure: null };
    const parsed = parseJsonDocument(body);
    if (!parsed.ok || !parsed.document)
        return { document: null, failure: parsed.failure };
    const document = parsed.document;
    collapseToDepth(document.root, state.fold);
    for (const [key, collapsed] of state.collapsed) {
        const node = walkTo(document.root, parseKey(key));
        if (node)
            node.collapsed = collapsed;
    }
    state.document = document;
    state.body = body;
    return { document, failure: null };
}

function parseKey(key: string): JsonPath {
    try {
        const parsed: unknown = JSON.parse(key);
        return Array.isArray(parsed) ? parsed as JsonPath : [];
    }
    catch {
        return [];
    }
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

function controlFor(block: HTMLElement, ctx: BlockActionContext, state: JsonBlockState): JsonViewControl {
    return {
        editable: block.dataset.jsonReadonly === undefined && Boolean(ctx.sourceNoteId),
        commit: (body) => {
            const wrote = writeBody(block, body, ctx);
            if (wrote) {
                state.collapsed = readCollapsed(state.document as JsonDocument | null);
                ctx.api.toast({ title: t('preview.json_written'), tone: 'success', duration: 4000 });
            }
            return wrote;
        },
        notify: (title, tone = 'warning') => ctx.api.toast({ title, tone, duration: 6000 }),
    };
}

function readCollapsed(document: JsonDocument | null): Map<string, boolean> {
    const collapsed = new Map<string, boolean>();
    if (!document)
        return collapsed;
    const walk = (node: JsonNode, path: JsonPath): void => {
        if (node.children) {
            collapsed.set(pathKey(path), node.collapsed);
            node.children.forEach((child, index) => {
                walk(child, [...path, node.kind === 'array' ? index : (child.key ?? '')]);
            });
        }
    };
    walk(document.root, []);
    return collapsed;
}

/**
 * Replaces the fence body.
 *
 * The fence is resolved against the committed text and the write is declined when it is not there any
 * more, so a block the reader has since moved cannot be overwritten by a stale line number.
 */
function writeBody(block: HTMLElement, body: string, ctx: BlockActionContext): boolean {
    const line = Number(block.dataset.line);
    const editable = ctx.sourceNoteId;
    if (!editable || !Number.isInteger(line) || line < 0) {
        ctx.api.toast({ title: t('preview.json_edit_unavailable'), tone: 'warning' });
        return false;
    }
    if (ctx.content !== ctx.committedSourceRef.current) {
        ctx.api.toast({ title: t('preview.the_preview_is_updating_try_again_in_a_moment'), tone: 'warning' });
        return false;
    }
    const fence = fenceAt(ctx.committedSourceRef.current, line, JSON_LANGUAGES);
    if (fence === null) {
        ctx.api.toast({ title: t('preview.json_source_moved'), tone: 'warning' });
        return false;
    }
    const next = applyFencePatchAtSource(ctx.committedSourceRef.current, { line, body: fence.body }, { body }, JSON_LANGUAGES);
    if (next === null) {
        ctx.api.toast({ title: t('preview.json_source_moved'), tone: 'warning' });
        return false;
    }
    ctx.api.editContent(editable, next);
    return true;
}

/**
 * Draws every open face of the note's JSON blocks, after the preview has committed its markup.
 *
 * Called once per commit with the whole set rather than per block, because each mount is a parse and a
 * re-render of one note's worth of blocks is the unit the reader actually sees change.
 */
export function mountJsonBlocks(blocks: HTMLElement[], ctx: BlockActionContext): void {
    for (const block of blocks) {
        const host = hostOf(block);
        if (!host)
            continue;
        const state = jsonBlockState(block, { view: 'source', fold: 2 });
        const { document, failure } = documentFor(block, state);
        if (!document) {
            host.innerHTML = invalidHtml(failure);
            continue;
        }
        const control = controlFor(block, ctx, state);
        if (state.mode === 'tree') {
            renderJsonTree(host, document, control, jsonFilterKept(document.root, state.filter));
            continue;
        }
        renderJsonMap(host, document);
    }
}

/** One block, for the surfaces that redraw a single view outside the commit pass. */
export function mountJsonBlock(block: HTMLElement, ctx: BlockActionContext): void {
    mountJsonBlocks([block], ctx);
}

/**
 * Draws only the map, into a host the caller owns — the full screen overlay's, which is not the block's.
 *
 * The two hosts share the parsed document and the fold state, so a branch folded in the overlay is still
 * folded when the reader gets back to the note.
 */
export function mountJsonMapInto(block: HTMLElement, host: HTMLElement, ctx: BlockActionContext): void {
    const state = jsonBlockState(block, { view: 'map', fold: 2 });
    const { document, failure } = documentFor(block, state);
    if (!document) {
        host.innerHTML = invalidHtml(failure);
        return;
    }
    controlFor(block, ctx, state);
    renderJsonMap(host, document);
}

function invalidHtml(failure: JsonFailure | null): string {
    const reason = failure?.detail ? `${failure.reason} (${failure.detail})` : failure?.reason ?? 'preview.json_error_unknown';
    const where = failure && failure.line > 0 ? ` · ${failure.line}:${failure.column}` : '';
    const message = `${t('preview.json_invalid', { reason: t(reason as never) })}${where}`;
    return `<p class="json-view-note is-invalid" data-json-invalid>${escapeText(message)}</p>`
      + `<button type="button" class="json-tool is-inline" data-jv="show-source">${escapeText(t('preview.json_show_source'))}</button>`;
}

function escapeText(value: string): string {
    return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

export function writeJsonBlock(block: HTMLElement, body: string, ctx: BlockActionContext): void {
    writeBody(block, body, ctx);
}

/** The head's icon buttons, all of which act on the block rather than on one row. */
export function runJsonBlockTool(action: string, block: HTMLElement, ctx: BlockActionContext, override?: HTMLElement): void {
    const state = jsonBlockState(block, { view: 'source', fold: 2 });
    const host = override ?? hostOf(block);
    if (!host)
        return;
    const { document } = documentFor(block, state);
    if (action === 'show-source') {
        state.mode = 'source';
        block.dataset.jsonMode = 'source';
        host.hidden = true;
        const pre = block.querySelector<HTMLElement>(':scope > pre');
        if (pre)
            pre.hidden = false;
        return;
    }
    if (action === 'copy') {
        void copyText(jsonBlockBody(block), ctx);
        return;
    }
    if (action === 'reformat') {
        if (document)
            writeReformatted(block, document, ctx, state);
        return;
    }
    if (!document)
        return;
    if (action === 'fold-all') {
        foldAllJsonTree(host, document, !allCollapsed(document));
        state.collapsed = readCollapsed(document);
        return;
    }
    if (action === 'expand-all') {
        foldAllJsonTree(host, document, false);
        state.collapsed = readCollapsed(document);
        return;
    }
    if (action === 'validate') {
        const issues = validateJsonDocument(document.root);
        ctx.api.toast({
            title: issues.length ? t('preview.json_issues', { count: issues.length }) : t('preview.json_copied'),
            tone: issues.length ? 'warning' : 'success',
            duration: 6000,
        });
        return;
    }
    if (action === 'copy-path') {
        void copyText(formatJsonPath(selectedPath(host)), ctx);
        return;
    }
    if (action === 'export-svg') {
        exportSvg(jsonMapSvg(document, host), ctx);
        return;
    }
    if (action === 'export-png') {
        exportPng(jsonMapSvg(document, host), ctx);
        return;
    }
    if (action === 'fit') {
        fitJsonMap(host);
        return;
    }
    if (action === 'center') {
        centerJsonMap(host);
        return;
    }
    if (action === 'zoom-in' || action === 'zoom-out') {
        zoomJsonMap(host, action === 'zoom-in' ? 1.2 : 1 / 1.2);
        return;
    }
    if (action === 'fullscreen')
        ctx.json?.fullscreen(block);
    if (action === 'copy-json')
        void copyText(jsonBlockBody(block), ctx);
}

function allCollapsed(document: JsonDocument): boolean {
    let containers = 0;
    let folded = 0;
    const walk = (node: JsonNode): void => {
        if (!node.children?.length)
            return;
        containers++;
        if (node.collapsed)
            folded++;
        node.children.forEach(walk);
    };
    walk(document.root);
    return containers > 1 && folded === containers - 1;
}

function selectedPath(host: HTMLElement): JsonPath {
    const row = host.querySelector<HTMLElement>('.jt-row.is-selected, .jm-node.is-selected');
    return row ? pathOf(row) : [];
}

function writeReformatted(block: HTMLElement, document: JsonDocument, ctx: BlockActionContext, state: JsonBlockState): void {
    const body = reindentJsonDocument(document, document.indent);
    if (writeBody(block, `${body}\n`, ctx))
        state.document = null;
}

async function copyText(text: string, ctx: BlockActionContext): Promise<void> {
    if (!navigator.clipboard?.writeText) {
        ctx.api.toast({ title: t('preview.could_not_copy'), tone: 'danger' });
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        ctx.api.toast({ title: t('common.copied'), tone: 'success', duration: 3000 });
    }
    catch {
        ctx.api.toast({ title: t('preview.could_not_copy'), tone: 'danger' });
    }
}

function download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportSvg(svg: string, ctx: BlockActionContext): void {
    download('json-mind-map.svg', new Blob([svg], { type: 'image/svg+xml' }));
    ctx.api.toast({ title: t('preview.json_export_svg'), tone: 'success', duration: 3000 });
}

/**
 * The map as a picture, rasterised through an image of its own SVG.
 *
 * The SVG is loaded as a data URL rather than by drawing the live DOM to a canvas: the DOM is HTML boxes
 * styled by this app's stylesheet, and taking that with it would make the exported file unreadable
 * outside the theme it came from.
 */
function exportPng(svg: string, ctx: BlockActionContext): void {
    const image = new Image();
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.min(8192, image.naturalWidth * 2));
        canvas.height = Math.max(1, Math.min(8192, image.naturalHeight * 2));
        const context = canvas.getContext('2d');
        if (!context) {
            ctx.api.toast({ title: t('preview.json_export_failed'), tone: 'danger' });
            return;
        }
        context.scale(2, 2);
        context.drawImage(image, 0, 0);
        canvas.toBlob((blob) => {
            if (blob)
                download('json-mind-map.png', blob);
            else
                ctx.api.toast({ title: t('preview.json_export_failed'), tone: 'danger' });
        }, 'image/png');
    };
    image.onerror = () => ctx.api.toast({ title: t('preview.json_export_failed'), tone: 'danger' });
    image.src = url;
}

/**
 * One press inside a view.
 *
 * Rows are addressed by path rather than by element, which is what lets the tree's buttons, the
 * keyboard, and the map's node menu all reach the same operation without a second copy of it.
 */
export function routeJsonViewPress(target: HTMLElement, block: HTMLElement, ctx: BlockActionContext): void {
    const host = hostOf(block);
    if (!host)
        return;
    const state = jsonBlockState(block, { view: 'source', fold: 2 });
    const { document } = documentFor(block, state);
    if (!document)
        return;
    const control = controlFor(block, ctx, state);
    const path = pathOf(target);

    const fold = target.closest<HTMLElement>('[data-jm="fold"]');
    if (fold) {
        toggleJsonMapNode(document, host, path);
        state.collapsed = readCollapsed(document);
        return;
    }
    const press = target.closest<HTMLElement>('[data-jt]');
    if (!press) {
        markSelected(host, target);
        return;
    }
    const action = press.dataset.jt!;
    if (action === 'edit-key' || action === 'edit-value') {
        startInlineEdit(press, action === 'edit-key' ? 'key' : 'value', document, path, control, host, state);
        return;
    }
    const result = applyJsonAction(action, document, path, control);
    if (result === 'declined')
        return;
    if (result === 'noop') {
        // A fold changes nothing about the note, so it is applied to the DOM the reader is looking at
        // rather than round-tripping through a re-render that would lose their scroll position.
        if (action === 'fold' || action === 'fold-all') {
            const node = walkTo(document.root, path);
            if (node?.collapsed)
                host.querySelector<HTMLElement>(`[data-jt-node="${cssEscape(pathKey(path))}"]`)?.classList.add('is-collapsed');
            else
                expandJsonNode(host, path);
            state.collapsed = readCollapsed(document);
        }
        return;
    }
    state.collapsed = readCollapsed(document);
    state.document = null;
}

function cssEscape(value: string): string {
    return value.replace(/[\\"]/g, match => `\\${match}`);
}

function markSelected(host: HTMLElement, target: HTMLElement): void {
    const row = target.closest<HTMLElement>('[data-path], [data-jm-path]');
    host.querySelectorAll('.is-selected').forEach(node => node.classList.remove('is-selected'));
    row?.classList.add('is-selected');
}

/**
 * Turns one span into an editor and back.
 *
 * Enter commits, Escape cancels, and a click away commits — but the commit path re-renders the block from
 * the note, so the key press has to consume its own default action. Without `preventDefault` an Enter
 * here also reaches whatever else is listening for it, which is how the reference's inline editor could
 * open a confirmation dialog it had just itself popped up.
 */
function startInlineEdit(
    span: HTMLElement,
    field: 'key' | 'value',
    document: JsonDocument,
    path: JsonPath,
    control: JsonViewControl,
    host: HTMLElement,
    state: JsonBlockState,
): void {
    if (span.querySelector('input'))
        return;
    const node = walkTo(document.root, path);
    if (!node)
        return;
    const before = field === 'key' ? (node.key ?? '') : displayFor(node);
    const input = span.ownerDocument.createElement('input');
    input.className = 'jt-input';
    input.value = before;
    input.setAttribute('aria-label', t(field === 'key' ? 'preview.json_copy_path' : 'preview.json_view_tree'));
    const width = Math.min(480, Math.max(80, before.length * 8 + 24));
    input.style.width = `${width}px`;
    span.replaceChildren(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (commit: boolean): void => {
        if (settled)
            return;
        settled = true;
        const text = input.value;
        if (!commit || text === before) {
            // Nothing changed, so the only thing to undo is the editor itself. Re-rendering from the
            // model puts the span back exactly as it was, including the truncation a long value shows.
            renderJsonTree(host, document, control, null);
            return;
        }
        const result = applyJsonAction(field === 'key' ? 'rename' : 'value', document, path, control, text);
        if (result !== 'declined') {
            state.document = null;
            state.collapsed = readCollapsed(document);
        }
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
        }
        else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
        }
    });
}

function displayFor(node: JsonNode): string {
    if (node.children)
        return '';
    if (node.kind === 'string')
        return typeof node.value === 'string' ? node.value : '';
    return node.literal ?? String(node.value ?? '');
}

/** The row a path names, opening what is above it. Used by the full screen overlay's "edit this". */
export function revealJsonBlockPath(block: HTMLElement, path: JsonPath): void {
    const host = hostOf(block);
    if (!host)
        return;
    const state = jsonBlockState(block, { view: 'source', fold: 2 });
    state.mode = 'tree';
    revealJsonPath(host, path);
}
