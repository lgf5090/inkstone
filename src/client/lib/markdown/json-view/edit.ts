/**
 * The edits the JSON view can make, as plain functions over the model.
 *
 * Nothing here returns a new tree. The staleness rule is what makes that safe: an entry is written back
 * from its source slice only while it and every descendant still match it, so marking one node stale is
 * enough to make every slice above it ineligible — `isFresh` recurses, and no operation has to remember
 * to invalidate an ancestor by hand.
 */
import type { JsonNode, JsonPath } from './types';
import { nodeFromValue } from './write';

/** The node a path names, or null when the tree has moved out from under it. */
export function findNode(root: JsonNode, path: JsonPath): JsonNode | null {
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

export function parentNode(root: JsonNode, path: JsonPath): JsonNode | null {
    return path.length === 0 ? null : findNode(root, path.slice(0, -1));
}

/** Renaming an entry invalidates its own slice, which is the only one that carried the key. */
export function renameEntry(node: JsonNode, key: string): boolean {
    if (node.key === key)
        return false;
    node.key = key;
    node.stale = true;
    return true;
}

/**
 * Replacing a node in place with one of another shape.
 *
 * The node object itself is kept, because the DOM the view built holds a reference to it: swapping the
 * entry in the parent's array would leave the row that was just clicked pointing at a detached node.
 */
export function replaceNode(target: JsonNode, next: JsonNode): void {
    target.kind = next.kind;
    target.value = next.value;
    target.literal = next.literal;
    target.children = next.children;
    target.raw = next.raw;
    target.valueRaw = next.valueRaw;
    target.stale = true;
    if (next.children && !target.collapsed)
        target.collapsed = false;
}

/** The empty member a container accepts; an array element has no key and an object entry must. */
export function emptyChild(parent: JsonNode, key: string | null): JsonNode {
    return parent.kind === 'object' ? nodeFromValue('', key ?? 'new_key') : nodeFromValue('', null);
}

/** A fresh member of the shape a container's children already have, for "add another like this". */
export function siblingOf(parent: JsonNode, index: number): JsonNode {
    const neighbour = parent.children?.[index];
    if (!neighbour)
        return emptyChild(parent, null);
    if (isContainerKind(neighbour.kind))
        return nodeFromValue(neighbour.kind === 'object' ? {} : [], neighbour.key);
    return nodeFromValue(neighbour.kind === 'number' ? 0 : neighbour.kind === 'boolean' ? false : neighbour.kind === 'null' ? null : '', neighbour.key);
}

function isContainerKind(kind: JsonNode['kind']): boolean {
    return kind === 'object' || kind === 'array';
}

export function insertChild(parent: JsonNode, index: number, child: JsonNode): number {
    const children = parent.children ?? [];
    const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : children.length, children.length));
    children.splice(at, 0, child);
    parent.children = children;
    parent.stale = true;
    return at;
}

export function removeChild(parent: JsonNode, index: number): JsonNode | null {
    const children = parent.children;
    if (!children || index < 0 || index >= children.length)
        return null;
    const [taken] = children.splice(index, 1);
    parent.stale = true;
    return taken ?? null;
}

/** Moves one member within its parent, which is the only drag the model supports. */
export function moveChild(parent: JsonNode, from: number, to: number): boolean {
    const children = parent.children;
    if (!children || children.length < 2)
        return false;
    const fromIndex = clampIndex(from, children.length);
    const toIndex = clampIndex(to, children.length);
    if (fromIndex === toIndex)
        return false;
    const [taken] = children.splice(fromIndex, 1);
    if (!taken)
        return false;
    children.splice(toIndex, 0, taken);
    parent.stale = true;
    return true;
}

function clampIndex(index: number, length: number): number {
    if (!Number.isFinite(index))
        return 0;
    return Math.max(0, Math.min(Math.trunc(index), length - 1));
}

/**
 * Reorders a container's members by a comparator.
 *
 * The same staleness as a move: only the parent's slice is invalidated, so each moved line keeps its own
 * formatting and the comment attached to it.
 */
export function sortChildren(parent: JsonNode, by: (left: JsonNode, right: JsonNode) => number): boolean {
    const children = parent.children;
    if (!children || children.length < 2)
        return false;
    const order = [...children.keys()];
    order.sort((left, right) => by(children[left]!, children[right]!));
    const next = order.map(index => children[index]!);
    const changed = next.some((child, index) => child !== children[index]);
    if (!changed)
        return false;
    parent.children = next;
    parent.stale = true;
    return true;
}

/**
 * Collapsing a subtree from the root of a document.
 *
 * Depth is counted in edges from the root, and level 0 is the root itself, so `collapseTo(1)` leaves the
 * top-level keys visible and their contents folded — the reading state a preview opens in.
 */
export function collapseToDepth(root: JsonNode, depth: number): void {
    const walk = (node: JsonNode, level: number): void => {
        if (!node.children)
            return;
        node.collapsed = level >= depth;
        for (const child of node.children)
            walk(child, level + 1);
    };
    root.collapsed = false;
    walk(root, 0);
}

export function setCollapsed(node: JsonNode, collapsed: boolean): void {
    if (node.children)
        node.collapsed = collapsed;
}

/** Every descendant of a container, folded or not — the count the view's badge shows. */
export function countDescendants(node: JsonNode): number {
    let total = 0;
    const walk = (current: JsonNode): void => {
        for (const child of current.children ?? []) {
            total++;
            walk(child);
        }
    };
    walk(node);
    return total;
}

/**
 * The deepest a tree goes, without recursing through it.
 *
 * The parser already refuses anything past its own ceiling, so a stored tree is bounded — but this runs
 * per keystroke on the filter's "how much did that match" line, and an iterative walk keeps a 20 000-node
 * document from costing a stack frame each.
 */
export function treeDepth(root: JsonNode): number {
    let depth = 0;
    const stack: Array<{ node: JsonNode, level: number }> = [{ node: root, level: 0 }];
    while (stack.length > 0) {
        const entry = stack.pop()!;
        depth = Math.max(depth, entry.level);
        for (const child of entry.node.children ?? [])
            stack.push({ node: child, level: entry.level + 1 });
    }
    return depth;
}
