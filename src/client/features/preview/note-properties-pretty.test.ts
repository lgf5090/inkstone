import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeSettings } from '@shared/constants';
import { parseFrontMatter } from '@shared/markdown-utils';
import type { PropertySettings, UserSettings } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { PromptHost } from '../../components/overlay';
import { forgetPropertyImages } from '../../lib/property-images';

const editContent = vi.fn();
const updateSettings = vi.fn();
const openSearchList = vi.fn();
const byName = vi.fn();
const listFiles = vi.fn();

interface AppStore {
    contents: Record<string, string>;
    editContent: typeof editContent;
    tags: Array<{ id: string; name: string; color: string | null; count: number; createdAt: number }>;
    notes: Record<string, never>;
    excludedTags: string[];
    toggleTagExclusion: ReturnType<typeof vi.fn>;
    openView: ReturnType<typeof vi.fn>;
    openSearchList: typeof openSearchList;
    toast: ReturnType<typeof vi.fn>;
    activeNoteId: string | null;
}

interface SessionStore {
    settings: UserSettings;
    updateSettings: typeof updateSettings;
}

let store: AppStore;
let session: SessionStore;

const harness = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    return {
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        bump: () => listeners.forEach((listener) => listener()),
    };
});

vi.mock('../../store/notes', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useNotes: (selector: (state: AppStore) => unknown) => useSyncExternalStore(harness.subscribe, () => selector(store), () => selector(store)),
        findNoteByTitle: () => undefined,
    };
});
vi.mock('../../store/ui', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useUi: (selector: (state: AppStore) => unknown) => useSyncExternalStore(harness.subscribe, () => selector(store), () => selector(store)),
    };
});
vi.mock('../../store/session', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useSession: (selector: (state: SessionStore) => unknown) => useSyncExternalStore(harness.subscribe, () => selector(session), () => selector(session)),
    };
});
vi.mock('../../lib/api', () => ({
    api: {
        files: {
            byName: (name: string) => byName(name),
            list: () => listFiles(),
            upload: vi.fn(),
        },
    },
}));

const { NoteProperties } = await import('./NoteProperties');

const KEYS = ['title', 'status', 'pages', 'total', 'due', 'tags', 'secret', 'draft', 'note'];

const BASE = [
    '---',
    'title: Example',
    'status: reading',
    'pages: 40',
    'total: 200',
    'due: 2026-10-01',
    'tags: [book, slow]',
    'secret: hidden text',
    'draft:',
    'note: "**bold** text"',
    '---',
    '',
    'body.',
].join('\n');

let host: HTMLDivElement;
let root: Root;

async function renderPanel(): Promise<void> {
    await act(async () => {
        root.render(createElement(Fragment, null,
            createElement(PromptHost),
            createElement(NoteProperties, { noteId: 'n1' })));
        await Promise.resolve();
    });
}

async function flush(): Promise<void> {
    await act(async () => {
        harness.bump();
        await Promise.resolve();
    });
}

async function apply(patch: Partial<PropertySettings>): Promise<void> {
    session.settings = mergeSettings({
        ...session.settings,
        properties: { ...session.settings.properties, ...patch },
    });
    await flush();
}

function controls(scope: ParentNode = host): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>('button')];
}

function valueCell(raw: string, scope: ParentNode = host): HTMLElement {
    const found = scope.querySelector<HTMLElement>(`[data-property-value="${raw}"]`);
    if (!found)
        throw new Error(`missing value cell ${raw}`);
    return found;
}

function rowOf(key: string): HTMLElement {
    const found = [...host.querySelectorAll<HTMLElement>('[data-property-key]')].find(node => node.dataset.propertyKey === key);
    if (!found)
        throw new Error(`missing row ${key}`);
    return found;
}

function rowText(key: string): string | undefined {
    return [...host.querySelectorAll<HTMLElement>('[data-property-key]')].find(node => node.dataset.propertyKey === key)?.textContent ?? undefined;
}

function byLabel(label: string, scope: ParentNode = host): HTMLElement {
    const found = controls(scope).find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
    if (!found)
        throw new Error(`missing control ${label}`);
    return found;
}

async function click(element: Element | null | undefined, init: MouseEventInit = {}): Promise<void> {
    expect(element, 'expected element to be present').toBeTruthy();
    await act(async () => {
        element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
        await Promise.resolve();
    });
}

async function rightClick(element: Element | null | undefined): Promise<void> {
    expect(element, 'expected element to be present').toBeTruthy();
    await act(async () => {
        element!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 40 }));
        await Promise.resolve();
    });
}

function menuItems(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')];
}

function menuItem(label: string): HTMLElement | undefined {
    return menuItems().find(node => node.textContent?.includes(label));
}

function written(): Record<string, unknown> {
    expect(editContent).toHaveBeenCalledTimes(1);
    return parseFrontMatter(editContent.mock.calls[0]![1] as string).data;
}

function lastWrite(): string {
    expect(editContent).toHaveBeenCalled();
    return editContent.mock.calls.at(-1)![1] as string;
}

async function fillField(selector: string, value: string): Promise<void> {
    const field = document.querySelector(selector) as HTMLInputElement | null;
    expect(field, `missing field ${selector}`).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field!.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
    });
}

function dialogButton(label: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(node => node.textContent?.trim() === label);
}

beforeAll(async () => {
    await initI18n();
});

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    editContent.mockReset();
    updateSettings.mockReset();
    openSearchList.mockReset();
    byName.mockReset();
    listFiles.mockReset();
    forgetPropertyImages();
    byName.mockResolvedValue({ files: [{ id: 'a1', filename: 'Cover.png', mime: 'image/png', url: '/files/cover.png' }] });
    listFiles.mockResolvedValue({
        files: [{ id: 'a2', filename: 'Other.png', mime: 'image/png', url: '/files/other.png', noteId: null, usage: 0, size: 10, createdAt: 1 }],
        nextCursor: null,
    });
    store = {
        contents: { n1: BASE },
        editContent,
        tags: [{ id: 't1', name: 'book', color: '#dc2626', count: 2, createdAt: 1 }],
        notes: {},
        excludedTags: [],
        toggleTagExclusion: vi.fn(),
        openView: vi.fn(),
        openSearchList,
        toast: vi.fn(),
        activeNoteId: 'n1',
    };
    session = { settings: mergeSettings({}), updateSettings };
    updateSettings.mockImplementation((patch: { properties?: Partial<PropertySettings> }) => {
        session.settings = mergeSettings({
            ...session.settings,
            properties: { ...session.settings.properties, ...patch.properties },
        });
        harness.bump();
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await renderPanel();
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

describe('pretty property values', () => {
    it('paints the colour the reader assigned to a value', async () => {
        await apply({ colors: { status: { reading: { pill: '#059669', text: '#059669' } } } });
        expect(valueCell('reading').getAttribute('style')).toContain('rgb(5, 150, 105)');
    });

    it('keeps a tag pill coloured from the tag registry', () => {
        const pill = controls().find(node => node.getAttribute('data-property-pill-value') === 'book');
        expect(pill).toBeTruthy();
        expect(pill!.querySelector('span[style]')?.getAttribute('style')).toContain('rgb(220, 38, 38)');
    });

    it('draws a progress bar over the numeric property it was given', async () => {
        await apply({ progress: { pages: { maxProperty: 'total' } } });
        const bar = rowOf('pages').querySelector('progress')!;
        expect(bar.getAttribute('max')).toBe('200');
        expect(bar.getAttribute('value')).toBe('40');
        expect(bar.getAttribute('aria-label')).toContain('20%');
    });

    it('renders the ring variant instead of the bar', async () => {
        await apply({ progress: { pages: { max: 100, variant: 'circle' } } });
        expect(rowOf('pages').querySelector('.pp-progress-circle')).toBeTruthy();
        expect(rowOf('pages').querySelector('progress')).toBeNull();
    });

    it('replaces the value with the display format and edits the raw text', async () => {
        await apply({ formats: { title: { template: '{{upper propertyValue}}' } } });
        const shown = valueCell('Example');
        expect(shown.textContent).toBe('EXAMPLE');
        expect(shown.getAttribute('data-property-format')).toBe('template');
        await click(shown);
        const field = host.querySelector<HTMLInputElement>('input[aria-label="title"]');
        expect(field?.value).toBe('Example');
        await act(async () => {
            field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
        });
    });

    it('formats a date with the pattern the reader wrote', async () => {
        await apply({ useCustomDateFormats: true, dateFormat: 'YYYY/MM/DD' });
        expect(valueCell('2026-10-01').textContent).toBe('2026/10/01');
    });

    it('tints a date by its relation to today', async () => {
        await apply({ relativeDateColors: true, datePastColor: '#2563eb' });
        expect(valueCell('2026-10-01').getAttribute('style')).toContain('rgb(37, 99, 235)');
    });

    it('renders a markdown value through the prose whitelist', async () => {
        await apply({ formats: { note: { markdown: true } } });
        const cell = valueCell('**bold** text');
        expect(cell.className).toContain('pp-markdown');
        expect(cell.querySelector('strong')?.textContent).toBe('bold');
        expect(cell.querySelector('script')).toBeNull();
    });

    it('offers the option list and writes the picked value back', async () => {
        await apply({ selectOptions: { status: ['reading', 'finished'] } });
        await click(valueCell('reading'));
        expect(menuItem('finished')).toBeTruthy();
        await click(menuItem('finished'));
        expect(written().status).toBe('finished');
    });

    it('searches the value under the configured modifier and edits it without one', async () => {
        await click(valueCell('reading'));
        expect(openSearchList).not.toHaveBeenCalled();
        expect(host.querySelector('input[aria-label="status"]')).toBeTruthy();
        await act(async () => {
            host.querySelector<HTMLInputElement>('input[aria-label="status"]')!
                .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
        });
        await click(valueCell('reading'), { ctrlKey: true });
        expect(openSearchList).toHaveBeenCalledWith('reading');
    });

    it('turns the modifier search off when the reader asks', async () => {
        await apply({ quickSearchKey: 'off' });
        await click(valueCell('reading'), { ctrlKey: true });
        expect(openSearchList).not.toHaveBeenCalled();
        expect(host.querySelector('input[aria-label="status"]')).toBeTruthy();
    });

    it('marks every value with the data attributes custom CSS can hook', async () => {
        await apply({ colors: { status: { reading: { pill: '#059669' } } } });
        expect(valueCell('reading').getAttribute('data-property-value')).toBe('reading');
        expect(rowOf('status').getAttribute('data-property-key')).toBe('status');
        expect(controls().find(node => node.getAttribute('data-property-pill-value') === 'slow')).toBeTruthy();
    });
});

describe('hidden properties', () => {
    it('drops a hidden row and counts it in the header', async () => {
        await apply({ hidden: ['secret'] });
        expect(rowText('secret')).toBeUndefined();
        expect(host.textContent).toContain(t('properties.hidden_count', { value0: 1 }));
    });

    it('shows hidden rows again under the reveal toggle', async () => {
        await apply({ hidden: ['secret'] });
        await click(byLabel(t('properties.hidden_count', { value0: 1 })));
        expect(session.settings.properties.revealHidden).toBe(true);
        expect(rowOf('secret').getAttribute('data-property-hidden')).toBe('true');
    });

    it('hides an empty row when the author marked it hide-when-empty', async () => {
        await apply({ hiddenWhenEmpty: ['draft'] });
        expect(rowText('draft')).toBeUndefined();
        expect(rowText('secret')).toBeTruthy();
    });

    it('hides every empty row when the account asks for that', async () => {
        await apply({ hideAllEmpty: true });
        expect(rowText('draft')).toBeUndefined();
        expect(rowText('title')).toBeTruthy();
    });

    it('unhides from the row itself', async () => {
        await apply({ hidden: ['secret'], revealHidden: true });
        await click(rowOf('secret').querySelector(`button[aria-label="${t('properties.unhide')}"]`)!);
        expect(session.settings.properties.hidden).not.toContain('secret');
    });

    it('says so when nothing is left to show', async () => {
        await apply({ hidden: KEYS });
        expect(host.textContent).toContain(t('properties.all_hidden'));
    });

    it('keeps every row when the whole feature is off', async () => {
        await apply({ enabled: false, hidden: ['secret'] });
        expect(rowText('secret')).toBeTruthy();
        expect(host.textContent).not.toContain(t('properties.hidden_count', { value0: 1 }));
    });

    it('hides the whole block when the reader asked and nothing is visible', async () => {
        await apply({ hidden: KEYS, hideWholeBlockWhenEmpty: true });
        expect(host.querySelector('.pp-layout')).toBeNull();
    });

    it('drops the header when the reader asked, and keeps a way to add', async () => {
        await apply({ hideHeader: true });
        expect(host.querySelector('header')).toBeNull();
        expect(byLabel(t('properties.add'))).toBeTruthy();
    });
});

describe('property menus', () => {
    it('opens the row menu on right-click and hides the property from it', async () => {
        await rightClick(rowOf('status'));
        await click(menuItem(t('properties.hide')));
        expect(session.settings.properties.hidden).toContain('status');
        expect(rowText('status')).toBeUndefined();
    });

    it('adds and removes a progress bar from the row menu', async () => {
        await rightClick(rowOf('pages'));
        await click(menuItem(t('properties.progress_bar')));
        expect(session.settings.properties.progress.pages).toBeTruthy();
        expect(rowOf('pages').querySelector('progress')).toBeTruthy();
        await rightClick(rowOf('pages'));
        await click(menuItem(t('properties.progress_remove')));
        expect(session.settings.properties.progress.pages).toBeUndefined();
    });

    it('offers the note\'s own numeric properties as the progress maximum', async () => {
        await rightClick(rowOf('pages'));
        await click(menuItem(t('properties.progress_bar')));
        await rightClick(rowOf('pages'));
        await click(menuItem(t('properties.progress_max')));
        await click(menuItem('total'));
        expect(session.settings.properties.progress.pages?.maxProperty).toBe('total');
        expect(rowOf('pages').querySelector('progress')?.getAttribute('max')).toBe('200');
    });

    it('writes the colour picked from a value menu into the account settings', async () => {
        await click(rowOf('status').querySelector(`button[aria-label="${t('properties.pill_color')}"]`)!);
        await click(menuItem(t('properties.pill_color')));
        const swatch = document.querySelector<HTMLElement>(`button[aria-label="${t('color.emerald')}"]`);
        expect(swatch).toBeTruthy();
        await click(swatch);
        expect(session.settings.properties.colors.status?.reading?.pill).toBe('#059669');
        expect(valueCell('reading').getAttribute('style')).toContain('background-color: rgba(5, 150, 105, 0.17)');
    });

    it('asks for a display format through the prompt host, not a native dialog', async () => {
        const spy = vi.spyOn(window, 'prompt').mockImplementation(() => null);
        await rightClick(rowOf('pages'));
        await click(menuItem(t('properties.format_add')));
        await fillField('[role="dialog"] input[type="text"]', '{{upper propertyValue}}');
        await click(dialogButton(t('common.apply')));
        expect(session.settings.properties.formats.pages?.template).toBe('{{upper propertyValue}}');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('renders a markdown value and turns it back into plain text', async () => {
        await rightClick(rowOf('note'));
        await click(menuItem(t('properties.markdown_on')));
        expect(valueCell('**bold** text').className).toContain('pp-markdown');
        await rightClick(rowOf('note'));
        await click(menuItem(t('properties.markdown_off')));
        expect(valueCell('**bold** text').className).not.toContain('pp-markdown');
    });

    it('offers no menu while the front matter cannot be parsed', async () => {
        store.contents = { n1: ['---', 'title: [unclosed', '---', 'body'].join('\n') };
        await flush();
        expect(host.textContent).toContain(t('properties.invalid'));
        await rightClick(host);
        expect(menuItems()).toHaveLength(0);
    });
});

describe('note decorations', () => {
    async function withBody(content: string): Promise<void> {
        store.contents = { n1: content };
        await flush();
    }

    it('renders a cover from the note front matter', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', '---', '', 'body.'].join('\n'));
        expect(host.querySelector<HTMLImageElement>('.pp-cover-image')?.getAttribute('src')).toBe('/files/cover.png');
        expect(host.querySelector('.pp-cover')!.className).toContain('is-left');
    });

    it('reads the shape and position properties off the note', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', 'cover_shape: circle', 'cover_position: right', '---', 'body'].join('\n'));
        const cover = host.querySelector<HTMLElement>('.pp-cover')!;
        expect(cover.className).toContain('is-circle');
        expect(cover.className).toContain('is-right');
    });

    it('writes a shape pick back into the front matter', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', '---', 'body'].join('\n'));
        await rightClick(host.querySelector('.pp-cover')!);
        await click(menuItem(t('properties.cover_shape')));
        await click(menuItem(t('properties.shape_square')));
        expect(written().cover_shape).toBe('square');
    });

    it('opens the image library from the cover menu and writes a wikilink', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', '---', 'body'].join('\n'));
        await rightClick(host.querySelector('.pp-cover')!);
        await click(menuItem(t('properties.cover_change')));
        const tile = document.querySelector<HTMLButtonElement>('button[aria-label="Other.png"]');
        expect(tile).toBeTruthy();
        await click(tile);
        expect(written().cover).toBe('[[Other.png]]');
    });

    it('refuses a link that cannot paint as an image', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', '---', 'body'].join('\n'));
        await rightClick(host.querySelector('.pp-cover')!);
        await click(menuItem(t('properties.cover_change')));
        await fillField(`input[aria-label="${t('properties.image_link')}"]`, 'javascript:alert(1)');
        await click(dialogButton(t('properties.image_use_link')) ?? [...document.querySelectorAll<HTMLElement>('button')].find(node => node.textContent?.trim() === t('properties.image_use_link')));
        expect(editContent).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain(t('properties.image_link_invalid'));
    });

    it('removes a cover together with its shape and position', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', 'cover_shape: square', 'cover_position: right', '---', 'body'].join('\n'));
        await rightClick(host.querySelector('.pp-cover')!);
        await click(menuItem(t('properties.cover_remove')));
        expect(editContent).toHaveBeenCalledTimes(3);
        expect(parseFrontMatter(lastWrite()).data.cover).toBeUndefined();
    });

    it('renders a banner and an icon, and hides them when the account turns them off', async () => {
        await withBody(['---', 'banner: "[[Cover.png]]"', 'icon: \u{1F385}', '---', 'body'].join('\n'));
        expect(host.querySelector('.pp-banner-image')).toBeTruthy();
        expect(host.querySelector('.pp-icon-glyph')?.textContent).toBe('\u{1F385}');
        await apply({ showBanner: false, showIcon: false });
        expect(host.querySelector('.pp-banner-image')).toBeNull();
        expect(host.querySelector('.pp-icon-glyph')).toBeNull();
    });

    it('moves the icon into the header when the reader asks', async () => {
        await withBody(['---', 'icon: \u{1F385}', '---', 'body'].join('\n'));
        expect(host.querySelector('.pp-icon-row .pp-icon')).toBeTruthy();
        await apply({ iconInline: true });
        expect(host.querySelector('header .pp-icon')).toBeTruthy();
    });

    it('shows the cover before the rows when it sits on top', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', 'cover_position: top', '---', 'body'].join('\n'));
        const layout = host.querySelector<HTMLElement>('.pp-layout')!;
        expect(layout.getAttribute('data-cover-position')).toBe('top');
        expect(layout.firstElementChild!.className).toContain('pp-cover');
    });

    it('leaves the decorations out when the feature is off', async () => {
        await withBody(['---', 'cover: "[[Cover.png]]"', '---', 'body'].join('\n'));
        await apply({ enabled: false });
        expect(host.querySelector('.pp-cover')).toBeNull();
        expect(rowOf('cover')).toBeTruthy();
    });

    it('keeps a body typed underneath the panel when a decoration is written', async () => {
        store.contents = { n1: ['---', 'cover: "[[Cover.png]]"', '---', 'body, then typed'].join('\n') };
        await flush();
        await rightClick(host.querySelector('.pp-cover')!);
        await click(menuItem(t('properties.cover_shape')));
        await click(menuItem(t('properties.shape_circle')));
        expect(lastWrite()).toContain('body, then typed');
        expect(parseFrontMatter(lastWrite()).data.cover_shape).toBe('circle');
    });

    it('does not paint an image the account cannot find', async () => {
        byName.mockResolvedValue({ files: [] });
        await withBody(['---', 'cover: "[[Missing.png]]"', '---', 'body'].join('\n'));
        expect(host.querySelector('.pp-cover-image')).toBeNull();
        expect(host.querySelector('.pp-cover-empty')?.textContent).toContain(t('properties.image_missing'));
    });
});
