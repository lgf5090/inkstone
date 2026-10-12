import { getAllFolderDescendants } from './library-store';
import type { ExcalidrawLibraryFolder } from './types';

/**
 * The payload a library folder drag carries. Its own type rather than the note or tag ones, so a
 * folder row never mistakes a dragged note - or a dragged stencil tile, which this panel also
 * exports - for something it can reorder.
 */
export const LIBRARY_FOLDER_DRAG_TYPE = 'application/x-inkstone-library-folder';

export type FolderDropPlacement = 'before' | 'inside' | 'after';

const BEFORE_RATIO = 0.28;
const AFTER_RATIO = 0.72;

/**
 * Where a pointer sitting at `ratio` down a row wants to put the folder.
 *
 * A row is about 30px tall and the pointer is rarely dead-centre, so the middle band is generous: it
 * is the one placement that changes the hierarchy, and the two edges only ever swap neighbours.
 */
export function folderDropPlacement(ratio: number): FolderDropPlacement {
    if (!Number.isFinite(ratio))
        return 'inside';
    if (ratio < BEFORE_RATIO)
        return 'before';
    if (ratio > AFTER_RATIO)
        return 'after';
    return 'inside';
}

/** The ratio `folderDropPlacement` reads out of a pointer position and a row box. */
export function pointerRatio(event: { clientY: number }, box: { top: number; height: number }): number {
    return box.height ? (event.clientY - box.top) / box.height : 0.5;
}

/**
 * The drag in memory as well as in the transfer bag.
 *
 * `dataTransfer.getData()` is specified to return the empty string for every type until the drop
 * happens, so a row that wants to know *while the pointer is over it* whether this is its own subtree
 * has to read the id from somewhere else. The tag tree made the same choice for the same reason.
 */
let currentDragId: string | null = null;

export function beginFolderDrag(id: string, dataTransfer: DataTransfer): void {
    currentDragId = id;
    dataTransfer.setData(LIBRARY_FOLDER_DRAG_TYPE, id);
    dataTransfer.effectAllowed = 'move';
}

export function currentFolderDrag(): string | null {
    return currentDragId;
}

export function endFolderDrag(): void {
    currentDragId = null;
}

export function isFolderDrag(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).includes(LIBRARY_FOLDER_DRAG_TYPE);
}


export interface FolderMove {
    parentId: string | null;
    beforeId: string | null;
    /** False when the drop would leave the folder exactly where it is, so nothing needs writing. */
    changed: boolean;
}

const byOrder = (a: ExcalidrawLibraryFolder, b: ExcalidrawLibraryFolder) =>
    a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

function parentOf(folder: ExcalidrawLibraryFolder): string | null {
    return folder.parentId ?? null;
}

/**
 * The children of one folder in the order the tree draws them.
 *
 * Same comparator as `buildLibraryTree`, because a menu row that says "move earlier" has to agree with
 * the row above the one the user is looking at.
 */
export function orderedSiblings(folders: readonly ExcalidrawLibraryFolder[], parentId: string | null): ExcalidrawLibraryFolder[] {
    return folders.filter((folder) => parentOf(folder) === parentId).sort(byOrder);
}

/** The slot `beforeId` would land the subject in, among siblings that do not include it. */
function slotOf(siblingsWithoutSubject: readonly ExcalidrawLibraryFolder[], beforeId: string | null): number {
    if (beforeId === null)
        return siblingsWithoutSubject.length;
    const at = siblingsWithoutSubject.findIndex((folder) => folder.id === beforeId);
    return at < 0 ? siblingsWithoutSubject.length : at;
}

/**
 * The move a drop asks for, or `null` when the drop must not happen at all.
 *
 * Two rejections live here rather than in the store. A folder cannot be dropped into itself or into
 * anything it already contains - the same cycle `moveFolder` refuses, but caught while the pointer is
 * still over the row, so the indicator never promises a move that would be thrown away. And a drop
 * that lands the folder in the slot it already occupies reports `changed: false`: the row still
 * accepts it, because the pointer said "here" and the honest answer is "it is already here", but
 * nothing is written, so the manifest is not re-persisted and re-uploaded for a move that did
 * nothing.
 */
export function resolveFolderDrop(input: {
    folders: readonly ExcalidrawLibraryFolder[];
    subjectId: string;
    /** `null` for the top level, which is where a drop on the panel's own background goes. */
    targetId: string | null;
    placement: FolderDropPlacement;
}): FolderMove | null {
    const subject = input.folders.find((folder) => folder.id === input.subjectId);
    if (!subject || input.targetId === input.subjectId)
        return null;
    const target = input.targetId === null ? null : input.folders.find((folder) => folder.id === input.targetId);
    let parentId: string | null;
    if (input.targetId === null)
        parentId = null;
    else {
        if (!target)
            return null;
        parentId = input.placement === 'inside' ? target.id : parentOf(target);
    }
    if (parentId !== null && getAllFolderDescendants(input.folders, input.subjectId).has(parentId))
        return null;

    const siblings = orderedSiblings(input.folders, parentId);
    const withoutSubject = siblings.filter((folder) => folder.id !== input.subjectId);
    let beforeId: string | null = null;
    if (input.targetId !== null && input.placement !== 'inside') {
        const at = withoutSubject.findIndex((folder) => folder.id === input.targetId);
        beforeId = input.placement === 'before'
            ? input.targetId
            : withoutSubject[at + 1]?.id ?? null;
    }

    const current = siblings.findIndex((folder) => folder.id === input.subjectId);
    const wanted = slotOf(withoutSubject, beforeId);
    const sameParent = parentOf(subject) === parentId;

    return { parentId, beforeId, changed: !sameParent || current !== wanted };
}
