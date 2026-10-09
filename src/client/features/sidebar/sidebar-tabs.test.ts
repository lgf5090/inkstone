import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, NoteSummary } from '@shared/types';
import { SIDEBAR_TABS } from '@shared/constants';
import { initI18n, t } from '../../lib/i18n';
import { fullTime, shortSince } from '../../lib/time';
import { api } from '../../lib/api';
import { installTestGlobals } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { Sidebar } from './Sidebar';
import { BacklinksPanel } from '../workspace/BacklinksPanel';
import { ConfirmHost } from '../../components/overlay';
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

    it('gives the tag tab the same header shape as the folder tab', async () => {
        await act(async () => tabs().find((tab) => tab.dataset.tab === 'tags')?.click());
        const section = panel().querySelector('section')!;
        expect(section.className).not.toContain('mt-');
        const head = section.querySelector(':scope > div')!;
        // No printed heading, the controls own the line, and they are centred in it — the same three
        // rules the folder tab follows, read off the classes because jsdom lays nothing out.
        expect(head.textContent).toBe('');
        expect(head.className).toContain('justify-center');
        expect(head.className).not.toContain('justify-between');
        const group = head.lastElementChild!;
        // This fixture has one flat tag, so the expand-all control is not on offer: the create
        // action is the whole group, and it stays visible without a hover like the folder tab's.
        expect(group.querySelectorAll('button')).toHaveLength(1);
        expect(group.querySelector('button')!.getAttribute('aria-label')).toBe(t('tags.new'));
        expect(group.querySelector('button')!.className).not.toContain('md:opacity-0');
        expect(group.className).toBe('flex shrink-0 items-center');
    });

    it('holds the calendar and the view rows outside the panel, above the strip', () => {
        const fixed = container.querySelector<HTMLElement>('[data-sidebar-fixed]')!;
        expect(fixed).toBeTruthy();
        expect(fixed.contains(panel())).toBe(false);
        expect(fixed.querySelector(`section[aria-label="${t('sidebar.calendar_title')}"]`)).toBeTruthy();
        expect(fixed.textContent).toContain(t('navigation.all_notes'));
        expect(fixed.textContent).toContain(t('navigation.unfiled'));
        const strip = container.querySelector('[role="tablist"]')!;
        expect(fixed.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(panel().compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    it('keeps the calendar and the view rows on screen whatever tab is open', async () => {
        for (const id of ['tags', 'recent', 'backlinks', 'outlinks', 'history', 'graph']) {
            await act(async () => tabs().find((tab) => tab.dataset.tab === id)?.click());
            const fixed = container.querySelector<HTMLElement>('[data-sidebar-fixed]')!;
            expect(fixed.textContent, `tab ${id} lost the view rows`).toContain(t('navigation.unfiled'));
            expect(panel().textContent).not.toContain(t('navigation.all_notes'));
        }
    });

    it('swaps the whole body when the tag tab is chosen', async () => {
        await act(async () => tabs().find((tab) => tab.dataset.tab === 'tags')?.click());
        expect(useUi.getState().sidebarTab).toBe('tags');
        expect(container.querySelectorAll('[data-folder-drop-target]').length).toBe(0);
        expect(container.querySelector(`input[aria-label="${t('tags.filter')}"]`)).toBeTruthy();
        await act(async () => {
            const box = container.querySelector<HTMLInputElement>(`input[aria-label="${t('tags.filter')}"]`)!;
            box.value = '/^demo$/';
            box.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(container.querySelectorAll('[data-tag-row]').length).toBe(1);
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

    it('centres its one control and prints no tab name of its own', async () => {
        useNotes.setState({ notes: { a: summary('a', 'Alpha') } });
        useUi.setState({ recentNoteIds: ['a'] });
        await open();
        const row = panel().firstElementChild!;
        expect(row.textContent).toBe('');
        expect(row.className).toContain('justify-center');
        expect(row.querySelector('[data-recent-clear]')).toBeTruthy();
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

    it('lists the outgoing links without repeating the tab name above them', async () => {
        await openTab('outlinks');
        expect(container.querySelectorAll('[data-outlink-id]').length).toBe(1);
        expect(panel().textContent).not.toContain(t('sidebar.outlinks_heading'));
    });

    it('keeps the backlink count and drops the title the tab already carries', async () => {
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({ backlinks: [{ id: 'tgt', title: 'Target note', context: 'points here' }], unlinked: [] });
        await openTab('backlinks');
        await vi.waitFor(() => expect(container.textContent).toContain('points here'), { timeout: 4000 });
        const row = container.querySelector<HTMLElement>('[role="tabpanel"] section > div')!;
        expect(row.className).toContain('justify-center');
        expect(row.textContent).not.toContain(t('common.backlinks'));
        expect(row.textContent).toContain('1');
    });

    it('keeps the title on the panel docked under the editor', async () => {
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({ backlinks: [], unlinked: [] });
        await act(async () => root.unmount());
        root = createRoot(container);
        await act(() => root.render(createElement(BacklinksPanel, { noteId: 'src' })));
        await vi.waitFor(() => expect(container.textContent).toContain(t('common.backlinks')), { timeout: 4000 });
        const row = container.querySelector('section > div')!;
        expect(row.className).toContain('sticky');
        expect(row.className).not.toContain('justify-center');
    });

    it('asks for a note before showing backlinks', async () => {
        useUi.setState({ activeNoteId: null });
        await openTab('backlinks');
        expect(container.textContent).toContain(t('sidebar.links_no_note'));
    });

    it('grows the backlinks panel to the column instead of docking it under an editor', async () => {
        const spy = vi.spyOn(api.notes, 'backlinks').mockResolvedValue({ backlinks: [{ id: 'tgt', title: 'Target note', context: 'points here' }], unlinked: [] });
        await openTab('backlinks');
        await vi.waitFor(() => expect(container.textContent).toContain('points here'), { timeout: 4000 });
        const section = container.querySelector('[role="tabpanel"] section')!;
        expect(section.className).not.toContain('max-h-[36%]');
        expect(spy).toHaveBeenCalledWith('src', expect.anything());
    });
});

describe('history tab', () => {
    const version = { id: 'v1', noteId: 'src', title: 'Source note', size: 120, createdAt: Date.now() - 60_000 };
    type RestoreFn = (id: string, versionId: string, content: string, title?: string) => Promise<boolean>;
    let restoreVersion: ReturnType<typeof vi.fn<RestoreFn>>;

    beforeEach(() => {
        restoreVersion = vi.fn<RestoreFn>(async () => true);
        useNotes.setState({ notes: { src: summary('src', 'Source note') }, contents: { src: 'current text' }, restoreVersion });
        useUi.setState({ activeNoteId: 'src', panel: null });
        vi.spyOn(api.notes, 'versions').mockResolvedValue({ versions: [version] });
        vi.spyOn(api.notes, 'version').mockResolvedValue({ ...version, content: 'older text' });
    });

    const openTab = async (tab: 'history' | 'graph') => {
        await act(async () => useUi.getState().setSidebarTab(tab));
    };

    /** The dialog only answers when a host is mounted, and `confirm()` resolves false without one. */
    const mountWithConfirmHost = async () => {
        await act(() => root.unmount());
        root = createRoot(container);
        await act(() => root.render(createElement(Fragment, null, createElement(Sidebar), createElement(ConfirmHost))));
    };

    it('lists the saved snapshots of the note being read', async () => {
        await openTab('history');
        await vi.waitFor(() => expect(container.querySelectorAll('[data-version-id]').length).toBe(1), { timeout: 4000 });
        const row = container.querySelector('[data-version-id="v1"]')!;
        expect(row.textContent).toContain('120 B');
    });

    it('starts at the snapshots without repeating the tab name', async () => {
        await openTab('history');
        await vi.waitFor(() => expect(container.querySelectorAll('[data-version-id]').length).toBe(1), { timeout: 4000 });
        expect(panel().textContent).not.toContain(t('sidebar.tab_history'));
    });

    it('asks before putting an old snapshot back, then restores with the fetched body', async () => {
        await openTab('history');
        await vi.waitFor(() => expect(container.querySelectorAll('[data-version-id]').length).toBe(1), { timeout: 4000 });
        await mountWithConfirmHost();
        await vi.waitFor(() => expect(container.querySelector('[data-version-id="v1"] button')).toBeTruthy(), { timeout: 4000 });
        await act(async () => container.querySelector<HTMLButtonElement>('[data-version-id="v1"] button')!.click());
        await vi.waitFor(() => expect(document.body.textContent).toContain(t('sidebar.version_restore_title')), { timeout: 4000 });
        const dialog = document.querySelector('[role="alertdialog"]') ?? document.body;
        await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('common.restore'))?.click());
        await vi.waitFor(() => expect(restoreVersion).toHaveBeenCalled(), { timeout: 4000 });
        expect(api.notes.version).toHaveBeenCalledWith('src', 'v1');
        expect(restoreVersion).toHaveBeenCalledWith('src', 'v1', 'older text', 'Source note');
    });

    it('leaves the note alone when the reader cancels', async () => {
        await openTab('history');
        await vi.waitFor(() => expect(container.querySelectorAll('[data-version-id]').length).toBe(1), { timeout: 4000 });
        await mountWithConfirmHost();
        await vi.waitFor(() => expect(container.querySelector('[data-version-id="v1"] button')).toBeTruthy(), { timeout: 4000 });
        await act(async () => container.querySelector<HTMLButtonElement>('[data-version-id="v1"] button')!.click());
        await vi.waitFor(() => expect(document.body.textContent).toContain(t('sidebar.version_restore_title')), { timeout: 4000 });
        const dialog = document.querySelector('[role="alertdialog"]') ?? document.body;
        await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('common.cancel'))?.click());
        await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 250)); });
        expect(restoreVersion).not.toHaveBeenCalled();
    });

    it('names the tab that needs a note without mounting the canvas', async () => {
        useUi.setState({ activeNoteId: null });
        await openTab('graph');
        expect(container.textContent).toContain(t('graph.local_graph'));
        expect(container.textContent).toContain(t('sidebar.graph_no_note'));
    });
});

describe('backlinks panel mentions section', () => {
    const noteA = summary('a', 'Note A');

    beforeEach(() => {
        useNotes.setState({ notes: { a: noteA }, contents: { a: 'text' } });
        useUi.setState({ activeNoteId: 'a', sidebarTab: 'backlinks' });
    });

    it('lists the notes that only mention the title, apart from the linked ones', async () => {
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({
            backlinks: [{ id: 'l1', title: 'Linked note', context: 'a link here' }],
            unlinked: [{ id: 'm1', title: 'Mentioning note', context: 'says the title in passing' }],
        });
        await act(() => root.render(createElement(Sidebar)));
        await vi.waitFor(() => expect(container.textContent).toContain('says the title in passing'), { timeout: 4000 });
        expect(container.textContent).toContain(t('workspace.mentions_here'));
        expect(container.textContent).toContain('a link here');
    });

    it('leaves the mentions heading out when nothing mentions the note', async () => {
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({
            backlinks: [{ id: 'l1', title: 'Linked note', context: 'a link here' }],
            unlinked: [],
        });
        await act(() => root.render(createElement(Sidebar)));
        await vi.waitFor(() => expect(container.textContent).toContain('a link here'), { timeout: 4000 });
        expect(container.textContent).not.toContain(t('workspace.mentions_here'));
    });

    it('opens the note a mention was clicked on', async () => {
        const openNote = vi.fn(async () => {});
        useNotes.setState({ openNote });
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({
            backlinks: [],
            unlinked: [{ id: 'm1', title: 'Mentioning note', context: 'says the title in passing' }],
        });
        await act(() => root.render(createElement(Sidebar)));
        await vi.waitFor(() => expect(container.textContent).toContain('Mentioning note'), { timeout: 4000 });
        await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Mentioning note'))?.click());
        expect(openNote).toHaveBeenCalledWith('m1');
    });

    it('offers the link action on a mention row and not on a linked one', async () => {
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({
            backlinks: [{ id: 'l1', title: 'Linked note', context: 'a link here' }],
            unlinked: [{ id: 'm1', title: 'Mentioning note', context: 'says the title in passing' }],
        });
        await act(() => root.render(createElement(Sidebar)));
        await vi.waitFor(() => expect(container.textContent).toContain('says the title in passing'), { timeout: 4000 });
        const names = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
        expect(names.filter((name) => name.startsWith(t('workspace.link_the_mention'))))
            .toEqual([`${t('workspace.link_the_mention')}: Mentioning note`]);
    });

    it('links the mention the reader clicked, then asks the server what is left', async () => {
        const backlinks = vi.spyOn(api.notes, 'backlinks').mockResolvedValue({
            backlinks: [],
            unlinked: [{ id: 'm1', title: 'Mentioning note', context: 'says the title' }],
        });
        const linkMention = vi.fn(async () => 'linked' as const);
        useNotes.setState({ linkMention });
        await act(() => root.render(createElement(Sidebar)));
        await vi.waitFor(() => expect(container.textContent).toContain('Mentioning note'), { timeout: 4000 });
        const asked = backlinks.mock.calls.length;
        const button = [...container.querySelectorAll('button')]
            .find((b) => (b.getAttribute('aria-label') ?? '').startsWith(t('workspace.link_the_mention')))!;
        await act(async () => button.click());
        expect(linkMention).toHaveBeenCalledWith('a', 'm1');
        await vi.waitFor(() => expect(backlinks.mock.calls.length).toBeGreaterThan(asked), { timeout: 4000 });
    });

    it('waits for the reader before a second mention goes in the same note', async () => {
        vi.spyOn(api.notes, 'backlinks').mockResolvedValue({
            backlinks: [],
            unlinked: [
                { id: 'm1', title: 'First note', context: 'says it once' },
                { id: 'm2', title: 'Second note', context: 'says it too' },
            ],
        });
        let release: ((value: 'linked') => void) | null = null;
        useNotes.setState({ linkMention: () => new Promise<'linked'>((resolve) => {
            release = resolve;
        }) });
        await act(() => root.render(createElement(Sidebar)));
        await vi.waitFor(() => expect(container.textContent).toContain('says it too'), { timeout: 4000 });
        const buttons = () => [...container.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? '').startsWith(t('workspace.link_the_mention')));
        await act(async () => buttons()[0].click());
        expect(buttons().every((b) => b.disabled)).toBe(true);
        await act(async () => release?.('linked'));
        await vi.waitFor(() => expect(buttons().some((b) => !b.disabled)).toBe(true), { timeout: 4000 });
    });
});

const DAY = 86_400_000;

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('folder filter', () => {
    const work: Folder = { id: 'f-work', name: 'Work', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 };
    const research: Folder = { id: 'f-research', name: 'Deep Research', parentId: 'f-work', icon: null, color: null, position: 1, createdAt: 2, updatedAt: 2 };
    const games: Folder = { id: 'f-games', name: 'Games', parentId: null, icon: null, color: null, position: 2, createdAt: 3, updatedAt: 3 };
    const filter = () => container.querySelector<HTMLInputElement>('input[data-folder-filter]');
    const shownFolders = () => [...container.querySelectorAll(`[role="tree"][aria-label="${t('navigation.folder')}"] button[data-tree-row]`)].map((row) => row.getAttribute('aria-label')).filter((label) => label !== null);

    beforeEach(async () => {
        useNotes.setState({ folders: [work, research, games] });
        useUi.setState({ sidebarTab: 'library', expandedFolders: [] });
        await act(() => root.render(createElement(Sidebar)));
    });

    it('offers the box once there is a folder to filter', () => {
        expect(filter()).toBeTruthy();
        expect(filter()!.getAttribute('aria-label')).toBe(t('folders.search'));
    });

    it('hides the box while the vault holds neither a folder nor a note', async () => {
        await act(async () => useNotes.setState({ folders: [], notes: {} }));
        await act(() => root.render(createElement(Sidebar)));
        expect(filter()).toBeNull();
    });

    it('still offers the box to a vault of unfiled notes', async () => {
        await act(async () => useNotes.setState({ folders: [], notes: { n9: summary('n9', 'Loose sketch') } }));
        await act(() => root.render(createElement(Sidebar)));
        expect(filter()).toBeTruthy();
        await typeInto(filter()!, 'sketch');
        expect([...container.querySelectorAll('[data-unfiled-matches] [data-tree-note-id]')]).toHaveLength(1);
        expect(container.querySelector('[data-unfiled-label]')?.textContent).toBe(t('navigation.unfiled'));
        expect(container.querySelector('[data-folder-match-count]')?.textContent).toBe(t('folders.note_match_count', { value0: 0, value1: 1 }));
    });

    it('shows every folder while the box is empty, nested ones only when opened', () => {
        expect(shownFolders()).toEqual(['Work', 'Games']);
    });

    it('keeps the road to a match and reveals it without the reader opening anything', async () => {
        await typeInto(filter()!, 'research');
        expect(shownFolders()).toEqual(['Work', 'Deep Research']);
        expect(container.querySelector('[data-folder-no-match]')).toBeNull();
        expect(container.querySelector('[data-folder-match-count]')?.textContent).toBe(t('folders.match_count', { value0: 2 }));
    });

    it('drops the branches that hold no match', async () => {
        await typeInto(filter()!, 'research');
        expect(shownFolders()).not.toContain('Games');
    });

    it('keeps a matched folder whole, subfolders and all', async () => {
        await typeInto(filter()!, 'work');
        expect(shownFolders()).toEqual(['Work', 'Deep Research']);
    });

    it('says so when nothing is named that way, and recovers', async () => {
        await typeInto(filter()!, 'zzqx');
        expect(container.querySelector('[data-folder-no-match]')?.textContent).toBe(t('folders.no_match'));
        expect(shownFolders()).toEqual([]);
        await typeInto(filter()!, '');
        expect(shownFolders()).toEqual(['Work', 'Games']);
        expect(container.querySelector('[data-folder-match-count]')).toBeNull();
    });

    it('clears from the button beside the field', async () => {
        await typeInto(filter()!, 'games');
        expect(shownFolders()).toEqual(['Games']);
        const clear = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('notes.clear_filters')}"]`);
        expect(clear).toBeTruthy();
        await act(async () => clear!.click());
        expect(filter()!.value).toBe('');
        expect(shownFolders()).toEqual(['Work', 'Games']);
    });

    it('opens the first match on Enter', async () => {
        await typeInto(filter()!, 'research');
        await act(async () => {
            filter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(useUi.getState().view).toBe('folder');
        expect(useUi.getState().folderId).toBe('f-work');
    });

    it('opens a deep match with the road to it left open', async () => {
        await typeInto(filter()!, 'research');
        const deep = container.querySelector<HTMLElement>('button[aria-label="Deep Research"]');
        expect(deep).toBeTruthy();
        await act(async () => deep!.click());
        expect(useUi.getState().view).toBe('folder');
        expect(useUi.getState().folderId).toBe('f-research');
    });

    it('leaves the built-in rows out of the way while filtering', async () => {
        // The tab has no printed heading of its own any more, so the tree's name is what remains.
        expect(container.querySelector(`[role="tree"][aria-label="${t('navigation.folder')}"]`)).toBeTruthy();
        expect(container.textContent).not.toContain(t('navigation.folder'));
        await typeInto(filter()!, 'games');
        expect(shownFolders()).toEqual(['Games']);
    });

    const notesIn = () => [...container.querySelectorAll(`[role="tree"][aria-label="${t('navigation.folder')}"] [data-tree-note-id]`)].map((row) => row.getAttribute('data-tree-note-id'));
    const filed = {
        n1: summary('n1', 'Quarterly report', { folderId: 'f-research' }),
        n2: summary('n2', 'Shopping list', { folderId: 'f-games' }),
        n3: summary('n3', 'Standup notes', { folderId: 'f-work' }),
        n4: summary('n4', 'Loose thought', { folderId: null }),
    };
    const withNotes = async () => {
        await act(async () => useNotes.setState({ notes: filed }));
    };

    it('finds a note by its file name and shows the road to it', async () => {
        await withNotes();
        await typeInto(filter()!, 'report');
        expect(shownFolders()).toEqual(['Work', 'Deep Research']);
        expect(notesIn()).toEqual(['n1']);
        expect(container.querySelector('[data-folder-match-count]')?.textContent).toBe(t('folders.note_match_count', { value0: 2, value1: 1 }));
    });

    it('underlines the letters a query reached inside a note title', async () => {
        await withNotes();
        await typeInto(filter()!, 'port');
        const marks = [...container.querySelectorAll('[data-tree-note-id] span.font-semibold')].map((span) => span.textContent);
        expect(marks).toEqual(['port']);
        expect(notesIn()).toEqual(['n1']);
    });

    it('hides the notes of a folder the query only walks through', async () => {
        await withNotes();
        await typeInto(filter()!, 'report');
        expect(notesIn()).not.toContain('n3');
    });

    it('keeps every note of a folder the query names', async () => {
        await withNotes();
        await typeInto(filter()!, 'work');
        expect(shownFolders()).toEqual(['Work', 'Deep Research']);
        expect(notesIn()).toEqual(['n1', 'n3']);
    });

    it('lists a matching note that lives in no folder', async () => {
        await withNotes();
        await typeInto(filter()!, 'loose');
        expect(shownFolders()).toEqual([]);
        expect(container.querySelector('[data-folder-no-match]')).toBeNull();
        const loose = [...container.querySelectorAll('[data-unfiled-matches] [data-tree-note-id]')];
        expect(loose.map((row) => row.getAttribute('data-tree-note-id'))).toEqual(['n4']);
        expect(container.querySelector('[data-folder-match-count]')?.textContent).toBe(t('folders.note_match_count', { value0: 0, value1: 1 }));
    });

    it('opens an unfiled match on Enter', async () => {
        const opened = vi.fn(async () => {});
        await withNotes();
        await act(async () => useNotes.setState({ openNote: opened }));
        await typeInto(filter()!, 'loose');
        await act(async () => {
            filter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(opened).toHaveBeenCalledWith('n4');
    });

    it('answers an expression typed into the box', async () => {
        await withNotes();
        await typeInto(filter()!, '/^deep /');
        expect(shownFolders()).toEqual(['Work', 'Deep Research']);
        await typeInto(filter()!, '/report|shopping/');
        expect(notesIn()).toEqual(['n1', 'n2']);
    });

    it('says in the box why a refused expression found nothing', async () => {
        await typeInto(filter()!, '/(a+)+b/');
        expect(filter()!.getAttribute('aria-invalid')).toBe('true');
        expect(container.querySelector('[role="status"]')?.textContent).toBe(t('filter.regex_unsafe'));
        expect(shownFolders()).toEqual([]);
        expect(container.querySelector('[data-folder-no-match]')?.textContent).toBe(t('folders.no_match'));
    });

    it('clears from the keyboard before it gives up the focus', async () => {
        await typeInto(filter()!, 'games');
        expect(filter()!.value).toBe('games');
        await act(async () => {
            filter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(filter()!.value).toBe('');
        expect(shownFolders()).toEqual(['Work', 'Games']);
    });
});

describe('recent file ages', () => {
    const open = async () => {
        await act(async () => useUi.getState().setSidebarTab('recent'));
    };

    it('says how long ago each note was last written', async () => {
        const stamp = Date.now() - (3 * DAY + 5 * 60_000);
        useNotes.setState({ notes: { a: summary('a', 'Alpha', { updatedAt: stamp }) } });
        useUi.setState({ recentNoteIds: ['a'] });
        await open();
        const age = container.querySelector<HTMLElement>('[data-recent-age]');
        expect(age).toBeTruthy();
        expect(age!.textContent).toBe(shortSince(stamp, Date.now()));
        expect(age!.getAttribute('title')).toBe(fullTime(stamp));
    });

    it('keeps the folder tree free of the age column', async () => {
        useNotes.setState({ notes: { a: summary('a', 'Alpha', { updatedAt: Date.now() - 3 * DAY }) } });
        useUi.setState({ recentNoteIds: ['a'], sidebarTab: 'library' });
        await act(() => root.render(createElement(Sidebar)));
        expect(container.querySelectorAll('[data-recent-age]').length).toBe(0);
    });
});

describe('clearing the recent trail', () => {
    it('offers the button only while there is something to clear', async () => {
        useNotes.setState({ notes: { a: summary('a', 'Alpha') } });
        useUi.setState({ recentNoteIds: ['a'], sidebarTab: 'recent' });
        await act(() => root.render(createElement(Sidebar)));
        expect(container.querySelector('[data-recent-clear]')).toBeTruthy();
        useUi.setState({ recentNoteIds: [] });
        await act(() => root.render(createElement(Sidebar)));
        expect(container.querySelector('[data-recent-clear]')).toBeNull();
    });

    it('empties the list without touching the notes', async () => {
        useNotes.setState({ notes: { a: summary('a', 'Alpha'), b: summary('b', 'Bravo') } });
        useUi.setState({ recentNoteIds: ['a', 'b'], sidebarTab: 'recent', activeNoteId: 'a' });
        await act(() => root.render(createElement(Sidebar)));
        await act(async () => container.querySelector<HTMLButtonElement>('[data-recent-clear]')!.click());
        expect(useUi.getState().recentNoteIds).toEqual([]);
        expect(container.querySelector('[data-recent-list]')).toBeNull();
        expect(container.textContent).toContain(t('sidebar.recent_empty'));
        expect(useNotes.getState().notes.a).toBeTruthy();
        expect(useUi.getState().activeNoteId).toBe('a');
    });
});
