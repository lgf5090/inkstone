export const TREE_ROW_SELECTOR = '[data-tree-row]';

function isWithinCollapsedBranch(element: HTMLElement, tree: HTMLElement): boolean {
    let cursor: HTMLElement | null = element.parentElement;
    while (cursor && cursor !== tree) {
        if (cursor.hasAttribute('inert') || cursor.getAttribute('aria-hidden') === 'true')
            return true;
        cursor = cursor.parentElement;
    }
    return false;
}

export function visibleTreeRows(element: HTMLElement): HTMLElement[] {
    const tree = element.closest('[role="tree"]');
    if (!(tree instanceof HTMLElement))
        return [];
    return [...tree.querySelectorAll<HTMLElement>(TREE_ROW_SELECTOR)]
        .filter((row) => !row.hasAttribute('disabled') && !isWithinCollapsedBranch(row, tree));
}

export function focusTreeRow(row: HTMLElement | null): void {
    row?.focus({ preventScroll: false });
    row?.scrollIntoView({ block: 'nearest' });
}

export function moveTreeFocus(element: HTMLElement, step: 1 | -1): boolean {
    const rows = visibleTreeRows(element);
    const index = rows.indexOf(element);
    if (index < 0 || rows.length === 0)
        return false;
    const next = rows[(index + step + rows.length) % rows.length];
    if (!next)
        return false;
    focusTreeRow(next);
    return true;
}

export function toggleOf(element: HTMLElement): HTMLButtonElement | null {
    const row = element.closest('[role="treeitem"]');
    if (!(row instanceof HTMLElement))
        return null;
    const toggle = row.querySelector<HTMLButtonElement>('[data-tree-toggle]');
    return toggle && !toggle.disabled ? toggle : null;
}

export function parentRowOf(element: HTMLElement): HTMLElement | null {
    const group = element.closest('[role="group"]');
    const parentItem = group?.closest('[role="treeitem"]');
    if (!(parentItem instanceof HTMLElement))
        return null;
    return parentItem.querySelector<HTMLElement>(TREE_ROW_SELECTOR);
}

export function firstChildRowOf(element: HTMLElement): HTMLElement | null {
    const item = element.closest('[role="treeitem"]');
    if (!(item instanceof HTMLElement))
        return null;
    const group = item.querySelector(':scope > [role="group"]');
    if (!(group instanceof HTMLElement) || group.hasAttribute('inert'))
        return null;
    return group.querySelector<HTMLElement>(TREE_ROW_SELECTOR);
}

export function isExpandable(element: HTMLElement): boolean {
    return toggleOf(element) !== null;
}

export function isExpanded(element: HTMLElement): boolean {
    return element.closest('[role="treeitem"]')?.getAttribute('aria-expanded') === 'true';
}

export function expandOrReveal(element: HTMLElement): boolean {
    if (!isExpandable(element))
        return false;
    if (!isExpanded(element)) {
        toggleOf(element)?.click();
        return true;
    }
    const child = firstChildRowOf(element);
    if (!child)
        return false;
    focusTreeRow(child);
    return true;
}

export function collapseOrLeave(element: HTMLElement): boolean {
    if (isExpandable(element) && isExpanded(element)) {
        toggleOf(element)?.click();
        return true;
    }
    const parent = parentRowOf(element);
    if (!parent)
        return false;
    focusTreeRow(parent);
    return true;
}
