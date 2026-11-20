import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, CalendarClock, SquareKanban } from 'lucide-react'
import type { ProjectMyTask } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { navigateToAddress, navigateToPath } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { fetchMyProjectTasks } from './api'

const DAY_MS = 86_400_000

function dayStamp(date: Date): number {
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function bucketOf(task: ProjectMyTask, today: number): 'overdue' | 'today' | 'week' | 'later' | 'none' {
  if (task.dueAt === null) return 'none'
  const days = Math.round((task.dueAt - today) / DAY_MS)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days <= 7) return 'week'
  return 'later'
}

export function MyTasksPage(): ReactElement {
  const [tasks, setTasks] = useState<ProjectMyTask[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const locale = useLocale()

  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    fetchMyProjectTasks(controller.signal)
      .then(setTasks)
      .catch(() => { if (!controller.signal.aborted) { setFailed(true); setTasks(null) } })
    return () => controller.abort()
  }, [attempt])

  const load = useCallback(() => setAttempt((current) => current + 1), [])
  const today = dayStamp(new Date())
  const groups = useMemo(() => {
    const buckets: Record<string, ProjectMyTask[]> = { overdue: [], today: [], week: [], later: [], none: [] }
    for (const task of tasks ?? []) buckets[bucketOf(task, today)]!.push(task)
    return buckets
  }, [tasks, today])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-project-my-tasks="">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('project.my_tasks.back')} size="sm" onClick={() => navigateToPath('/project')}><ArrowLeft size={16} /></IconButton>
        <CalendarClock size={16} aria-hidden="true" className="text-[var(--accent)]" />
        <h1 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('project.my_tasks.title')}</h1>
        {tasks && <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.my_tasks.count', { count: tasks.length })}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {failed
          ? (
              <div className="space-y-2">
                <p role="alert" className="text-[length:var(--text-13)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
                <Button size="sm" onClick={load}>{t('project.common.retry')}</Button>
              </div>
            )
          : tasks === null
            ? <LoadingBlock />
            : tasks.length === 0
              ? <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('project.my_tasks.empty')}</p>
              : (
                  <div className="mx-auto w-full max-w-3xl space-y-5">
                    {(['overdue', 'today', 'week', 'later', 'none'] as const).map((key) => groups[key]!.length > 0 && (
                      <section key={key} aria-label={t(`project.my_tasks.${key}` as Parameters<typeof t>[0])}>
                        <h2 className={`mb-1.5 text-[length:var(--text-11)] font-semibold uppercase tracking-wide ${key === 'overdue' ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}`}>
                          {t(`project.my_tasks.${key}` as Parameters<typeof t>[0])}
                        </h2>
                        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
                          {groups[key]!.map((task) => (
                            <li key={`${task.boardId}:${task.cardId}`}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                                onClick={() => navigateToAddress(`/project/boards/${task.boardId}`, `card=${encodeURIComponent(task.cardId)}`)}
                              >
                                <span aria-hidden="true" className="text-[length:var(--text-13)]">{task.boardIcon || <SquareKanban size={14} className="text-[var(--text-quaternary)]" />}</span>
                                <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{task.title || t('project.boards.untitled')}</span>
                                <span className="min-w-0 max-w-40 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{task.boardTitle}</span>
                                <span className={`shrink-0 text-[length:var(--text-11)] tabular ${key === 'overdue' ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}`}>
                                  {task.dueAt === null ? '' : new Date(task.dueAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
      </div>
    </div>
  )
}
