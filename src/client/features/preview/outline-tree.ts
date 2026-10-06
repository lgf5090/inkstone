import type { Heading } from '../../lib/markdown/renderer';

export interface OutlineNode {
    heading: Heading;
    index: number;
    tier: number;
    parentIndex: number;
    hasChildren: boolean;
}

/**
 * Assigns each heading the parent implied by the headings around it, so a document that jumps
 * from `#` straight to `###` still indents by one step rather than two.
 */
export function buildOutlineTree(headings: Heading[]): OutlineNode[] {
    const stack: Array<{ index: number; level: number }> = [];
    return headings.map((heading, index) => {
        const next = headings[index + 1];
        while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
        const parentIndex = stack.length === 0 ? -1 : stack[stack.length - 1]!.index;
        const node: OutlineNode = {
            heading,
            index,
            tier: stack.length,
            parentIndex,
            hasChildren: Boolean(next && next.level > heading.level),
        };
        stack.push({ index, level: heading.level });
        return node;
    });
}

export function parentSlugs(tree: OutlineNode[]): string[] {
    return tree.filter((node) => node.hasChildren).map((node) => node.heading.slug);
}

/**
 * Collapse every parent sitting at `level` or deeper, which leaves levels 1…level-1 open.
 * Asking for a level past the deepest heading collapses nothing, so the tree stays fully open.
 */
export function collapsedToLevel(tree: OutlineNode[], level: number): Set<string> {
    const collapsed = new Set<string>();
    for (const node of tree)
        if (node.hasChildren && node.heading.level >= level) collapsed.add(node.heading.slug);
    return collapsed;
}

/** Drops slugs that no longer name a collapsible row, so the set cannot grow without bound. */
export function pruneCollapsed(tree: OutlineNode[], collapsed: Set<string>): Set<string> {
    const parents = new Set(parentSlugs(tree));
    const kept = new Set<string>();
    for (const slug of collapsed)
        if (parents.has(slug)) kept.add(slug);
    return kept.size === collapsed.size ? collapsed : kept;
}

export function computeHiddenByCollapse(tree: OutlineNode[], collapsed: ReadonlySet<string>): boolean[] {
    const hidden = new Array<boolean>(tree.length);
    for (const node of tree) {
        const parent = node.parentIndex >= 0 ? tree[node.parentIndex] : undefined;
        hidden[node.index] = parent
            ? hidden[parent.index] || (parent.hasChildren && collapsed.has(parent.heading.slug))
            : false;
    }
    return hidden;
}

/**
 * Turns a query into a predicate. An unparseable regex matches everything, which keeps the panel
 * readable while the pattern is half-typed instead of blanking the outline.
 */
export function compileFilter(query: string, useRegex: boolean): (text: string) => boolean {
    if (!useRegex) {
        const needle = query.toLowerCase();
        return (text) => text.toLowerCase().includes(needle);
    }
    let rule: RegExp;
    try {
        rule = new RegExp(query, 'i');
    }
    catch {
        return () => true;
    }
    return (text) => rule.test(text);
}

export interface OutlineFilterResult {
    /** Every match plus the ancestors that lead to it. */
    visible: boolean[];
    matchCount: number;
}

export function filterTree(tree: OutlineNode[], query: string, useRegex: boolean): OutlineFilterResult {
    const trimmed = query.trim();
    if (!trimmed)
        return { visible: new Array<boolean>(tree.length).fill(true), matchCount: tree.length };
    const test = compileFilter(trimmed, useRegex);
    const visible = tree.map((node) => test(node.heading.text));
    const matchCount = visible.filter(Boolean).length;
    for (let index = tree.length - 1; index >= 0; index--) {
        const parent = tree[index]!.parentIndex;
        if (visible[index] && parent >= 0) visible[parent] = true;
    }
    return { visible, matchCount };
}

export function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** A document that fits its viewport has nothing left to read, so it counts as finished. */
export function readingProgress(scrollTop: number, scrollHeight: number, clientHeight: number): number {
    const distance = scrollHeight - clientHeight;
    return distance <= 1 ? 1 : clamp(scrollTop / distance, 0, 1);
}

export function activeHeadingIndex(tops: readonly number[], threshold: number, atBottom: boolean): number {
    if (tops.length === 0) return -1;
    if (atBottom) return tops.length - 1;
    let low = 0;
    let high = tops.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (tops[middle]! <= threshold) {
            found = middle;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    return found;
}
