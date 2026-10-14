/**
 * The assistant's task list.
 *
 * Three tabs rather than one long list, because the question a reader opens this for is "what is on
 * me today", and a completed task should leave the way without leaving the database.
 *
 * The Today tab's set is decided by the *server*: "today" is a span in the reader's timezone, and a
 * browser in another zone would otherwise disagree with the reminder engine about what is overdue.
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, CheckCircle2, Circle, CircleDot, Flag, Plus, Trash2 } from 'lucide-react'
import type { Task as AssistantTask } from '@shared/assistant'
import { TASK_PRIORITIES, TASK_STATUSES } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { formatDue } from './time-format'
import { Button } from '../../components/primitives'
import { Field, Input, Segmented, Select, Textarea } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { Modal, confirm } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { useAssistant } from './assistant-store'

const TABS = [
  { value: 'today', label: 'assistant.tasks.today' },
  { value: 'upcoming', label: 'assistant.tasks.upcoming' },
  { value: 'completed', label: 'assistant.tasks.completed' },
] as const

const PRIORITY_LABELS: Record<string, () => string> = {
  low: () => t('assistant.tasks.priority.low'),
  medium: () => t('assistant.tasks.priority.medium'),
  high: () => t('assistant.tasks.priority.high'),
  urgent: () => t('assistant.tasks.priority.urgent'),
}

const STATUS_LABELS: Record<string, () => string> = {
  todo: () => t('assistant.tasks.status.todo'),
  in_progress: () => t('assistant.tasks.status.in_progress'),
  done: () => t('assistant.tasks.status.done'),
}

export function TasksView() {
  const tasks = useAssistant((state) => state.tasks)
  const tab = useAssistant((state) => state.taskTab)
  const setTab = useAssistant((state) => state.setTaskTab)
  const loadTasks = useAssistant((state) => state.loadTasks)
  const addTask = useAssistant((state) => state.addTask)
  const toggleTask = useAssistant((state) => state.toggleTask)
  const timezone = useAssistant((state) => state.settings?.timezone)
  const [quick, setQuick] = useState('')
  const [editing, setEditing] = useState<AssistantTask | null>(null)

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  const sections = useMemo(() => {
    const todayEnd = endOfTodayLocalMs()
    const open = tasks.filter((task) => task.status !== 'done')
    return {
      today: open.filter((task) => (task.dueAt !== null && task.dueAt <= todayEnd) || (task.dueAt === null && task.status === 'in_progress')),
      upcoming: open.filter((task) => !((task.dueAt !== null && task.dueAt <= todayEnd) || (task.dueAt === null && task.status === 'in_progress'))),
      completed: tasks.filter((task) => task.status === 'done'),
      all: tasks,
    }
  }, [tasks])

  const list = sections[tab]
  const now = Date.now()

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-5 md:px-8">
        <header>
          <h2 className="font-serif text-[length:var(--text-18)] font-semibold tracking-[var(--tracking-title)] text-[var(--text-primary)]">
            {t('assistant.tasks.title')}
          </h2>
          <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.tasks.description')}</p>
        </header>

        <Segmented
          size="sm"
          label={t('assistant.tasks.filter_label')}
          value={tab}
          onChange={setTab}
          options={TABS.map((entry) => ({ value: entry.value, label: `${t(entry.label)} ${sections[entry.value].length}` }))}
        />

        {tab !== 'completed' && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!quick.trim()) return
              void addTask(quick.trim())
              setQuick('')
            }}
          >
            <Input
              value={quick}
              onChange={(event) => setQuick(event.target.value)}
              placeholder={tab === 'today' ? t('assistant.tasks.add_today') : t('assistant.tasks.add')}
              maxLength={300}
              aria-label={t('assistant.tasks.add')}
              className="h-8 flex-1 text-[length:var(--text-12-5)]"
            />
            <Button type="submit" size="sm" variant="primary" icon={<Plus size={14} />} disabled={!quick.trim()} aria-label={t('assistant.tasks.add')}>
              {t('assistant.tasks.add_short')}
            </Button>
          </form>
        )}

        {!list.length ? (
          <Empty
            art="notes"
            title={tab === 'completed' ? t('assistant.tasks.empty_done') : t('assistant.tasks.empty_clear')}
            description={tab === 'today' ? t('assistant.tasks.empty_today') : tab === 'upcoming' ? t('assistant.tasks.empty_upcoming') : t('assistant.tasks.empty_done_hint')}
          />
        ) : (
          <ul className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            {list.map((task) => {
              const overdue = task.status !== 'done' && task.dueAt !== null && task.dueAt < now
              return (
                <li key={task.id} className="flex items-start gap-2.5 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0 hover:bg-[var(--bg-hover)]">
                  <button
                    type="button"
                    onClick={() => void toggleTask(task)}
                    aria-label={task.status === 'done' ? t('assistant.tasks.uncomplete') : t('assistant.tasks.complete')}
                    className="mt-0.5 shrink-0 text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
                  >
                    {task.status === 'done'
                      ? <CheckCircle2 size={16} className="text-[var(--accent)]" />
                      : task.status === 'in_progress'
                        ? <CircleDot size={16} />
                        : <Circle size={16} />}
                  </button>
                  <button type="button" onClick={() => setEditing(task)} className="min-w-0 flex-1 text-left">
                    <p className={cn('text-[length:var(--text-13)] leading-relaxed', task.status === 'done' ? 'text-[var(--text-quaternary)] line-through' : 'text-[var(--text-primary)]')}>
                      {task.title}
                    </p>
                    {(task.dueAt !== null || task.description) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                        {task.dueAt !== null && (
                          <span className={cn('inline-flex items-center gap-1', overdue && 'font-medium text-[var(--danger)]')}>
                            <CalendarDays size={11} />
                            {overdue && `${t('assistant.tasks.overdue')} · `}
                            {formatDue(task.dueAt, timezone)}
                          </span>
                        )}
                        {task.description && <span className="max-w-[22rem] truncate">{task.description}</span>}
                      </div>
                    )}
                  </button>
                  {(task.priority === 'high' || task.priority === 'urgent') && task.status !== 'done' && (
                    <span
                      className={cn(
                        'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[length:var(--text-10)]',
                        task.priority === 'urgent'
                          ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                          : 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
                      )}
                    >
                      <Flag size={9} />
                      {PRIORITY_LABELS[task.priority]?.()}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <TaskEditor task={editing} onClose={() => setEditing(null)} timezone={timezone} />
    </div>
  )
}

function TaskEditor({ task, onClose, timezone }: { task: AssistantTask | null, onClose: () => void, timezone?: string }) {
  const updateTask = useAssistant((state) => state.updateTask)
  const removeTask = useAssistant((state) => state.removeTask)
  const projects = useAssistant((state) => state.projects)
  const loadProjects = useAssistant((state) => state.loadProjects)
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium', status: 'todo', due: '', projectId: '' })

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (!task) return
    setForm({
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      due: task.dueAt === null ? '' : toLocalInput(task.dueAt),
      projectId: task.projectId ?? '',
    })
  }, [task])

  return (
    <Modal
      open={!!task}
      onClose={onClose}
      title={t('assistant.tasks.edit')}
      width={480}
      footer={(
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            variant="ghost"
            className="text-[var(--danger)]"
            icon={<Trash2 size={14} />}
            onClick={() => {
              if (!task) return
              void confirm({
                title: t('assistant.tasks.delete'),
                description: t('assistant.tasks.delete_hint', { title: task.title }),
                confirmLabel: t('assistant.tasks.delete'),
                tone: 'danger',
              }).then((yes) => {
                if (yes) {
                  void removeTask(task.id)
                  onClose()
                }
              })
            }}
          >
            {t('assistant.tasks.delete')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button
              disabled={!form.title.trim()}
              onClick={() => {
                if (!task) return
                void updateTask(task.id, {
                  title: form.title.trim(),
                  description: form.description,
                  status: form.status,
                  priority: form.priority,
                  dueAt: form.due ? localInputToMs(form.due) : null,
                  projectId: form.projectId || null,
                })
                onClose()
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('assistant.tasks.title_label')}>
          <Input value={form.title} maxLength={300} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </Field>
        <Field label={t('assistant.tasks.notes_label')}>
          <Textarea rows={3} value={form.description} maxLength={10_000} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('assistant.tasks.status_label')}>
            <Select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              {TASK_STATUSES.map((entry) => <option key={entry} value={entry}>{STATUS_LABELS[entry]?.()}</option>)}
            </Select>
          </Field>
          <Field label={t('assistant.tasks.priority_label')}>
            <Select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
              {TASK_PRIORITIES.map((entry) => <option key={entry} value={entry}>{PRIORITY_LABELS[entry]?.()}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('assistant.tasks.due_label')} hint={timezone}>
            <DatePicker withTime label={t('assistant.tasks.due_label')} value={form.due} onChange={(due) => setForm({ ...form, due })} />
          </Field>
          <Field label={t('assistant.tasks.project_label')} hint={t('assistant.tasks.project_optional')}>
            <Select value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
              <option value="">{t('assistant.tasks.project_none')}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/** End of the reader's local day, in the same milliseconds the server compares against. */
function endOfTodayLocalMs(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
}

function toLocalInput(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localInputToMs(value: string): number {
  const parsed = Date.parse(`${value}:00`)
  return Number.isFinite(parsed) ? parsed : Date.now()
}
