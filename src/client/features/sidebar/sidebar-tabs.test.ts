import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, NoteSummary } from '@shared/types';
import { SIDEBAR_TABS } from '@shared/constants';
import { initI18n, t } from '../../lib/i18n';
import { api } from '../../lib/api';
import { installTestGlobals } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { Sidebar } from './Sidebar';
import { SIDEBAR_PANEL_ID, SIDEBAR_TAB_IDS, tabId } from './SidebarTabs';

const folder: Folder = { id: 'folder', name: 'Project', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 };
const originalUi = useUi.getState();
const originalNotes = useNotes.getState();
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    installTestGlobals();
    await initI18n();
    useUi.setState({ ...originalUi, sidebarTab: 'library', listCollapsed: true, view: 'all', folderId: null, activeNoteId: null, expandedFolders: [] });
    useNotes.setState({ ...originalNotes, folders: [folder], tags: [{ id: 'demo', name: 'demo', color: null, count: 2, createdAt: 1 }], notes: {} });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(createElement(Sidebar)));
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useUi.setState(originalUi, true);
    useNotes.setState(originalNotes, true);
    vi.unstubAllGlobals();
});

const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('aside [role="tab"]')];
const panel = () => container.querySelector<HTMLElement>(`#${SIDEBAR_PANEL_ID}`)!;
const press = async (element: HTMLElement, key: string) => {
    await act(async () => {
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
};

describe('sidebar tab strip', () => {
    it('offers only tabs the store is allowed to remember', () => {
        for (const id of SIDEBAR_TAB_IDS)
            expect(SIDEBAR_TABS, `tab ${id} has no place in the persisted value list`).toContain(id);
    });

    it('gives the library tab the folder tree and keeps the tag list out of it', () => {
        expect(container.querySelectorAll('[data-folder-drop-target]').length).toBe(1);
        expect(panel().getAttribute('aria-labelledby')).toBe(tabId('library'));
        expect(container.querySelector('[data-tag-row]')).toBeNull();
    });

    it('swaps the whole body when the tag tab is chosen', async () => {
        await act(async () => tabs().find((tab) => tab.dataset.tab === 'tags')?.click());
        expect(useUi.getState().sidebarTab).toBe('tags');
        expect(container.querySelectorAll('[data-folder-drop-target]').length).toBe(0);
        expect(container.querySelector(`input[aria-label="${t('tags.filter')}"]`)).toBeTruthy();
        expect(panel().getAttribute('aria-labelledby')).toBe(tabId('tags'));
    });

    it('keeps exactly one tab in the tab order and walks it with the arrows', async () => {
        const at = () => tabs().findIndex((tab) => tab.tabIndex === 0);
        expect(tabs().map((tab) => tab.dataset.tab)).toEqual([...SIDEBAR_TAB_IDS]);
        expect(at()).toBe(0);
        for (let step = 1; step < SIDEBAR_TAB_IDS.length; step++) {
            await press(tabs()[at()], 'ArrowRight');
            expect(at(), `step ${step}`).toBe(step);
            expect(useUi.getState().sidebarTab).toBe(SIDEBAR_TAB_IDS[step]);
        }
        await press(tabs()[at()], 'ArrowRight');
        expect(at()).toBe(0);
        await press(tabs()[at()], 'End');
        expect(at()).toBe(SIDEBAR_TAB_IDS.length - 1);
        await press(tabs()[at()], 'Home');
        expect(at()).toBe(0);
    });

    it('remembers the choice against the store default', () => {
        expect(originalUi.sidebarTab).toBe('library');
        useUi.getState().setSidebarTab('tags');
        expect(useUi.getState().sidebarTab).toBe('tags');
    });
});

function summary(id: string, title: string, over: Partial<NoteSummary> = {}): NoteSummary {
    return { id, title, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null, ...over };
}

describe('recent files tab', () => {
    const open = async () => {
        await act(async () => useUi.getState().setSidebarTab('recent'));
    };
    const rows = () => [...container.querySelectorAll('[data-recent-list] [data-note-row], [data-recent-list] [role="treeitem"]')].map((element) => element.textContent?.replace(/\s+/g, ' ').trim());

    it('keeps the order the reader walked and drops notes that are gone', async () => {
        useNotes.setState({ notes: { a: summary('a', 'Alpha'), b: summary('b', 'Bravo') } });
        useUi.setState({ recentNoteIds: ['b', 'vanished', 'a'] });
        await open();
        expect(rows().filter((text) => text?.includes('Alpha') || text?.includes('Bravo'))).toHaveLength(2);
        expect(container.textContent).not.toContain('vanished');
    });

    it('hides notes that left the library', async () => {
        useNotes.setState({ notes: { a: summary('a', 'Alpha'), t: summary('t', 'InTrash', { deletedAt: 5 }), r: summary('r', 'Archived', { isArchived: true }) } });
        useUi.setState({ recentNoteIds: ['a', 't', 'r'] });
        await open();
        const text = container.querySelector('[data-recent-list]')?.textContent ?? '';
        expect(text).toContain('Alpha');
        expect(text).not.toContain('InTrash');
        expect(text).not.toContain('Archived');
    });

    it('says so when nothing has been opened', async () => {
        useUi.setState({ recentNoteIds: [] });
        await open();
        expect(container.textContent).toContain(t('sidebar.recent_empty'));
        expect(container.querySelector('[data-recent-list]')).toBeNull();
    });

    it('opens the note a row is clicked on', async () => {
        const openNote = vi.fn(async () => {});
        useNotes.setState({ notes: { a: summary('a', 'Alpha') }, openNote });
        useUi.setState({ recentNoteIds: ['a'] });
        await open();
        const row = container.querySelector<HTMLButtonElement>('[data-recent-list] [data-tree-note-open]')!;
        expect(row).toBeTruthy();
        expect(row.getAttribute('title')).toBe('Alpha');
        await act(() => row.click());
        expect(openNote).toHaveBeenCalledWith('a', undefined);
    });
});

describe('link tabs', () => {
    const source = summary('src', 'Source note');
    const target = summary('tgt', 'Target note');
    const gone = summary('gone', 'Trashed note', { deletedAt: 9 });

    beforeEach(() => {
        useNotes.setState({ notes: { src: source, tgt: target, gone }, contents: { src: 'x [[Target note|alias text]] y [[Target note]] z [[gone]] w [[No Such Note]]' } });
        useUi.setState({ activeNoteId: 'src', recentNoteIds: ['src'] });
    });

    const openTab = async (tab: 'outlinks' | 'backlinks') => {
        await act(async () => useUi.getState().setSidebarTab(tab));
    };

    it('lists each outgoing link once, resolving aliases and skipping the note itself', async () => {
        await openTab('outlinks');
        const ids = [...container.querySelectorAll('[data-outlink-id]')].map((e) => e.getAttribute('data-outlink-id'));
        expect(ids).toEqual(['tgt']);
        const row = container.querySelector('[data-outlink-id="tgt"]')!;
        expect(row.textContent).toContain('Target note');
        expect(row.textContent).toContain('alias text');
    });

    it('shows a trashed target as unresolved rather than openable', async () => {
        await openTab('outlinks');
        const gaps = [...container.querySelectorAll('[data-unresolved-list] [role="listitem"]')].map((e) => e.textContent?.trim());
        expect(gaps).toEqual(['gone', 'No Such Note']);
        expect([...container.querySelectorAll('[data-outlink-id]')].map((e) => e.getAttribute('data-outlink-id'))).toEqual(['tgt']);
    });

    it('opens the linked note when a row is clicked', async () => {
        const openNote = vi.fn(async () => {});
        useNotes.setState({ openNote });
        await openTab('outlinks');
        await act(async () => container.querySelector<HTMLButtonElement>('[data-outlink-id="tgt"]')?.click());
        expect(openNote).toHaveBeenCalledWith('tgt');
    });

    it('asks for a note before showing backlinks', async () => {
        useUi.setState({ activeNoteId: null });
        await openTab('backlinks');
        expect(container.textContent).toContain(t('sidebar.links_no_note'));
    });

    it('grows the backlinks panel to the column instead of docking it under an editor', async () => {
        const spy = vi.spyOn(api.notes, 'backlinks').mockResolvedValue({ backlinks: [{ id: 'tgt', title: 'Target note', context: 'points here' }] });
        await openTab('backlinks');
        await vi.waitFor(() => expect(container.textContent).toContain('points here'), { timeout: 4000 });
        const section = container.querySelector('[role="tabpanel"] section')!;
        expect(section.className).not.toContain('max-h-[36%]');
        expect(spy).toHaveBeenCalledWith('src', expect.anything());
    });
});
