/**
 * The bar that states how the listing is read, for both layouts.
 *
 * It sits under the header rather than in the desktop toolbar: a phone is where "most urgent first"
 * is most likely to be wanted, and a control only one layout can reach is half a control. The order
 * shown when the address names none is the order the server itself reads for the view on screen, so
 * the default a reader sees is the default the route applies rather than a second answer.
 *
 * The due window is the same bargain: the presets are calendar arithmetic (`due-range.ts`) turned
 * into the half-open bounds the route reads, and the two date fields are the same bounds spelled as
 * the inclusive days a reader picks. Every move is written to the address and asked of the server;
 * nothing here filters the page the browser happens to hold.
 */
import { useState } from 'react'
import { localDate } from '@shared/assistant-time'
import { TASK_SORTS, type TaskSort } from '@shared/todos/model'
import type { MessageKey } from '@shared/locales/en-US'
import { Input, Select } from '../../components/form'
import { t } from '../../lib/i18n'
import { boundDay, daysToRange, endDayOf, presetOf, presetRange, type DueRangePreset, type DuePreset } from './due-range'
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
  const timezone = useTodos((state) => state.timezone)
  const dueFrom = useTodos((state) => state.dueFrom)
  const dueTo = useTodos((state) => state.dueTo)
  const setDueRange = useTodos((state) => state.setDueRange)
  // Opening the two date fields is a view of the control, not a filter by itself: a reader who picks
  // "custom" with nothing entered has asked for a form, not for an empty window.
  const [customOpen, setCustomOpen] = useState(() => presetOf(dueFrom, dueTo, localDate(Date.now(), timezone)) === 'custom')
  const today = localDate(Date.now(), timezone)
  const duePreset: DueRangePreset = customOpen ? 'custom' : presetOf(dueFrom, dueTo, today)

  const onDuePreset = (value: DueRangePreset): void => {
    if (value === 'custom') { setCustomOpen(true); return }
    setCustomOpen(false)
    setDueRange(value === 'any' ? { from: null, to: null } : presetRange(value as DuePreset, today))
  }

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
      <Select
        aria-label={t('todo.filter.due')}
        value={duePreset}
        onChange={(event) => onDuePreset(event.target.value as DueRangePreset)}
        className="w-auto"
      >
        <option value="any">{t('todo.due.any')}</option>
        <option value="today">{t('todo.smart.today')}</option>
        <option value="week">{t('todo.due.week')}</option>
        <option value="next30">{t('todo.due.next30')}</option>
        <option value="custom">{t('todo.due.custom')}</option>
      </Select>
      {duePreset === 'custom' && (
        <>
          <Input
            type="date"
            aria-label={t('todo.due.from')}
            value={boundDay(dueFrom)}
            onChange={(event) => setDueRange(daysToRange(event.target.value, endDayOf(dueTo)))}
            className="w-auto"
          />
          <Input
            type="date"
            aria-label={t('todo.due.to')}
            value={endDayOf(dueTo)}
            onChange={(event) => setDueRange(daysToRange(boundDay(dueFrom), event.target.value))}
            className="w-auto"
          />
        </>
      )}
    </div>
  )
}
