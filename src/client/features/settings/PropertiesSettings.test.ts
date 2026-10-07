import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeSettings, mergeSettingsPatch } from '@shared/constants';
import type { UserSettings } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { PropertiesSettings } from './PropertiesSettings';

const updateSettings = vi.fn();

interface SessionStore {
    settings: UserSettings;
    updateSettings: typeof updateSettings;
}

let session: SessionStore;

vi.mock('../../store/session', () => ({
    useSession: (selector: (state: SessionStore) => unknown) => selector(session),
}));

let host: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
    await act(async () => {
        root.render(createElement(PropertiesSettings));
        await Promise.resolve();
    });
}

function rows(): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>('[data-setting-title]')];
}

function rowTitle(title: string): HTMLElement {
    const found = rows().find(node => node.getAttribute('data-setting-title') === title);
    if (!found)
        throw new Error(`missing setting row ${title}`);
    return found;
}

function control(title: string): HTMLElement {
    return rowTitle(title).querySelector<HTMLElement>('button[role="switch"], input, select, button')!;
}

async function click(element: Element | null | undefined): Promise<void> {
    expect(element, 'expected a control').toBeTruthy();
    await act(async () => {
        element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await Promise.resolve();
    });
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
    });
}

function latest(): Partial<PropertyKeys> {
    const call = updateSettings.mock.calls.at(-1)![0] as { properties?: Record<string, unknown> };
    return call?.properties ?? {};
}

type PropertyKeys = keyof UserSettings['properties'];

beforeAll(async () => {
    await initI18n();
});

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    updateSettings.mockReset();
    session = { settings: mergeSettings({}), updateSettings };
    updateSettings.mockImplementation((patch) => {
        session.settings = mergeSettingsPatch(session.settings, patch);
        void render();
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

describe('properties settings', () => {
    it('renders a row for every group the panel exposes', async () => {
        await render();
        for (const title of [
            t('settings.properties_enabled'),
            t('settings.cover_properties'),
            t('settings.cover_default_shape'),
            t('settings.banner_height'),
            t('settings.icon_size'),
            t('settings.property_formats'),
            t('settings.hidden_properties'),
        ])
            expect(rows().map(node => node.getAttribute('data-setting-title'))).toContain(title);
    });

    it('writes the master switch back as its own patch', async () => {
        await render();
        await click(control(t('settings.properties_enabled')));
        expect(latest().enabled).toBe(false);
        expect(session.settings.properties.enabled).toBe(false);
    });

    it('adds a cover property name and keeps the existing ones', async () => {
        await render();
        const field = rowTitle(t('settings.cover_properties')).querySelector<HTMLInputElement>('input')!;
        await type(field, 'cover_url');
        await act(async () => {
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await Promise.resolve();
        });
        expect(latest().coverProperties).toEqual(['cover', 'cover_url']);
    });

    it('removes a hidden property name from the chip', async () => {
        session.settings = mergeSettings({ properties: { hidden: ['draft', 'secret'] } });
        await render();
        await click(rowTitle(t('settings.hidden_properties')).querySelector<HTMLElement>('button[aria-label]')!);
        expect(latest().hidden).toEqual(['secret']);
    });

    it('keeps a width inside the range the panel can draw', async () => {
        await render();
        const field = rowTitle(t('settings.cover_widths')).querySelector<HTMLInputElement>('input')!;
        await type(field, '9999');
        expect(latest().coverWidth).toBe(9999);
        expect(session.settings.properties.coverWidth).toBe(900);
    });

    it('adds a display format rule and edits its template', async () => {
        await render();
        await click([...rowTitle(t('settings.property_formats')).querySelectorAll<HTMLElement>('button')].find(node => node.textContent?.includes(t('settings.rule_add'))));
        expect(latest().formats).toHaveProperty('property-1');
        const template = host.querySelector<HTMLInputElement>(`input[aria-label="property-1 · ${t('settings.property_formats')}"]`)!;
        expect(template).toBeTruthy();
        await type(template, '{{upper propertyValue}}');
        expect(session.settings.properties.formats['property-1']?.template).toBe('{{upper propertyValue}}');
    });

    it('drops a progress rule when its row is removed', async () => {
        session.settings = mergeSettings({ properties: { progress: { pages: { max: 250 } } } });
        await render();
        await click(rowTitle(t('settings.property_progress')).querySelector<HTMLElement>('button[aria-label="' + t('settings.rule_remove') + '"]')!);
        expect(session.settings.properties.progress.pages).toBeUndefined();
    });

    it('switches a progress rule between the bar and the ring', async () => {
        session.settings = mergeSettings({ properties: { progress: { pages: { max: 250 } } } });
        await render();
        const select = rowTitle(t('settings.property_progress')).querySelector<HTMLSelectElement>('select')!;
        await act(async () => {
            select.value = 'circle';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await Promise.resolve();
        });
        expect(session.settings.properties.progress.pages?.variant).toBe('circle');
    });

    it('previews the date pattern with today, in the reader\'s language', async () => {
        await render();
        const field = rowTitle(t('settings.date_format')).querySelector<HTMLInputElement>('input')!;
        await type(field, 'YYYY');
        const description = rowTitle(t('settings.date_format')).querySelector('.text-\\[11\\.5px\\]');
        expect(description?.textContent).toMatch(/^\d{4}$/);
    });
});
