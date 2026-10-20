/**
 * The bar that states how the listing is read, for both layouts.
 *
 * It sits under the header rather than in the desktop toolbar: a phone is where "most urgent first"
 * is most likely to be wanted, and a control only one layout can reach is half a control. The order
 * shown when the address names none is the order the server itself reads for the view on screen, so
 * the default a reader sees is the default the route applies rather than a second answer.
 */
import { TASK_SORTS, type TaskSort } from '@shared/todos/model'
import type { MessageKey } from '@shared/locales/en-US'
import { Select } from '../../components/form'
import { t } from '../../lib/i18n'
import { useTodos, type TodoView } from './store'

const SORT_LABELS: Record<TaskSort, MessageKey> = {
  due: 'todo.sort.due',
  priority: 'todo.sort.priority',
  created: 'todo.sort.created',
  completed: 'todo.sort.completed',
}

/** The order the route reads a view in when the address names none. */
export function defaultSortFor(view: TodoView): TaskSort {
  return view === 'completed' ? 'completed' : 'due'
}

export function TodoFilters() {
  const view = useTodos((state) => state.view)
  const sort = useTodos((state) => state.sort)
  const setSort = useTodos((state) => state.setSort)

  return (
    <div data-todo-filters="" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5 md:px-5">
      <Select
        aria-label={t('todo.filter.sort')}
        value={sort ?? defaultSortFor(view)}
        onChange={(event) => setSort(event.target.value as TaskSort)}
        className="w-auto"
      >
        {TASK_SORTS.map((key) => <option key={key} value={key}>{t(SORT_LABELS[key])}</option>)}
      </Select>
    </div>
  )
}
