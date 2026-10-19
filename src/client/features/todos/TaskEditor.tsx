/**
 * The task editor: one dialog for a new task and for an existing one.
 *
 * It is a `Modal`, which already renders as a bottom sheet on a phone and a centred dialog on a
 * desktop — the two shapes the reference app has, without a second component. Fields are saved
 * together rather than on every keystroke: a title is edited in one pass, and a save per character
 * would be a write per character.
 *
 * Steps are the exception, and only for a task that already exists: adding a step is its own request
 * because the row it produces has to come back with an id the panel can tick.
 */

import { useEffect, useMemo, useState } from 'react'
import { MessagesSquare, Plus, Sparkles, Star, Trash2, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select, Textarea, Field } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { useTodos, type TaskDraft } from './store'
import { dueValue } from './todo-ui'
import { openConversationInChat, startChatAboutTask } from '../chat/start-chat'
import { REPEAT_FREQUENCIES, REMIND_OFFSETS, type RemindOffset, type RepeatFrequency, type TaskStep } from '@shared/todos/model'

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

function remindOffsetOf(task: { remindAt: number | null; dueAt: number | null }): RemindOffset {
  if (task.remindAt === null || task.dueAt === null) return 'none'
  const delta = task.dueAt - task.remindAt
  if (delta <= 0) return 'due'
  if (delta === 15 * 60_000) return '15m'
  if (delta === 60 * 60_000) return '1h'
  if (delta === 24 * 60 * 60_000) return '1d'
  return 'none'
}

export function TaskEditor() {
  const open = useTodos((state) => state.editorOpen)
  const draft = useTodos((state) => state.draft)
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const tasks = useTodos((state) => state.tasks)
  const completed = useTodos((state) => state.completed)
  const timezone = useTodos((state) => state.timezone)
  const saving = useTodos((state) => state.saving)
  const close = useTodos((state) => state.closeEditor)
  const createTask = useTodos((state) => state.createTask)
  const updateTask = useTodos((state) => state.updateTask)
  const removeTask = useTodos((state) => state.removeTask)
  const restoreTask = useTodos((state) => state.restoreTask)
  const addStep = useTodos((state) => state.addStep)
  const updateStep = useTodos((state) => state.updateStep)
  const removeStep = useTodos((state) => state.removeStep)

  const existing = useMemo(() => {
    if (!draft?.id) return null
    return tasks.find((task) => task.id === draft.id) ?? completed.find((task) => task.id === draft.id) ?? null
  }, [draft?.id, tasks, completed])

  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('medium')
  const [starred, setStarred] = useState(false)
  const [dueText, setDueText] = useState('')
  const [listId, setListId] = useState('')
  const [repeat, setRepeat] = useState<'none' | RepeatFrequency>('none')
  const [interval, setInterval] = useState(1)
  const [remind, setRemind] = useState<RemindOffset>('none')
  const [tagNames, setTagNames] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [steps, setSteps] = useState<TaskStep[]>([])
  const [stepInput, setStepInput] = useState('')

  useEffect(() => {
    if (!open) return
    const source = draft ?? {}
    const task = source.id ? tasks.find((entry) => entry.id === source.id) ?? completed.find((entry) => entry.id === source.id) : null
    setTitle(task?.title ?? source.title ?? '')
    setNotes(task?.description ?? source.description ?? '')
    setPriority(task?.priority ?? source.priority ?? 'medium')
    setStarred(task?.starred ?? source.starred ?? false)
    setDueText(task
      ? dueValue(task.dueAt, timezone)
      : typeof source.dueAt === 'string' ? source.dueAt : source.dueAt ? dueValue(source.dueAt, timezone) : '')
    setListId(task?.listId ?? source.listId ?? '')
    setRepeat(task?.repeat?.freq ?? source.repeat?.freq ?? 'none')
    setInterval(task?.repeat?.interval ?? source.repeat?.interval ?? 1)
    setRemind(task ? remindOffsetOf(task) : 'none')
    setTagNames(task ? task.tags.map((tag) => tag.name) : source.tags ?? [])
    setStepInput('')
    setTagInput('')
    setSteps([])
    if (task) {
      let alive = true
      void api.todos.get(task.id).then(({ steps: rows }) => { if (alive) setSteps(rows) }).catch(() => { if (alive) setSteps([]) })
      return () => { alive = false }
    }
    return undefined
  }, [open, draft, tasks, completed, timezone])

  const save = async (): Promise<void> => {
    const body = {
      title: title.trim(),
      description: notes,
      priority,
      starred,
      dueAt: dueText ? dueText : null,
      listId: listId || null,
      repeat: repeat === 'none' ? null : { freq: repeat, interval: Math.max(1, Math.min(99, interval)) },
      remind,
      tags: tagNames,
    }
    if (!body.title) return
    if (existing) await updateTask(existing.id, body)
    else await createTask({ ...body, steps: steps.map((step) => step.text) })
    close()
  }

  const remove = async (): Promise<void> => {
    if (!existing) return
    const ok = await confirm({
      title: t('todo.action.delete'),
      description: t('todo.task.delete_hint', { title: existing.title }),
      confirmLabel: t('todo.action.delete'),
      tone: 'danger',
    })
    if (!ok) return
    const snapshot: TaskDraft = {
      title: existing.title,
      description: existing.description,
      priority: existing.priority,
      starred: existing.starred,
      dueAt: existing.dueAt,
      listId: existing.listId,
      repeat: existing.repeat,
      remindAt: existing.remindAt,
      tags: existing.tags.map((tag) => tag.name),
      noteId: existing.noteId,
      conversationId: existing.conversationId,
    }
    const removed = await removeTask(existing.id)
    close()
    if (!removed) return
    useUi.getState().toast({
      title: t('todo.toast.deleted'),
      action: { label: t('todo.action.undo'), run: () => { void restoreTask(snapshot) } },
    })
  }

  const addTag = (): void => {
    const name = tagInput.replace(/^#+/, '').trim()
    if (!name) return
    setTagNames((current) => (current.some((entry) => entry.toLowerCase() === name.toLowerCase()) ? current : [...current, name]))
    setTagInput('')
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? t('todo.task.edit_title') : t('todo.task.new_title')}
      width={560}
      footer={(
        <div className="flex w-full items-center gap-2">
          {existing && (
            <Button variant="danger" size="sm" onClick={() => { void remove() }}>
              <Trash2 size={14} />{t('todo.action.delete')}
            </Button>
          )}
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={close}>{t('todo.action.cancel')}</Button>
          <Button size="sm" disabled={!title.trim() || saving} onClick={() => { void save() }}>{t('todo.action.save')}</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <IconButton
            label={starred ? t('todo.task.unstar') : t('todo.task.star')}
            active={starred}
            size="sm"
            onClick={() => setStarred((value) => !value)}
          >
            <Star size={15} className={starred ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]'} fill={starred ? 'currentColor' : 'none'} />
          </IconButton>
          <Input
            autoFocus
            value={title}
            placeholder={t('todo.task.title_label')}
            aria-label={t('todo.task.title_label')}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }}
            className="flex-1"
          />
        </div>

        <Textarea
          value={notes}
          rows={3}
          placeholder={t('todo.task.notes_label')}
          aria-label={t('todo.task.notes_label')}
          onChange={(event) => setNotes(event.target.value)}
        />

        {/* Where the task came from, and the way back into a conversation about it. Both close the
            panel first: the chat tab is a different container, and a dialog left open over it would
            cover the composer the reader was just handed. */}
        {existing && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { close(); startChatAboutTask(existing) }}>
              <Sparkles size={13} />{t('todo.task.ask_ai')}
            </Button>
            {existing.conversationId && (
              <Button variant="ghost" size="sm" onClick={() => { close(); openConversationInChat(existing.conversationId!) }}>
                <MessagesSquare size={13} />{t('todo.task.from_chat')}
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label={t('todo.task.priority_label')}>
            <Select value={priority} onChange={(event) => setPriority(event.target.value as TodoPriority)}>
              {PRIORITIES.map((entry) => <option key={entry} value={entry}>{t(`todo.priority.${entry}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('todo.task.list_label')}>
            <Select value={listId} onChange={(event) => setListId(event.target.value)}>
              <option value="">{t('todo.smart.inbox')}</option>
              {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
            </Select>
          </Field>
          <Field label={t('todo.task.due_label')}>
            <DatePicker label={t('todo.task.due_label')} value={dueText} withTime onChange={setDueText} />
          </Field>
          <Field label={t('todo.task.remind_label')}>
            <Select value={remind} onChange={(event) => setRemind(event.target.value as RemindOffset)}>
              {REMIND_OFFSETS.map((entry) => <option key={entry} value={entry}>{t(`todo.remind.${entry}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('todo.task.repeat_label')}>
            <div className="flex items-center gap-1.5">
              <Select value={repeat} onChange={(event) => setRepeat(event.target.value as 'none' | RepeatFrequency)}>
                <option value="none">{t('todo.repeat.none')}</option>
                {REPEAT_FREQUENCIES.map((entry) => <option key={entry} value={entry}>{t(`todo.repeat.${entry}`)}</option>)}
              </Select>
              {repeat !== 'none' && (
                <Input
                  type="number"
                  min={1}
                  max={99}
                  value={interval}
                  aria-label={t('todo.repeat.every', { count: interval, unit: '' })}
                  onChange={(event) => setInterval(Number(event.target.value) || 1)}
                  className="w-16"
                />
              )}
            </div>
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.tags_label')}</span>
          <div className="flex flex-wrap items-center gap-1">
            {tagNames.map((name) => {
              const known = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
              return (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11)]"
                  style={{
                    color: known?.color ?? 'var(--text-secondary)',
                    backgroundColor: `color-mix(in oklab, ${known?.color ?? 'var(--text-secondary)'} 12%, transparent)`,
                  }}
                >
                  {name}
                  <button
                    type="button"
                    aria-label={`${t('todo.action.delete')} ${name}`}
                    onClick={() => setTagNames((current) => current.filter((entry) => entry !== name))}
                    className="text-[var(--text-quaternary)] hover:text-[var(--danger)]"
                  >
                    <X size={11} />
                  </button>
                </span>
              )
            })}
            <Input
              value={tagInput}
              list="todo-tag-options"
              placeholder={t('todo.task.tags_label')}
              aria-label={t('todo.task.tags_label')}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addTag() }
              }}
              className="w-32"
            />
            <datalist id="todo-tag-options">
              {tags.map((tag) => <option key={tag.id} value={tag.name} />)}
            </datalist>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('todo.task.steps_label')}</span>
          {steps.length === 0 && <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.task.no_steps')}</span>}
          {steps.map((step) => (
            <div key={step.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={step.done}
                aria-label={step.text}
                onChange={(event) => {
                  const done = event.target.checked
                  setSteps((current) => current.map((entry) => (entry.id === step.id ? { ...entry, done } : entry)))
                  if (existing) void updateStep(existing.id, step.id, { done })
                }}
                className="size-4 accent-[var(--accent)]"
              />
              <span className={cn('min-w-0 flex-1 truncate text-[length:var(--text-12-5)]', step.done && 'text-[var(--text-tertiary)] line-through')}>{step.text}</span>
              <IconButton
                label={t('todo.action.delete')}
                size="sm"
                onClick={() => {
                  setSteps((current) => current.filter((entry) => entry.id !== step.id))
                  if (existing) void removeStep(existing.id, step.id)
                }}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <Input
              value={stepInput}
              placeholder={t('todo.task.step_add')}
              aria-label={t('todo.task.step_add')}
              onChange={(event) => setStepInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                const text = stepInput.trim()
                if (!text) return
                setStepInput('')
                if (existing) {
                  void addStep(existing.id, text).then((step) => {
                    if (step) setSteps((current) => [...current, step])
                  })
                } else {
                  setSteps((current) => [...current, {
                    id: `draft-${current.length}`, taskId: '', text, done: false, position: current.length, createdAt: Date.now(),
                  }])
                }
              }}
            />
            <IconButton label={t('todo.task.step_add')} size="sm" onClick={() => {
              const text = stepInput.trim()
              if (!text) return
              setStepInput('')
              if (existing) {
                void addStep(existing.id, text).then((step) => { if (step) setSteps((current) => [...current, step]) })
              } else {
                setSteps((current) => [...current, {
                  id: `draft-${current.length}`, taskId: '', text, done: false, position: current.length, createdAt: Date.now(),
                }])
              }
            }}>
              <Plus size={13} />
            </IconButton>
          </div>
        </div>
      </div>
    </Modal>
  )
}

type TodoPriority = 'low' | 'medium' | 'high' | 'urgent'
