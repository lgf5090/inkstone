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
import { Menu } from '../../components/overlay'
import { useTodos } from './store'
import { batchMenuVocabulary, buildBatchMenuItems, confirmBatchDelete } from './task-menu'
import type { TaskBatchOp } from '@shared/todos/model'

/** How wide a right-clicked row's batch panel is: as wide as the bar's own widest menu. */
const BATCH_MENU_WIDTH = 200

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

  // The rows come from the same builder a right-clicked row uses, so the bar and that menu cannot offer
  // two different readings of "move this group".
  const vocabulary = batchMenuVocabulary(lists, tags, run)

  const remove = async (): Promise<void> => {
    if (await confirmBatchDelete(count)) run('delete')
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
        items={vocabulary.move}
        align="end"
        width={200}
        label={t('todo.batch.move')}
      />
      <Menu
        anchor={priorityRef}
        open={openMenu === 'priority'}
        onClose={() => setOpenMenu(null)}
        items={vocabulary.priority}
        align="end"
        width={180}
        label={t('todo.batch.priority')}
      />
      <Menu
        anchor={tagRef}
        open={openMenu === 'tag'}
        onClose={() => setOpenMenu(null)}
        items={vocabulary.tag}
        align="end"
        width={200}
        label={t('todo.batch.tag')}
      />
    </div>
  )
}

/**
 * The bar's actions, offered wherever a picked row is right-clicked.
 *
 * The group is what a picked row acts on, so the menu names the count the bar is naming and runs one
 * request over exactly those ids — the same vocabulary the three buttons open, never a second set of
 * batch semantics written for a context menu. It reads the selection from the store rather than from a
 * prop, because a row does not know what the reader picked.
 */
export function BatchContextMenu({ point, onClose }: {
  point: { x: number, y: number } | null
  onClose: () => void
}) {
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const count = useTodos((state) => state.selectedIds.size)
  const batchTasks = useTodos((state) => state.batchTasks)
  if (!point || !count) return null
  return (
    <Menu
      anchor={point}
      open
      onClose={onClose}
      items={buildBatchMenuItems({
        count,
        lists,
        tags,
        onClose,
        run: (op, value) => {
          onClose()
          void batchTasks(op, value)
        },
      })}
      width={BATCH_MENU_WIDTH}
      label={t('todo.a11y.batch_bar')}
    />
  )
}
