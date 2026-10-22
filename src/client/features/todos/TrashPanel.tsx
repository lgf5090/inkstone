/**
 * The trash: the tasks a delete only hid, and the two ways to settle them.
 *
 * The server keeps a deleted row — with its steps and tags — for the retention window, so this screen
 * is where a reader finds it again. Restoring is the same call the undo uses, and purging is the one
 * irreversible door, which is why it asks first. The panel is opened from the organizer page rather
 * than the task views: the trash is management, not a list to work in.
 */

import { useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { localeTag, t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useTodos } from './store'
import { TODO_TRASH_RETENTION_DAYS, TRASH_PAGE_SIZE, type TodoTask } from '@shared/todos/model'

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toastFailure(error: unknown): void {
  useUi.getState().toast({ title: t('todo.toast.failed'), description: failureText(error), tone: 'danger' })
}

/** When the row was deleted, in the reader's own calendar. */
function deletedLabel(deletedAt: number | null | undefined): string {
  if (!deletedAt) return ''
  const date = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(new Date(deletedAt))
  return t('todo.trash.deleted_at', { date })
}

export function TrashPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const restoreTask = useTodos((state) => state.restoreTask)
  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** Bumped by the retry button, so the effect below reads the page again. */
  const [reloadKey, setReloadKey] = useState(0)
  /** The row a request is in flight on, so its two buttons cannot be pressed twice. */
  const [busyId, setBusyId] = useState<string | null>(null)

  // A fresh read on every open: the trash may have changed while the panel was away, and a stale page
  // would offer a restore for a row the retention sweep has already removed.
  useEffect(() => {
    if (!open) return
    let live = true
    setStatus('loading')
    setError(null)
    setTasks([])
    setTotal(0)
    api.todos.trash({ limit: TRASH_PAGE_SIZE })
      .then((page) => {
        if (!live) return
        setTasks(page.tasks)
        setTotal(page.total)
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
      const page = await api.todos.trash({ limit: TRASH_PAGE_SIZE, offset: tasks.length })
      setTasks((current) => [...current, ...page.tasks])
      setTotal(page.total)
    } catch (reason) {
      toastFailure(reason)
    } finally {
      setLoadingMore(false)
    }
  }

  const restore = async (task: TodoTask): Promise<void> => {
    setBusyId(task.id)
    // The store's restore reports and reloads the listing; the panel only drops the row it sees.
    const restored = await restoreTask(task.id)
    setBusyId(null)
    if (!restored) return
    setTasks((current) => current.filter((entry) => entry.id !== task.id))
    setTotal((current) => Math.max(0, current - 1))
  }

  const purge = async (task: TodoTask): Promise<void> => {
    const ok = await confirm({
      title: t('todo.trash.purge_title', { title: task.title }),
      description: t('todo.trash.purge_hint'),
      confirmLabel: t('todo.trash.purge'),
      tone: 'danger',
    })
    if (!ok) return
    setBusyId(task.id)
    try {
      await api.todos.purge(task.id)
      setTasks((current) => current.filter((entry) => entry.id !== task.id))
      setTotal((current) => Math.max(0, current - 1))
      useUi.getState().toast({ title: t('todo.toast.deleted'), tone: 'success' })
    } catch (reason) {
      toastFailure(reason)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('todo.trash.title')}
      description={t('todo.trash.description', { days: TODO_TRASH_RETENTION_DAYS })}
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
          {t('todo.trash.empty')}
        </p>
      )}
      {status === 'ready' && tasks.length > 0 && (
        <ul className="m-0 list-none p-0">
          {tasks.map((task, index) => (
            <li key={task.id} className={index > 0 ? 'border-t border-[var(--border-subtle)]' : undefined}>
              <div data-todo-trash-row className="flex min-h-12 items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{task.title}</p>
                  <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{deletedLabel(task.deletedAt)}</p>
                </div>
                <IconButton
                  label={`${t('todo.trash.restore')} ${task.title}`}
                  size="sm"
                  disabled={busyId === task.id}
                  onClick={() => { void restore(task) }}
                >
                  <RotateCcw size={14} />
                </IconButton>
                <IconButton
                  label={`${t('todo.trash.purge')} ${task.title}`}
                  size="sm"
                  disabled={busyId === task.id}
                  onClick={() => { void purge(task) }}
                >
                  <Trash2 size={14} />
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
