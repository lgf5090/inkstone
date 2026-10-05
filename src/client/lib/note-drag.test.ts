import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary } from '@shared/types';
import type { DragEvent } from 'react';
import {
    NOTE_DRAG_TYPE,
    NOTES_DRAG_TYPE,
    isNoteDrag,
    leftDropTarget,
    moveNotesToFolder,
    parseNoteIds,
    readDraggedNoteIds,
    restoreNoteFolders,
    writeNoteDrag,
} from './note-drag';
import { useNotes } from '../store/notes';

function dragEvent(payload: { types?: string[]; data?: Map<string, string> } = {}): {
    event: DragEvent<HTMLElement>;
    data: Map<string, string>;
} {
    const bag = payload.data ?? new Map<string, string>();
    const types = payload.types ?? [...bag.keys()];
    const event = {
        dataTransfer: {
            types,
            getData: (format: string) => bag.get(format) ?? '',
            setData: (format: string, value: string) => {
                bag.set(format, value);
                if (!types.includes(format))
                    types.push(format);
            },
            effectAllowed: '',
        },
    };
    return { event: event as unknown as DragEvent<HTMLElement>, data: bag };
}

function note(id: string, folderId: string | null): NoteSummary {
    return {
        id, title: id, excerpt: '', folderId, tags: [], isPinned: false, isStarred: false,
        isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
    };
}

describe('drag payloads', () => {
    it('writes a single id under the single-note type', () => {
        const { event, data } = dragEvent();
        writeNoteDrag(event, ['a']);
        expect(data.get(NOTE_DRAG_TYPE)).toBe('a');
        expect(data.has(NOTES_DRAG_TYPE)).toBe(false);
    });

    it('adds the multi-note type only when more than one note is dragged', () => {
        const { event, data } = dragEvent();
        writeNoteDrag(event, ['a', 'b', 'c']);
        expect(data.get(NOTE_DRAG_TYPE)).toBe('a');
        expect(parseNoteIds(data.get(NOTES_DRAG_TYPE) ?? '')).toEqual(['a', 'b', 'c']);
    });

    it('writes nothing for an empty selection', () => {
        const { event, data } = dragEvent();
        writeNoteDrag(event, []);
        expect(data.size).toBe(0);
    });

    it('prefers the multi payload and falls back to the single one', () => {
        const both = new Map([[NOTE_DRAG_TYPE, 'a'], [NOTES_DRAG_TYPE, JSON.stringify(['a', 'b'])]]);
        expect(readDraggedNoteIds(dragEvent({ data: both }).event)).toEqual(['a', 'b']);
        const single = new Map([[NOTE_DRAG_TYPE, 'a']]);
        expect(readDraggedNoteIds(dragEvent({ data: single }).event)).toEqual(['a']);
    });

    it('ignores a corrupt multi payload instead of throwing', () => {
        const broken = new Map([[NOTE_DRAG_TYPE, 'a'], [NOTES_DRAG_TYPE, '{oops'],]);
        expect(readDraggedNoteIds(dragEvent({ data: broken }).event)).toEqual(['a']);
        expect(parseNoteIds('{"a":1}')).toEqual([]);
        expect(parseNoteIds(JSON.stringify(['a', 3, '']))).toEqual(['a']);
    });

    it('recognises a note drag from either type', () => {
        expect(isNoteDrag(dragEvent({ types: [NOTES_DRAG_TYPE] }).event)).toBe(true);
        expect(isNoteDrag(dragEvent({ types: [NOTE_DRAG_TYPE] }).event)).toBe(true);
        expect(isNoteDrag(dragEvent({ types: ['text/plain'] }).event)).toBe(false);
    });
});

describe('leftDropTarget', () => {
    it('treats a null or outside related target as leaving', () => {
        const currentTarget = document.createElement('div');
        expect(leftDropTarget({ currentTarget, relatedTarget: null } as unknown as React.DragEvent<HTMLElement>)).toBe(true);
        const inside = document.createElement('span');
        currentTarget.append(inside);
        expect(leftDropTarget({ currentTarget, relatedTarget: inside } as unknown as React.DragEvent<HTMLElement>)).toBe(false);
        expect(leftDropTarget({ currentTarget, relatedTarget: document.createElement('b') } as unknown as React.DragEvent<HTMLElement>)).toBe(true);
    });
});

describe('bulk folder moves', () => {
    beforeEach(() => {
        useNotes.setState({
            notes: {
                a: note('a', 'old'),
                b: note('b', null),
                gone: { ...note('gone', 'old'), deletedAt: 5 },
            },
        });
    });

    it('patches only the notes that actually change and reports the previous homes', async () => {
        const patchNote = vi.fn(async (_id: string, _patch: { folderId?: string | null }) => {});
        useNotes.setState({ patchNote });
        const previous = await moveNotesToFolder(['a', 'b', 'missing', 'gone'], 'target');
        expect(previous).toEqual([{ id: 'a', folderId: 'old' }, { id: 'b', folderId: null }]);
        expect(patchNote.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
        expect(patchNote).toHaveBeenCalledWith('a', { folderId: 'target' });
    });

    it('skips notes already in the destination folder', async () => {
        const patchNote = vi.fn(async () => {});
        useNotes.setState({ patchNote });
        const previous = await moveNotesToFolder(['a'], 'old');
        expect(previous).toEqual([]);
        expect(patchNote).not.toHaveBeenCalled();
    });

    it('restores every recorded home', async () => {
        const patchNote = vi.fn(async () => {});
        useNotes.setState({ patchNote });
        const previous = await moveNotesToFolder(['a', 'b'], 'target');
        patchNote.mockClear();
        await restoreNoteFolders(previous);
        expect(patchNote).toHaveBeenNthCalledWith(1, 'a', { folderId: 'old' });
        expect(patchNote).toHaveBeenNthCalledWith(2, 'b', { folderId: null });
    });
});
