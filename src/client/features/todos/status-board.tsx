/**
 * One list read as three status columns, and the switch that asks for it.
 *
 * This is a reading of rows the server already scoped, not a second listing: the page arrives in the
 * order the chosen sort states, and a column keeps that order rather than sorting again. The split is
 * offered only where three columns fit; a narrower window draws the ordinary grouped list. The
 * arrangement lives in the address (`layout=columns`), so a reload or a pasted link opens the same
 * screen, and the switch is chrome rather than content when the page is printed.
 */
import { useSearch } from '../../lib/app-history'
import { Segmented } from '../../components/form'
import { t } from '../../lib/i18n'
import { useTodos } from './store'
import { TaskCard, useTaskMoves } from './TaskCard'
import { TodoPageFooter } from './TodoPageFooter'
import { setTodoLayout, todoLayoutFromSearch, type TodoLayout } from './todo-address'
import type { MessageKey } from '@shared/locales/en-US'
import type { TaskStatus, TodoTask } from '@shared/todos/model'

/** Three columns need a window this wide; below it the list is the honest reading. */
export const LIST_COLUMNS_QUERY = '(min-width: 1024px)'

/** The three states a task can be in, in the order the columns are read. */
const STATUS_COLUMNS: readonly TaskStatus[] = ['todo', 'in_progress', 'done']

const STATUS_LABEL_KEYS: Record<TaskStatus, MessageKey> = {
  todo: 'todo.status.todo',
  in_progress: 'todo.status.in_progress',
  done: 'todo.status.done',
}

/** The layout the address names for the list on screen. */
export function useListLayout(): TodoLayout {
  const search = useSearch()
  return todoLayoutFromSearch(search)
}

/**
 * The list/columns switch.
 *
 * The layout is not store state, so the switch writes the address and lets the address re-render the
 * screen. `Segmented` is a radiogroup of real buttons, and each option is 44px tall on a touch screen.
 */
export function ListLayoutToggle({ layout }: { layout: TodoLayout }) {
  return (
    <div data-print="hide" data-todo-layout-toggle="" className="flex justify-end px-3 pb-1 pt-2 md:px-5">
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
 * One list split by status.
 *
 * The rows are grouped by a single pass over the page, so their relative order is the server's
 * everywhere; a column with nothing in it says so rather than looking like a failed read.
 */
export function StatusBoard({ tasks }: { tasks: readonly TodoTask[] }) {
  const lists = useTodos((state) => state.lists)
  const dayEnd = useTodos((state) => state.dayEnd)
  const timezone = useTodos((state) => state.timezone)
  const sort = useTodos((state) => state.sort)
  const openEditor = useTodos((state) => state.openEditor)
  const updateTask = useTodos((state) => state.updateTask)
  const moveFor = useTaskMoves(!sort)
  const bounds = { dayEnd, now: Date.now() }

  return (
    <div role="group" aria-label={t('todo.a11y.status_board')} data-todo-status-board="" data-print="hide">
      <div className="grid grid-cols-3 items-start gap-2.5 px-3 pb-6 pt-2 md:px-5">
        {STATUS_COLUMNS.map((status) => {
          const label = t(STATUS_LABEL_KEYS[status])
          const rows = tasks.filter((task) => task.status === status)
          return (
            <section
              key={status}
              data-todo-status-column={status}
              aria-labelledby={`todo-status-column-${status}`}
              className="min-w-0 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
            >
              <h2
                id={`todo-status-column-${status}`}
                className="flex items-baseline justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]"
              >
                <span className="min-w-0 truncate">{label}</span>
                <span className="shrink-0 text-[length:var(--text-11)] font-normal tabular-nums text-[var(--text-quaternary)]">{rows.length}</span>
              </h2>
              {rows.length > 0 ? (
                <ul className="px-0.5 py-1">
                  {rows.map((task) => (
                    <li key={task.id}>
                      <TaskCard
                        task={task}
                        lists={lists}
                        bounds={bounds}
                        timezone={timezone}
                        showList={false}
                        onOpen={() => openEditor({ id: task.id })}
                        onStar={() => { void updateTask(task.id, { starred: !task.starred }) }}
                        {...(moveFor(task) ? { move: moveFor(task)! } : {})}
                      />
                    </li>
                  ))}
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
      {/* Outside the columns, because the rows a page still owes are not one of the rows. */}
      <div className="px-3 pb-16 md:px-5 md:pb-2">
        <TodoPageFooter />
      </div>
    </div>
  )
}
