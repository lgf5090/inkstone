import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, NoteSummary } from '@shared/types';
import { ORGANIZER_COLORS } from '@shared/organizer-colors';
import { initI18n, t } from '../../lib/i18n';
import { api } from '../../lib/api';
import { getInboxFolderId, setInboxFolderId } from '../../lib/folder-prefs';
import { loadCalendarPrefs, saveCalendarPrefs } from '../../lib/calendar-prefs';
import { useNotes, useVisibleNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { Sidebar } from './Sidebar';
import { FOLDER_ICON_CHOICES } from '../folders/FolderAppearanceMenus';
import { groupExplorerNotes } from './ExplorerNote';
import { MobileLibraryFilters } from '../shell/MobileLibraryFilters';
import { NoteList } from '../list/NoteList';

const folder: Folder = { id: 'folder', name: 'Project', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 };
const note: NoteSummary = { id: 'note', title: 'Nested note', excerpt: '', folderId: folder.id, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null };
const originalUi = useUi.getState();
const originalNotes = useNotes.getState();
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    await initI18n();
    useUi.setState({ ...originalUi, listCollapsed: true, view: 'all', folderId: null, activeNoteId: null, expandedFolders: [], mobilePane: 'list', searchList: false });
    useNotes.setState({ ...originalNotes, folders: [folder], notes: { [note.id]: note }, tags: [], openNote: vi.fn(async (id) => { useUi.getState().setActiveNote(id); }) });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useUi.setState(originalUi, true);
    useNotes.setState(originalNotes, true);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)!;
const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(() => element.click()); };
const byLabel = (scope: ParentNode, label: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.replace(/✓$/,'').trim() === label || element.getAttribute('aria-label') === label);
    if (!found)
        throw new Error(`missing control ${label}`);
    return found;
};
const folderTree = () => document.querySelector<HTMLElement>(`[role="tree"][aria-label="${t('navigation.folder')}"]`)!;

describe('folder drag feedback', () => {
    async function drag(target: EventTarget, type: string) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
            dataTransfer: { value: { types: ['application/x-inkstone-folder'], getData: (format: string) => format === 'application/x-inkstone-folder' ? 'dragged-folder' : '', dropEffect: 'move' } },
            clientY: { value: 0 },
            relatedTarget: { value: null },
        });
        await act(() => target.dispatchEvent(event));
    }
    const highlighted = (element: Element) => element.classList.contains('ring-1');
    async function renderTree() {
        await act(() => root.render(createElement(Sidebar)));
        return {
            section: container.querySelector('[role="tree"]')!.closest('section')!,
            folderRow: container.querySelector<HTMLElement>('[data-folder-drop-target]')!,
        };
    }

    it('clears the root highlight when a folder handles and stops the drop event', async () => {
        const move = vi.fn(() => true);
        useNotes.setState({ patchFolder: move });
        const { section, folderRow } = await renderTree();
        await drag(section, 'dragover');
        expect(highlighted(section)).toBe(true);
        await drag(folderRow, 'drop');
        expect(move).toHaveBeenCalledExactlyOnceWith('dragged-folder', { parentId: folder.id, beforeId: null });
        expect(highlighted(section)).toBe(false);
        expect(highlighted(folderRow)).toBe(false);
    });

    it('highlights only the folder while moving from the root into that folder', async () => {
        const { section, folderRow } = await renderTree();
        await drag(section, 'dragover');
        expect(highlighted(section)).toBe(true);
        await drag(folderRow, 'dragover');
        expect(highlighted(section)).toBe(false);
        expect(highlighted(folderRow)).toBe(true);
        await drag(document.body, 'dragend');
        expect(highlighted(folderRow)).toBe(false);
    });

    it.each(['dragend', 'escape', 'blur', 'leave-window', 'drop-outside'])('clears the root highlight after %s', async (ending) => {
        const { section } = await renderTree();
        await drag(section, 'dragover');
        expect(highlighted(section)).toBe(true);
        if (ending === 'escape') {
            await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        } else if (ending === 'blur') {
            await act(() => window.dispatchEvent(new Event('blur')));
        } else {
            await drag(ending === 'leave-window' ? document.documentElement : document.body,
                ending === 'leave-window' ? 'dragleave' : ending === 'drop-outside' ? 'drop' : 'dragend');
        }
        expect(highlighted(section)).toBe(false);
    });
});

describe('explorer and collection navigation', () => {
    it('defaults to a hidden desktop list and reopens it for every collection', () => {
        expect(useUi.getInitialState().listCollapsed).toBe(true);
        for (const view of ['all', 'recent', 'starred', 'unfiled', 'archived', 'trash', 'tag', 'folder'] as const) {
            useUi.getState().openView(view, { folderId: folder.id, tag: 'topic' });
            expect(useUi.getState().listCollapsed).toBe(false);
            useUi.getState().toggleList();
        }
    });

    it('groups active notes at their actual depth, keeps root notes, and excludes archive and trash', () => {
        const rootNote = { ...note, id: 'root', folderId: null };
        const orphan = { ...note, id: 'orphan', folderId: 'missing' };
        const archived = { ...note, id: 'archive', isArchived: true };
        const trashed = { ...note, id: 'trash', deletedAt: 1 };
        const groups = groupExplorerNotes(Object.fromEntries([note, rootNote, orphan, archived, trashed].map((item) => [item.id, item])), [folder], 'en-US');
        expect(groups.get(folder.id)).toEqual([note]);
        expect(groups.get(null)?.map((item) => item.id).sort()).toEqual(['orphan', 'root']);
    });

    it('opens a collection, then opens a tree note without keeping the list', async () => {
        await act(() => root.render(createElement(Sidebar)));
        await click(button(container, t('navigation.all_notes') + '1'));
        expect(useUi.getState().listCollapsed).toBe(false);
        await click(button(container, folder.name));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(useUi.getState().listCollapsed).toBe(true);
        expect(container.querySelector('[data-tree-note-id="note"]')).toBeTruthy();
        await click(container.querySelector<HTMLButtonElement>('[data-tree-note-open]')!);
        expect(useUi.getState().activeNoteId).toBe(note.id);
        expect(useUi.getState().folderId).toBe(folder.id);
        expect(useUi.getState().listCollapsed).toBe(true);
    });

    it('opens global search as a list and returns to folder context when using the explorer', () => {
        useUi.getState().openView('trash');
        useUi.getState().openSearchList();
        expect(useUi.getState()).toMatchObject({ searchList: true, listCollapsed: false, view: 'all', mobilePane: 'list' });
        useUi.getState().openExplorer(folder.id);
        expect(useUi.getState()).toMatchObject({ searchList: false, listCollapsed: true, view: 'folder', folderId: folder.id });
    });

    it('restores the note in the background on mobile without interrupting navigation', () => {
        useUi.getState().setWorkspaceNote('primary', note.id, true, false);
        expect(useUi.getState()).toMatchObject({ activeNoteId: note.id, mobilePane: 'list' });
        useUi.getState().setMobilePane('account');
        useUi.getState().setWorkspaceNote('primary', note.id, true, false);
        expect(useUi.getState().mobilePane).toBe('account');
        useUi.getState().setActiveNote(note.id);
        expect(useUi.getState().mobilePane).toBe('preview');
    });
});

describe('mobile navigation sheets', () => {
    it('keeps archive and trash in the view sheet and closes after selection', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        await click(container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
        const sheet = document.querySelector('[role="dialog"]')!;
        expect(sheet).toBeTruthy();
        expect(sheet.contains(document.activeElement)).toBe(true);
        await click(button(sheet, t('navigation.trash') + '0'));
        expect(useUi.getState().view).toBe('trash');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('expands folders without closing, then opens a note and dismisses the sheet', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        await click(container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[2]!);
        const sheet = document.querySelector('[role="dialog"]')!;
        await click(button(sheet.querySelector('[data-folder-drop-target]')!, t('sidebar.expand')));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(document.querySelector('[role="dialog"]')).toBeTruthy();
        await click(sheet.querySelector<HTMLButtonElement>('[data-tree-note-open]')!);
        expect(useUi.getState().activeNoteId).toBe(note.id);
        expect(useUi.getState().mobilePane).toBe('preview');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('dismisses with Escape and restores focus to the trigger', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        const trigger = container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[1]!;
        trigger.focus();
        await click(trigger);
        await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('selects a folder as a list filter without opening an arbitrary note', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        await click(container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[2]!);
        await click(button(document.querySelector('[role="dialog"]')!, folder.name));
        expect(useUi.getState()).toMatchObject({ view: 'folder', folderId: folder.id, mobilePane: 'list', activeNoteId: null });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});

describe('search list', () => {
    async function input(value: string) {
        const element = container.querySelector<HTMLInputElement>('input')!;
        await act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(() => vi.advanceTimersByTimeAsync(200));
    }

    it('ignores stale full-text results after the query changes', async () => {
        vi.useFakeTimers();
        const requests: { signal?: AbortSignal; resolve: (response: Awaited<ReturnType<typeof api.search>>) => void }[] = [];
        vi.spyOn(api, 'search').mockImplementation((_query, _limit, signal) => new Promise((resolve) => requests.push({ signal, resolve })));
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('first');
        await input('second');
        expect(requests).toHaveLength(2);
        expect(requests[0]!.signal?.aborted).toBe(true);
        const response = (title: string): Awaited<ReturnType<typeof api.search>> => ({ results: [{ note: { ...note, id: title, title }, snippet: '', score: 1 }], mode: 'fts', took: 1, query: { text: title, tags: [], folder: null, starred: null, archived: null } });
        await act(() => requests[1]!.resolve(response('Current result')));
        await act(() => requests[0]!.resolve(response('Stale result')));
        const list = container.querySelector('[data-note-list]')!;
        expect(list.textContent).toContain('Current result');
        expect(list.textContent).not.toContain('Stale result');
    });

    it('keeps cached full-text matches usable if the server search fails', async () => {
        vi.useFakeTimers();
        vi.spyOn(api, 'search').mockRejectedValue(new Error('offline'));
        useNotes.setState({ contents: { [note.id]: 'A unique cached keyword' } });
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('keyword');
        expect(container.querySelector('[data-note-list]')?.textContent).toContain(note.title);
        expect(container.querySelector('[role="status"]')?.textContent).toBe(t('navigation.local_search_only'));
    });

    it('finds an archived note through full-text search', async () => {
        vi.useFakeTimers();
        vi.spyOn(api, 'search').mockRejectedValue(new Error('offline'));
        useNotes.setState({ notes: { [note.id]: note, 'note-archived': { ...note, id: 'note-archived', title: 'Archived zebra', isArchived: true } } });
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('zebra');
        expect(container.querySelector('[data-note-list]')?.textContent).toContain('Archived zebra');
    });

    it('keeps archived notes out of the unfiltered full-text list', async () => {
        vi.useFakeTimers();
        vi.spyOn(api, 'search').mockRejectedValue(new Error('offline'));
        useNotes.setState({ notes: { [note.id]: note, 'note-archived': { ...note, id: 'note-archived', title: 'Archived zebra', isArchived: true } } });
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        const list = container.querySelector('[data-note-list]')!;
        expect(list.textContent).toContain(note.title);
        expect(list.textContent).not.toContain('Archived zebra');
    });

    it('searches a body that is cached after the query was already typed', async () => {
        vi.useFakeTimers();
        vi.spyOn(api, 'search').mockRejectedValue(new Error('offline'));
        useNotes.setState({ contents: {} });
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('zqjxr');
        expect(container.querySelector('[data-note-list]')?.textContent).not.toContain(note.title);
        await act(async () => {
            useNotes.setState({ contents: { [note.id]: 'a body holding the zqjxr marker' } });
        });
        expect(container.querySelector('[data-note-list]')?.textContent).toContain(note.title);
    });

    it('keeps the query when the viewport crosses the desktop breakpoint', async () => {
        vi.useFakeTimers();
        vi.spyOn(api, 'search').mockRejectedValue(new Error('offline'));
        let wide = true;
        const changeHandlers = new Set<() => void>();
        vi.stubGlobal('matchMedia', (query: string) => ({
            get matches() {
                return query.includes('1180') ? wide : query.includes('768');
            },
            addEventListener: (_type: string, handler: () => void) => { changeHandlers.add(handler); },
            removeEventListener: (_type: string, handler: () => void) => { changeHandlers.delete(handler); },
        }));
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('Nested');
        expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Nested');
        await act(async () => {
            wide = false;
            for (const handler of [...changeHandlers]) handler();
        });
        expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Nested');
    });
});

describe('folder row menu', () => {
    const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!;
    const allButtons = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
    const labels = (scope: ParentNode) => allButtons(scope).map((element) => element.textContent?.trim() ?? '');
    const flyout = () => document.querySelector<HTMLElement>('[role="group"][aria-label]')!;

    beforeEach(() => {
        setInboxFolderId(null);
    });

    async function openFolderMenu() {
        await act(() => root.render(createElement(Sidebar)));
        await click(byLabel(container.querySelector('[data-folder-drop-target]')!, t('common.more_actions')));
        return menu();
    }

    it('lists every folder action in order', async () => {
        const scope = await openFolderMenu();
        expect(labels(scope)).toEqual([
            t('sidebar.rename'),
            t('sidebar.create_new_note_here'),
            t('sidebar.new_subfolder'),
            t('folders.color'),
            t('folders.icon'),
            t('folders.set_as_inbox'),
            t('folders.move_to'),
            t('sidebar.move_earlier'),
            t('sidebar.move_later'),
            t('sidebar.move_out_one_level'),
            t('folders.sort_by_name'),
            t('folders.export_zip'),
            t('folders.manage_folders'),
            t('sidebar.delete_folder'),
        ]);
    });

    it('paints the folder from the colour flyout and closes the menu', async () => {
        const patchFolder = vi.fn(() => true);
        useNotes.setState({ patchFolder });
        const scope = await openFolderMenu();
        await click(byLabel(scope, t('folders.color')));
        const panel = flyout();
        expect(byLabel(panel, t('folders.no_color')).getAttribute('aria-pressed')).toBe('true');
        expect(allButtons(panel).filter((element) => element.getAttribute('aria-pressed') !== null)).toHaveLength(ORGANIZER_COLORS.length + 1);
        await click(byLabel(panel, t('color.red')));
        expect(patchFolder).toHaveBeenCalledExactlyOnceWith(folder.id, { color: ORGANIZER_COLORS[0] });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(flyout()).toBeNull();
    });

    it('binds a custom emoji from the icon flyout', async () => {
        const patchFolder = vi.fn(() => true);
        useNotes.setState({ patchFolder });
        const scope = await openFolderMenu();
        await click(byLabel(scope, t('folders.icon')));
        const panel = flyout();
        expect(allButtons(panel).filter((element) => element.getAttribute('aria-pressed') !== null)).toHaveLength(FOLDER_ICON_CHOICES.length + 1);
        const field = panel.querySelector<HTMLInputElement>('input')!;
        await act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '🚀tail');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(patchFolder).toHaveBeenLastCalledWith(folder.id, { icon: '🚀' });
    });

    it('marks the inbox folder and flips the menu label', async () => {
        const scope = await openFolderMenu();
        await click(byLabel(scope, t('folders.set_as_inbox')));
        expect(getInboxFolderId()).toBe(folder.id);
        expect(useUi.getState().toasts.at(-1)?.title).toBe(t('folders.inbox_set_toast', { value0: folder.name }));
        await act(() => root.render(createElement(Sidebar)));
        expect(container.querySelector('[data-folder-drop-target] svg.lucide-inbox')).toBeTruthy();
        await click(byLabel(container.querySelector('[data-folder-drop-target]')!, t('common.more_actions')));
        await click(byLabel(menu(), t('folders.unset_inbox')));
        expect(getInboxFolderId()).toBeNull();
        await act(() => root.render(createElement(Sidebar)));
        expect(container.querySelector('[data-folder-drop-target] svg.lucide-inbox')).toBeNull();
    });

    it('moves every dropped note and restores them through the undo action', async () => {
        const moved = { ...note, id: 'note-2', title: 'Second', folderId: null };
        const patchNote = vi.fn(async () => {});
        useNotes.setState({ notes: { [note.id]: note, [moved.id]: moved }, patchNote });
        await act(() => root.render(createElement(Sidebar)));
        const row = container.querySelector<HTMLElement>('[data-folder-drop-target]')!;
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: {
                types: ['application/x-inkstone-note', 'application/x-inkstone-notes'],
                getData: (format: string) => format === 'application/x-inkstone-notes'
                    ? JSON.stringify([note.id, moved.id])
                    : note.id,
            },
        });
        await act(() => row.dispatchEvent(event));
        await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(patchNote).toHaveBeenCalledExactlyOnceWith(moved.id, { folderId: folder.id });
        const toast = useUi.getState().toasts.at(-1)!;
        expect(toast.title).toBe(t('folders.moved_value0_to_value1', { value0: 1, value1: folder.name }));
        await act(() => toast.action!.run());
        expect(patchNote).toHaveBeenLastCalledWith(moved.id, { folderId: null });
    });

    it('expands and collapses every branch from the section header', async () => {
        const child: Folder = { ...folder, id: 'child', name: 'Child', parentId: folder.id };
        useNotes.setState({ folders: [folder, child], notes: {} });
        await act(() => root.render(createElement(Sidebar)));
        await click(byLabel(container, t('folders.expand_all')));
        expect(useUi.getState().expandedFolders).toContain(folder.id);
        await click(byLabel(container, t('folders.collapse_all')));
        expect(useUi.getState().expandedFolders).not.toContain(folder.id);
    });

    it('sorts sibling folders by name from the row menu', async () => {
        const beta: Folder = { ...folder, id: 'beta', name: 'Beta', position: 1 };
        const alpha: Folder = { ...folder, id: 'alpha', name: 'Alpha', position: 2 };
        const patchFolder = vi.fn((_id: string, _patch: { beforeId?: string | null }) => true);
        useNotes.setState({ folders: [beta, alpha], notes: {}, patchFolder });
        const scope = await openFolderMenu();
        await click(byLabel(scope, t('folders.sort_by_name')));
        expect(patchFolder.mock.calls.map(([id]) => id)).toEqual([alpha.id, beta.id]);
        expect(patchFolder).toHaveBeenLastCalledWith(beta.id, { beforeId: null });
    });
});

describe('folder tree keyboard', () => {
    const press = async (element: HTMLElement, key: string) => {
        await act(() => {
            element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
    };

    it('moves focus between rows and starts renaming with F2', async () => {
        const second: Folder = { ...folder, id: 'folder-2', name: 'Second', position: 1 };
        useNotes.setState({ folders: [folder, second], notes: {} });
        await act(() => root.render(createElement(Sidebar)));
        const rows = () => [...folderTree().querySelectorAll<HTMLElement>('[data-tree-row]')];
        expect(rows().map((element) => element.textContent?.trim())).toEqual(['Project', 'Second']);
        await act(() => rows()[0]!.focus());
        await press(rows()[0]!, 'ArrowDown');
        expect(document.activeElement).toBe(rows()[1]);
        await press(rows()[1]!, 'F2');
        expect(container.querySelector(`input[aria-label="${t('sidebar.rename')}"]`)).toBeTruthy();
    });

    it('expands a collapsed branch with ArrowRight and returns to the parent with ArrowLeft', async () => {
        const child: Folder = { ...folder, id: 'child', name: 'Child', parentId: folder.id, position: 1 };
        useNotes.setState({ folders: [folder, child], notes: {} });
        await act(() => root.render(createElement(Sidebar)));
        const parentRow = folderTree().querySelector<HTMLElement>('[data-tree-row]')!;
        await act(() => parentRow.focus());
        await press(parentRow, 'ArrowRight');
        expect(useUi.getState().expandedFolders).toContain(folder.id);
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        await press(parentRow, 'ArrowRight');
        const rows = [...folderTree().querySelectorAll<HTMLElement>('[data-tree-row]')];
        expect(document.activeElement).toBe(rows[1]);
        await press(rows[1]!, 'ArrowLeft');
        expect(document.activeElement).toBe(parentRow);
    });
});


describe('built-in logical folders', () => {
    const treeRows = () => [...document.querySelectorAll<HTMLElement>('[role="tree"] [data-tree-row]')].map((element) => element.textContent?.trim());
    const header = () => document.querySelector<HTMLElement>('#sidebar-folders > div')!;
    const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!;

    async function openHeaderMenu() {
        await act(() => root.render(createElement(Sidebar)));
        await act(() => {
            header().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        return menu();
    }

    it('renders calendar, todo and inbox above the real folders', async () => {
        saveCalendarPrefs({ calendarVisible: true, todoVisible: true, inboxVisible: true });
        await act(() => root.render(createElement(Sidebar)));
        expect(treeRows().slice(0, 3)).toEqual([t('sidebar.calendar_folder'), t('sidebar.todo_folder'), t('sidebar.inbox_folder')]);
        expect(treeRows()).toContain(folder.name);
    });

    it('hides a built-in row when its header-menu checkbox is cleared', async () => {
        saveCalendarPrefs({ calendarVisible: true, todoVisible: true, inboxVisible: true });
        const scope = await openHeaderMenu();
        const labels = [...scope.querySelectorAll<HTMLButtonElement>('button')].map((element) => element.textContent?.replace(/✓$/,'').trim());
        expect(labels.slice(-3)).toEqual([t('sidebar.calendar_folder'), t('sidebar.todo_folder'), t('sidebar.inbox_folder')]);
        await click(byLabel(scope, t('sidebar.calendar_folder')));
        expect(loadCalendarPrefs().calendarVisible).toBe(false);
        await act(() => root.render(createElement(Sidebar)));
        expect(treeRows().slice(0, 2)).toEqual([t('sidebar.todo_folder'), t('sidebar.inbox_folder')]);
    });

    it('buckets notes by creation week and opens the calendar node as a folder view', async () => {
        saveCalendarPrefs({ calendarVisible: true, todoVisible: false, inboxVisible: false });
        const dated = { ...note, createdAt: new Date(2026, 9, 6).getTime() };
        useNotes.setState({ notes: { [dated.id]: dated } });
        await act(() => root.render(createElement(Sidebar)));
        const calendarRow = treeRows().indexOf(t('sidebar.calendar_folder'));
        expect(calendarRow).toBe(0);
        const toggle = document.querySelectorAll<HTMLElement>('[role="tree"] [data-tree-toggle]')[0]!;
        await click(toggle);
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        const yearRow = [...document.querySelectorAll<HTMLElement>('[role="tree"] [data-tree-row]')].find((element) => element.textContent?.trim() === '2026');
        expect(yearRow).toBeTruthy();
        await click(yearRow!);
        expect(useUi.getState()).toMatchObject({ view: 'folder', folderId: 'cal:2026' });
        expect(document.querySelector<HTMLElement>('[role="tree"][aria-label="' + t('navigation.folder') + '"] [data-tree-row]')).toBeTruthy();
    });

    it('aggregates unfiled notes under the inbox row and reveals them on expand', async () => {
        saveCalendarPrefs({ calendarVisible: false, todoVisible: false, inboxVisible: true });
        const loose = { ...note, id: 'loose', title: 'Loose end', folderId: null };
        useNotes.setState({ notes: { [note.id]: note, [loose.id]: loose } });
        await act(() => root.render(createElement(Sidebar)));
        const inbox = document.querySelector<HTMLElement>('[role="tree"][aria-label="' + t('sidebar.inbox_folder') + '"]')!;
        expect(inbox.querySelector('[data-tree-note-open]')).toBeNull();
        await click(byLabel(inbox, t('sidebar.expand')));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(inbox.querySelector<HTMLElement>('[data-tree-note-open]')?.textContent?.trim()).toBe('Loose end');
        expect(container.querySelector('[data-folder-drop-target] [data-tree-note-open]')).toBeNull();
    });
});

describe('virtual folder filtering', () => {
    function VisibleIdsProbe({ onRender }: { onRender: (ids: string[]) => void }) {
        onRender(useVisibleNotes().map((item) => item.id));
        return null;
    }

    async function visibleFor(folderId: string): Promise<string[]> {
        let ids: string[] = [];
        useUi.getState().openView('folder', { folderId });
        await act(() => root.render(createElement(VisibleIdsProbe, { onRender: (next) => { ids = next; } })));
        return ids;
    }

    beforeEach(() => {
        const dated = { ...note, id: 'dated', title: 'Dated', createdAt: new Date(2026, 9, 6).getTime() };
        const old = { ...note, id: 'old', title: 'Old', createdAt: new Date(2021, 0, 1).getTime() };
        useNotes.setState({ notes: { [note.id]: note, dated, old } });
    });

    it('selects notes inside a calendar month and its week leaf', async () => {
        expect(await visibleFor('cal:2026:q4:10')).toEqual(['dated']);
        expect(await visibleFor('cal:2026:q4:10:w41')).toEqual(['dated']);
        expect(await visibleFor('cal:2020:q4:12:w53')).toEqual(['old']);
    });

    it('selects every note of the calendar root without leaking other folders', async () => {
        expect(await visibleFor('cal')).toEqual([note.id, 'dated', 'old'].sort());
    });

    it('keeps the todo tree to the configured tags', async () => {
        const notes = {
            tagged: { ...note, id: 'tagged', tags: ['chore'] },
            other: { ...note, id: 'other', tags: ['reading'] },
            plain: { ...note, id: 'plain', tags: ['archive'] },
        };
        useNotes.setState({ notes });
        useSession.setState({ settings: { ...useSession.getState().settings, notes: { todoTag: 'chore' } } });
        expect(await visibleFor('todo')).toEqual(['tagged']);
        useSession.setState({ settings: { ...useSession.getState().settings, notes: { todoTag: 'chore,reading' } } });
        expect((await visibleFor('todo')).sort()).toEqual(['other', 'tagged']);
    });

    it('shows only unfiled notes for the inbox node and still honours real folders', async () => {
        useNotes.setState({ notes: { [note.id]: note, loose: { ...note, id: 'loose', folderId: null } } });
        expect(await visibleFor('inbox')).toEqual(['loose']);
        expect(await visibleFor(folder.id)).toEqual([note.id]);
    });
});
