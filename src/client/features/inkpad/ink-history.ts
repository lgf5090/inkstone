import type { InkDocument } from '../../lib/inkpad/types'

export const MAX_UNDO_STEPS = 80

function cloneDocument(document: InkDocument): InkDocument {
    return {
        ...document,
        viewport: document.viewport ? { ...document.viewport } : undefined,
        strokes: document.strokes.map((stroke) => ({ ...stroke, points: stroke.points })),
        shapes: document.shapes.map((shape) => ({ ...shape, start: { ...shape.start }, end: { ...shape.end } })),
        elements: document.elements.map((element) => ({ ...element })),
        bookmarks: document.bookmarks?.map((bookmark) => ({ ...bookmark })),
    }
}

/** Appending a stroke never mutates existing items, so only the top-level arrays need copies. */
function appendSnapshot(document: InkDocument): InkDocument {
    return {
        ...document,
        viewport: document.viewport ? { ...document.viewport } : undefined,
        strokes: document.strokes.slice(),
        shapes: document.shapes.slice(),
        elements: document.elements.slice(),
        bookmarks: document.bookmarks?.slice(),
    }
}

/**
 * Snapshot stacks for the canvas. Point arrays are shared by reference in an append snapshot,
 * which is what keeps a lecture-sized drawing's undo path O(strokes) rather than O(samples).
 */
export class InkHistory {
    private readonly undoStack: InkDocument[] = []
    private readonly redoStack: InkDocument[] = []

    get canUndo(): boolean {
        return this.undoStack.length > 0
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0
    }

    clear(): void {
        this.undoStack.length = 0
        this.redoStack.length = 0
    }

    snapshot(document: InkDocument): void {
        this.push(cloneDocument(document))
    }

    snapshotForAppend(document: InkDocument): void {
        this.push(appendSnapshot(document))
    }

    undo(current: InkDocument): InkDocument | null {
        const previous = this.undoStack.pop()
        if (!previous) return null
        this.redoStack.push(cloneDocument(current))
        return previous
    }

    redo(current: InkDocument): InkDocument | null {
        const next = this.redoStack.pop()
        if (!next) return null
        this.push(cloneDocument(current))
        return next
    }

    private push(snapshot: InkDocument): void {
        this.undoStack.push(snapshot)
        if (this.undoStack.length > MAX_UNDO_STEPS) this.undoStack.shift()
        this.redoStack.length = 0
    }
}
