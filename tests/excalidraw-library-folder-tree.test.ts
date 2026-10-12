import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/lib/api', () => ({
    api: {
        excalidrawLibrary: {
            getManifest: vi.fn(async () => ({ ok: false })),
            saveManifest: vi.fn(async () => ({ ok: true })),
        },
    },
}));

import { ConfirmHost } from '../src/client/components/overlay';
import { ExcalidrawLibraryTree } from '../src/client/features/excalidraw/library/ExcalidrawLibraryTree';
import { useExcalidrawLibraryStore } from '../src/client/features/excalidraw/library/library-store';
import { LIBRARY_FOLDER_DRAG_TYPE, endFolderDrag } from '../src/client/features/excalidraw/library/library-folder-drag';
import type { ExcalidrawLibraryFolder, ExcalidrawLibraryItem } from '../src/client/features/excalidraw/library/types';
import { initI18n, t } from '../src/client/lib/i18n';
import { installTestGlobals } from '../src/client/lib/test-render';

const MANIFEST_KEY = 'inkstone_excalidraw_library_manifest_v2';

function folder(id: string, parentId: string | null, order: number): ExcalidrawLibraryFolder {
    return { id, name: id, parentId, order, createdAt: order + 1, updatedAt: 1 };
}

function stencil(id: string, folderId: string): ExcalidrawLibraryItem {
    return { id, folderId, name: id, elements: [{ id: `${id}-r`, type: 'rectangle', x: 0, y: 0, width: 8, height: 8 }], status: 'published', created: 1 };
}

/**
 * alpha · beta( gamma ) · delta
 *
 * Three roots and one branch: enough to tell "earlier" from "later", and the only shape where a folder
 * can be dragged at its own child and must not be reparented into it.
 */
function seed(): void {
    useExcalidrawLibraryStore.setState({
        folders: [folder('alpha', null, 0), folder('beta', null, 1), folder('delta', null, 2), folder('gamma', 'beta', 0)],
        items: [stencil('s-1', 'alpha'), stencil('s-2', 'gamma')],
        activeFolderId: null,
        expandedFolderIds: ['alpha', 'beta'],
        searchQuery: '',
    });
}

function rowOf(id: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-library-folder="${id}"]`);
    if (!found)
        throw new Error(`missing folder row ${id}`);
    return found;
}

function drag(type: string, bag: Map<string, string>, clientY = 0): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: {
            getData: (key: string) => bag.get(key) ?? '',
            setData: (key: string, value: string) => {
                bag.set(key, value);
            },
            dropEffect: 'none',
            effectAllowed: 'unset',
            types: [...bag.keys()],
        },
    });
    Object.defineProperty(event, 'clientY', { value: clientY });
    Object.defineProperty(event, 'relatedTarget', { value: null });
    return event;
}

function menuRows(): HTMLButtonElement[] {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    return menu ? [...menu.querySelectorAll<HTMLButtonElement>('button')] : [];
}

function rowByLabel(label: string): HTMLButtonElement {
    const found = menuRows().find((button) => button.textContent === label);
    if (!found)
        throw new Error(`missing menu row ${label}`);
    return found;
}

function submenuRows(label: string): HTMLButtonElement[] {
    const panel = [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => element.getAttribute('aria-label') === label);
    if (!panel)
        throw new Error(`missing submenu ${label}`);
    return [...panel.querySelectorAll<HTMLButtonElement>('button')];
}

function hover(element: HTMLElement): void {
    act(() => {
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    });
}

function press(element: HTMLElement): void {
    act(() => {
        element.click();
    });
}

function contextMenu(element: HTMLElement): Event {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 40 });
    act(() => {
        element.dispatchEvent(event);
    });
    return event;
}

const order = (): string[] =>
    useExcalidrawLibraryStore
        .getState()
        .folders.filter((f) => f.parentId === null)
        .sort((a, b) => a.order - b.order)
        .map((f) => f.id);

const parentOf = (id: string): string | null => useExcalidrawLibraryStore.getState().folders.find((f) => f.id === id)?.parentId ?? null;

const stored = (): ExcalidrawLibraryFolder[] => JSON.parse(String(localStorage.getItem(MANIFEST_KEY))).folders as ExcalidrawLibraryFolder[];

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
    localStorage.clear();
    // A drag left in flight by a previous test would make a foreign drop look like ours.
    endFolderDrag();
    installTestGlobals();
    await initI18n();
    seed();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
        root.render(createElement(Fragment, null,
            createElement(ExcalidrawLibraryTree, { api: null, lib: {} }),
            createElement(ConfirmHost)));
    });
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('the folder context menu', () => {
    it('replaces the browser menu with the panel’s own rows', () => {
        const event = contextMenu(rowOf('beta'));
        expect(event.defaultPrevented).toBe(true);
        const labels = menuRows().map((button) => button.textContent);
        expect(labels).toEqual([
            t('sidebar.rename'),
            t('sidebar.new_subfolder'),
            t('excalidraw.collapse'),
            t('folders.move_to'),
            t('folders.group_arrange'),
            t('excalidraw.export_folder'),
            t('excalidraw.import_into_folder'),
            t('sidebar.delete_folder'),
        ]);
        expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(t('excalidraw.folder_actions_value0', { value0: 'beta' }));
    });

    it('opens the same menu from the row’s own button, the keyboard and touch route', () => {
        const trigger = rowOf('beta').querySelector<HTMLButtonElement>(`button[aria-label="${t('common.more_actions')}"]`);
        if (!trigger)
            throw new Error('missing the row’s menu button');
        expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        press(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(menuRows().map((button) => button.textContent)).toContain(t('folders.move_to'));
    });

    it('names the empty folder’s row expand rather than offering a collapse it cannot do', () => {
        const event = contextMenu(rowOf('delta'));
        expect(event.defaultPrevented).toBe(true);
        expect(menuRows().map((button) => button.textContent)).toContain(t('excalidraw.expand'));
        expect(menuRows().map((button) => button.textContent)).not.toContain(t('excalidraw.collapse'));
        expect(rowByLabel(t('excalidraw.expand')).disabled).toBe(true);
    });

    it('reorders through the arrange submenu and writes the manifest once', () => {
        contextMenu(rowOf('delta'));
        hover(rowByLabel(t('folders.group_arrange')));
        press(submenuRows(t('folders.group_arrange')).find((button) => button.textContent === t('sidebar.move_earlier'))!);
        expect(order()).toEqual(['alpha', 'delta', 'beta']);
        expect(stored().find((f) => f.id === 'delta')?.order).toBe(1);
        expect(useExcalidrawLibraryStore.getState().folders.find((f) => f.id === 'beta')?.order).toBe(2);
    });

    it('disables the rows that have nowhere to go', () => {
        contextMenu(rowOf('alpha'));
        hover(rowByLabel(t('folders.group_arrange')));
        const rows = submenuRows(t('folders.group_arrange'));
        expect(rows.find((button) => button.textContent === t('sidebar.move_earlier'))?.disabled).toBe(true);
        expect(rows.find((button) => button.textContent === t('sidebar.move_out_one_level'))?.disabled).toBe(true);
        expect(rows.find((button) => button.textContent === t('sidebar.move_later'))?.disabled).toBe(false);
    });

    it('moves a folder into another one from the picker and expands it', () => {
        contextMenu(rowOf('delta'));
        hover(rowByLabel(t('folders.move_to')));
        const picker = [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => element.getAttribute('aria-label') === t('folders.move_to'));
        if (!picker)
            throw new Error('missing move picker');
        press([...picker.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('beta'))!);
        expect(parentOf('delta')).toBe('beta');
        expect(useExcalidrawLibraryStore.getState().expandedFolderIds).toContain('beta');
        expect(stored().find((f) => f.id === 'delta')?.parentId).toBe('beta');
    });

    it('asks before deleting, and only removes the subtree on the confirming answer', async () => {
        const dialogButton = (label: string) =>
            [...(document.querySelector<HTMLElement>('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
                .find((button) => button.textContent === label);

        contextMenu(rowOf('beta'));
        press(rowByLabel(t('sidebar.delete_folder')));
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog?.textContent).toContain(t('excalidraw.delete_library_folder_value0', { value0: 'beta' }));
        // beta holds no stencil of its own, but gamma holds one and is itself a subfolder going with it.
        expect(dialog?.textContent).toContain(t('excalidraw.delete_library_folder_contents', { value0: 1, value1: 1 }));
        expect(parentOf('beta')).toBeNull();

        await act(async () => {
            dialogButton(t('common.cancel'))?.click();
            await Promise.resolve();
        });
        expect(useExcalidrawLibraryStore.getState().folders.map((f) => f.id)).toContain('beta');

        contextMenu(rowOf('beta'));
        press(rowByLabel(t('sidebar.delete_folder')));
        await act(async () => {
            dialogButton(t('common.delete'))?.click();
            await Promise.resolve();
        });
        const left = useExcalidrawLibraryStore.getState().folders.map((f) => f.id);
        expect(left).not.toContain('beta');
        expect(left).not.toContain('gamma');
        expect(useExcalidrawLibraryStore.getState().items.map((item) => item.id)).toEqual(['s-1']);
    });

    /**
     * The engine closes its library sidebar on a pointer down outside the panel, and the confirmation
     * dialog lives on the body - so answering it used to leave the user on a bare canvas. The panel has
     * to be asked back whichever button they pressed.
     */
    async function deleteWithEngineSidebar(openSidebar: unknown) {
        const updateScene = vi.fn();
        const api = { getAppState: () => ({ openSidebar }), updateScene };
        await act(async () => {
            root.render(createElement(Fragment, null,
                createElement(ExcalidrawLibraryTree, { api, lib: {} }),
                createElement(ConfirmHost)));
        });
        contextMenu(rowOf('beta'));
        press(rowByLabel(t('sidebar.delete_folder')));
        await act(async () => {
            const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
            const cancel = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
                .find((button) => button.textContent === t('common.cancel'));
            cancel?.click();
            await Promise.resolve();
        });
        return updateScene;
    }

    it('reopens the engine library panel after a dialog answered with the sidebar closed', async () => {
        const updateScene = await deleteWithEngineSidebar(null);
        expect(updateScene).toHaveBeenCalledWith({ appState: { openSidebar: { name: 'default', tab: 'library' } } });
        expect(useExcalidrawLibraryStore.getState().folders.map((f) => f.id)).toContain('beta');
    });

    it('leaves the engine alone when the panel is still open', async () => {
        const updateScene = await deleteWithEngineSidebar({ name: 'default', tab: 'library' });
        expect(updateScene).not.toHaveBeenCalled();
    });

    it('gives the top level its own menu without the rows that need a folder', () => {        const top = container.querySelector<HTMLElement>('[data-library-folder-root]');
        if (!top)
            throw new Error('missing top level row');
        contextMenu(top);
        const labels = menuRows().map((button) => button.textContent);
        expect(labels).toEqual([
            t('excalidraw.new_folder'),
            t('excalidraw.import_from_file'),
            t('excalidraw.export_library'),
            t('folders.group_arrange'),
        ]);
    });
});

describe('dragging folders in the library tree', () => {
    function key(element: HTMLElement, name: string): void {
        act(() => {
            element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
        });
    }

    it('is a drag source, except for the row being edited', () => {
        expect(rowOf('beta').draggable).toBe(true);

        contextMenu(rowOf('beta'));
        press(rowByLabel(t('sidebar.rename')));
        const field = rowOf('beta').querySelector<HTMLInputElement>('input[type="text"]');
        expect(field).toBeTruthy();
        // A drag begun from a caret would take the row instead of the text, so editing wins.
        expect(rowOf('beta').draggable).toBe(false);
        key(field!, 'Escape');
        expect(rowOf('beta').draggable).toBe(true);

        contextMenu(rowOf('alpha'));
        press(rowByLabel(t('sidebar.new_subfolder')));
        expect(rowOf('alpha').draggable).toBe(false);
        expect(rowOf('beta').draggable).toBe(true);
    });

    it('hands the keyboard to the field the menu opened', () => {
        contextMenu(rowOf('beta'));
        press(rowByLabel(t('sidebar.rename')));
        const field = rowOf('beta').querySelector<HTMLInputElement>('input[type="text"]');
        expect(field).toBeTruthy();
        // The menu restores focus to whatever it took it from when it closes, and that happens after
        // the field mounts - so without an explicit focus the row shows a box that swallows typing.
        expect(document.activeElement).toBe(field);
        expect(field?.selectionStart).toBe(0);
        expect(field?.selectionEnd).toBe('beta'.length);

        contextMenu(rowOf('alpha'));
        press(rowByLabel(t('sidebar.new_subfolder')));
        // The draft row is a sibling under the folder's wrapper, not inside the row itself.
        const draft = container.querySelector<HTMLInputElement>('input[placeholder="' + t('sidebar.new_subfolder') + '"]');
        expect(draft).toBeTruthy();
        expect(document.activeElement).toBe(draft);
    });

    it('paints the quick actions where nothing ever hovers', async () => {
        // A bare `opacity-100` token, not the substring: `group-hover:opacity-100` carries it too, and
        // matching that would say the toolbar is painted on a phone when it is still waiting for hover.
        const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);
        const toolbar = () => rowOf('beta').querySelector('div[class*="group-hover:opacity-100"]');
        const rootTrigger = () => container.querySelector('[data-library-folder-root] button[aria-label="' + t('common.more_actions') + '"]');
        const realMatchMedia = window.matchMedia;
        try {
            expect(classes(toolbar())).not.toContain('opacity-100');
            expect(classes(rootTrigger())).not.toContain('opacity-100');
            window.matchMedia = ((query: string) => ({
                matches: query === '(hover: none)',
                media: query,
                onchange: null,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                dispatchEvent: () => false,
            })) as unknown as typeof window.matchMedia;
            // A fresh mount: the hook reads the media query when the row is created, so re-rendering
            // the same tree would keep answering with the value it saw the first time.
            await act(async () => {
                root.unmount();
            });
            container = document.createElement('div');
            document.body.append(container);
            root = createRoot(container);
            await act(async () => {
                root.render(createElement(Fragment, null,
                    createElement(ExcalidrawLibraryTree, { api: null, lib: {} }),
                    createElement(ConfirmHost)));
            });
            expect(classes(toolbar())).toContain('opacity-100');
            expect(classes(rootTrigger())).toContain('opacity-100');
        } finally {
            window.matchMedia = realMatchMedia;
        }
    });

    it('reparents onto the row the folder is dropped in the middle of', () => {
        const bag = new Map<string, string>();
        act(() => {
            rowOf('delta').dispatchEvent(drag('dragstart', bag));
        });
        expect(bag.get(LIBRARY_FOLDER_DRAG_TYPE)).toBe('delta');
        const over = drag('dragover', bag);
        act(() => {
            rowOf('beta').dispatchEvent(over);
        });
        expect(over.defaultPrevented).toBe(true);
        expect(rowOf('beta').className).toContain('ring-[var(--accent)]');
        act(() => {
            rowOf('beta').dispatchEvent(drag('drop', bag));
        });
        expect(parentOf('delta')).toBe('beta');
        expect(stored().find((f) => f.id === 'delta')?.parentId).toBe('beta');
    });

    it('refuses a folder’s own row and its own subtree, and leaves the tree alone', () => {
        const bag = new Map<string, string>();
        act(() => {
            rowOf('beta').dispatchEvent(drag('dragstart', bag));
        });
        for (const id of ['beta', 'gamma']) {
            const over = drag('dragover', bag);
            act(() => {
                rowOf(id).dispatchEvent(over);
            });
            expect(over.defaultPrevented, id).toBe(false);
            act(() => {
                rowOf(id).dispatchEvent(drag('drop', bag));
            });
        }
        expect(parentOf('beta')).toBeNull();
        expect(rowOf('gamma').className).not.toContain('ring-[var(--accent)]');
    });

    it('sends a drop on the top level row to the end of the root list', () => {
        const bag = new Map<string, string>();
        act(() => {
            rowOf('alpha').dispatchEvent(drag('dragstart', bag));
        });
        const top = container.querySelector<HTMLElement>('[data-library-folder-root]')!;
        act(() => {
            top.dispatchEvent(drag('drop', bag));
        });
        expect(parentOf('alpha')).toBeNull();
        expect(order()).toEqual(['beta', 'delta', 'alpha']);
    });

    it('ignores a drag that is not a folder, so a stencil tile can still leave for the canvas', () => {
        const bag = new Map([['application/vnd.excalidrawlib.elements', '[]']]);
        const over = drag('dragover', bag);
        act(() => {
            rowOf('beta').dispatchEvent(over);
        });
        expect(over.defaultPrevented).toBe(false);
    });
});
