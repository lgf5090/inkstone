import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary, Tag } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render';
import { encodeDataValue } from '../../lib/markdown/data-attr';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { TagContextMenuAt, tagMenuRequestFrom } from './TagContextMenuAt';
import { resolveHoverCandidate } from '../preview/link-hover-host';

vi.mock('../../lib/api', () => ({
    api: {
        tags: {
            create: vi.fn(async () => ({})),
            patch: vi.fn(async () => ({})),
            remove: vi.fn(async () => ({})),
            move: vi.fn(async () => ({ ok: true, moved: 0 })),
        },
    },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();
let root: Root;
let container: HTMLDivElement;

function tag(name: string, extra: Partial<Tag> = {}): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1, ...extra };
}

function note(id: string, title: string, tags: string[]): NoteSummary {
    return {
        id, title, excerpt: '', folderId: null, tags, isPinned: false, isStarred: false, isArchived: false,
        wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
    };
}

const menuText = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].map((element) => element.textContent?.trim() ?? '');

beforeEach(async () => {
    installTestGlobals();
    stubBreakpoint(true);
    await initI18n();
    useNotes.setState({ ...originalNotes, tags: [tag('work'), tag('work/meeting')], notes: {}, folders: [] });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [], searchList: false, searchQuery: '' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useNotes.setState(originalNotes, true);
    useUi.setState(originalUi, true);
    vi.unstubAllGlobals();
});

describe('the tag menu reaches every surface', () => {
    it('reads the tag off the element the pointer landed on', () => {
        const span = document.createElement('span');
        span.dataset.tag = encodeDataValue('work/meeting');
        const nested = document.createElement('b');
        span.append(nested);
        expect(tagMenuRequestFrom(nested, 12, 34)).toEqual({ name: 'work/meeting', x: 12, y: 34 });
        expect(tagMenuRequestFrom(document.createElement('i'), 1, 2)).toBeNull();
        expect(tagMenuRequestFrom(null, 1, 2)).toBeNull();
    });

    it('shows the whole menu for a tag the library knows', async () => {
        await act(() => root.render(createElement(TagContextMenuAt, {
            request: { name: 'work', x: 8, y: 8 },
            onClose: vi.fn(),
        })));
        const labels = menuText();
        expect(labels).toContain(t('tags.pin'));
        expect(labels).toContain(t('tags.color'));
        expect(labels).toContain(t('tags.exclude'));
        expect(labels).toContain(t('tags.delete'));
        expect(labels.some((label) => label.includes('work'))).toBe(true);
    });

    it('adds the panel entries only where the surface can open the panel', async () => {
        await act(() => root.render(createElement(TagContextMenuAt, {
            request: { name: 'work', x: 8, y: 8 },
            options: { onManage: vi.fn() },
            onClose: vi.fn(),
        })));
        expect(menuText()).toContain(t('tags.manage'));
    });

    it('drops the row-only actions where there is no row to rename', async () => {
        await act(() => root.render(createElement(TagContextMenuAt, {
            request: { name: 'work', x: 8, y: 8 },
            onClose: vi.fn(),
        })));
        expect(menuText()).not.toContain(t('tags.rename'));
        expect(menuText()).not.toContain(t('tags.new_child'));
        await act(() => root.render(createElement(TagContextMenuAt, {
            request: { name: 'work', x: 8, y: 8 },
            options: { onStartRename: vi.fn(), onCreateChild: vi.fn() },
            onClose: vi.fn(),
        })));
        expect(menuText()).toContain(t('tags.rename'));
        expect(menuText()).toContain(t('tags.new_child'));
    });

    it('offers to create the page, then to open it', async () => {
        const request = { name: 'work', x: 8, y: 8 };
        await act(() => root.render(createElement(TagContextMenuAt, { request, onClose: vi.fn() })));
        expect(menuText()).toContain(t('tags.create_page'));
        useNotes.setState({ notes: { p: note('p', 'work', ['work']) } });
        await act(async () => undefined);
        expect(menuText()).toContain(t('tags.open_page'));
    });

    it('hides the row-only actions for a name with no tag behind it', async () => {
        await act(() => root.render(createElement(TagContextMenuAt, {
            request: { name: 'neverused', x: 8, y: 8 },
            onClose: vi.fn(),
        })));
        expect(menuText()).not.toContain(t('tags.color'));
        expect(menuText()).not.toContain(t('tags.delete'));
        expect(menuText()).toContain(t('tags.exclude'));
    });
});

describe('the tag hover card only appears for a tag with a page', () => {
    function anchorFor(name: string) {
        const element = document.createElement('span');
        element.dataset.tag = encodeDataValue(name);
        return element;
    }

    it('resolves the page note', () => {
        useNotes.setState({ notes: { p: note('p', 'work', ['work']) } });
        expect(resolveHoverCandidate(anchorFor('work'), null)?.noteId).toBe('p');
    });

    it('stays away when there is no page', () => {
        expect(resolveHoverCandidate(anchorFor('work'), null)).toBeNull();
        useNotes.setState({ notes: { other: note('other', 'Not The Page', ['work']) } });
        expect(resolveHoverCandidate(anchorFor('work'), null)).toBeNull();
    });
});
