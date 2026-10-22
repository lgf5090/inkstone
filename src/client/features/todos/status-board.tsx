/**
 * One page of tasks read as columns of a derived dimension.
 *
 * A column is not a second place a task is kept: it is what one field of the row says, and the field is
 * the reader's choice — the status, the list, the priority. Which of the three is drawn is worked out
 * from the rows in front of them, so nothing here stores a column, and a task dropped into one has that
 * one field written. The rows themselves are a reading of what the server already scoped: a column keeps
 * the order the page arrived in rather than sorting again.
 *
 * Both halves of the arrangement live in the address (`layout=columns&group=…`), so a reload or a pasted
 * link opens the same screen, and the switch is chrome rather than content when the page is printed. A
 * narrower window draws the ordinary grouped list instead, because columns that have to be scrolled
 * sideways are a worse reading than one.
 */
import { useSearch } from '../../lib/app-history'
import { cn } from '../../lib/cn'
import { useDropState } from '../../lib/drop-state'
import { useMediaQuery } from '../../lib/hooks'
import { Segmented } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { t } from '../../lib/i18n'
import { priorityLabel } from './todo-ui'
import { useTodos } from './store'
import {
  TaskCard,
  isTodoTaskDrag,
  moveTodoTask,
  readTodoTaskDrag,
  useTaskMoves,
  type TaskMoveControls,
} from './TaskCard'
import { TodoPageFooter } from './TodoPageFooter'
import {
  TODO_GROUPS,
  setTodoGroup,
  setTodoLayout,
  todoGroupFromSearch,
  todoLayoutFromSearch,
  type TodoGroup,
  type TodoLayout,
} from './todo-address'
import { BOARD_INBOX_COLUMN, boardColumns, boardColumnKey } from './task-groups'
import type { MessageKey } from '@shared/locales/en-US'
import type { TaskList, TaskPriority, TaskStatus, TodoTask } from '@shared/todos/model'

/** Three columns need a window this wide; below it the list is the honest reading. */
export const LIST_COLUMNS_QUERY = '(min-width: 1024px)'

/**
 * The pointer a drag is worth drawing for.
 *
 * The same one a card reads before it makes itself draggable; a phone gets the card's menu instead, so
 * the two must answer the same question. It is spelled here rather than imported because the card keeps
 * it to itself.
 */
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'

const STATUS_LABEL_KEYS: Record<TaskStatus, MessageKey> = {
  todo: 'todo.status.todo',
  in_progress: 'todo.status.in_progress',
  done: 'todo.status.done',
}

const GROUP_LABEL_KEYS: Record<TodoGroup, MessageKey> = {
  status: 'todo.layout.group.status',
  list: 'todo.layout.group.list',
  priority: 'todo.layout.group.priority',
}

/** The layout the address names for the list on screen. */
export function useListLayout(): TodoLayout {
  const search = useSearch()
  return todoLayoutFromSearch(search)
}

/** The dimension the address names for the columns on screen. */
export function useBoardGroup(): TodoGroup {
  const search = useSearch()
  return todoGroupFromSearch(search)
}

/**
 * The layout switch, and the dimension switch that belongs to it.
 *
 * Neither is store state, so the switches write the address and let the address re-render the screen.
 * `Segmented` is a radiogroup of real buttons, and each option is 44px tall on a touch screen; the
 * dimension is a `SelectMenu`, because three named readings is a pick rather than a toggle. The second
 * control only exists while the columns are up — a dimension beside the plain list would be a control
 * that changes nothing on the screen it stands on.
 */
export function ListLayoutToggle({ layout, group }: { layout: TodoLayout; group: TodoGroup }) {
  return (
    <div data-print="hide" data-todo-layout-toggle="" className="flex flex-wrap items-center justify-end gap-2 px-3 pb-1 pt-2 md:px-5">
      {layout === 'columns' && (
        <SelectMenu
          size="sm"
          className="w-auto min-w-[132px]"
          label={t('todo.layout.group.label')}
          value={group}
          onChange={(next) => setTodoGroup(next)}
          options={TODO_GROUPS.map((value) => ({ value, label: t(GROUP_LABEL_KEYS[value]) }))}
        />
      )}
      <Segmented
        size="sm"
        value={layout}
        onChange={(next) => setTodoLayout(next)}
        label={t('todo.layout.label')}
        options={[
          { value: 'list', label: t('todo.layout.list') },
          { value: 'columns', label: t('todo.layout.columns') },
        ]}
        className="[&_button]:min-h-11"
      />
    </div>
  )
}

/**
 * What one column stands for, as the words the reader knows the field by.
 */
function columnLabel(dimension: TodoGroup, key: string, lists: readonly TaskList[]): string {
  if (dimension === 'status') return t(STATUS_LABEL_KEYS[key as TaskStatus])
  if (dimension === 'priority') return priorityLabel(key as TaskPriority)
  if (key === BOARD_INBOX_COLUMN) return t('todo.smart.inbox')
  return lists.find((list) => list.id === key)?.name ?? t('todo.view.list')
}

/**
 * The rows of the page, split into the columns of one dimension.
 *
 * Every column of the dimension is drawn, empty included: an empty one is still somewhere a task can be
 * dropped, and a column that vanished with its last row would take the door away mid-gesture. Which field
 * a drop writes follows the dimension, and only that field — a status or a priority drop never touches
 * the row's place, and a list drop never keeps the number it had in the list it is leaving.
 */
export function StatusBoard({ tasks, group }: { tasks: readonly TodoTask[]; group: TodoGroup }) {
  const lists = useTodos((state) => state.lists)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const sort = useTodos((state) => state.sort)
  const openEditor = useTodos((state) => state.openEditor)
  const updateTask = useTodos((state) => state.updateTask)
  const listMoves = useTaskMoves(!sort && group !== 'priority')
  const finePointer = useMediaQuery(FINE_POINTER_QUERY)
  const columns = boardColumns(group, tasks, lists)
  const [dropColumn, setDropColumn] = useDropState<string | null>(null)
  const bounds = { dayEnd, now: Date.now() }
  const groupLabel = t(GROUP_LABEL_KEYS[group])

  /**
   * The one write a drop into a column is.
   *
   * A row already in the column writes nothing, because a gesture that changed nothing should not bump
   * the row's revision or reload the page.
   */
  const dropInto = (key: string, draggedId: string): void => {
    const dragged = tasks.find((entry) => entry.id === draggedId)
    if (!dragged) return
    if (group === 'status') {
      if (dragged.status === key) return
      void updateTask(dragged.id, { status: key as TaskStatus })
      return
    }
    if (group === 'priority') {
      if (dragged.priority === key) return
      void updateTask(dragged.id, { priority: key as TaskPriority })
      return
    }
    // The list is the one dimension whose drop moves the row between two manual sequences, and moving
    // between them needs the anchored append: a bare `listId` patch would carry the row's number in the
    // list it leaves into the middle of the destination's own. The inbox is named by a null, not by
    // leaving the field out — leaving it out means "stay where you are".
    const listId = key === BOARD_INBOX_COLUMN ? null : key
    if (dragged.listId === listId) return
    void moveTodoTask(dragged.id, { beforeId: null, listId })
  }

  /**
   * The move controls one row is handed, which is where the dimensions stop being alike.
   *
   * Status and list columns are cut out of the same hand-written sequence the plain list draws, so a row
   * keeps the neighbours its list gives it. A priority column is not: a place belongs to a list and a
   * priority is not one, so here nothing moves up or down and a drop between two rows writes the priority
   * of the column they stand in. The card asks for one control set, so the two refused moves answer with
   * the column the row is already in — which `dropInto` guards to no write at all.
   */
  const moveFor = (task: TodoTask): TaskMoveControls | null => {
    if (group !== 'priority') return listMoves(task)
    const ownColumn = boardColumnKey('priority', task)
    return {
      dragEnabled: finePointer,
      canMoveUp: false,
      canMoveDown: false,
      onMoveUp: () => { dropInto(ownColumn, task.id) },
      onMoveDown: () => { dropInto(ownColumn, task.id) },
      onMoveToList: (listId) => { void moveTodoTask(task.id, { beforeId: null, listId }) },
      onDropBefore: (draggedId) => { dropInto(ownColumn, draggedId) },
      onDropAfter: (draggedId) => { dropInto(ownColumn, draggedId) },
    }
  }

  return (
    <div data-todo-status-board="" data-todo-board-group={group} data-print="hide">
      <div
        role="group"
        aria-label={t('todo.a11y.board', { group: groupLabel })}
        // The columns scroll sideways once the dimension names more of them than fit — a reader with a
        // keyboard and no pointer has to be able to reach the ones off the right edge.
        tabIndex={0}
        className={cn(
          // One column per track, each free to share the room out but none squeezed below what three
          // columns of the old fixed grid were handed — so `status` and `priority` still read as they
          // did, and a dimension that names more columns than fit goes sideways instead of narrow.
          'grid grid-flow-col items-start gap-2.5 overflow-x-auto px-3 pb-4 pt-2 md:px-5',
          'auto-cols-[minmax(12rem,1fr)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        )}
      >
        {columns.map((column) => {
          const label = columnLabel(group, column.key, lists)
          const rows = column.tasks
          const headingId = `todo-board-column-${column.key}`
          return (
            <section
              key={column.key}
              data-todo-board-column={column.key}
              aria-labelledby={headingId}
              onDragOver={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropColumn(column.key)
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropColumn(null)
              }}
              onDrop={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                setDropColumn(null)
                const draggedId = readTodoTaskDrag(event)
                if (draggedId) dropInto(column.key, draggedId)
              }}
              className={cn(
                'flex min-w-0 flex-col overflow-hidden rounded-[var(--r-lg)] border bg-[var(--bg-surface)]',
                dropColumn === column.key ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border-subtle)]',
              )}
            >
              <h2
                id={headingId}
                className="flex items-baseline justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]"
              >
                <span className="min-w-0 truncate">{label}</span>
                <span className="shrink-0 text-[length:var(--text-11)] font-normal tabular-nums text-[var(--text-quaternary)]">{rows.length}</span>
              </h2>
              {rows.length > 0 ? (
                <ul className="px-0.5 py-1">
                  {rows.map((task) => {
                    const move = moveFor(task)
                    return (
                      <li key={task.id}>
                        <TaskCard
                          task={task}
                          lists={lists}
                          bounds={bounds}
                          timezone={timezone}
                          // Every column of this board already names the collection its rows are in, and
                          // the other two dimensions cut a page that is one list's, so a row that named
                          // its list again would be saying the heading.
                          showList={false}
                          onOpen={() => openEditor({ id: task.id })}
                          onStar={() => { void updateTask(task.id, { starred: !task.starred }) }}
                          {...(move ? { move } : {})}
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="px-3 py-8 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                  {t('todo.board.empty_column')}
                </p>
              )}
            </section>
          )
        })}
      </div>
      {/* The limit a priority column cannot show any other way: a card is dragged as a whole, so the
          one thing this dimension refuses would otherwise read as a drag that did nothing. */}
      {group === 'priority' && (
        <p data-todo-board-hint="" className="px-3 pb-2 text-[length:var(--text-11)] text-[var(--text-quaternary)] md:px-5">
          {t('todo.board.priority_hint')}
        </p>
      )}
      {/* Outside the columns, because the rows a page still owes are not one of the rows. */}
      <div className="px-3 pb-16 md:px-5 md:pb-2">
        <TodoPageFooter />
      </div>
    </div>
  )
}
