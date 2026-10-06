/**
 * Keeping the note in step with a live map: the debounce that turns an operation
 * burst into a single write, the serialization, and the explicit writes the block's own
 * controls make (a format conversion, the header's palette pick).
 *
 * The fence is resolved against the note's *current* text by the writer the
 * surface hands over (see features/preview/mindmap-sync): when it no longer holds
 * the body the map was built from, the writer reports a conflict and the note is
 * left alone, because writing would drop whatever the user typed since.
 */
import { detectMindmapMode, type MindmapFencePatch, type MindmapMode } from './body';
import type { MindmapBlockEntry } from './entry';
import { APP_THEME_CHOICE } from './theme';
import type { MindmapVendor, MindmapWriteResult } from './types';
import { MINDMAP_THEME_AUTO, type MindmapThemePickName } from './view';

/** Operations are coalesced: dragging a node fires many, the note gets one write. */
const WRITE_DEBOUNCE_MS = 400;

export function scheduleWrite(entry: MindmapBlockEntry): void {
    if (!entry.handle || !entry.write || !entry.ref)
        return;
    entry.dirty = true;
    if (entry.timer !== null)
        window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
        entry.timer = null;
        flushEntry(entry);
    }, WRITE_DEBOUNCE_MS);
}

/** Writes the map's current body into the note, if it is both dirty and still its own. */
export function flushEntry(entry: MindmapBlockEntry): MindmapWriteResult | null {
    if (entry.timer !== null) {
        window.clearTimeout(entry.timer);
        entry.timer = null;
    }
    if (!entry.handle || !entry.vendor || !entry.write || !entry.ref || !entry.dirty)
        return null;
    entry.dirty = false;
    const nextBody = entry.vendor.serialize(entry.handle.getData(), entry.mode, entry.extra);
    if (nextBody === entry.source)
        return null;
    const result = entry.write(entry.ref, nextBody);
    if (result === 'written' || result === 'moved') {
        entry.source = nextBody;
        entry.ref = { line: entry.ref.line, body: nextBody };
    }
    return result;
}

/** The current body text for a block, in the given mode (used by copy/convert actions). */
export function serializeEntryAs(entry: MindmapBlockEntry, mode: MindmapMode): string | null {
    if (!entry.handle || !entry.vendor)
        return null;
    return entry.vendor.serialize(entry.handle.getData(), mode, mode === 'json' ? entry.extra : {});
}

export function serializeEntry(entry: MindmapBlockEntry): string | null {
    return serializeEntryAs(entry, entry.mode);
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record)) {
        if (name !== key)
            kept[name] = value;
    }
    return kept;
}

/** The JSON body with `theme` set to `pick`, or without the field at all for `auto`. */
function serializeWithTheme(entry: MindmapBlockEntry, pick: MindmapThemePickName, vendor: MindmapVendor): string {
    const extra = withoutKey(entry.extra, 'theme');
    if (pick !== MINDMAP_THEME_AUTO)
        extra.theme = pick;
    return vendor.serialize(entry.handle!.getData(), 'json', extra);
}

/** The note now holds this body, so the entry stops standing in for the previous one. */
function adoptBody(entry: MindmapBlockEntry, body: string): void {
    entry.source = body;
    entry.mode = detectMindmapMode(body);
    entry.extra = withoutKey(entry.extra, 'theme');
    if (entry.ref)
        entry.ref = { line: entry.ref.line, body };
}

/**
 * Writes the palette the header's control was set to into the fence, and paints it. A
 * JSON body states it in its own `theme` field and has the annotation beside it cleared,
 * so the statement lives in exactly one place; an outline body has no field to hold one,
 * so it goes on the info line. Either way it is a single note edit — one undo takes the
 * pick back — and the answer is resolved and applied here rather than waiting for the
 * re-render, so the map repaints immediately.
 */
export function setEntryTheme(entry: MindmapBlockEntry, pick: MindmapThemePickName): MindmapWriteResult {
    const { vendor, handle, ref, writeFence } = entry;
    if (!vendor || !handle || !ref || !writeFence || !entry.editable)
        return 'missing';
    const patch: MindmapFencePatch = entry.mode === 'json'
        ? { body: serializeWithTheme(entry, pick, vendor), annotation: null }
        : { annotation: pick === MINDMAP_THEME_AUTO ? null : pick };
    const result = writeFence(ref, patch);
    if (result !== 'written' && result !== 'moved')
        return result;
    entry.bodyChoice = pick === MINDMAP_THEME_AUTO ? APP_THEME_CHOICE : { kind: pick };
    if (patch.body === undefined)
        entry.annotation = patch.annotation ?? null;
    else
        adoptBody(entry, patch.body);
    return result;
}

/** Writes an explicit body (a format conversion), bypassing the operation debounce. */
export function applyEntryBody(entry: MindmapBlockEntry, nextBody: string): MindmapWriteResult {
    if (!entry.write || !entry.ref)
        return 'missing';
    const result = entry.write(entry.ref, nextBody);
    if (result === 'written' || result === 'moved') {
        entry.source = nextBody;
        entry.mode = detectMindmapMode(nextBody);
        entry.extra = {};
        entry.ref = { line: entry.ref.line, body: nextBody };
    }
    return result;
}
