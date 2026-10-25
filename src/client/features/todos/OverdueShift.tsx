/**
 * The overdue rows, shifted to today in one press.
 *
 * The count on the button is the server's account-wide overdue number, and the rows are read by the
 * same `overdue` view that number counts, so the banner and the rows it moves cannot disagree. A batch
 * names at most `MAX_BATCH_TASKS`, so a longer shelf is sent in chunks and both halves of every answer
 * are summed — a toast that said "moved" over a partial batch would be a lie. Only `due_at` moves on
 * the server: the day a row was picked for is the reader's own plan and stays where it was, which is
 * what keeps this gesture from silently rearranging "My Day".
 *
 * The banner is drawn above the plan and above "My Day". Each screen wraps it in its own padding, so
 * the wrapper class is the caller's rather than this component's: the plan has no padded container of
 * its own and needs `px/pt`, while "My Day" already sits inside one and only needs the gap below.
 */
import { useState } from 'react'
import { MAX_BATCH_TASKS, MAX_TASKS_PER_QUERY } from '@shared/todos/model'
import { isTaskOpen } from '@shared/todos/status'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { useTodos } from './store'

export function OverdueShift({ className }: { className: string }) {
  const counts = useTodos((state) => state.counts)
  const [busy, setBusy] = useState(false)
  const overdue = counts?.overdue ?? 0
  if (overdue === 0) return null

  const shift = async (): Promise<void> => {
    setBusy(true)
    try {
      const page = await api.todos.list({ view: 'overdue', limit: MAX_TASKS_PER_QUERY })
      const ids = page.tasks.filter((task) => isTaskOpen(task.status)).map((task) => task.id)
      let done = 0
      let failed = 0
      for (let start = 0; start < ids.length; start += MAX_BATCH_TASKS) {
        const result = await api.todos.batch({ ids: ids.slice(start, start + MAX_BATCH_TASKS), op: 'due' })
        done += result.done.length
        failed += result.failed.length
      }
      // The rows moved, so the page and the count are read again rather than patched by hand — the
      // same rule every other write in this feature follows.
      await useTodos.getState().load()
      if (!ids.length) return
      useUi.getState().toast(failed
        ? { title: t('todo.toast.batch_partial', { failed, total: done + failed }), tone: 'danger' }
        : { title: t('todo.toast.batch_due', { count: done }), tone: 'success' })
    } catch (error) {
      useUi.getState().toast({
        title: t('todo.toast.failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={className}>
      <Button
        variant="ghost"
        size="sm"
        block
        data-todo-overdue-shift=""
        disabled={busy}
        onClick={() => { void shift() }}
        className="justify-start text-[var(--text-secondary)]"
      >
        {t('todo.overdue.shift', { count: overdue })}
      </Button>
    </div>
  )
}
