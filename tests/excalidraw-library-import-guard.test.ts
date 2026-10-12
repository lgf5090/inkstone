import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/lib/api', () => ({
    api: {
        get: vi.fn(async () => ({ data: null })),
        put: vi.fn(async () => ({ data: {} })),
        post: vi.fn(async () => ({ data: {} })),
    },
}));

import { useExcalidrawLibraryStore } from '../src/client/features/excalidraw/library/library-store';
import { useUi } from '../src/client/store/ui';

function reset() {
    useExcalidrawLibraryStore.setState({ items: [], folders: [], activeFolderId: null, expandedFolderIds: [] });
}

const rectangle = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...extra,
});

describe('importing a stencil library', () => {
    it('drops embeddables and rewrites unsafe links before anything is stored', async () => {
        reset();
        const count = await useExcalidrawLibraryStore.getState().importFromLibraryData(
            {
                libraryItems: [
                    {
                        id: 'mixed',
                        name: 'Mixed',
                        elements: [
                            rectangle('keep'),
                            { id: 'frame', type: 'embeddable', x: 0, y: 0, width: 10, height: 10, link: 'https://evil.test' },
                            rectangle('bad-link', { link: 'javascript:alert(1)' }),
                        ],
                    },
                ],
            },
            null,
            'mixed.excalidrawlib',
        );

        expect(count).toBe(1);
        const stored = useExcalidrawLibraryStore.getState().items;
        expect(stored).toHaveLength(1);
        expect(stored[0].elements.map((e: any) => e.id)).toEqual(['keep', 'bad-link']);
        expect(stored[0].elements[1].link).toBeNull();
    });

    it('refuses an item that has nothing safe left in it, and says so', async () => {
        reset();
        const ui = useUi.getState() as any;
        const notices: any[] = [];
        const originalToast = ui.toast;
        ui.toast = (input: any) => { notices.push(input); };
        let count = 0;
        try {
            count = await useExcalidrawLibraryStore.getState().importFromLibraryData(
                { libraryItems: [{ id: 'only-bad', name: 'Only Bad', elements: [{ id: 'f', type: 'embeddable' }] }] },
                null,
                'only-bad.excalidrawlib',
            );
        } finally {
            ui.toast = originalToast;
        }

        expect(count).toBe(0);
        expect(useExcalidrawLibraryStore.getState().items).toEqual([]);
        expect(notices).toHaveLength(1);
        expect(notices[0].tone).toBe('danger');
    });

    it('stops at the byte budget instead of importing a whole megabyte of stencils', async () => {
        reset();
        const huge = Array.from({ length: 400 }, (_unused, i) => ({
            id: `bulk-${i}`,
            name: `bulk ${i}`,
            elements: [rectangle('r', { points: Array.from({ length: 4000 }, () => [0, 0]) })],
        }));
        const count = await useExcalidrawLibraryStore.getState().importFromLibraryData(
            { libraryItems: huge },
            null,
            'bulk.excalidrawlib',
        );

        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(huge.length);
    });

    it('caps how many stencils one file may contribute', async () => {
        reset();
        const many = Array.from({ length: 600 }, (_unused, i) => ({
            id: `n-${i}`,
            name: `n ${i}`,
            elements: [rectangle('r')],
        }));
        const count = await useExcalidrawLibraryStore.getState().importFromLibraryData(
            { libraryItems: many },
            null,
            'many.excalidrawlib',
        );

        expect(count).toBe(500);
        expect(useExcalidrawLibraryStore.getState().items).toHaveLength(500);
    });
});
