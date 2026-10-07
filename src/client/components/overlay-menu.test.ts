import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './overlay';

const POINT = { x: 10, y: 10 };

let root: Root;
let host: HTMLDivElement;

function renderMenu(items: MenuItem[], onClose: () => void, open = true): void {
    act(() => {
        root.render(createElement(Menu, { anchor: POINT, open, onClose, items }));
    });
}

function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="menu"]');
}

function submenu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="group"]');
}

function itemByLabel(label: string): HTMLButtonElement {
    const found = [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent === label);
    if (!found)
        throw new Error(`missing menu item ${label}`);
    return found;
}

function hover(element: HTMLElement): void {
    act(() => {
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    });
}

function keyDown(key: string, target: EventTarget = document.activeElement ?? document.body): void {
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
}

function flyoutNode(): ReactNode {
    return createElement('div', { className: 'flyout' }, [
        createElement('button', {
            key: 'pick',
            type: 'button',
            'data-pick': 'yes',
            onClick: () => undefined,
        }, 'Pick me'),
    ]);
}

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

describe('Menu without submenus', () => {
    it('selects an item and closes', () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        renderMenu([{ id: 'plain', label: 'Plain', onSelect }], onClose);
        act(() => {
            itemByLabel('Plain').click();
        });
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('Menu submenu flyout', () => {
    const items = (closeSpy: () => void): MenuItem[] => [
        { id: 'plain', label: 'Plain', onSelect: vi.fn() },
        {
            id: 'colors',
            label: 'Colors',
            submenu: ({ closeMenu }) => createElement('div', {
                onClick: () => {
                    closeSpy();
                    closeMenu();
                },
            }, flyoutNode()),
        },
    ];

    it('marks the item as a submenu trigger and keeps the flyout closed', () => {
        renderMenu(items(vi.fn()), vi.fn());
        const trigger = itemByLabel('Colors');
        expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(submenu()).toBeNull();
    });

    it('opens the flyout on click without closing the menu', () => {
        const onClose = vi.fn();
        renderMenu(items(vi.fn()), onClose);
        act(() => {
            itemByLabel('Colors').click();
        });
        expect(submenu()).not.toBeNull();
        expect(itemByLabel('Colors').getAttribute('aria-expanded')).toBe('true');
        expect(onClose).not.toHaveBeenCalled();
        expect(menu()).not.toBeNull();
    });

    it('opens on hover and follows the hovered row', () => {
        renderMenu(items(vi.fn()), vi.fn());
        act(() => {
            hover(itemByLabel('Colors'));
        });
        expect(submenu()).not.toBeNull();
        act(() => {
            hover(itemByLabel('Plain'));
        });
        expect(submenu()).toBeNull();
    });

    it('closes the flyout first when Escape is pressed', () => {
        const onClose = vi.fn();
        renderMenu(items(vi.fn()), onClose);
        act(() => {
            hover(itemByLabel('Colors'));
        });
        keyDown('Escape');
        expect(submenu()).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        keyDown('Escape');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('opens with ArrowRight and returns with ArrowLeft', () => {
        renderMenu(items(vi.fn()), vi.fn());
        act(() => {
            itemByLabel('Plain').focus();
        });
        keyDown('ArrowDown');
        expect(document.activeElement).toBe(itemByLabel('Colors'));
        keyDown('ArrowRight');
        expect(submenu()).not.toBeNull();
        expect(submenu()?.hasAttribute('inert')).toBe(false);
        keyDown('ArrowLeft');
        expect(submenu()).toBeNull();
    });

    it('keeps the flyout open and re-anchored while the menu scrolls', () => {
        renderMenu(items(vi.fn()), vi.fn());
        act(() => {
            itemByLabel('Plain').focus();
        });
        keyDown('ArrowDown');
        keyDown('ArrowRight');
        expect(submenu()).not.toBeNull();
        const before = submenu()?.getBoundingClientRect().top ?? -1;
        act(() => {
            document.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(new Event('scroll'));
        });
        expect(submenu()).not.toBeNull();
        expect(submenu()?.getBoundingClientRect().top ?? -1).toBe(before);
    });
    it('moves focus into the flyout when opened from the keyboard', () => {
        renderMenu(items(vi.fn()), vi.fn());
        act(() => {
            itemByLabel('Plain').focus();
        });
        keyDown('ArrowDown');
        keyDown('Enter');
        expect(submenu()).not.toBeNull();
        expect(submenu()?.contains(document.activeElement)).toBe(true);
    });

    it('leaves arrow keys to the text field inside the flyout', () => {
        const onClose = vi.fn();
        renderMenu([{
            id: 'icon',
            label: 'Icon',
            submenu: () => createElement('input', { type: 'text' }),
        }], onClose);
        act(() => {
            itemByLabel('Icon').focus();
        });
        keyDown('Enter');
        const field = submenu()?.querySelector('input');
        expect(field).toBeTruthy();
        act(() => {
            field?.focus();
        });
        keyDown('ArrowLeft', field!);
        expect(submenu()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes the whole menu when the flyout asks for it', () => {
        const closeSpy = vi.fn();
        const onClose = vi.fn();
        renderMenu(items(closeSpy), onClose);
        act(() => {
            hover(itemByLabel('Colors'));
        });
        act(() => {
            submenu()?.querySelector<HTMLButtonElement>('[data-pick]')?.click();
        });
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('forgets the open flyout when the menu closes and reopens', () => {
        const onClose = vi.fn();
        const withSubmenu = items(vi.fn());
        renderMenu(withSubmenu, onClose);
        act(() => {
            hover(itemByLabel('Colors'));
        });
        expect(submenu()).not.toBeNull();
        renderMenu(withSubmenu, onClose, false);
        expect(menu()).toBeNull();
        renderMenu(withSubmenu, onClose, true);
        expect(submenu()).toBeNull();
    });
});
