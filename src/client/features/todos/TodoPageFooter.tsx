/**
 * The end of a page: what the server says is still behind it, and the control that reads the rest.
 *
 * A listing that stopped at its own page limit has to say so. Without this, "no matches" and "the rest of
 * your tasks are not on screen" look identical on a phone, and the second one is the common case: the
 * count comes from the server's `total`, which is measured over the filter on screen rather than over the
 * rows the browser happens to be holding.
 */

import { t } from '../../lib/i18n'
import { remainingCount, useTodos } from './store'

export function TodoPageFooter() {
  const remaining = useTodos(remainingCount)
  const loadMore = useTodos((state) => state.loadMore)
  const loadingMore = useTodos((state) => state.loadingMore)
  if (remaining <= 0) return null

  return (
    <div className="flex justify-center px-1 py-3">
      <button
        type="button"
        data-todo-more=""
        onClick={() => { void loadMore() }}
        disabled={loadingMore}
        className="flex min-h-11 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60"
      >
        {loadingMore
          ? t('common.loading')
          : `${t('todo.load_more')} · ${t('todo.remaining', { count: remaining })}`}
      </button>
    </div>
  )
}
