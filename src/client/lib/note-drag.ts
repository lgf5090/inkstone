import { useNotes } from '../store/notes';

export const NOTE_DRAG_TYPE = 'application/x-inkstone-note';
export const NOTES_DRAG_TYPE = 'application/x-inkstone-notes';
export const FOLDER_DRAG_TYPE = 'application/x-inkstone-folder';

export interface NoteFolderAssignment {
    id: string;
    folderId: string | null;
}

export function leftDropTarget(event: React.DragEvent<HTMLElement>): boolean {
    const next = event.relatedTarget;
    return !(next instanceof Node) || !event.currentTarget.contains(next);
}

export function dragTypes(event: React.DragEvent): string[] {
    return Array.from(event.dataTransfer.types);
}

export function isNoteDrag(event: React.DragEvent): boolean {
    const types = dragTypes(event);
    return types.includes(NOTE_DRAG_TYPE) || types.includes(NOTES_DRAG_TYPE);
}

export function parseNoteIds(value: string): string[] {
    if (!value)
        return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
            : [];
    }
    catch {
        return [];
    }
}

export function writeNoteDrag(event: React.DragEvent, noteIds: string[]): void {
    const ids = noteIds.filter(Boolean);
    if (ids.length === 0)
        return;
    event.dataTransfer.setData(NOTE_DRAG_TYPE, ids[0]);
    if (ids.length > 1)
        event.dataTransfer.setData(NOTES_DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
}

export function readDraggedNoteIds(event: React.DragEvent): string[] {
    const multi = parseNoteIds(event.dataTransfer.getData(NOTES_DRAG_TYPE));
    if (multi.length > 0)
        return multi;
    const single = event.dataTransfer.getData(NOTE_DRAG_TYPE);
    return single ? [single] : [];
}

export async function moveNotesToFolder(noteIds: string[], folderId: string | null): Promise<NoteFolderAssignment[]> {
    const notes = useNotes.getState().notes;
    const previous: NoteFolderAssignment[] = [];
    for (const id of noteIds) {
        const note = notes[id];
        if (!note || note.deletedAt || (note.folderId ?? null) === folderId)
            continue;
        previous.push({ id, folderId: note.folderId ?? null });
    }
    for (const assignment of previous)
        await useNotes.getState().patchNote(assignment.id, { folderId });
    return previous;
}

export async function restoreNoteFolders(assignments: NoteFolderAssignment[]): Promise<void> {
    for (const assignment of assignments)
        await useNotes.getState().patchNote(assignment.id, { folderId: assignment.folderId });
}
