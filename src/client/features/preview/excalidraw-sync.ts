import { t } from '../../lib/i18n';
import {
    applyBodyAtFence,
    type ExcalidrawFenceRef,
    type ExcalidrawWriteResult,
    type ExcalidrawWriter,
} from '../../lib/markdown/excalidraw';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

const CONFLICT_NOTICE_INTERVAL_MS = 4000;

function patchNote(noteId: string | null, apply: (content: string) => string | null): ExcalidrawWriteResult {
    if (!noteId) return 'missing';
    const state = useNotes.getState();
    const current = state.contents[noteId];
    if (current === undefined) return 'missing';
    const next = apply(current);
    if (next === null) return 'conflict';
    if (next !== current) {
        state.editContent(noteId, next);
    }
    return 'written';
}

export function writeExcalidrawBody(noteId: string | null, ref: ExcalidrawFenceRef, nextBody: string): ExcalidrawWriteResult {
    return patchNote(noteId, (content) => applyBodyAtFence(content, ref, nextBody));
}

function conflictReporter(): (result: ExcalidrawWriteResult) => ExcalidrawWriteResult {
    let lastNoticeAt = 0;
    return (result) => {
        if (result === 'conflict' && Date.now() - lastNoticeAt > CONFLICT_NOTICE_INTERVAL_MS) {
            lastNoticeAt = Date.now();
            useUi.getState().toast({ title: t('preview.excalidraw_source_moved'), tone: 'warning' });
        }
        return result;
    };
}

export function createExcalidrawWriter(noteId: string | null): ExcalidrawWriter {
    const report = conflictReporter();
    return (ref, nextBody) => report(writeExcalidrawBody(noteId, ref, nextBody));
}
