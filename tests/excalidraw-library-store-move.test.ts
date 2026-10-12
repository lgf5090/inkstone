import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/lib/api', () => ({
    api: {
        excalidrawLibrary: {
            getManifest: vi.fn(async () => ({ ok: false })),
            saveManifest: vi.fn(async () => ({ ok: true })),
        },
    },
}));

import { useExcalidrawLibraryStore } from '../src/client/features/excalidraw/library/library-store';
import type { ExcalidrawLibraryFolder } from '../src/client/features/excalidraw/library/types';

const MANIFEST_KEY = 'inkstone_excalidraw_library_manifest_v2';

function folder(id: string, parentId: string | null, order: number, updatedAt = 1): ExcalidrawLibraryFolder {
    return { id, name: id, parentId, order, createdAt: 1, updatedAt };
}

function state(folders: ExcalidrawLibraryFolder[]): void {
    useExcalidrawLibraryStore.setState({ folders, items: [], activeFolderId: null, expandedFolderIds: [] });
}

const read = (): ExcalidrawLibraryFolder[] => JSON.parse(String(localStorage.getItem(MANIFEST_KEY))).folders as ExcalidrawLibraryFolder[];

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('sorting a folder group by name', () => {
    it('rewrites the order of one level and leaves the other levels alone', () => {
        state([folder('zeta', null, 0), folder('alpha', null, 1), folder('mid', null, 2), folder('kid', 'zeta', 0)]);
        useExcalidrawLibraryStore.getState().sortFolders(null);
        const after = useExcalidrawLibraryStore.getState().folders;
        expect(after.filter((f) => f.parentId === null).sort((a, b) => a.order - b.order).map((f) => f.id)).toEqual(['alpha', 'mid', 'zeta']);
        expect(after.find((f) => f.id === 'kid')?.order).toBe(0);
        expect(read().find((f) => f.id === 'zeta')?.order).toBe(2);
    });

    it('sorts a child group when asked for its parent', () => {
        state([folder('p', null, 0), folder('q', 'p', 1), folder('r', 'p', 0)]);
        useExcalidrawLibraryStore.getState().sortFolders('p');
        const after = useExcalidrawLibraryStore.getState().folders.filter((f) => f.parentId === 'p').sort((a, b) => a.order - b.order);
        expect(after.map((f) => f.id)).toEqual(['q', 'r']);
    });

    it('does not touch the manifest when the level is already in order', () => {
        state([folder('a', null, 0, 7), folder('b', null, 1, 7)]);
        useExcalidrawLibraryStore.getState().sortFolders(null);
        expect(localStorage.getItem(MANIFEST_KEY)).toBeNull();
        expect(useExcalidrawLibraryStore.getState().folders.find((f) => f.id === 'a')?.updatedAt).toBe(7);
    });

    it('orders a mixed script level the way the locale reads it, not by code point', () => {
        state([folder('z-拉丁', null, 0), folder('a-中文', null, 1)]);
        useExcalidrawLibraryStore.getState().sortFolders(null);
        const after = useExcalidrawLibraryStore.getState().folders.filter((f) => f.parentId === null).sort((a, b) => a.order - b.order);
        expect(after[0]?.name).toBe('a-中文');
    });
});

describe('moving a folder through the store', () => {
    it('refuses to make a folder live inside itself', () => {
        state([folder('p', null, 0), folder('c', 'p', 0), folder('g', 'c', 0)]);
        useExcalidrawLibraryStore.getState().moveFolder('p', 'c');
        useExcalidrawLibraryStore.getState().moveFolder('p', 'g');
        expect(useExcalidrawLibraryStore.getState().folders.find((f) => f.id === 'p')?.parentId).toBeNull();
    });

    it('renumbers the destination level and keeps unrelated levels intact', () => {
        state([folder('a', null, 0), folder('b', null, 1), folder('c', null, 2), folder('x', 'a', 0)]);
        useExcalidrawLibraryStore.getState().moveFolder('c', null, 'a');
        const roots = useExcalidrawLibraryStore.getState().folders.filter((f) => f.parentId === null).sort((f1, f2) => f1.order - f2.order);
        expect(roots.map((f) => f.id)).toEqual(['c', 'a', 'b']);
        expect(useExcalidrawLibraryStore.getState().folders.find((f) => f.id === 'x')?.order).toBe(0);
    });
});
