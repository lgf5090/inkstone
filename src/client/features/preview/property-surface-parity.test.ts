import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeSettings } from '@shared/constants';
import type { Tag, UserSettings } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import { buildPropertyRenderOptions } from '../../lib/property-view';
import { renderMarkdown } from '../../lib/markdown/renderer';
import { PP_ROW } from '../../lib/property-markup';

const editContent = vi.fn();
const openView = vi.fn();
const openSearchList = vi.fn();

interface AppStore {
    contents: Record<string, string>;
    editContent: typeof editContent;
    tags: Tag[];
    notes: Record<string, never>;
    excludedTags: string[];
    toggleTagExclusion: ReturnType<typeof vi.fn>;
    openView: typeof openView;
    openSearchList: typeof openSearchList;
    activeNoteId: string | null;
}

interface SessionStore {
    settings: UserSettings;
    updateSettings: ReturnType<typeof vi.fn>;
}

const harness = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    return {
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        bump: () => listeners.forEach(listener => listener()),
    };
});

let store: AppStore;
let session: SessionStore;

vi.mock('../../store/notes', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useNotes: Object.assign((selector: (state: AppStore) => unknown) => useSyncExternalStore(harness.subscribe, () => selector(store), () => selector(store)), { getState: () => store }),
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
    api: { files: { byName: vi.fn(), list: vi.fn(), upload: vi.fn() } },
}));

const { NoteProperties } = await import('./NoteProperties');

const SOURCE = [
    '---',
    'title: Example',
    'status: reading',
    'pages: 40',
    'total: 200',
    'due: 2026-10-01',
    'tags: [book, slow]',
    'aliases: [one, two]',
    'draft: true',
    'secret: hidden text',
    '---',
    '',
    'body.',
].join('\n');

/**
 * The mirror's `<details>` is the panel column plus the collapse semantics a React `useState` gives the
 * reading pane; those two classes are the only markup the reading pane does not share.
 */
const MIRROR_ONLY = /^frontmatter-properties pp /;

function projection(root: ParentNode) {
    const shell = root.querySelector<HTMLElement>('[data-note-properties]');
    if (!shell)
        throw new Error('missing property panel');
    const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const cls = (node: Element | null | undefined) => (node?.className ?? null);
    const shared = (value: string | null) => (value === null ? null : value.replace(/ ?group\/row(?= |$)/g, '').replace(MIRROR_ONLY, '').trim());
    return {
        shell: shared(cls(shell)),
        layout: shared(cls(shell.querySelector('.pp-layout'))),
        coverPosition: shell.querySelector('.pp-layout')?.getAttribute('data-cover-position') ?? null,
        column: shared(cls(shell.querySelector('.pp-column'))),
        header: shared(cls(shell.querySelector('.pp-header'))),
        headerText: text(shell.querySelector('.pp-header-toggle')),
        rows: [...shell.querySelectorAll<HTMLElement>('[data-property-key]')].map(row => ({
            key: row.getAttribute('data-property-key'),
            row: shared(cls(row)),
            glyph: text(row.querySelector('.pp-kind')),
            name: text(row.querySelector('.pp-key')),
            value: shared(cls(row.querySelector('.pp-value'))),
            inner: shared(cls(row.querySelector('.pp-value')?.firstElementChild)),
            pills: shared(cls(row.querySelector('.pp-pills'))),
            shown: [...row.querySelectorAll('.pp-pill, .pp-scalar, .pp-object, [role="switch"]')].map(text).join(' '),
            hidden: row.getAttribute('data-property-hidden'),
        })),
    };
}

function controlCount(root: ParentNode): number {
    return root.querySelectorAll('[data-note-properties] button').length;
}

function mirrorPanel(): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(SOURCE, { properties: buildPropertyRenderOptions(session.settings.properties, store.tags) }).html;
    return host;
}

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
    await initI18n();
});

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    editContent.mockReset();
    store = {
        contents: { n1: SOURCE },
        editContent,
        tags: [{ id: 't1', name: 'book', color: null, count: 2, createdAt: 1 }],
        notes: {},
        excludedTags: [],
        toggleTagExclusion: vi.fn(),
        openView,
        openSearchList,
        activeNoteId: 'n1',
    };
    session = { settings: mergeSettings({}), updateSettings: vi.fn() };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(NoteProperties, { noteId: 'n1' }));
        await Promise.resolve();
    });
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

describe('property panel surfaces', () => {
    it('lays the reading pane and the live editor out identically', () => {
        expect(projection(mirrorPanel())).toEqual(projection(host));
    });

    it('keeps the shared row anatomy, and the controls, out of the mirror', () => {
        const mirror = mirrorPanel();
        expect(mirror.querySelectorAll('.pp-row').length).toBeGreaterThan(0);
        expect(mirror.querySelector('.pp-row')!.className).toBe(PP_ROW);
        expect(controlCount(mirror)).toBe(0);
        expect(controlCount(host)).toBeGreaterThan(0);
    });

    it('paints the same colours on both surfaces, the accent token by whichever carrier survives', async () => {
        session.settings = mergeSettings({
            ...session.settings,
            properties: {
                ...session.settings.properties,
                colors: {
                    status: { reading: { pill: '#059669', text: '#059669' } },
                    title: { Example: { text: 'accent', pill: 'accent' } },
                },
            },
        });
        await act(async () => {
            harness.bump();
            await Promise.resolve();
        });
        for (const [name, surface] of [['reading pane', host], ['live mirror', mirrorPanel()]] as const) {
            const reading = surface.querySelector<HTMLElement>('[data-property-value="reading"]');
            expect(reading, `${name}: the hex value is missing`).toBeTruthy();
            expect(`${name} ${reading!.closest('.pp-pill')?.outerHTML ?? ''}${reading!.getAttribute('style') ?? ''}`).toMatch(/#059669|rgb\(5, 150, 105\)/);
            const example = surface.querySelector<HTMLElement>('[data-property-value="Example"]');
            expect(example, `${name}: the accent value is missing`).toBeTruthy();
            expect(`${name} ${example!.outerHTML}`).toMatch(/accent/);
        }
    });

    it('honours the panel settings the same way on both surfaces', async () => {
        const patch = async (properties: Record<string, unknown>) => {
            session.settings = mergeSettings({ ...session.settings, properties: { ...session.settings.properties, ...properties } });
            await act(async () => {
                harness.bump();
                await Promise.resolve();
            });
        };
        await patch({ hidden: ['secret'] });
        expect(projection(mirrorPanel()).rows.map(row => row.key)).toEqual(projection(host).rows.map(row => row.key));
        expect(projection(mirrorPanel()).headerText).toBe(projection(host).headerText);
        await patch({ hidden: ['secret'], revealHidden: true });
        expect(projection(mirrorPanel())).toEqual(projection(host));
        await patch({ hideHeader: true });
        expect(projection(mirrorPanel())).toEqual(projection(host));
        await patch({ revealHidden: false, hideHeader: false, hidden: ['title', 'status', 'pages', 'total', 'due', 'tags', 'aliases', 'draft', 'secret'], hideWholeBlockWhenEmpty: true });
        expect(projection(mirrorPanel())).toEqual(projection(host));
        expect(mirrorPanel().querySelector('.pp-layout')).toBeNull();
        expect(host.querySelector('.pp-layout')).toBeNull();
    });
});
