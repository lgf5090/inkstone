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
    writeJsonNode,
} from '../../lib/markdown/json-view';
import type { JsonViewControl } from './json-tree-view';
import { handleBlockToolbarClick } from './block-actions';
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
    closeMapOverlays,
    fitJsonMap,
    foldAllJsonMap,
    jsonMapSvg,
    renderJsonMap,
    resizeJsonMapHost,
    showJsonDetail,
    toggleJsonMapNode,
    zoomJsonMap,
} from './json-map-view';
import { jsonBlockBody, jsonBlockState, pruneJsonBlockStates, rebuildJsonBlockHead, type JsonBlockState } from './json-block-toolbar';
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
/**
 * The depth to put on the model for the face that is showing.
 *
 * The account's fold-depth setting counts *source levels*, which is what the structure list shows. The map counts card
 * columns, and promoting an array of objects turns each element's row into a card one column out — so the
 * same number costs the map a whole level, and an array of objects at the default 2 arrived as one lonely
 * row with nothing hanging off it. One extra level makes "2" mean the same picture on both faces.
 */
function foldDepthFor(state: JsonBlockState): number {
    if (state.mode !== 'map')
        return state.fold;
    return Number.isFinite(state.fold) ? state.fold + 1 : state.fold;
}

/** Puts the arrival fold, and then the reader's own exceptions, onto a model. */
function applyFold(document: JsonDocument, state: JsonBlockState, depth: number): void {
    collapseToDepth(document.root, depth);
    for (const [key, collapsed] of state.collapsed) {
        const node = walkTo(document.root, parseKey(key));
        if (node)
            node.collapsed = collapsed;
    }
    state.foldApplied = depth;
}

function documentFor(block: HTMLElement, state: JsonBlockState): { document: JsonDocument | null, failure: JsonFailure | null } {
    const body = jsonBlockBody(block);
    const cached = state.document as JsonDocument | null;
    const depth = foldDepthFor(state);
    if (cached && state.body === body) {
        // Switching face changes the depth without changing the text, and the fold lives on the model the
        // two faces share — so the model has to be re-prepared here rather than being trusted from the last
        // draw. The reader's own folds are replayed on top, which is what keeps a hand-folded card folded on
        // both faces while the arrival depth differs.
        if (state.foldApplied !== depth)
            applyFold(cached, state, depth);
        return { document: cached, failure: null };
    }
    const parsed = parseJsonDocument(body, { tolerant: state.tolerant });
    if (!parsed.ok || !parsed.document)
        return { document: null, failure: parsed.failure };
    const document = parsed.document;
    applyFold(document, state, depth);
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

function controlFor(block: HTMLElement, ctx: BlockActionContext, state: JsonBlockState, host: HTMLElement): JsonViewControl {
    return {
        // Three ways a block can be read-only: the fence said so, the surface has no note to write
        // to, and the account turned the whole feature off.
        editable: block.dataset.jsonReadonly === undefined
            && Boolean(ctx.sourceNoteId)
            && ctx.jsonEditable !== false,
        commit: (body) => {
            const wrote = writeBody(block, body, ctx);
            if (!wrote)
                return false;
            rememberFoldExceptions(state);
            // The draw signature cannot see this: the body the block still shows is the text from
            // before the write, so the guard would skip the one redraw that matters and the reader
            // would watch the view they just edited go empty until the next commit came around.
            state.rendered = '';
            // Draw the result here rather than waiting for the commit to come back around: the note write
            // lands on the next React pass, and without this the reader watches the view they just edited
            // go empty for a frame first. Measured as `0 1202 1202 …` in the row timeline.
            draw(block, host, state, ctx);
            ctx.api.toast({ title: t('preview.json_written'), tone: 'success', duration: 4000 });
            return true;
        },
        notify: (title, tone = 'warning') => ctx.api.toast({ title, tone, duration: 6000 }),
    };
}

/**
 * The one draw path, shared by the commit pass and by a control that just wrote the note.
 *
 * It re-reads the body from the block, so after a write it is drawing what the note now holds rather than
 * what was on screen before it.
 */
function draw(block: HTMLElement, host: HTMLElement, state: JsonBlockState, ctx: BlockActionContext): void {
    const { document, failure } = documentFor(block, state);
    if (!document) {
        host.innerHTML = invalidHtml(failure);
        state.rendered = '';
        return;
    }
    // A commit draws once from the control that made it and again from the mount pass that follows the
    // note write, and the preview re-runs the mount pass on renders that have nothing to do with this
    // block. Rebuilding 1200 rows is ~860ms measured, so the second and third pass have to be cheap:
    // the signature says what the host is already showing.
    const signature = `${state.mode}|${state.body}|${state.filter}`;
    if (signature === state.rendered && host.childElementCount > 0)
        return;
    state.rendered = signature;
    const control = controlFor(block, ctx, state, host);
    if (state.mode === 'tree') {
        // The map makes its host a focusable group for the arrow-key pan; the tree is a list of real
        // controls and would announce itself as a second mind map to a screen reader.
        host.removeAttribute('tabindex');
        host.removeAttribute('role');
        host.removeAttribute('aria-label');
        renderJsonTree(host, document, control, jsonFilterKept(document.root, state.filter));
        return;
    }
    renderJsonMap(host, document, state.map, jsonFilterKept(document.root, state.filter));
}

/**
 * The fold state, as the exceptions the reader introduced.
 *
 * Storing every container costs one stringified path per container per edit — 1200 of them on a flat
 * config. A fold that matches what the block arrived at is not an exception and is not recorded.
 */
function rememberFoldExceptions(state: JsonBlockState): void {
    const document = state.document as JsonDocument | null;
    if (!document)
        return;
    const exceptions = new Map<string, boolean>();
    const walk = (node: JsonNode, path: JsonPath, level: number): void => {
        if (!node.children?.length)
            return;
        // Compared against the depth the model was actually prepared at, which on the map is one more than
        // the setting: comparing against `state.fold` here would record every card the arrival depth had
        // opened as an exception the reader never made, and replay them onto the structure face.
        if (node.collapsed !== (level >= state.foldApplied))
            exceptions.set(pathKey(path), node.collapsed);
        node.children.forEach((child, index) => {
            walk(child, [...path, node.kind === 'array' ? index : (child.key ?? '')], level + 1);
        });
    };
    walk(document.root, [], 0);
    state.collapsed = exceptions;
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
    const noteId = ctx.sourceNoteId ?? null;
    // The note may have been replaced while a block was on the window; the stage is not the block's
    // element any more, so nothing but this pass can notice that it is orphaned.
    reapJsonFullscreen();
    for (const block of blocks) {
        const host = hostOf(block);
        if (!host)
            continue;
        const state = jsonBlockState(block, { view: 'source', fold: 2 }, noteId);
        wireMapOpenInTree(block, host, ctx);
        draw(block, host, state, ctx);
    }
    // Whatever this note no longer has a block for is forgotten, so the map cannot grow across a session.
    pruneJsonBlockStates(noteId, blocks.map(block => block.dataset.line ?? ''));
}

/**
 * Hands a double-clicked node to the tree, at its own row.
 *
 * The reference's map jumped to the editor view and left the reader to find the node again, which is a
 * long way of saying "you are on your own from here". The path travels with the event the map dispatches,
 * so the tree opens the branches above the row and puts the caret on it.
 */
function wireMapOpenInTree(block: HTMLElement, host: HTMLElement, ctx: BlockActionContext): void {
    if (host.dataset.jsonOpenWired === '1')
        return;
    host.dataset.jsonOpenWired = '1';
    host.addEventListener('jsonmapopen', (event) => {
        const detail = (event as CustomEvent).detail as { path: JsonPath, edit: boolean };
        const state = jsonBlockState(block, { view: 'source', fold: 2 }, ctx.sourceNoteId ?? null);
        if (state.mode !== 'tree') {
            state.mode = 'tree';
            state.rendered = '';
            rebuildJsonBlockHead(block, ctx);
        }
        draw(block, host, state, ctx);
        const row = revealJsonPath(host, detail.path);
        // A double-click means "let me change this one", so it opens the editor. The card menu's item means
        // "show me where this is", and starting an edit for that would put a caret in a reader's document
        // that they never asked for — so it marks the row instead.
        if (detail.edit)
            row?.querySelector<HTMLElement>('[data-jt="edit-value"], [data-jt="edit-key"]')?.click();
        else if (row)
            markSelected(host, row);
    });
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
    const state = jsonBlockState(block, { view: 'source', fold: 2 }, ctx.sourceNoteId ?? null);
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
        rememberFoldExceptions(state);
        return;
    }
    if (action === 'expand-all') {
        foldAllJsonTree(host, document, false);
        rememberFoldExceptions(state);
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
        exportSvg(jsonMapSvg(document, host, jsonFilterKept(document.root, state.filter)), ctx);
        return;
    }
    if (action === 'export-png') {
        exportPng(jsonMapSvg(document, host, jsonFilterKept(document.root, state.filter)), ctx);
        return;
    }
    if (action === 'fit') {
        fitJsonMap(host, state.map);
        return;
    }
    if (action === 'fold-all-map') {
        // One button for both directions, the way the tree's collapse-all works: which way it goes is
        // decided from the document in front of the reader, not from a label that cannot know.
        foldAllJsonMap(document, host, state.map, !allCollapsed(document), jsonFilterKept(document.root, state.filter));
        rememberFoldExceptions(state);
        return;
    }
    if (action === 'center') {
        centerJsonMap(host, state.map);
        return;
    }
    if (action === 'zoom-in' || action === 'zoom-out') {
        zoomJsonMap(host, state.map, action === 'zoom-in' ? 1.2 : 1 / 1.2);
        return;
    }
    if (action === 'fullscreen')
        enterJsonFullscreen(block, host, ctx);
    if (action === 'exit-fullscreen')
        leaveJsonFullscreen(block, ctx);
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
    const row = host.querySelector<HTMLElement>('.jt-row.is-selected, .jm-card.is-selected, .jm-row.is-selected');
    return row ? pathOf(row) : [];
}

/**
 * One member as the note holds it, for the detail card's copy button.
 *
 * Read from the model on the press rather than cached on the open card: a note can hold two ```json
 * blocks, and text parked on a module slot would be whatever the last-opened card showed, which is not
 * necessarily the one the reader is pressing.
 */
function detailBody(document: JsonDocument, path: JsonPath): string {
    const node = walkTo(document.root, path);
    return node ? writeJsonNode(document, node) : '';
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
    const state = jsonBlockState(block, { view: 'source', fold: 2 }, ctx.sourceNoteId ?? null);
    const { document } = documentFor(block, state);
    if (!document)
        return;
    const control = controlFor(block, ctx, state, host);
    const path = pathOf(target);

    const kept = jsonFilterKept(document.root, state.filter);

    const fold = target.closest<HTMLElement>('[data-jm="fold"]');
    if (fold) {
        toggleJsonMapNode(document, host, state.map, path, kept);
        rememberFoldExceptions(state);
        return;
    }
    const press = target.closest<HTMLElement>('[data-jt]');
    if (!press) {
        markSelected(host, target);
        // A press on a card's body or on one of its rows asks the same question a reader asks out loud
        // when a map gets big: what exactly is this member? The detail card answers it with the member's
        // own text and the path that names it, both of which survive being pasted elsewhere.
        const member = target.closest<HTMLElement>('[data-jm-path]');
        if (member && !target.closest('.jm-detail, .jm-map-menu'))
            showJsonDetail(host, document, path, member);
        return;
    }
    if (target.closest('.jm-map-menu'))
        closeMapOverlays(host);
    const action = press.dataset.jt!;
    if (action === 'close-detail') {
        closeMapOverlays(host);
        // The × is a control the reader was inside; leaving them with focus on the canvas behind it is
        // what the app's other closers do, and what keeps the next Tab in the right place.
        host.focus();
        return;
    }
    if (action === 'copy-value' || action === 'copy-path') {
        void copyText(action === 'copy-path' ? formatJsonPath(path) : detailBody(document, path), ctx);
        return;
    }
    // The map's own menu. Each item is a `[data-jt]` button carrying the path it acts on, so it reaches the
    // same operation the tree's buttons and the detail card use rather than a second copy of it.
    if (action === 'fold-branch' || action === 'expand-branch') {
        toggleJsonMapNode(document, host, state.map, path, kept);
        rememberFoldExceptions(state);
        return;
    }
    if (action === 'fold-all-map' || action === 'expand-all-map') {
        foldAllJsonMap(document, host, state.map, action === 'fold-all-map', kept);
        rememberFoldExceptions(state);
        return;
    }
    if (action === 'open-in-tree') {
        host.dispatchEvent(new CustomEvent('jsonmapopen', { bubbles: true, composed: true, detail: { path, edit: false } }));
        return;
    }
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
            rememberFoldExceptions(state);
        }
        return;
    }
    rememberFoldExceptions(state);
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
    input.setAttribute('aria-label', t(field === 'key' ? 'preview.json_edit_key' : 'preview.json_edit_value'));
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
        // Put the editor away before anything asks for a redraw. The guard in `renderJsonTree` exists so a
        // keystroke in the other pane cannot pull the caret out mid-word, and while this input still
        // holds focus it correctly refuses every rebuild — including the one that would show the edit
        // the reader just committed, which is what left the view blank for a frame.
        input.blur();
        input.remove();
        if (!commit || text === before) {
            // Nothing changed, so the only thing to undo is the editor itself. Re-rendering from the
            // model puts the span back exactly as it was, including the truncation a long value shows.
            renderJsonTree(host, document, control, null);
            return;
        }
        const result = applyJsonAction(field === 'key' ? 'rename' : 'value', document, path, control, text);
        if (result !== 'declined') {
            state.document = null;
            rememberFoldExceptions(state);
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

/**
 * Puts one block's map on the whole window.
 *
 * The element is moved to `document.body` rather than painted with `position: fixed` where it stands,
 * because the prose column is inside elements that animate with a transform — and a transformed ancestor
 * becomes the containing block of a fixed descendant, which would size the "full screen" to the column.
 * The slot it came from is kept as a placeholder so leaving puts it back exactly where it was.
 */
function enterJsonFullscreen(block: HTMLElement, host: HTMLElement, ctx: BlockActionContext): void {
    if (block.classList.contains('is-json-fullscreen'))
        return;
    const state = jsonBlockState(block, { view: 'map', fold: 2 }, ctx.sourceNoteId ?? null);
    const slot = block.ownerDocument.createComment('json-fullscreen-slot');
    block.parentNode?.insertBefore(slot, block);
    (block as HTMLElement & { jsonSlot?: Comment }).jsonSlot = slot;
    const stage = block.ownerDocument.createElement('div');
    stage.className = 'ink-prose json-fs-stage';
    stage.dataset.jsonFullscreenStage = '';
    block.ownerDocument.body.appendChild(stage);
    stage.appendChild(block);
    // Both preview surfaces delegate their block-toolbar clicks from their own container, and this block
    // has just left it: moved onto `<body>`, a press on the head or on a fold handle bubbles to nothing,
    // and every tool in the full-screen view is dead while looking entirely wired. The stage carries the
    // same route for exactly as long as it holds the block.
    const press = (event: MouseEvent): void => {
        handleBlockToolbarClick(event, event.target as HTMLElement, ctx);
    };
    stage.addEventListener('click', press);
    const esc = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape')
            return;
        // This listener is on `document` in the capture phase, so it sees the press before the map does.
        // Escape with an overlay open means "put the card away", not "throw me out of the full-screen view",
        // and the map's own handler is the one that closes it — so stand aside while one is on screen.
        if (host.querySelector('[data-json-detail], [data-json-map-menu]'))
            return;
        event.stopPropagation();
        leaveJsonFullscreen(block, ctx);
    };
    block.ownerDocument.addEventListener('keydown', esc, true);
    openStage = {
        block,
        stage,
        dispose: () => stage.removeEventListener('click', press),
        closeEsc: () => block.ownerDocument.removeEventListener('keydown', esc, true),
    };
    block.classList.add('is-json-fullscreen');
    // The head is the overlay's only tool surface, so it takes over the whole tool list — including the
    // press that leaves again. Rebuilding goes through the toolbar module, which is where that list lives.
    state.fullscreen = true;
    rebuildJsonBlockHead(block, ctx);
    // The inline box grew to fit the picture it was drawn into; the stage is the window now, and that
    // leftover pixel height would stay as a band of empty field under the map.
    host.style.height = '';
    // A write from inside the overlay replaces the block in the note, which would leave this copy
    // orphaned and every later edit landing on a different element. Leaving first is the honest answer.
    const original = ctx.api.editContent;
    ctx.api.editContent = (noteId: string, next: string) => {
        leaveJsonFullscreen(block, ctx);
        original(noteId, next);
    };
    // The overlay draws at the size of the window, so the fit the inline block settled on is no longer
    // the right one; `fitted` is reset so the first frame of the big view is fitted to the big box.
    state.map.fitted = false;
    fitJsonMap(host, state.map);
}

function leaveJsonFullscreen(block: HTMLElement, ctx: BlockActionContext): void {
    if (!block.classList.contains('is-json-fullscreen'))
        return;
    const state = jsonBlockState(block, { view: 'map', fold: 2 }, ctx.sourceNoteId ?? null);
    block.classList.remove('is-json-fullscreen');
    state.fullscreen = false;
    closeMapOverlays(block);
    // Read the stage while the block is still inside it: once the block is put back, `closest` from the
    // block can no longer reach the wrapper and the empty stage would stay on the page covering the app.
    const stage = block.closest<HTMLElement>('[data-json-fullscreen-stage]');
    const slot = (block as HTMLElement & { jsonSlot?: Comment }).jsonSlot;
    slot?.parentNode?.insertBefore(block, slot);
    slot?.remove();
    stage?.remove();
    delete (block as HTMLElement & { jsonSlot?: Comment }).jsonSlot;
    rebuildJsonBlockHead(block, ctx);
    // Back in the column, the box is the column's again: the height the inline draw asked for has to come
    // back, and the fit the window decided on has to be redone or the reader returns to a map zoomed to a
    // fragment of itself.
    const host = hostOf(block);
    if (host) {
        resizeJsonMapHost(host);
        state.map.fitted = false;
        fitJsonMap(host, state.map);
    }
    if (openStage?.block === block) {
        openStage.closeEsc();
        openStage.dispose();
        openStage = null;
    }
}

/**
 * The block currently occupying the window, if any.
 *
 * Full screen moves the block into a stage on `<body>`, so if the note is closed or the block is deleted
 * while it is open, nothing is left holding the stage and it stays on the page covering the app. Every
 * mount pass checks the recorded block is still attached and takes the stage back down if it is not.
 */
let openStage: { block: HTMLElement, stage: HTMLElement, dispose: () => void, closeEsc: () => void } | null = null;

/** Reaps an orphaned full screen stage. Returns whether one had to go. */
export function reapJsonFullscreen(): boolean {
    if (!openStage || openStage.block.isConnected)
        return false;
    // The Escape handler lives on `document`, not on the stage, so taking the stage down without it leaves
    // a capture-phase listener that stops every later Escape press in the app — the command palette, a
    // dialog, an inline editor — for the rest of the session.
    openStage.closeEsc();
    openStage.dispose();
    openStage.stage.remove();
    openStage = null;
    return true;
}
