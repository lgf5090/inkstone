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
import type { ExcalidrawLibraryFolder, ExcalidrawLibraryItem } from '../src/client/features/excalidraw/library/types';
import { initI18n, t } from '../src/client/lib/i18n';
import { installTestGlobals } from '../src/client/lib/test-render';

function folder(id: string, order: number, parentId: string | null = null): ExcalidrawLibraryFolder {
    return { id, name: id, parentId, order, createdAt: order + 1, updatedAt: 1 };
}

function stencil(id: string, folderId: string | null): ExcalidrawLibraryItem {
    return { id, folderId, name: id, elements: [{ id: `${id}-r`, type: 'rectangle', x: 0, y: 0, width: 8, height: 8 }], status: 'published', created: 1 };
}

let root: Root;
let container: HTMLDivElement;
let updateScene: ReturnType<typeof vi.fn>;

/** The engine surface a click-to-insert writes through: the panel only ever reads state and calls
 * `updateScene`, so one stub covers the whole insert path without a canvas. */
function engineApi() {
    updateScene = vi.fn();
    return {
        getAppState: () => ({ zoom: { value: 1 }, scrollX: 0, scrollY: 0, width: 800, height: 600 }),
        getSceneElements: () => [],
        updateScene,
    };
}

function press(element: HTMLElement): void {
    act(() => {
        element.click();
    });
}

function tileOf(id: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>(`button[title="${t('excalidraw.click_to_insert')}"]`)]
        .find((button) => button.textContent?.includes(id));
    if (!found)
        throw new Error(`missing stencil tile ${id}`);
    return found;
}

async function renderTree(seed: { folders?: ExcalidrawLibraryFolder[]; items?: ExcalidrawLibraryItem[]; expanded?: string[] }): Promise<void> {
    useExcalidrawLibraryStore.setState({
        folders: seed.folders ?? [],
        items: seed.items ?? [],
        activeFolderId: null,
        expandedFolderIds: seed.expanded ?? (seed.folders ?? []).map((entry) => entry.id),
        searchQuery: '',
    });
    await act(async () => {
        root.render(createElement(Fragment, null,
            createElement(ExcalidrawLibraryTree, { api: engineApi(), lib: {} }),
            createElement(ConfirmHost)));
    });
}

/** `alpha · aleph( alpha ) · beta · gamma( beta ) · delta`, with alpha's branch closed. */
const BRANCH: ExcalidrawLibraryFolder[] = [
    folder('alpha', 0),
    folder('aleph', 0, 'alpha'),
    folder('beta', 1),
    folder('gamma', 0, 'beta'),
    folder('delta', 2),
];

function rowButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button[data-tree-row]')];
}

function namedRow(name: string): HTMLButtonElement {
    const found = rowButtons().find((row) => row.getAttribute('aria-label') === name);
    if (!found)
        throw new Error(`missing tree row ${name}`);
    return found;
}

async function key(element: HTMLElement, name: string): Promise<void> {
    await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
    // A fold mounts its branch on the commit and reveals it one tick later, so the tick that makes a
    // newly opened row landable is the one after React's effects have run; this waits for it.
    await act(async () => {
        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
        });
    });
}

beforeEach(async () => {
    localStorage.clear();
    installTestGlobals();
    await initI18n();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('activating a stencil tile', () => {
    /**
     * SH-110 rule one: the insert was a `div onClick`, so the one action the library offers was
     * unreachable without a pointer. The element it sits on now is a `button`, which is what makes
     * Enter and Space mean the same thing the mouse does — jsdom fires no click from a keydown, so
     * these tests read the element's own contract plus its activation, and the browser gate covers
     * the rest: focus the first tile with Tab, press Enter, then Space, and the scene gains the
     * rectangle either way with the new element left selected.
     */
    it('puts the insert on a real button the keyboard can focus', async () => {
        await renderTree({ items: [stencil('s-1', null)] });
        const tile = tileOf('s-1');
        expect(tile.tagName).toBe('BUTTON');
        expect(tile.getAttribute('type')).toBe('button');
        expect(tile.hasAttribute('role')).toBe(false);
        // A negative tabIndex is how a "reachable" control usually turns out not to be.
        expect(tile.tabIndex).toBeGreaterThanOrEqual(0);
        act(() => {
            tile.focus();
        });
        expect(document.activeElement).toBe(tile);
    });

    it('inserts the stencil when the tile is activated', async () => {
        await renderTree({ items: [stencil('s-1', null)] });
        press(tileOf('s-1'));
        expect(updateScene).toHaveBeenCalledTimes(1);
        const scene = updateScene.mock.calls[0]?.[0] as { elements: any[]; appState: { selectedElementIds: Record<string, boolean> } };
        expect(scene.elements).toHaveLength(1);
        expect(scene.elements[0].type).toBe('rectangle');
        expect(Object.keys(scene.appState.selectedElementIds)).toHaveLength(1);
    });

    it('keeps the card itself the drag source the canvas reads', async () => {
        await renderTree({ items: [stencil('s-1', null)] });
        const card = tileOf('s-1').closest<HTMLElement>('div[draggable]');
        expect(card).not.toBeNull();
        const bag = new Map<string, string>();
        const event = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: {
                getData: (key: string) => bag.get(key) ?? '',
                setData: (key: string, value: string) => {
                    bag.set(key, value);
                },
                types: [...bag.keys()],
            },
        });
        act(() => {
            card!.dispatchEvent(event);
        });
        expect(JSON.parse(bag.get('application/vnd.excalidrawlib.elements') ?? 'null')).toHaveLength(1);
    });

    it('keeps the rename field out of the button, so typing does not insert', async () => {
        await renderTree({ items: [stencil('s-1', null)] });
        press(container.querySelector<HTMLButtonElement>(`button[title="${t('excalidraw.rename_item')}"]`)!);
        const field = container.querySelector<HTMLInputElement>('input[type="text"]');
        expect(field).toBeTruthy();
        // Interactive content inside a button is not merely invalid - the keystrokes would reach the
        // tile that activates, so the field replaces the button's label instead of nesting in it.
        expect(field?.closest('button')).toBeNull();
        expect(updateScene).not.toHaveBeenCalled();
        act(() => {
            field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        // Enter commits the name and closes the field; nothing of it belongs to the scene.
        expect(container.querySelector('input[type="text"]')).toBeNull();
        expect(updateScene).not.toHaveBeenCalled();
    });
});

describe('the folder tree’s keyboard', () => {
    /** The fold control that belongs to one row, found the way `lib/tree/keyboard` finds it. */
    function toggleOf(name: string): HTMLButtonElement | undefined {
        return namedRow(name)
            .closest<HTMLElement>('[role="treeitem"]')
            ?.querySelector<HTMLButtonElement>('[data-tree-toggle]');
    }

    it('gives every row the pair of attributes the shared keyboard walks', async () => {
        await renderTree({ folders: BRANCH, expanded: ['beta'] });
        expect(rowButtons().map((row) => row.getAttribute('aria-label'))).toEqual(['alpha', 'beta', 'gamma', 'delta']);
        expect(namedRow('alpha').hasAttribute('data-tree-row')).toBe(true);
        expect(toggleOf('alpha')?.disabled).toBe(false);
        expect(toggleOf('alpha')?.getAttribute('aria-expanded')).toBe('false');
        expect(toggleOf('beta')?.getAttribute('aria-expanded')).toBe('true');
        // A leaf offers no fold: an invisible control still in the tab order is a stop the reader
        // cannot see and cannot leave.
        expect(toggleOf('delta')?.disabled).toBe(true);
        expect(toggleOf('delta')?.getAttribute('aria-hidden')).toBe('true');
        expect(toggleOf('delta')?.getAttribute('tabindex')).toBe('-1');
    });

    it('walks the visible rows with the arrows, wraps at each end and jumps with Home and End', async () => {
        await renderTree({ folders: BRANCH, expanded: ['beta'] });
        await key(namedRow('alpha'), 'ArrowDown');
        expect(document.activeElement).toBe(namedRow('beta'));
        await key(namedRow('beta'), 'ArrowDown');
        expect(document.activeElement).toBe(namedRow('gamma'));
        await key(namedRow('gamma'), 'ArrowUp');
        expect(document.activeElement).toBe(namedRow('beta'));
        // gamma sits under beta, and the walk is over the rows a reader can see, not the model order.
        await key(namedRow('delta'), 'ArrowDown');
        expect(document.activeElement).toBe(namedRow('alpha'));
        await key(namedRow('alpha'), 'End');
        expect(document.activeElement).toBe(namedRow('delta'));
        await key(namedRow('delta'), 'Home');
        expect(document.activeElement).toBe(namedRow('alpha'));
    });

    it('opens a closed branch with ArrowRight and steps into it', async () => {
        await renderTree({ folders: BRANCH, expanded: ['beta'] });
        expect(container.querySelector('[data-library-folder="aleph"]')).toBeNull();
        await key(namedRow('alpha'), 'ArrowRight');
        expect(useExcalidrawLibraryStore.getState().expandedFolderIds).toContain('alpha');
        // The walk refuses a row whose branch is still `inert`, so a branch the key just opened has to
        // be revealed before the next key can land on it.
        expect(container.querySelector('[data-library-folder="aleph"]')).toBeTruthy();
        expect(namedRow('aleph').closest('[role="group"]')?.hasAttribute('inert')).toBe(false);
        await key(namedRow('alpha'), 'ArrowRight');
        expect(document.activeElement).toBe(namedRow('aleph'));
        await key(namedRow('aleph'), 'ArrowLeft');
        expect(document.activeElement).toBe(namedRow('alpha'));
    });

    it('closes the branch ArrowLeft is standing on and takes the walk past it', async () => {
        await renderTree({ folders: BRANCH, expanded: ['beta'] });
        await key(namedRow('gamma'), 'ArrowLeft');
        expect(document.activeElement).toBe(namedRow('beta'));
        await key(namedRow('beta'), 'ArrowLeft');
        expect(useExcalidrawLibraryStore.getState().expandedFolderIds).not.toContain('beta');
        // The collapsed branch is still in the DOM while it folds, held out of the way by `inert`
        // rather than unmounted — which is exactly what a screen reader and this walk both skip.
        expect(namedRow('gamma').closest('[role="group"]')?.hasAttribute('inert')).toBe(true);
        await key(namedRow('beta'), 'ArrowDown');
        expect(document.activeElement).toBe(namedRow('delta'));
    });

    it('answers the row’s own shortcuts the toolbar already offers', async () => {
        await renderTree({ folders: BRANCH, expanded: ['beta'] });
        await key(namedRow('alpha'), 'F2');
        const field = container.querySelector<HTMLInputElement>(`input[aria-label="${t('sidebar.rename')}"]`);
        expect(field).toBeTruthy();
        expect(document.activeElement).toBe(field);
    });
});


