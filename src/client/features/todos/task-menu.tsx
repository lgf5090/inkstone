/**
 * The rows a task's menus offer, built once.
 *
 * The card's kebab button and a right-click answer with the same list — the right-click opens with a
 * schedule strip above it — because two copies of the same actions drift the first time somebody adds a
 * row to only one of them. Every row here is a `MenuItem`, so the roles, the roving focus and the escape
 * route come from the shared overlay rather than from anything invented beside it.
 *
 * The quick rows name a *day*, never an instant: the store and the route both read a bare `YYYY-MM-DD`
 * as the end of that day in the account zone (`assistant-time`'s `parseLocalTime`, the same reading
 * `quick-parse.ts` gives a date typed into the quick-add bar). Nothing here repeats a 23:59 of its own.
 */

import { ArrowDown, ArrowUp, CalendarDays, CalendarOff, Check, Flag, FolderInput, Tag, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { addDaysKey } from '../../lib/time'
import { localDate } from '@shared/assistant-time'
import { DatePicker } from '../../components/date-picker'
import { MenuSubmenuList, confirm, type MenuItem } from '../../components/overlay'
import { dueValue, priorityLabel } from './todo-ui'
import { snoozeLabel } from './store'
import {
  SNOOZE_MINUTES,
  type SnoozeMinutes,
  type TaskBatchOp,
  type TaskList,
  type TaskPriority,
  type TaskTag,
  type TodoTask,
} from '@shared/todos/model'
import type { MessageKey } from '@shared/locales/en-US'
import type { TaskMoveControls } from './TaskCard'

/** The four priorities a batch may set, in the order the bar has always listed them. */
const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent']

/**
 * The days the strip names, as a shift from the reader's own today. The last is a week out rather than
 * the next Monday, because that is what the editor's quick chip of the same name already writes.
 */
const QUICK_DAYS: readonly { id: string; label: MessageKey; days: number }[] = [
  { id: 'due-today', label: 'todo.date.today', days: 0 },
  { id: 'due-tomorrow', label: 'todo.date.tomorrow', days: 1 },
  { id: 'due-next-week', label: 'todo.date.next_week', days: 7 },
]

/**
 * What a menu row needs in order to write.
 *
 * `update` is the store's own patch call, so every row lands on the one route a card has: the menu is a
 * second way to reach a write, never a second write.
 */
export interface TaskMenuHandlers {
  /** The account's zone and clock, both read from the listing the row arrived on. */
  timezone: string
  now: number
  lists: readonly TaskList[]
  /** Absent where the order is not the reader's — the plan groups by day, an explicit sort has its own. */
  move?: TaskMoveControls
  onClose: () => void
  update: (patch: Record<string, unknown>) => void
  /** Left out for a task that has nothing left to be reminded about. */
  snooze?: (minutes: SnoozeMinutes) => void
}

/** The day a quick row writes: the reader's own calendar day, moved by whole days. */
function quickDueDay(handlers: Pick<TaskMenuHandlers, 'timezone' | 'now'>, days: number): string {
  return addDaysKey(localDate(handlers.now, handlers.timezone), days)
}

/**
 * The strip a right-click opens with: put this row on a day, or take the day off it.
 *
 * The three quick days write a bare day and let the server read it. Selecting a date hands the row to the
 * shared picker rather than to a calendar of our own, and the picker comes as it is written for the
 * editor: a field in a flyout whose day grid is the one every date field in the app already uses.
 */
export function buildScheduleMenuItems(task: TodoTask, handlers: TaskMenuHandlers): MenuItem[] {
  const items: MenuItem[] = QUICK_DAYS.map((entry) => ({
    id: entry.id,
    label: t(entry.label),
    onSelect: () => {
      handlers.onClose()
      handlers.update({ dueAt: quickDueDay(handlers, entry.days) })
    },
  }))

  items.push({
    id: 'due-pick',
    label: t('todo.date.pick'),
    icon: <CalendarDays size={13} />,
    submenu: ({ closeMenu }) => (
      <DatePicker
        className="w-64"
        label={t('todo.task.due_label')}
        value={dueValue(task.dueAt, handlers.timezone)}
        onChange={(dateStr) => {
          closeMenu()
          handlers.update({ dueAt: dateStr || null })
        }}
      />
    ),
  })

  // A row with no date has nothing to take off, and a row that offered it would be a button that lies.
  if (task.dueAt !== null) {
    items.push({
      id: 'due-clear',
      label: t('todo.date.clear'),
      icon: <CalendarOff size={13} />,
      onSelect: () => {
        handlers.onClose()
        handlers.update({ dueAt: null })
      },
    })
  }

  return items
}

/** The rows the kebab has always offered: the status the reader can move to, the moves, the reminders. */
export function buildTaskMenuItems(task: TodoTask, handlers: TaskMenuHandlers): MenuItem[] {
  const { lists, move, onClose, update, snooze } = handlers

  // The same four durations the editor and the notification row offer, so "10 minutes" means one thing
  // wherever the reader reads it. The status rows come first, and the rule between them is what keeps
  // "start this" from reading as one more snooze preset.
  const statusItems: MenuItem[] = task.status === 'in_progress'
    ? [{
        id: 'status-todo',
        label: t('todo.status.mark_todo'),
        onSelect: () => {
          onClose()
          update({ status: 'todo' })
        },
      }]
    : task.status === 'todo'
      ? [{
          id: 'status-in-progress',
          label: t('todo.status.mark_in_progress'),
          onSelect: () => {
            onClose()
            update({ status: 'in_progress' })
          },
        }]
      : []

  // The manual-order rows. They live in the menu rather than on a draggable handle alone because a
  // phone cannot drag and a keyboard never could: this is the equivalent path, not a secondary one.
  const moveTargets: { id: string; name: string }[] = move
    ? [
        ...(task.listId !== null ? [{ id: 'inbox', name: t('todo.smart.inbox') }] : []),
        ...lists
          .filter((entry) => entry.id !== task.listId)
          .map((entry) => ({ id: entry.id, name: entry.name })),
      ]
    : []
  const moveItems: MenuItem[] = move
    ? [
        {
          id: 'move-up',
          label: t('todo.move.up'),
          icon: <ArrowUp size={13} />,
          disabled: !move.canMoveUp,
          separatorBefore: statusItems.length > 0,
          onSelect: () => {
            onClose()
            move.onMoveUp()
          },
        },
        {
          id: 'move-down',
          label: t('todo.move.down'),
          icon: <ArrowDown size={13} />,
          disabled: !move.canMoveDown,
          onSelect: () => {
            onClose()
            move.onMoveDown()
          },
        },
        {
          id: 'move-to-list',
          label: t('todo.move.to_list'),
          icon: <FolderInput size={13} />,
          disabled: moveTargets.length === 0,
          submenu: ({ closeMenu }) => (
            <MenuSubmenuList
              label={t('todo.move.to_list')}
              items={moveTargets.map((target) => ({
                id: `move-to-${target.id}`,
                label: target.name,
                onSelect: () => {
                  closeMenu()
                  move.onMoveToList(target.id === 'inbox' ? null : target.id)
                },
              }))}
            />
          ),
        },
      ]
    : []

  const snoozeItems: MenuItem[] = snooze
    ? SNOOZE_MINUTES.map((minutes, index) => ({
        id: `snooze-${minutes}`,
        label: snoozeLabel(minutes),
        separatorBefore: index === 0 && statusItems.length + moveItems.length > 0,
        onSelect: () => {
          onClose()
          snooze(minutes)
        },
      }))
    : []

  return [...statusItems, ...moveItems, ...snoozeItems]
}

/**
 * What a right-click answers with: the strip, then the kebab's rows.
 *
 * One rule separates the two groups — the row that starts the second one carries it — so a card that
 * finished the strip and found nothing else to offer still shows a list without a stray divider.
 */
export function buildTaskContextMenuItems(task: TodoTask, handlers: TaskMenuHandlers): MenuItem[] {
  const schedule = buildScheduleMenuItems(task, handlers)
  const rows = buildTaskMenuItems(task, handlers)
  const [first, ...rest] = rows
  return first
    ? [...schedule, { ...first, separatorBefore: true }, ...rest]
    : schedule
}

/** What a batch row has to do: one request naming the ids the reader picked. */
export interface BatchMenuHandlers {
  count: number
  lists: readonly TaskList[]
  tags: readonly TaskTag[]
  onClose: () => void
  run: (op: TaskBatchOp, value?: string | string[] | null) => void
}

/**
 * The three vocabularies a batch is made of, as flat rows.
 *
 * The bar shows each of them under its own button and a context menu shows them under a submenu, so the
 * words, the ids and the request live here and neither surface writes its own copy of the list.
 */
export function batchMenuVocabulary(
  lists: readonly TaskList[],
  tags: readonly TaskTag[],
  run: (op: TaskBatchOp, value?: string | string[] | null) => void,
): { move: MenuItem[]; priority: MenuItem[]; tag: MenuItem[] } {
  return {
    move: [
      { id: 'inbox', label: t('todo.smart.inbox'), onSelect: () => { run('move', null) } },
      ...lists.map((list) => ({ id: list.id, label: list.name, onSelect: () => { run('move', list.id) } })),
    ],
    priority: PRIORITIES.map((priority) => ({
      id: priority,
      label: priorityLabel(priority),
      onSelect: () => { run('priority', priority) },
    })),
    tag: tags.length
      ? tags.map((entry) => ({ id: entry.id, label: entry.name, onSelect: () => { run('tag', entry.name) } }))
      : [{ id: 'none', label: t('todo.batch.no_tags'), disabled: true }],
  }
}

/** The bar's delete question, so a menu and a toolbar ask it in exactly the same words. */
export async function confirmBatchDelete(count: number): Promise<boolean> {
  return confirm({
    title: t('todo.batch.delete'),
    description: t('todo.batch.delete_hint', { count }),
    confirmLabel: t('todo.action.delete'),
    tone: 'danger',
  })
}

/** One picked group's actions as a menu: the bar's set, not a second one invented for a right-click. */
export function buildBatchMenuItems(handlers: BatchMenuHandlers): MenuItem[] {
  const { count, onClose, run } = handlers
  const vocabulary = batchMenuVocabulary(handlers.lists, handlers.tags, run)

  return [
    {
      id: 'batch-complete',
      label: t('todo.batch.complete'),
      icon: <Check size={13} />,
      onSelect: () => { run('complete') },
    },
    {
      id: 'batch-move',
      label: t('todo.batch.move'),
      icon: <FolderInput size={13} />,
      submenu: () => <MenuSubmenuList label={t('todo.batch.move')} items={vocabulary.move} />,
    },
    {
      id: 'batch-priority',
      label: t('todo.batch.priority'),
      icon: <Flag size={13} />,
      submenu: () => <MenuSubmenuList label={t('todo.batch.priority')} items={vocabulary.priority} />,
    },
    {
      id: 'batch-tag',
      label: t('todo.batch.tag'),
      icon: <Tag size={13} />,
      submenu: () => <MenuSubmenuList label={t('todo.batch.tag')} items={vocabulary.tag} />,
    },
    {
      id: 'batch-delete',
      label: t('todo.batch.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => {
        onClose()
        // The question is asked after the menu is gone: a modal that opens under a floating panel is
        // a reader choosing between two layers they cannot both see.
        void confirmBatchDelete(count).then((ok) => {
          if (ok) run('delete')
        })
      },
    },
  ]
}
