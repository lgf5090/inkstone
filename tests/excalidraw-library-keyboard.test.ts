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

function folder(id: string, order: number): ExcalidrawLibraryFolder {
    return { id, name: id, parentId: null, order, createdAt: order + 1, updatedAt: 1 };
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

async function renderTree(seed: { folders?: ExcalidrawLibraryFolder[]; items?: ExcalidrawLibraryItem[] }): Promise<void> {
    useExcalidrawLibraryStore.setState({
        folders: seed.folders ?? [],
        items: seed.items ?? [],
        activeFolderId: null,
        expandedFolderIds: (seed.folders ?? []).map((entry) => entry.id),
        searchQuery: '',
    });
    await act(async () => {
        root.render(createElement(Fragment, null,
            createElement(ExcalidrawLibraryTree, { api: engineApi(), lib: {} }),
            createElement(ConfirmHost)));
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
