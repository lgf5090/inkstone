/**
 * Which subscriptions are actually being read.
 *
 * A reader who adds forty feeds reads ten of them, and the list is the only place that shows the
 * gap. The reference reader put this behind a modal in the subscription centre; it lives in the
 * settings section here because the decision it supports — unsubscribe, or leave it — is a
 * maintenance decision, and the table is next to the cache size it explains.
 *
 * Unsubscribing arms first: one press says "Unsubscribe?" and the same row's second press does it.
 * A confirmation dialog for a row the reader can already see is a heavier interrupt than the act
 * deserves, and the favourites and notes they made stay whatever happens.
 */
import { useState, type ReactElement } from 'react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { shortSince } from '../../lib/time'
import type { RssEntry, RssLibrary } from '@shared/rss/model'
import { useRss, type RssCacheMeta } from './store'

export interface SourceHealthRow {
  id: string
  name: string
  group: string
  cached: number | null
  opened: number | null
  last: number | null
}

const DAY_MS = 86_400_000

export function sourceHealthRows(
  library: RssLibrary,
  articles: Record<string, RssEntry[]>,
  cache: Record<string, RssCacheMeta>,
): SourceHealthRow[] {
  return library.feeds.map(feed => {
    const loaded = articles[feed.id]
    const entries = loaded ?? []
    let opened: number | null = null
    let last: number | null = null
    if (loaded) {
      opened = 0
      for (const entry of entries) {
        const at = library.opened[entry.id]
        if (at) {
          opened++
          if (at > (last ?? 0)) last = at
        }
      }
    }
    return {
      id: feed.id,
      name: feed.title,
      group: library.groups.find(group => group.id === feed.groupId)?.name ?? t('rss.ungrouped'),
      cached: loaded ? entries.length : cache[feed.id]?.count ?? null,
      opened,
      last,
    }
  }).sort((a, b) => (b.opened ?? -1) - (a.opened ?? -1) || (b.last ?? 0) - (a.last ?? 0) || a.name.localeCompare(b.name))
}

export function SourceHealth(): ReactElement | null {
  const library = useRss(state => state.library)
  const articles = useRss(state => state.articles)
  const cache = useRss(state => state.cache)
  const removeFeed = useRss(state => state.removeFeed)
  const [armed, setArmed] = useState<string | null>(null)
  if (!library.feeds.length) return null

  const rows = sourceHealthRows(library, articles, cache)
  const sleeping = rows.filter(row => row.opened !== null
    && (row.opened === 0 || (row.last !== null && Date.now() - row.last > 30 * DAY_MS))).length
  const groupNames = new Map(library.groups.map(group => [group.id, group.name]))

  return (
    <section>
      <h3 className="mb-1 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('rss.health')}</h3>
      <div className="mb-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('rss.health.summary', { n: rows.length, sleeping })}
      </div>
      <div className="max-h-[280px] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)]">
        <table className="w-full border-collapse text-[length:var(--text-12)]">
          <thead className="sticky top-0 bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">{t('rss.health.col.source')}</th>
              <th className="px-2 py-1.5 text-left font-medium">{t('rss.health.col.group')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('rss.health.col.articles')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('rss.health.col.opened')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('rss.health.col.last')}</th>
              <th aria-label={t('rss.unsubscribe')} className="w-16 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className="border-t border-[var(--border-subtle)]">
                <td className="max-w-[180px] truncate px-2 py-1.5 text-[var(--text-primary)]">{row.name}</td>
                <td className="px-2 py-1.5 text-[var(--text-tertiary)]">{groupNames.get(row.group) ?? row.group}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{row.cached ?? '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{row.opened ?? '—'}</td>
                <td className="px-2 py-1.5 text-right text-[var(--text-tertiary)]">{row.last ? shortSince(row.last) : row.opened === null ? '—' : t('rss.health.never')}</td>
                <td className="px-2 py-1 text-right">
                  {row.opened !== null && row.opened > 0 && row.last !== null && Date.now() - row.last <= 30 * DAY_MS
                    ? null
                    : (
                        <button
                          type="button"
                          onClick={() => {
                            if (armed !== row.id) {
                              setArmed(row.id)
                              return
                            }
                            setArmed(null)
                            removeFeed(row.id)
                          }}
                          className={cn(
                            'rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11)]',
                            armed === row.id
                              ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                              : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
                          )}
                        >
                          {armed === row.id ? t('rss.health.confirm') : t('rss.unsubscribe')}
                        </button>
                      )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
