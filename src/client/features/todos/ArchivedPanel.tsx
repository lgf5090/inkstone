/**
 * The shelf: the tasks the reader put away, and the one way back.
 *
 * Archiving hides a row from every set the reader browses — the working surfaces and the completed list
 * alike — which is what makes closing a day change anything on the screen. That is only survivable
 * because this page exists: a shelf nobody can look at again is a deletion the reader cannot see coming,
 * and the statistics, the export and the row's own record are no consolation to somebody holding a task
 * they meant to come back to.
 *
 * It is opened from the organizer page beside the trash and reads the other side of the same predicate
 * the listings read (`archived=1`), so the answer it gives is the answer the rest of the app already
 * gave: whatever is missing from today is exactly what is here.
 */

import { useEffect, useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { localeTag, t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useTodos } from './store'
import { SHELF_PAGE_SIZE, type TodoTask } from '@shared/todos/model'

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** When the row was put away, in the reader's own calendar. */
function shelvedLabel(archivedAt: number | null | undefined): string {
  if (!archivedAt) return ''
  const date = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(new Date(archivedAt))
  return t('todo.shelf.put_away_on', { date })
}

export function ArchivedPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** Bumped by the retry button, so the effect below reads the page again. */
  const [reloadKey, setReloadKey] = useState(0)
  /** The row a request is in flight on, so its button cannot be pressed twice. */
  const [busyId, setBusyId] = useState<string | null>(null)
  // The listing behind the panel has to be told, too: a row taken off the shelf belongs on the board
  // the reader will return to, not only in this page's copy of it.
  const load = useTodos((state) => state.load)

  // A fresh read on every open: another device, the day's close, or a search that picked a row back
  // into today can all have emptied the shelf while this panel was away.
  useEffect(() => {
    if (!open) return
    let live = true
    setStatus('loading')
    setError(null)
    setTasks([])
    setTotal(0)
    api.todos.list({ view: 'all', archived: '1', limit: SHELF_PAGE_SIZE })
      .then((answer) => {
        if (!live) return
        setTasks(answer.tasks)
        setTotal(answer.total)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!live) return
        setStatus('error')
        setError(failureText(reason))
      })
    return () => { live = false }
  }, [open, reloadKey])

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true)
    try {
      const answer = await api.todos.list({ view: 'all', archived: '1', limit: SHELF_PAGE_SIZE, offset: tasks.length })
      setTasks((current) => [...current, ...answer.tasks])
      setTotal(answer.total)
    } catch (reason) {
      useUi.getState().toast({ title: t('todo.toast.failed'), description: failureText(reason), tone: 'danger' })
    } finally {
      setLoadingMore(false)
    }
  }

  const takeDown = async (task: TodoTask): Promise<void> => {
    setBusyId(task.id)
    try {
      // The shelf's own door, aimed at one row: the batch route is what stamps and clears
      // `archived_at`, so this page cannot invent a second write that the day's close would disagree
      // with.
      await api.todos.batch({ ids: [task.id], op: 'archive', value: 'false' })
      setTasks((current) => current.filter((entry) => entry.id !== task.id))
      setTotal((current) => Math.max(0, current - 1))
      useUi.getState().toast({ title: t('todo.toast.shelf_taken_down', { title: task.title }), tone: 'success' })
      await load()
    } catch (reason) {
      useUi.getState().toast({ title: t('todo.toast.failed'), description: failureText(reason), tone: 'danger' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('todo.shelf.title')}
      description={t('todo.shelf.description')}
      width={520}
    >
      {status === 'loading' && (
        <p role="status" className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('common.loading')}
        </p>
      )}
      {status === 'error' && (
        <div className="flex flex-col items-center gap-2 py-6">
          <p role="alert" className="text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
          <Button size="sm" variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>{t('common.retry')}</Button>
        </div>
      )}
      {status === 'ready' && tasks.length === 0 && (
        <p role="status" className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('todo.shelf.empty')}
        </p>
      )}
      {status === 'ready' && tasks.length > 0 && (
        <ul className="m-0 list-none p-0">
          {tasks.map((task, index) => (
            <li key={task.id} className={index > 0 ? 'border-t border-[var(--border-subtle)]' : undefined}>
              <div data-todo-shelf-row className="flex min-h-12 items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{task.title}</p>
                  <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{shelvedLabel(task.archivedAt)}</p>
                </div>
                <IconButton
                  label={`${t('todo.shelf.take_down')} ${task.title}`}
                  size="sm"
                  disabled={busyId === task.id}
                  onClick={() => { void takeDown(task) }}
                >
                  <ArchiveRestore size={14} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status === 'ready' && tasks.length < total && (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" loading={loadingMore} onClick={() => { void loadMore() }}>
            {t('todo.load_more')}
          </Button>
        </div>
      )}
    </Modal>
  )
}
