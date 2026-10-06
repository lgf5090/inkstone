/**
 * Bridges the mind map registry (pure view state) to the note store: the map's
 * operations are serialized into the fence it came from, and the header's palette
 * control rewrites that fence.
 *
 * The fence is resolved against the note's *current* text, not against the
 * markup the preview rendered from: the user may have typed since, and writing
 * on top of a stale snapshot would throw those edits away. When the fence no
 * longer holds the body the map was built from, nothing is written and the user
 * is told, because silently dropping either side would be worse.
 */
import { t } from '../../lib/i18n';
import { applyBodyAtFence, applyFencePatchAtSource, type MindmapFencePatch, type MindmapFenceRef, type MindmapFenceWriter, type MindmapWriteResult, type MindmapWriter } from '../../lib/markdown/mindmap';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

const CONFLICT_NOTICE_INTERVAL_MS = 4000;

/** The note's text with the fence rewritten, or null when the fence moved out from under us. */
function patchNote(noteId: string | null, apply: (content: string) => string | null): MindmapWriteResult {
    if (!noteId)
        return 'missing';
    const state = useNotes.getState();
    const current = state.contents[noteId];
    if (current === undefined)
        return 'missing';
    const next = apply(current);
    if (next === null)
        return 'conflict';
    if (next !== current)
        state.editContent(noteId, next);
    return 'written';
}

export function writeMindmapBody(noteId: string | null, ref: MindmapFenceRef, nextBody: string): MindmapWriteResult {
    return patchNote(noteId, (content) => applyBodyAtFence(content, ref, nextBody));
}

/**
 * Rewrites the whole fence — its body, the palette on its info line, or both at once, in
 * a single note edit, so the two places a palette can be stated move together and one
 * undo takes the change back.
 */
export function writeMindmapFence(noteId: string | null, ref: MindmapFenceRef, patch: MindmapFencePatch): MindmapWriteResult {
    return patchNote(noteId, (content) => applyFencePatchAtSource(content, ref, patch));
}

/**
 * Conflicts are reported at most once every few seconds: a drag emits operations
 * continuously and each one would otherwise queue the same toast.
 */
function conflictReporter(): (result: MindmapWriteResult) => MindmapWriteResult {
    let lastNoticeAt = 0;
    return (result) => {
        if (result === 'conflict' && Date.now() - lastNoticeAt > CONFLICT_NOTICE_INTERVAL_MS) {
            lastNoticeAt = Date.now();
            useUi.getState().toast({ title: t('preview.mindmap_source_moved'), tone: 'warning' });
        }
        return result;
    };
}

/** The writer the registry hands a map's own operations to. */
export function createMindmapWriter(noteId: string | null): MindmapWriter {
    const report = conflictReporter();
    return (ref, nextBody) => report(writeMindmapBody(noteId, ref, nextBody));
}

/** The writer the header's palette control hands a fence rewrite to. */
export function createMindmapFenceWriter(noteId: string | null): MindmapFenceWriter {
    const report = conflictReporter();
    return (ref, patch) => report(writeMindmapFence(noteId, ref, patch));
}
