/**
 * The bar that appears once a reader has picked out tasks.
 *
 * Selection is a mode rather than a checkbox on every row: the bar is what makes the mode legible — it
 * says how many rows are picked and every action it offers acts on exactly those, through one batch
 * request. It is deliberately not the chat's `SelectionBar`: that one speaks `AssistantMessage`, and a
 * shared bar would either widen the chat's contract for the to-do app's sake or make this one pretend
 * every task is a message.
 *
 * The three menus are made of the vocabulary the screens already have — the account's lists, its four
 * priorities and its tags — so a batch cannot create a list or a tag in a shape the editor would not.
 */

import { useRef, useState } from 'react'
import { Check, Flag, FolderInput, Tag, Trash2, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Menu, confirm, type MenuItem } from '../../components/overlay'
import { useTodos } from './store'
import { priorityLabel } from './todo-ui'
import type { TaskBatchOp, TaskPriority } from '@shared/todos/model'

const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent']

type OpenMenu = 'move' | 'priority' | 'tag' | null

export function BatchBar() {
  const selectedIds = useTodos((state) => state.selectedIds)
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const batchTasks = useTodos((state) => state.batchTasks)
  const clearSelection = useTodos((state) => state.clearSelection)
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const moveRef = useRef<HTMLButtonElement>(null)
  const priorityRef = useRef<HTMLButtonElement>(null)
  const tagRef = useRef<HTMLButtonElement>(null)

  const count = selectedIds.size
  if (!count) return null

  const run = (op: TaskBatchOp, value?: string | string[] | null): void => {
    setOpenMenu(null)
    void batchTasks(op, value)
  }

  const moveItems: MenuItem[] = [
    { id: 'inbox', label: t('todo.smart.inbox'), onSelect: () => run('move', null) },
    ...lists.map((list) => ({ id: list.id, label: list.name, onSelect: () => run('move', list.id) })),
  ]
  const priorityItems: MenuItem[] = PRIORITIES.map((priority) => ({
    id: priority,
    label: priorityLabel(priority),
    onSelect: () => run('priority', priority),
  }))
  const tagItems: MenuItem[] = tags.length
    ? tags.map((tag) => ({ id: tag.id, label: tag.name, onSelect: () => run('tag', tag.name) }))
    : [{ id: 'none', label: t('todo.batch.no_tags'), disabled: true }]

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('todo.batch.delete'),
      description: t('todo.batch.delete_hint', { count }),
      confirmLabel: t('todo.action.delete'),
      tone: 'danger',
    })
    if (ok) run('delete')
  }

  return (
    <div
      role="toolbar"
      aria-label={t('todo.a11y.batch_bar')}
      data-todo-batch-bar=""
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5 md:px-3"
    >
      <span aria-live="polite" className="px-1 text-[length:var(--text-12)] tabular-nums text-[var(--text-secondary)]">
        {t('todo.batch.selected', { count })}
      </span>
      <Button size="sm" variant="ghost" onClick={() => run('complete')}>
        <Check size={13} />{t('todo.batch.complete')}
      </Button>
      <Button
        ref={moveRef}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'move'}
        onClick={() => setOpenMenu(openMenu === 'move' ? null : 'move')}
      >
        <FolderInput size={13} />{t('todo.batch.move')}
      </Button>
      <Button
        ref={priorityRef}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'priority'}
        onClick={() => setOpenMenu(openMenu === 'priority' ? null : 'priority')}
      >
        <Flag size={13} />{t('todo.batch.priority')}
      </Button>
      <Button
        ref={tagRef}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'tag'}
        onClick={() => setOpenMenu(openMenu === 'tag' ? null : 'tag')}
      >
        <Tag size={13} />{t('todo.batch.tag')}
      </Button>
      <Button size="sm" variant="ghost" className="text-[var(--danger)]" onClick={() => { void remove() }}>
        <Trash2 size={13} />{t('todo.batch.delete')}
      </Button>
      <span className="flex-1" />
      <IconButton size="sm" label={t('todo.batch.exit')} onClick={clearSelection}>
        <X size={14} />
      </IconButton>

      <Menu
        anchor={moveRef}
        open={openMenu === 'move'}
        onClose={() => setOpenMenu(null)}
        items={moveItems}
        align="end"
        width={200}
        label={t('todo.batch.move')}
      />
      <Menu
        anchor={priorityRef}
        open={openMenu === 'priority'}
        onClose={() => setOpenMenu(null)}
        items={priorityItems}
        align="end"
        width={180}
        label={t('todo.batch.priority')}
      />
      <Menu
        anchor={tagRef}
        open={openMenu === 'tag'}
        onClose={() => setOpenMenu(null)}
        items={tagItems}
        align="end"
        width={200}
        label={t('todo.batch.tag')}
      />
    </div>
  )
}
