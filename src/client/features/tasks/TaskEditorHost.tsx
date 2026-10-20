/**
 * The one place the task edit form is mounted.
 *
 * A row in a query block, a line in the editor and a task in the reading preview all ask for the same
 * dialog, and none of them should have to own reading the note. The host takes the line, fetches the
 * text it needs, and writes back through the same remote-content path a tick uses — which is what lets
 * it flush unsaved edits in that note instead of racing them.
 */
import { useEffect, useMemo, useState } from 'react'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { editTaskInNote, editTaskInSource, toggleSettings, type TaskEdit } from '../../lib/tasks/service'
import { draftFromTask, type DraftErrors, type TaskDraft } from '../../lib/tasks/edit/task-editor'
import { parseTaskLine } from '../../lib/tasks/model/task'
import { unknownPosition } from '../../lib/tasks/model/task-location'
import { EditTaskModal } from './EditTaskModal'
import { useTaskEditor, type TaskEditRequest } from './store'

export function TaskEditorHost() {
  const request = useTaskEditor((state) => state.request)
  const [source, setSource] = useState<string | null>(null)

  useEffect(() => {
    setSource(null)
    if (request === null) return
    let alive = true
    void api.notes.get(request.noteId).then((note) => {
      if (alive) setSource(note.content ?? '')
    }).catch(() => {
      if (!alive) return
      useUi.getState().toast({ title: t('dataview.task_unavailable'), tone: 'warning' })
      useTaskEditor.getState().close()
    })
    return () => { alive = false }
  }, [request])

  if (request === null || source === null) return null
  return <TaskEditorForm request={request} source={source} />
}

interface FormProps {
  request: TaskEditRequest
  source: string
}

/**
 * The form for one request.
 *
 * Split from the host so the line is parsed and the draft built once per open rather than on every
 * keystroke — and so a note that turned out not to hold a task at that line is reported from an
 * effect, where leaving is allowed to happen, rather than in the middle of a render.
 */
function TaskEditorForm({ request, source }: FormProps) {
  const settings = toggleSettings()
  const task = useMemo(() => parseTaskLine(
    source.split(/\r?\n/u)[request.line] ?? '',
    unknownPosition('', ''),
    { registry: settings.registry, serializer: settings.serializer, now: new Date() },
  ), [source, request.line, settings])
  const draft = useMemo(() => (task === null ? null : draftFromTask(task)), [task])

  useEffect(() => {
    if (task !== null) return
    // The line the row pointed at is no longer a task: say so, rather than opening an empty form.
    useUi.getState().toast({ title: t('dataview.task_moved'), tone: 'warning' })
    useTaskEditor.getState().close()
  }, [task])

  if (task === null || draft === null) return null

  const validate = (next: TaskDraft, statusSymbol: string): DraftErrors => {
    const outcome = editTaskInSource(source, request.line, { draft: next, statusSymbol }, new Date(), request.text ?? undefined)
    return outcome.ok ? { dates: {}, recurrence: 'none' } : (outcome.errors ?? { dates: {}, recurrence: 'none' })
  }

  const save = async (next: TaskDraft, statusSymbol: string): Promise<void> => {
    const edit: TaskEdit = { draft: next, statusSymbol }
    const result = await editTaskInNote(request.noteId, request.line, request.text, edit)
    if (result !== 'written') {
      useUi.getState().toast({
        title: t(result === 'conflict' ? 'dataview.task_moved' : 'dataview.task_unavailable'),
        tone: 'warning',
      })
      // Rejecting keeps the form open with what the reader typed still in it.
      throw new Error('task-edit-refused')
    }
  }

  return (
    <EditTaskModal
      draft={draft}
      statuses={settings.registry.registeredStatuses.map((status) => ({ symbol: status.symbol, name: status.name }))}
      validate={validate}
      onClose={useTaskEditor.getState().close}
      onSave={save}
    />
  )
}
