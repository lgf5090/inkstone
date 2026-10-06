import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    collapseOrLeave,
    expandOrReveal,
    firstChildRowOf,
    isExpanded,
    moveTreeFocus,
    parentRowOf,
    toggleOf,
    visibleTreeRows,
} from './tree-keyboard';

function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    return host;
}

function row(host: HTMLElement, name: string): HTMLElement {
    const found = [...host.querySelectorAll<HTMLElement>('[data-tree-row]')].find((element) => element.textContent === name);
    if (!found)
        throw new Error(`missing row ${name}`);
    return found;
}

function treeItem(host: HTMLElement, name: string): HTMLElement {
    const found = host.querySelector<HTMLElement>(`[data-item="${name}"]`);
    if (!found)
        throw new Error(`missing tree item ${name}`);
    return found;
}

const TREE = `
<div role="tree">
  <div role="treeitem" data-item="A" aria-level="1" aria-expanded="true">
    <div><button data-tree-toggle aria-expanded="true">toggle</button><button data-tree-row>A</button></div>
    <div role="group">
      <div role="treeitem" data-item="A1" aria-level="2">
        <div><button data-tree-row>A1</button></div>
      </div>
      <div role="treeitem" data-item="A2" aria-level="2" aria-expanded="false">
        <div><button data-tree-toggle aria-expanded="false">toggle</button><button data-tree-row>A2</button></div>
        <div role="group" inert aria-hidden="true">
          <div role="treeitem" data-item="Hidden" aria-level="3">
            <div><button data-tree-row>Hidden</button></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div role="treeitem" data-item="B" aria-level="1">
    <div><button data-tree-toggle disabled>toggle</button><button data-tree-row>B</button></div>
  </div>
</div>`;

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
});

let host: HTMLElement | undefined;

afterEach(() => {
    host?.remove();
    host = undefined;
    Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('visibleTreeRows', () => {
    it('lists rows in document order and skips collapsed branches', () => {
        host = mount(TREE);
        expect(visibleTreeRows(row(host, 'A')).map((element) => element.textContent)).toEqual(['A', 'A1', 'A2', 'B']);
    });

    it('returns nothing when the element is not inside a tree', () => {
        host = mount('<button data-tree-row>loose</button>');
        expect(visibleTreeRows(row(host, 'loose'))).toEqual([]);
    });
});

describe('moveTreeFocus', () => {
    it('steps forward and wraps to the first row', () => {
        host = mount(TREE);
        expect(moveTreeFocus(row(host, 'A2'), 1)).toBe(true);
        expect(document.activeElement).toBe(row(host, 'B'));
        expect(moveTreeFocus(row(host, 'B'), 1)).toBe(true);
        expect(document.activeElement).toBe(row(host, 'A'));
    });

    it('steps backward and wraps to the last row', () => {
        host = mount(TREE);
        expect(moveTreeFocus(row(host, 'A'), -1)).toBe(true);
        expect(document.activeElement).toBe(row(host, 'B'));
    });

    it('reports failure for a row the tree does not contain', () => {
        host = mount(TREE);
        const orphan = document.createElement('button');
        orphan.dataset.treeRow = '';
        document.body.append(orphan);
        expect(moveTreeFocus(orphan, 1)).toBe(false);
        orphan.remove();
    });
});

describe('expand and collapse', () => {
    it('clicks the toggle of a collapsed folder instead of moving focus', () => {
        host = mount(TREE);
        const item = treeItem(host, 'A2');
        const toggle = item.querySelector<HTMLButtonElement>('[data-tree-toggle]')!;
        const click = vi.spyOn(toggle, 'click');
        expect(expandOrReveal(row(host, 'A2'))).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
        expect(document.activeElement).not.toBe(row(host, 'A1'));
    });

    it('moves into the first child of an expanded folder', () => {
        host = mount(TREE);
        expect(isExpanded(row(host, 'A'))).toBe(true);
        expect(expandOrReveal(row(host, 'A'))).toBe(true);
        expect(document.activeElement).toBe(row(host, 'A1'));
    });

    it('collapses an expanded folder in place', () => {
        host = mount(TREE);
        const toggle = treeItem(host, 'A').querySelector<HTMLButtonElement>('[data-tree-toggle]')!;
        const click = vi.spyOn(toggle, 'click');
        expect(collapseOrLeave(row(host, 'A'))).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
    });

    it('walks a leaf back to its parent row', () => {
        host = mount(TREE);
        expect(collapseOrLeave(row(host, 'A1'))).toBe(true);
        expect(document.activeElement).toBe(row(host, 'A'));
    });

    it('treats a folder whose toggle is disabled as a leaf', () => {
        host = mount(TREE);
        expect(toggleOf(row(host, 'B'))).toBeNull();
        expect(expandOrReveal(row(host, 'B'))).toBe(false);
        expect(collapseOrLeave(row(host, 'B'))).toBe(false);
    });
});

describe('structure lookups', () => {
    it('finds the owning parent row and the first visible child row', () => {
        host = mount(TREE);
        expect(parentRowOf(row(host, 'A1'))).toBe(row(host, 'A'));
        expect(parentRowOf(row(host, 'A'))).toBeNull();
        expect(firstChildRowOf(treeItem(host, 'A'))).toBe(row(host, 'A1'));
        expect(firstChildRowOf(treeItem(host, 'A2'))).toBeNull();
    });
});
