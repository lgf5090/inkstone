import { t } from '../../lib/i18n'
import {
  applyKanbanBodyAtFence,
  type KanbanFenceRef,
  type KanbanWriteResult,
  type KanbanWriter,
} from '../../lib/markdown/kanban'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

const CONFLICT_NOTICE_INTERVAL_MS = 4000

function patchNote(noteId: string | null, apply: (content: string) => string | null): KanbanWriteResult {
  if (!noteId) return 'missing'
  const state = useNotes.getState()
  const current = state.contents[noteId]
  if (current === undefined) return 'missing'
  const next = apply(current)
  if (next === null) return 'conflict'
  if (next !== current) state.editContent(noteId, next)
  return 'written'
}

export function writeKanbanBody(noteId: string | null, ref: KanbanFenceRef, nextBody: string): KanbanWriteResult {
  return patchNote(noteId, (content) => applyKanbanBodyAtFence(content, ref, nextBody))
}

function conflictReporter(): (result: KanbanWriteResult) => KanbanWriteResult {
  let lastNoticeAt = 0
  return (result) => {
    if (result === 'conflict' && Date.now() - lastNoticeAt > CONFLICT_NOTICE_INTERVAL_MS) {
      lastNoticeAt = Date.now()
      useUi.getState().toast({ title: t('preview.kanban_source_moved'), tone: 'warning' })
    }
    return result
  }
}

export function createKanbanWriter(noteId: string | null): KanbanWriter {
  const report = conflictReporter()
  return (ref, nextBody) => report(writeKanbanBody(noteId, ref, nextBody))
}
