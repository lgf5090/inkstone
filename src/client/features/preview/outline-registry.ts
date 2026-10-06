import type { Heading } from '../../lib/markdown/renderer';

interface OutlineSnapshot {
    noteId: string | undefined;
    headings: Heading[];
}

let snapshot: OutlineSnapshot = { noteId: undefined, headings: [] };

export function publishOutlineHeadings(noteId: string | undefined, headings: Heading[]): void {
    snapshot = { noteId, headings };
}

export function readOutlineHeadings(): OutlineSnapshot {
    return snapshot;
}

/** Only the active note's outline is exportable; a stale snapshot must never reach the clipboard. */
export function outlineHeadingsFor(noteId: string | undefined): Heading[] {
    return snapshot.noteId === noteId ? snapshot.headings : [];
}

export function __resetOutlineHeadings(): void {
    snapshot = { noteId: undefined, headings: [] };
}
