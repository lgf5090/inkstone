/**
 * Writing a live mind map back into the note as a Markdown outline.
 *
 * The change goes through the note store, the same route the preview's other
 * block writes take (a task checkbox, a chart's format toggle): the surface that
 * owns the note is the one that has its current text, and a store write is what
 * makes the preview re-render around the new lines. The store has no editor undo
 * to lean on, so the write offers its own.
 *
 * Both placements run the same fence surgery (see lib/markdown/mindmap/body), so
 * they agree on where the outline lands, and both refuse outright when the fence
 * has moved.
 */
import { t } from '../../lib/i18n';
import { insertTextAfterFence, replaceFenceWithText, type MindmapSession } from '../../lib/markdown/mindmap';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

/** `replace` writes the outline over the fence; `after` keeps the map and appends. */
export type MindmapOutlinePlacement = 'replace' | 'after';

export type MindmapOutlineResult = 'written' | 'empty' | 'conflict' | 'missing';

export function writeMindmapOutline(session: MindmapSession, placement: MindmapOutlinePlacement): MindmapOutlineResult {
    const outline = session.outlineMarkdown();
    if (!outline)
        return 'empty';
    const noteId = session.noteId();
    const fence = session.fence();
    if (!noteId || !fence)
        return 'missing';
    const state = useNotes.getState();
    const content = state.contents[noteId];
    if (content === undefined)
        return 'missing';
    const next = placement === 'replace'
        ? replaceFenceWithText(content, fence, outline)
        : insertTextAfterFence(content, fence, outline);
    if (next === null)
        return 'conflict';
    if (next === content)
        return 'written';
    state.editContent(noteId, next);
    useUi.getState().toast({
        title: t('preview.mindmap_outline_written'),
        action: { label: t('common.undo'), run: () => useNotes.getState().editContent(noteId, content) },
        duration: 5000,
    });
    return 'written';
}
