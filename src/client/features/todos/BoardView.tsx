/**
 * The board: every list as a card, the way the reference app opens.
 *
 * A card answers one question — what does this list still owe me — so it shows a few open tasks and
 * a `done / total` line, and nothing else. The chips above it are the same lists, because on a phone
 * the board is two columns wide and a list that is not on screen needs a way to be reached.
 */

import { useState } from 'react'
import { ChevronRight, ListChecks, Plus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { KanbanIconBadge } from '../../lib/markdown/kanban/ui/kanban-icon-badge'
import { useTodos } from './store'
import { Input } from '../../components/form'
import { listIconFor } from './todo-ui'
import { TaskCard } from './TaskCard'
import { compareTasks } from './task-groups'
import type { TodoTask } from '@shared/todos/model'

interface BoardCard {
  id: string
  name: string
  icon: string | null
  color: string
  open: number
  done: number
  tasks: TodoTask[]
  listId: string | null
}

const INBOX_ID = 'inbox'

export function BoardView({ onOpenList }: { onOpenList: (listId: string) => void }) {
  const tasks = useTodos((state) => state.tasks)
  const lists = useTodos((state) => state.lists)
  const counts = useTodos((state) => state.counts)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const createTask = useTodos((state) => state.createTask)
  const openEditor = useTodos((state) => state.openEditor)
  const updateTask = useTodos((state) => state.updateTask)
  const [adding, setAdding] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const bounds = { dayEnd, now: Date.now() }
  const cards: BoardCard[] = [
    {
      id: INBOX_ID,
      name: t('todo.smart.inbox'),
      icon: null,
      color: 'var(--text-tertiary)',
      open: counts?.inbox ?? 0,
      done: counts?.byList[INBOX_ID]?.done ?? 0,
      tasks: tasks.filter((task) => task.listId === null).sort(compareTasks),
      listId: null,
    },
    ...lists.map((list) => ({
      id: list.id,
      name: list.name,
      icon: list.icon,
      color: list.color ?? 'var(--accent)',
      open: list.openCount,
      done: list.doneCount,
      tasks: tasks.filter((task) => task.listId === list.id).sort(compareTasks),
      listId: list.id,
    })),
  ]

  const submit = async (card: BoardCard): Promise<void> => {
    const title = draft.trim()
    setDraft('')
    setAdding(null)
    if (!title) return
    await createTask({ title, listId: card.listId })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto px-3 py-2 md:px-5">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onOpenList(card.id)}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--text-12)] md:min-h-0',
              'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]',
              'hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
            )}
          >
            {listIconFor(card.icon) ? <KanbanIconBadge icon={listIconFor(card.icon)} size={12} /> : <ListChecks size={12} style={{ color: card.color }} />}
            <span className="max-w-[140px] truncate">{card.name}</span>
          </button>
        ))}
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-1 md:px-5 md:pb-6">
        {lists.length === 0 && (
          <div className="px-2 py-10 text-center">
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{t('todo.empty.board')}</p>
            <p className="mt-1.5 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('todo.empty.board_hint')}</p>
          </div>
        )}
        <div className="grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" role="list" aria-label={t('todo.a11y.list_cards')}>
          {cards.map((card) => (
            <section
              key={card.id}
              aria-label={card.name}
              className="flex min-w-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
            >
              <button
                type="button"
                onClick={() => onOpenList(card.id)}
                className="flex min-h-11 items-center gap-1.5 px-2.5 py-2 text-left"
                style={{ backgroundColor: `color-mix(in oklab, ${card.color} 10%, transparent)` }}
              >
                {listIconFor(card.icon)
                  ? <KanbanIconBadge icon={listIconFor(card.icon)} size={14} />
                  : <ListChecks size={14} style={{ color: card.color }} />}
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{card.name}</span>
                <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">{card.done}/{card.open + card.done}</span>
                <ChevronRight size={12} className="shrink-0 text-[var(--text-quaternary)]" />
              </button>

              <div className="flex min-h-0 flex-col px-0.5 py-1">
                {card.tasks.slice(0, 3).map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    lists={lists}
                    bounds={bounds}
                    timezone={timezone}
                    compact
                    onOpen={() => openEditor({ id: task.id })}
                    onStar={() => { void updateTask(task.id, { starred: !task.starred }) }}
                  />
                ))}
                {card.tasks.length === 0 && (
                  <p className="px-2.5 py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.empty.list')}</p>
                )}
              </div>

              {adding === card.id ? (
                <div className="px-1.5 pb-1.5">
                  <Input
                    autoFocus
                    value={draft}
                    placeholder={t('todo.task.title_label')}
                    aria-label={t('todo.action.add_task')}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => { void submit(card) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(card) }
                      if (event.key === 'Escape') { setAdding(null); setDraft('') }
                    }}
                    className="h-9 text-[length:var(--text-12)]"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setAdding(card.id); setDraft('') }}
                  className="m-1.5 mt-0 flex min-h-11 items-center justify-center gap-1 rounded-[var(--r-md)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] md:min-h-9"
                  style={{ backgroundColor: `color-mix(in oklab, ${card.color} 8%, transparent)` }}
                >
                  <Plus size={12} />{t('todo.action.add_task')}
                </button>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

