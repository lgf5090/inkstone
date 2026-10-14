import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { Tag } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render';
import { createTag, normalizeTagName, renameTag } from './tagMutations';
import { dropTagFilter, hasTagFilter, mapTagFilter } from './tag-filter';
import { SidebarTags } from './SidebarTags';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

vi.mock('../../lib/api', () => ({
    api: {
        tags: {
            create: vi.fn(async () => ({})),
            patch: vi.fn(async () => ({ ok: true, renamed: 0 })),
            move: vi.fn(async () => ({ ok: true })),
            remove: vi.fn(async () => ({ ok: true, affected: 0 })),
        },
    },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();

function tag(id: string, name: string): Tag {
    return { id, name, color: null, count: 1, createdAt: 1 };
}

beforeEach(async () => {
    await initI18n();
    useNotes.setState({ ...originalNotes, tags: [tag('t-ss', 'stra\u00DFe'), tag('t-wide', 'work')], notes: {} });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [] });
});

describe('tag identity in the mutation layer', () => {
    it('treats a case or width variant as the tag that exists', () => {
        expect(createTag('WORK')).toBe('t-wide');
        expect(createTag('\uFF37\uFF2F\uFF32\uFF2B')).toBe('t-wide');
    });

    it('does not fold a German expansion into an existing tag', () => {
        expect(createTag('STRASSE')).not.toBe('t-ss');
        expect(normalizeTagName('STRASSE')).toBe('STRASSE');
    });

    it('renames without a merge prompt when only the spelling differs from the server', async () => {
        const confirm = await import('../../components/overlay');
        const spy = vi.spyOn(confirm, 'confirm').mockResolvedValue(false);
        await renameTag(tag('t-ss', 'stra\u00DFe'), 'STRASSE');
        expect(spy).not.toHaveBeenCalled();
        expect(useNotes.getState().tags.map((item) => item.name)).toContain('STRASSE');
        spy.mockRestore();
    });
});

describe('tag filter list folding', () => {
    it('matches, drops and renames a filter slot by the case- and width-folded key', () => {
        expect(hasTagFilter(['Work'], 'work')).toBe(true);
        expect(hasTagFilter(['ＷＯＲＫ'], 'work')).toBe(true);
        expect(hasTagFilter(['work'], 'work/meeting')).toBe(false);
        expect(dropTagFilter(['Work', 'other'], 'work')).toEqual(['other']);
        expect(mapTagFilter(['ＷＯＲＫ', 'other'], 'work', 'Home')).toEqual(['Home', 'other']);
    });
});

describe('the tag row highlight reads the filter through the same fold', () => {
    const originalNotes = useNotes.getState();
    const originalUi = useUi.getState();
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(async () => {
        installTestGlobals();
        stubBreakpoint(true);
        useNotes.setState({ ...originalNotes, tags: [{ id: 't-work', name: 'work', color: null, count: 1, createdAt: 1 }], notes: {}, folders: [], contents: {} });
        useUi.setState({ ...originalUi, view: 'tag', tags: ['Work'], excludedTags: [], listCollapsed: false, searchList: false, toast: vi.fn() });
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

    it('lights the row whose only difference from the active filter is case', async () => {
        await act(() => root.render(createElement(SidebarTags)));
        const row = container.querySelector<HTMLElement>('[data-tag-row]');
        expect(row).not.toBeNull();
        expect(row?.getAttribute('aria-selected')).toBe('true');
    });
});
