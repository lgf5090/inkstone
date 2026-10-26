/**
 * Find one of the account's own tasks by title, for a field that names it.
 *
 * The editor asks this question twice — which task should this one wait on, and which task should this
 * one sit under — so the finder lives in one place rather than being drawn twice with two slightly
 * different failure lines. The store's own search is the door: it already knows the server's shape and
 * the debounce the rest of the app pays for, and the task worth naming is usually not one currently on
 * screen. Three answers are owed and all three are said: a search in flight, one that found nothing, and
 * one that was refused — an empty list would otherwise read as "no such task exists".
 */
import { useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { isImeComposing } from '../../lib/ime'
import { useTodos } from './store'
import type { TaskRef } from '@shared/todos/model'

/** How many hits one search puts on the page. More is a list to read, not a choice to make. */
const FIND_LIMIT = 8

export function TaskFinder({ findLabel, statusId, excludeIds, onPick }: {
  /** The input's own label and placeholder: what the field is looking for. */
  findLabel: string
  statusId: string
  /** Rows the field cannot name — itself, and whatever it already holds. */
  excludeIds: readonly string[]
  onPick: (task: TaskRef) => void
}) {
  const searchTasks = useTodos((state) => state.searchTasks)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TaskRef[]>([])
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)

  const find = async (): Promise<void> => {
    const words = query.trim()
    if (!words || searching) return
    setSearching(true)
    setFailed(false)
    try {
      const excluded = new Set(excludeIds)
      const found = await searchTasks(words)
      setResults(found
        .filter((task) => !excluded.has(task.id))
        .slice(0, FIND_LIMIT)
        .map((task) => ({ id: task.id, title: task.title, status: task.status })))
    } catch (error) {
      // The refusal is said rather than swallowed into the empty case.
      console.warn('[inkstone] The task finder could not search:', error)
      setResults([])
      setFailed(true)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          value={query}
          placeholder={findLabel}
          aria-label={findLabel}
          aria-describedby={statusId}
          leading={<Search size={12} />}
          className="min-w-0 flex-1"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || isImeComposing(event)) return
            event.preventDefault()
            void find()
          }}
        />
        <Button size="sm" variant="subtle" onClick={() => { void find() }}>{t('todo.action.search')}</Button>
      </div>
      <p id={statusId} role="status" className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        {searching && t('common.loading')}
        {!searching && failed && t('todo.toast.failed')}
        {!searching && !failed && query.trim() && results.length === 0 && t('todo.empty.search')}
      </p>
      {results.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {results.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit)
                  setResults([])
                  setQuery('')
                }}
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <Plus size={11} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{hit.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
