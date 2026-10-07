import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, filterMenuItems, type MenuItem } from './overlay';
import { preloadPinyin } from '../lib/pinyin';

const POINT = { x: 10, y: 10 };

let root: Root;
let host: HTMLDivElement;

function render(node: ReactNode): void {
    act(() => {
        root.render(node);
    });
}

function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="menu"]');
}

function field(): HTMLInputElement | null {
    return menu()?.querySelector<HTMLInputElement>('input[type="search"]') ?? null;
}

function labels(): string[] {
    return [...(menu()?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]') ?? [])]
        .map((button) => button.textContent ?? '');
}

function row(label: string): HTMLButtonElement {
    const found = [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((button) => button.textContent === label);
    if (!found)
        throw new Error(`missing menu row ${label}`);
    return found;
}

/** What the user sees after typing: the field's own value plus whatever the list kept. */
function type(query: string): void {
    const input = field();
    if (!input)
        throw new Error('menu has no search field');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
        input.focus();
        setter?.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function keyDown(key: string, target: EventTarget = document.activeElement ?? document.body, init: KeyboardEventInit = {}): void {
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });
}

const LEAF: MenuItem = { id: 'plain', label: 'Plain', onSelect: vi.fn() };
const NESTED: MenuItem = {
    id: 'insert',
    label: 'Insert',
    subItems: [{ id: 'picture', label: 'Picture', onSelect: vi.fn() }],
    submenu: () => createElement('div', null, 'picture'),
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    host.remove();
});

describe('filterMenuItems', () => {
    it('hands back the list untouched for an empty or blank query', () => {
        const items = [LEAF, NESTED];
        expect(filterMenuItems(items, '')).toBe(items);
        expect(filterMenuItems(items, '   ')).toBe(items);
    });

    it('promotes a submenu child under its parent’s label and keeps both ids', () => {
        const out = filterMenuItems([LEAF, NESTED], 'picture');
        expect(out.map((item) => item.id)).toEqual(['insert:picture']);
        expect(out[0]!.label).toBe('Insert › Picture');
    });

    it('keeps a matching parent alone, since its children are one hover away', () => {
        expect(filterMenuItems([LEAF, NESTED], 'insert').map((item) => item.id)).toEqual(['insert']);
        expect(filterMenuItems([LEAF, NESTED], 'picture').map((item) => item.id)).toEqual(['insert:picture']);
    });

    it('turns a header action into a row of its own and skips a disabled one', () => {
        const onSelect = vi.fn();
        const out = filterMenuItems([], 'copy', [
            { id: 'copy', label: 'Copy', onSelect },
            { id: 'paste', label: 'Paste', disabled: true, onSelect },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ id: 'action-copy', label: 'Copy' });
        out[0]!.onSelect?.();
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('drops the separators, because a filtered list is no longer the original grouping', () => {
        const items: MenuItem[] = [{ id: 'a', label: 'Alpha', separatorBefore: true }];
        expect(filterMenuItems(items, 'alpha')[0]!.separatorBefore).toBe(false);
    });

    it('matches a two-word label by its initials, but not a single word', () => {
        const items: MenuItem[] = [
            { id: 'csv', label: 'Copy as CSV' },
            { id: 'one', label: 'Delete' },
        ];
        expect(filterMenuItems(items, 'cac').map((item) => item.id)).toEqual(['csv']);
        expect(filterMenuItems(items, 'del').map((item) => item.id)).toEqual(['one']);
        expect(filterMenuItems(items, 'de').map((item) => item.id)).toEqual(['one']);
    });

    it('matches a Chinese label by its first letters, once the readings have arrived', async () => {
        await preloadPinyin();
        const chinese: MenuItem[] = [
            { id: 'table', label: '\u63d2\u5165 › \u8868\u683c' },
            { id: 'code', label: '\u4ee3\u7801\u5757' },
        ];
        expect(filterMenuItems(chinese, 'crbg').map((item) => item.id)).toEqual(['table']);
        expect(filterMenuItems(chinese, 'dmk').map((item) => item.id)).toEqual(['code']);
        expect(filterMenuItems(chinese, 'biaoge').map((item) => item.id)).toEqual(['table']);
        expect(filterMenuItems(chinese, 'xyz')).toEqual([]);
    });
});

describe('Menu search field', () => {
    it('renders no field and no header for a plain menu', () => {
        render(createElement(Menu, { anchor: POINT, open: true, onClose: vi.fn(), items: [LEAF, NESTED] }));
        expect(field()).toBeNull();
        expect(labels()).toEqual(['Plain', 'Insert']);
    });

    it('shows every row before anything is typed and takes the caret itself', () => {
        render(createElement(Menu, { anchor: POINT, open: true, onClose: vi.fn(), items: [LEAF, NESTED], searchable: true }));
        expect(labels()).toEqual(['Plain', 'Insert']);
        expect(document.activeElement).toBe(field());
    });

    it('narrows the list as the query grows', () => {
        render(createElement(Menu, { anchor: POINT, open: true, onClose: vi.fn(), items: [LEAF, NESTED], searchable: true }));
        type('pic');
        expect(labels()).toEqual(['Insert › Picture']);
    });

    it('offers the header actions as rows beside the list', () => {
        render(createElement(Menu, {
            anchor: POINT,
            open: true,
            onClose: vi.fn(),
            items: [LEAF],
            searchable: true,
            searchActions: [{ id: 'cut', label: 'Cut', onSelect: vi.fn() }],
        }));
        type('c');
        expect(labels()).toEqual(['Cut']);
    });

    it('keeps a space typed in the field out of the list', () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        render(createElement(Menu, {
            anchor: POINT,
            open: true,
            onClose,
            items: [{ id: 's', label: 's', onSelect }],
            searchable: true,
        }));
        keyDown(' ', field()!);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(menu()).not.toBeNull();
    });

    it('steps from the field into the first row on ArrowDown', () => {
        render(createElement(Menu, { anchor: POINT, open: true, onClose: vi.fn(), items: [LEAF, NESTED], searchable: true }));
        type('');
        keyDown('ArrowDown', field()!);
        expect(document.activeElement).toBe(row('Plain'));
    });

    it('runs the highlighted row on Enter and closes', () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        render(createElement(Menu, {
            anchor: POINT,
            open: true,
            onClose,
            items: [{ id: 'p', label: 'Ping', onSelect }],
            searchable: true,
        }));
        keyDown('Enter', field()!);
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clears the query on the first Escape and closes on the second', () => {
        const onClose = vi.fn();
        render(createElement(Menu, { anchor: POINT, open: true, onClose, items: [LEAF], searchable: true }));
        type('pi');
        keyDown('Escape', field()!);
        expect(field()?.value).toBe('');
        expect(labels()).toEqual(['Plain']);
        expect(onClose).not.toHaveBeenCalled();
        keyDown('Escape', field()!);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('starts over each time the menu opens', () => {
        const props = { anchor: POINT, onClose: vi.fn(), items: [LEAF, NESTED], searchable: true };
        render(createElement(Menu, { ...props, open: true }));
        type('pic');
        render(createElement(Menu, { ...props, open: false }));
        render(createElement(Menu, { ...props, open: true }));
        expect(field()?.value).toBe('');
        expect(labels()).toEqual(['Plain', 'Insert']);
    });

    it('renders the header above the filter box, both outside the scrolling rows', () => {
        render(createElement(Menu, {
            anchor: POINT,
            open: true,
            onClose: vi.fn(),
            items: [LEAF],
            header: createElement('div', { 'data-head': 'yes' }, 'actions'),
            searchable: true,
        }));
        const head = menu()?.querySelector('[data-head]');
        expect(head).toBeTruthy();
        const input = field()!;
        expect(menu()?.contains(input)).toBe(true);
        expect(head!.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The rows scroll; the head and the box do not, so a query stays visible while its list moves.
        const scroller = input.parentElement?.nextElementSibling;
        expect(scroller?.querySelector('button[role="menuitem"]')?.textContent).toBe('Plain');
        expect(scroller?.contains(head!)).toBe(false);
        expect(scroller?.contains(input)).toBe(false);
    });
});
