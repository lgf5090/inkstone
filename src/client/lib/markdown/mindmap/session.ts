/**
 * The full screen view's handle on one block. Every method resolves the entry
 * again, so the facade keeps working when the preview re-renders underneath the
 * overlay (which re-parents the block but keeps the instance alive).
 */
import type { MindmapMode } from './body';
import { mindmapOutlineToMarkdown } from './outline';
import type { MindmapFenceRef, MindmapWriteResult } from './types';
import { attachMindmapToOverlay, detachMindmapFromOverlay, mindmapEntryForNode, type MindmapBlockEntry } from './registry';
import { applyEntryBody, flushEntry, serializeEntryAs } from './write';
import { mindmapEditing } from './view';

export interface MindmapSession {
    readonly key: string
    /** The note this block writes to, so an action can rewrite the note around the fence. */
    noteId(): string | null
    /** Where the fence is in that note, or null when the block is view-only. */
    fence(): MindmapFenceRef | null
    title(): string
    isReady(): boolean
    isEditable(): boolean
    isEditing(): boolean
    focus(): void
    mode(): MindmapMode
    moveInto(target: HTMLElement): void
    moveBack(): void
    fit(): void
    center(): void
    undo(): void
    redo(): void
    serialize(mode: MindmapMode): string | null
    /** The tree as Markdown headings and lists, for the "write as outline" actions. */
    outlineMarkdown(): string | null
    apply(nextBody: string): MindmapWriteResult
    exportSvg(): Promise<Blob | null>
    exportPng(): Promise<Blob | null>
    clearHistory(): void
    flush(): void
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Root topic of the live map, used as the full screen title and export name. */
function rootTopic(entry: MindmapBlockEntry): string {
    const data = entry.handle?.getData();
    if (typeof data !== 'object' || data === null)
        return '';
    const nodeData = (data as { nodeData?: unknown }).nodeData;
    if (typeof nodeData !== 'object' || nodeData === null)
        return '';
    const topic = (nodeData as { topic?: unknown }).topic;
    return typeof topic === 'string' ? topic.trim() : '';
}

async function toBlob(work: () => Promise<Blob>): Promise<Blob | null> {
    try {
        return await work();
    }
    catch (err) {
        console.warn('[inkstone] mind map export failed', messageOf(err));
        return null;
    }
}

export function openMindmapSession(node: HTMLElement): MindmapSession | null {
    const opened = mindmapEntryForNode(node);
    return opened ? sessionFor(opened) : null;
}

async function exportPngOf(entry: MindmapBlockEntry): Promise<Blob> {
    const blob = await entry.handle!.exportPng();
    if (!blob)
        throw new Error('mind-elixir produced no PNG');
    return blob;
}

/**
 * The entry object is the identity: re-renders re-parent it and renumber its
 * key, but only deleting the block (or its note) tears it down, and then every
 * method below turns into a no-op instead of touching a destroyed instance.
 */
export function sessionFor(entry: MindmapBlockEntry): MindmapSession {
    return {
        key: entry.key,
        title: () => rootTopic(entry),
        isReady: () => Boolean(entry.handle),
        isEditable: () => Boolean(entry.editable),
        isEditing: () => mindmapEditing(entry.container),
        // The handle targets the library's inner container — the element its own
        // keymap is bound to — not our wrapper around it.
        focus: () => entry.handle?.focus(),
        noteId: () => entry.noteId,
        fence: () => entry.ref,
        mode: () => entry.mode,
        /**
         * The tree as a Markdown outline: headings down to the sixth level, then a
         * nested list. Read from the map itself, so what lands in the note is what
         * is on screen — including a topic edited but not yet written back.
         */
        outlineMarkdown: () => {
            const outline = serializeEntryAs(entry, 'outline');
            return outline === null ? null : mindmapOutlineToMarkdown(outline);
        },
        moveInto: (target) => attachMindmapToOverlay(entry, target),
        moveBack: () => detachMindmapFromOverlay(entry),
        fit: () => entry.handle?.scaleFit(),
        center: () => entry.handle?.toCenter(),
        undo: () => entry.handle?.undo(),
        redo: () => entry.handle?.redo(),
        serialize: (mode) => serializeEntryAs(entry, mode),
        apply: (nextBody) => applyEntryBody(entry, nextBody),
        exportSvg: () => (entry.handle ? toBlob(() => entry.handle!.exportSvg()) : Promise.resolve(null)),
        exportPng: () => (entry.handle ? toBlob(() => exportPngOf(entry)) : Promise.resolve(null)),
        clearHistory: () => entry.handle?.clearHistory(),
        flush: () => flushEntry(entry),
    };
}
