/**
 * Hand-written submenu panels have to bring their own chrome.
 *
 * The wrapper `Menu` portals a submenu into is transparent by design — the panel inside it is what
 * makes the rows readable. A caller that writes its rows bare therefore draws text straight onto the
 * page behind the menu, and a test that only counts the rows still passes. jsdom resolves no
 * stylesheet, so the panels are pinned by the class they carry and the helper that reads the computed
 * style is pinned separately, against stubbed boxes.
 */
import { createElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NoteCoverDecoration } from '@shared/property-decorations';
import { COVER_POSITIONS, COVER_SHAPES } from '@shared/property-decorations';
import type { PropertySettings } from '@shared/types';
import type { MenuItem } from '../../components/overlay';
import { isOpaqueBackgroundColor, paintsOpaqueFill } from '../../components/overlay';
import { initI18n } from '../../lib/i18n';
import { renderElement } from '../../lib/test-render';
import { coverMenuItems, type DecorationActions } from './PropertyDecorations';
import { PropertyColorPanel } from './property-colors';

const PANEL_CHROME = ['bg-[var(--bg-overlay)]', 'border-[var(--border-default)]', 'shadow-[var(--shadow-pop)]'];

beforeAll(async () => {
    await initI18n();
});

function assertOpaquePanel(root: Element | null, name: string): void {
    expect(root, `${name}: no panel was rendered`).not.toBeNull();
    const className = root?.getAttribute('class') ?? '';
    for (const token of PANEL_CHROME)
        expect(className, `${name}: panel is missing ${token}`).toContain(token);
}

function renderSubmenu(item: MenuItem, name: string): ReturnType<typeof renderElement> {
    const build = item.submenu;
    expect(build, `${name}: the row declares no submenu`).toBeTruthy();
    const node = typeof build === 'function'
        ? build({ closeMenu: () => { } })
        : build;
    return renderElement(node);
}

function coverFixture(shape: string, position: string) {
    const cover = { property: 'cover', image: { source: 'url', value: 'https://example.test/a.png' }, shape, position } as unknown as NoteCoverDecoration;
    const settings = { coverShapeProperty: 'cover-shape', coverPositionProperty: 'cover-position' } as unknown as PropertySettings;
    const setProperty = vi.fn();
    const actions = {
        setProperty,
        hideProperty: vi.fn(),
        isHidden: () => false,
        pickImage: vi.fn(),
        pickIcon: vi.fn(),
        setSettings: vi.fn(),
    } satisfies DecorationActions;
    return { cover, settings, actions, setProperty };
}

describe('cover decoration submenus', () => {
    it('paint an opaque panel for both the shape and the position list', () => {
        const { cover, settings, actions } = coverFixture('square', 'left');
        const items = coverMenuItems(cover, settings, actions);
        for (const id of ['cover-shape', 'cover-position']) {
            const item = items.find(entry => entry.id === id);
            expect(item, `${id}: not offered`).toBeTruthy();
            const rendered = renderSubmenu(item!, id);
            assertOpaquePanel(rendered.container.firstElementChild, id);
            rendered.unmount();
        }
    });
    it('offer the search box exactly the rows the panel draws', () => {
        const { cover, settings, actions } = coverFixture('circle', 'top');
        const items = coverMenuItems(cover, settings, actions);
        for (const [id, total] of [['cover-shape', COVER_SHAPES.length], ['cover-position', COVER_POSITIONS.length]] as const) {
            const item = items.find(entry => entry.id === id)!;
            expect(item.subItems).toHaveLength(total);
            const rendered = renderSubmenu(item, id);
            expect(rendered.container.querySelectorAll('button[data-submenu-row]')).toHaveLength(total);
            // The current value is marked in the panel, not only in the data the search reads.
            expect(rendered.container.querySelectorAll('button[aria-checked="true"]')).toHaveLength(1);
            rendered.unmount();
        }
    });
    it('keeps each row writing to the property its own list belongs to', () => {
        const { cover, settings, actions, setProperty } = coverFixture('square', 'left');
        const items = coverMenuItems(cover, settings, actions);
        for (const [id, property, values, index] of [
            ['cover-shape', 'cover-shape', COVER_SHAPES, 3],
            ['cover-position', 'cover-position', COVER_POSITIONS, 2],
        ] as const) {
            const rendered = renderSubmenu(items.find(item => item.id === id)!, id);
            const row = rendered.container.querySelectorAll<HTMLButtonElement>('button[data-submenu-row]')[index];
            row.click();
            expect(setProperty, `${id} writes its own property`).toHaveBeenLastCalledWith(property, values[index]);
            rendered.unmount();
        }
        expect(setProperty).toHaveBeenCalledTimes(2);
    });
});

describe('the property colour picker', () => {
    it('paints an opaque panel, so the contrast hint reads its own surface', () => {
        const onPick = vi.fn();
        const rendered = renderElement(createElement(PropertyColorPanel, {
            label: 'Pill colour',
            current: null,
            tinted: true,
            onPick,
        }));
        assertOpaquePanel(rendered.container.firstElementChild, 'PropertyColorPanel');
        // The panel is only worth its chrome if its swatches still do their job from inside it.
        const swatch = rendered.container.querySelector<HTMLButtonElement>('button[aria-label][aria-pressed]');
        expect(swatch, 'the panel offers no swatch').not.toBeNull();
        swatch?.click();
        expect(onPick).toHaveBeenCalledTimes(1);
        rendered.unmount();
    });
});

describe('opaque fill detection', () => {
    it('reads the alpha channel of every form a computed background comes in', () => {
        expect(isOpaqueBackgroundColor('rgb(255, 255, 255)')).toBe(true);
        expect(isOpaqueBackgroundColor('rgba(41, 42, 45, 1)')).toBe(true);
        expect(isOpaqueBackgroundColor('rgba(0, 0, 0, 0)')).toBe(false);
        expect(isOpaqueBackgroundColor('rgba(127, 127, 127, 0.04)')).toBe(false);
        expect(isOpaqueBackgroundColor('oklab(1 0 0)')).toBe(true);
        expect(isOpaqueBackgroundColor('oklab(0.51 0.04 0.04 / 0.3)')).toBe(false);
        expect(isOpaqueBackgroundColor('rgb(0 0 0 / 100%)')).toBe(true);
        expect(isOpaqueBackgroundColor('rgb(0 0 0 / 50%)')).toBe(false);
        expect(isOpaqueBackgroundColor('transparent')).toBe(false);
        // A lightness percentage is not an alpha channel.
        expect(isOpaqueBackgroundColor('oklch(27% 0.012 265)')).toBe(true);
    });
    it('accepts a panel whose chrome sits one level in, and rejects a bare list of rows', () => {
        const rect = (element: HTMLElement, box: [number, number, number, number]) => {
            const [left, top, width, height] = box;
            element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
        };
        const panel = document.createElement('div');
        panel.style.backgroundColor = 'rgba(0, 0, 0, 0)';
        const inner = document.createElement('div');
        inner.style.backgroundColor = 'rgb(255, 255, 255)';
        panel.appendChild(inner);
        document.body.appendChild(panel);
        rect(panel, [40, 40, 200, 120]);
        rect(inner, [40, 40, 200, 120]);
        expect(paintsOpaqueFill(panel)).toBe(true);
        // The same chrome one pixel short of the wrapper leaves the edge unpainted.
        rect(inner, [40, 40, 190, 120]);
        expect(paintsOpaqueFill(panel)).toBe(false);
        inner.style.backgroundColor = 'rgba(127, 127, 127, 0.4)';
        rect(inner, [40, 40, 200, 120]);
        expect(paintsOpaqueFill(panel)).toBe(false);
        // Nothing is drawn, so nothing can be unreadable.
        rect(panel, [40, 40, 0, 0]);
        expect(paintsOpaqueFill(panel)).toBe(true);
        panel.remove();
    });
});
