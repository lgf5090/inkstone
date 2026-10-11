/**
 * The structured editing view of a ```json block.
 *
 * Three departures from the ported reference, all of them about what a tree of this size costs:
 *
 * - **Nested DOM, flat look.** A container's rows are children of its own element, so "hover a value and
 *   see the range it spans" is one CSS rule rather than a precomputed group per row. The reference built
 *   an array of every row inside every container and hung it on every row of that range, which is
 *   quadratic in the document: on its own demo that is 17 rows pointing at 17 arrays, and on a 10 000-line
 *   config it is 100 M pointer writes before the first paint.
 * - **Lazy children.** A folded container's rows are not built at all until it is opened, so a document
 *   that arrives folded costs the rows the reader can see — and the row budget below counts those, not
 *   every node in the file.
 * - **One writer.** Every press funnels through {@link JsonViewControl#commit}, which re-reads the fence
 *   from the note before it writes, so a rewrite that would land on a line the reader has since moved
 *   declines instead of guessing.
 */
import { t, type MessageKey } from '../../lib/i18n';
import { matchesQuery } from '../../lib/fuzzy';
import { escapeHtml } from '../../lib/markdown/renderer';
import type { JsonDocument, JsonNode, JsonPath } from '../../lib/markdown/json-view';
import {
    childCount,
    collapseToDepth,
    displaySummary,
    displayValue,
    emptyChild,
    findNode,
    insertChild,
    isContainerNode,
    moveChild,
    nodeFromInput,
    pathKey,
    removeChild,
    renameEntry,
    replaceNode,
    setCollapsed,
    writeJsonDocument,
} from '../../lib/markdown/json-view';

export type JsonViewMode = 'source' | 'tree' | 'map';

/** What a view needs to change the note and say whether it could. */
export interface JsonViewControl {
    readonly editable: boolean
    /** Rewrites the fence body. False when the note moved and the write was declined. */
    commit(body: string): boolean
    notify(title: string, tone?: 'success' | 'warning' | 'danger'): void
}

const FOLD_ICON = '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4l10 8-10 8z"/></svg>';

/**
 * How many rows one render may build.
 *
 * A note with a 50 000-entry array is the case this exists for. Because a folded branch builds nothing,
 * the budget is spent on what is actually on screen, and the row that trips it says so rather than the
 * list simply ending.
 */
export const JSON_TREE_ROW_BUDGET = 4000;

interface TreeContext {
    document: JsonDocument
    control: JsonViewControl
    kept: Set<string> | null
    budget: { left: number, overflow: boolean }
}

/** Per-host, so `expandJsonNode` can build a branch it was never given. */
const contexts = new WeakMap<HTMLElement, TreeContext>();

function rowHtml(node: JsonNode, path: JsonPath, isRoot: boolean, context: TreeContext): string {
    const container = isContainerNode(node);
    const editable = context.control.editable;
    const label = node.key === null
        ? `<span class="jt-index">${escapeHtml(String(path[path.length - 1] ?? ''))}</span>`
        : `<span class="jt-key"${editable ? ' data-jt="edit-key" role="button" tabindex="0"' : ''}>${escapeHtml(node.key)}</span>`;
    const value = container
        ? `<span class="jt-brace">${node.kind === 'object' ? '{' : '['}</span>`
          + `<span class="jt-count">${escapeHtml(displaySummary(node))}</span>`
        : `<span class="jt-value jt-value--${node.kind}"${editable ? ' data-jt="edit-value" role="button" tabindex="0"' : ''}>${escapeHtml(displayValue(node))}</span>`;
    return [
        '<div class="jt-row"',
        ` data-path="${escapeHtml(pathKey(path))}" role="treeitem" aria-level="${path.length + 1}"`,
        container ? ` aria-expanded="${String(!node.collapsed)}"` : '',
        '>',
        container
            ? `<button type="button" class="jt-fold" data-jt="fold" tabindex="-1" aria-hidden="true">${FOLD_ICON}</button>`
            : '<span class="jt-fold jt-fold--leaf"></span>',
        isRoot ? '' : `${label}<span class="jt-colon">:</span>`,
        value,
        container ? '' : `<span class="jt-kind" data-kind="${node.kind}">${node.kind.slice(0, 3)}</span>`,
        isRoot || !editable ? '' : `<span class="jt-ops">${opsHtml(container)}</span>`,
        '</div>',
    ].join('');
}

function opsHtml(container: boolean): string {
    const buttons: Array<[string, string, MessageKey]> = [
        ['up', '↑', 'preview.json_move_up'],
        ['down', '↓', 'preview.json_move_down'],
        ['delete', '×', 'preview.json_delete'],
    ];
    if (container)
        buttons.unshift(['fold-all', '⊟', 'preview.json_fold_branch'], ['add', '+', 'preview.json_add']);
    return buttons.map(([op, icon, key]) => {
        const text = t(key);
        return `<button type="button" class="jt-op" data-jt="${op}" title="${escapeHtml(text)}" aria-label="${escapeHtml(text)}">${icon}</button>`;
    }).join('');
}

function childrenHtml(path: JsonPath): string {
    return `<div class="jt-children" data-jt-children="${escapeHtml(pathKey(path))}"></div>`;
}

/**
 * One node and, unless it is folded, everything under it.
 *
 * A folded branch gets an empty container rather than a hidden full one: building 40 000 rows of markup
 * to display 12 of them is the cost the reference paid and this view does not.
 */
function nodeHtml(node: JsonNode, path: JsonPath, isRoot: boolean, context: TreeContext): string {
    if (context.kept && !context.kept.has(pathKey(path)))
        return '';
    context.budget.left--;
    if (context.budget.left < 0) {
        context.budget.overflow = true;
        return '';
    }
    const parts = [rowHtml(node, path, isRoot, context)];
    const children = node.children;
    if (children && children.length > 0) {
        if (node.collapsed) {
            parts.push(childrenHtml(path));
        }
        else {
            const kids = children
                .map((child, index) => {
                    const segment = node.kind === 'array' ? index : (child.key ?? '');
                    return nodeHtml(child, [...path, segment], false, context);
                })
                .join('');
            parts.push(`<div class="jt-children" data-jt-children="${escapeHtml(pathKey(path))}">${kids}</div>`);
        }
        parts.push(closingRowHtml(node, path, context));
    }
    return `<div class="jt-node${node.collapsed ? ' is-collapsed' : ''}" data-jt-node="${escapeHtml(pathKey(path))}">${parts.join('')}</div>`;
}

/** The bracket row at the end of a container, which is where "add at the end" belongs. */
function closingRowHtml(node: JsonNode, path: JsonPath, context: TreeContext): string {
    const add = context.control.editable
        ? `<button type="button" class="jt-op" data-jt="add" title="${escapeHtml(t('preview.json_add'))}" aria-label="${escapeHtml(t('preview.json_add'))}">+</button>`
        : '';
    return `<div class="jt-row jt-row--close" data-path="${escapeHtml(pathKey(path))}">`
      + '<span class="jt-fold"></span>'
      + `<span class="jt-brace">${node.kind === 'object' ? '}' : ']'}</span>${add}</div>`;
}

/**
 * Renders the tree into its host.
 *
 * Called again on every preview commit, which is why it declines to rebuild while a row is being edited:
 * the inline editor is a real `<input>` inside the host, and a re-render triggered by a keystroke in the
 * *other* pane would take the caret out of it mid-word.
 */
export function renderJsonTree(host: HTMLElement, document: JsonDocument, control: JsonViewControl, kept: Set<string> | null): void {
    if (host.querySelector('input.jt-input:focus'))
        return;
    const context: TreeContext = { document, control, kept, budget: { left: JSON_TREE_ROW_BUDGET, overflow: false } };
    contexts.set(host, context);
    const html = nodeHtml(document.root, [], true, context);
    const notes = [
        context.budget.overflow
            ? `<p class="json-view-note">${escapeHtml(t('preview.json_row_limit', { max: JSON_TREE_ROW_BUDGET }))}</p>`
            : '',
        kept && kept.size === 0 ? `<p class="json-view-note">${escapeHtml(t('preview.json_no_matches'))}</p>` : '',
    ].join('');
    host.innerHTML = `${notes}<div class="json-tree" role="tree">${html}</div>`;
}

function cssEscape(value: string): string {
    return value.replace(/[\\"]/g, match => `\\${match}`);
}

/**
 * Opens one branch, building its rows if this is the first time it has been opened.
 *
 * The fold state lives on the model, not on the element, so a branch the reader opened survives the
 * re-render that the next edit causes.
 */
export function expandJsonNode(host: HTMLElement, path: JsonPath): void {
    const key = pathKey(path);
    const node = host.querySelector<HTMLElement>(`[data-jt-node="${cssEscape(key)}"]`);
    if (!node)
        return;
    node.classList.remove('is-collapsed');
    node.querySelector<HTMLElement>(':scope > .jt-row')?.setAttribute('aria-expanded', 'true');
    const children = node.querySelector<HTMLElement>(`:scope > .jt-children`);
    if (!children || children.childElementCount > 0)
        return;
    const context = contexts.get(host);
    if (!context)
        return;
    const model = findNode(context.document.root, path);
    if (!model)
        return;
    children.innerHTML = (model.children ?? [])
        .map((child, index) => {
            const segment = model.kind === 'array' ? index : (child.key ?? '');
            return nodeHtml(child, [...path, segment], false, context);
        })
        .join('');
}

/** The row a path names, opening the branches above it first. */
export function revealJsonPath(host: HTMLElement, path: JsonPath): HTMLElement | null {
    for (let depth = 0; depth < path.length; depth++)
        expandJsonNode(host, path.slice(0, depth));
    const row = host.querySelector<HTMLElement>(`.jt-row[data-path="${cssEscape(pathKey(path))}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    return row;
}

/** Folds or opens every container at once, from the head's own button. */
export function foldAllJsonTree(host: HTMLElement, document: JsonDocument, collapsed: boolean): void {
    collapseToDepth(document.root, collapsed ? 0 : Number.POSITIVE_INFINITY);
    document.root.collapsed = false;
    const context = contexts.get(host);
    if (context)
        renderJsonTree(host, document, context.control, context.kept);
}

/** The key a new member gets: `new_key`, then `new_key_2`, without disturbing what is already there. */
function nextJsonKey(parent: JsonNode): string {
    const taken = new Set((parent.children ?? []).map(child => child.key ?? ''));
    if (!taken.has('new_key'))
        return 'new_key';
    for (let index = 2; index < 10000; index++) {
        const candidate = `new_key_${index}`;
        if (!taken.has(candidate))
            return candidate;
    }
    return `new_key_${Date.now()}`;
}

/**
 * Applies one press to the model and returns the body the note should hold.
 *
 * Everything the tree can do is expressed against the document rather than against the DOM it drew, so
 * the same call serves the row's buttons, the keyboard, and the map's node menu.
 */
export function applyJsonAction(
    action: string,
    document: JsonDocument,
    path: JsonPath,
    control: JsonViewControl,
    detail?: string,
): 'changed' | 'declined' | 'noop' {
    const root = document.root;
    const node = findNode(root, path);
    if (!node || !control.editable)
        return 'noop';
    const parent = path.length === 0 ? null : findNode(root, path.slice(0, -1));
    const index = path.length === 0 ? -1 : Number(path[path.length - 1]);
    switch (action) {
        case 'fold':
        case 'fold-all':
            setCollapsed(node, !node.collapsed);
            if (action === 'fold-all' && node.collapsed)
                walkCollapse(node, true);
            return 'noop';
        case 'up':
            if (!parent?.children || !moveChild(parent, index, index - 1))
                return 'noop';
            break;
        case 'down':
            if (!parent?.children || !moveChild(parent, index, index + 1))
                return 'noop';
            break;
        case 'delete':
            if (!parent)
                return 'noop';
            removeChild(parent, index);
            break;
        case 'add':
            if (!isContainerNode(node))
                return 'noop';
            insertChild(node, childCount(node), emptyChild(node, nextJsonKey(node)));
            setCollapsed(node, false);
            break;
        case 'rename': {
            const key = (detail ?? '').trim();
            if (!parent || !key || !renameEntry(node, key))
                return 'noop';
            if ((parent.children ?? []).some(child => child !== node && child.key === key)) {
                // The reference discarded a colliding rename in silence, which reads as a broken
                // control. The edit stands — a duplicate key is still legal JSON — and the reader is
                // told what they now have.
                control.notify(t('preview.json_duplicate_key', { key }), 'warning');
            }
            break;
        }
        case 'value': {
            replaceNode(node, nodeFromInput(detail ?? '', node.key));
            break;
        }
        default:
            return 'noop';
    }
    return control.commit(writeJsonDocument(document)) ? 'changed' : 'declined';
}

function walkCollapse(node: JsonNode, collapsed: boolean): void {
    setCollapsed(node, collapsed);
    for (const child of node.children ?? [])
        walkCollapse(child, collapsed);
}

/** Whether a row is about the filter's query, on either side of the colon. */
export function jsonRowMatches(node: JsonNode, query: string): boolean {
    if (node.key !== null && matchesQuery(node.key, query))
        return true;
    // The ceiling is the one thing that keeps a filter over a document of long strings linear: the row
    // itself shows at most JSON_TEXT_PREVIEW characters, so text past it could not be matched by eye
    // either. Asserted in json-tree-view.test.ts rather than trusted.
    return !isContainerNode(node) && matchesQuery(displayValue(node, JSON_FILTER_TEXT_LIMIT), query);
}

/** How much of a value the filter reads. */
export const JSON_FILTER_TEXT_LIMIT = 512;

/**
 * The rows a filter keeps: what matches, and everything that leads to a match.
 *
 * A branch is kept whole when its container's own key matches, because searching `config` and getting
 * the key back with nothing under it answers a question nobody asked.
 */
export function jsonFilterKept(root: JsonNode, query: string): Set<string> | null {
    const needle = query.trim();
    if (!needle)
        return null;
    const kept = new Set<string>();
    const walk = (node: JsonNode, path: JsonPath, forced: boolean): boolean => {
        const self = forced || jsonRowMatches(node, needle);
        let descendant = false;
        (node.children ?? []).forEach((child, index) => {
            const segment = node.kind === 'array' ? index : (child.key ?? '');
            if (walk(child, [...path, segment], self))
                descendant = true;
        });
        if (self || descendant)
            kept.add(pathKey(path));
        return self || descendant;
    };
    walk(root, [], false);
    return kept;
}
