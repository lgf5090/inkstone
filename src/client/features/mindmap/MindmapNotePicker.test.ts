import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spied rather than replaced: the folder path is what the list shows under each title, and how
// many times it is asked for is the whole point of the tests below.
vi.mock('../../lib/folders', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/folders')>();
    return { ...actual, folderPathLabel: vi.fn(actual.folderPathLabel) };
});

import type { NoteSummary } from '@shared/types';
import { folderPathLabel } from '../../lib/folders';
import { initI18n } from '../../lib/i18n';
import { useNotes } from '../../store/notes';
import { MindmapNotePicker } from './MindmapNotePicker';

const pathCalls = () => (folderPathLabel as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

/** Only the fields this list reads; the store's shape is wider and is not what is under test. */
function note(id: string, title: string, folderId: string | null = null): NoteSummary {
    return { id, title, folderId, deletedAt: null, isArchived: false } as unknown as NoteSummary;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: ReactNode) {
    act(() => {
        root.render(node);
    });
}

/** The rows the list drew, as the reader sees them: a title and the folder under it. */
function drawnRows(): Array<{ title: string, path: string }> {
    // The drawer portals itself to the body, so the test's own container is the wrong place
    // to look for what it rendered. A row is the only button in it that carries a title, which
    // is what tells it apart from the panel's own close control.
    const rows: Array<{ title: string, path: string }> = [];
    for (const button of Array.from(document.querySelectorAll('[data-surface="drawer"] button'))) {
        // The two lines live inside a wrapper span, so they are picked up by a nested query.
        const lines = Array.from(button.querySelectorAll('span.truncate')).map((span) => span.textContent ?? '');
        if (lines.length === 0)
            continue;
        rows.push({ title: lines[0] ?? '', path: lines.length > 1 ? lines[lines.length - 1]! : '' });
    }
    return rows;
}

function searchBox(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('[data-surface="drawer"] input');
    if (!input)
        throw new Error('the drawer did not render its search box');
    return input;
}

/** React owns the input's value, so a test has to write it the way a keyboard does. */
function type(value: string): void {
    const input = searchBox();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(async () => {
    await initI18n();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    (folderPathLabel as unknown as ReturnType<typeof vi.fn>).mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useNotes.setState({
        folders: [
            { id: 'f-root', name: 'Reading', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 } as never,
            { id: 'f-child', name: '2026', parentId: 'f-root', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 } as never,
        ],
        notes: {
            'n-b': note('n-b', 'Beta book'),
            'n-a': note('n-a', 'Alpha', 'f-child'),
            'n-gone': { ...note('n-gone', 'Deleted'), deletedAt: Date.now() },
            'n-shelf': { ...note('n-shelf', 'Archived too'), isArchived: true },
            'n-self': note('n-self', 'The map itself'),
        },
    });
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
});

describe('MindmapNotePicker', () => {
    it('lists what a map may point at, by name, with the folder that tells the two apart', () => {
        render(createElement(MindmapNotePicker, { open: true, title: 'Link to a note', excludeNoteId: 'n-self', onClose: () => {}, onSelect: () => {} }));
        expect(drawnRows()).toEqual([
            { title: 'Alpha', path: 'Reading / 2026' },
            { title: 'Beta book', path: '' },
        ]);
    });

    it('filters as the reader types, and says so when nothing matches', () => {
        render(createElement(MindmapNotePicker, { open: true, title: 'Link to a note', onClose: () => {}, onSelect: () => {} }));
        expect(drawnRows().map((row) => row.title)).toEqual(['Alpha', 'Beta book', 'The map itself']);
        type('bet');
        expect(drawnRows().map((row) => row.title)).toEqual(['Beta book']);
        type('zzz');
        expect(drawnRows()).toEqual([]);
        expect(document.querySelector('[data-surface="drawer"]')?.textContent).toContain('No matching');
    });

    // The cost this guards: the list was walked, its folder chains rebuilt and its names sorted
    // on every character, which on a large vault is the delay a reader feels as typing lag.
    it('walks the vault once per opening, not once per keystroke', () => {
        render(createElement(MindmapNotePicker, { open: true, title: 'Link to a note', onClose: () => {}, onSelect: () => {} }));
        const afterOpen = pathCalls();
        expect(afterOpen).toBe(3);
        type('a');
        type('al');
        type('alp');
        expect(pathCalls(), 'three keystrokes must not cost three walks').toBe(afterOpen);
        expect(drawnRows().map((row) => row.title)).toEqual(['Alpha']);
    });

    it('walks nothing at all while the list is closed', () => {
        render(createElement(MindmapNotePicker, { open: false, title: 'Link to a note', onClose: () => {}, onSelect: () => {} }));
        expect(pathCalls()).toBe(0);
        expect(drawnRows()).toEqual([]);
    });

    it('hands the caller the note that was picked, and closes', () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        render(createElement(MindmapNotePicker, { open: true, title: 'Import a note outline', onSelect, onClose }));
        const rows = Array.from(document.querySelectorAll('[data-surface="drawer"] button'));
        const row = rows.find((button) => button.textContent?.includes('Beta book'))!;
        act(() => {
            row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onSelect).toHaveBeenCalledWith({ id: 'n-b', title: 'Beta book' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('opens on the characters that called it, and on nothing when the menu did', () => {
        render(createElement(MindmapNotePicker, { open: false, title: 'Link to a note', onClose: () => {}, onSelect: () => {} }));
        render(createElement(MindmapNotePicker, { open: true, title: 'Link to a note', initialQuery: 'bet', onClose: () => {}, onSelect: () => {} }));
        expect(searchBox().value).toBe('bet');
        expect(drawnRows().map((row) => row.title)).toEqual(['Beta book']);
        render(createElement(MindmapNotePicker, { open: true, title: 'Link to a note', initialQuery: '', onClose: () => {}, onSelect: () => {} }));
        expect(searchBox().value, 'a list opened from the menu has no query to carry in').toBe('');
        expect(drawnRows().length).toBe(3);
    });
});
