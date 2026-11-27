/**
 * Search over every article this device holds, not just the channel on screen.
 *
 * The list's own box filters what is loaded; this answers the other question — "where did I see
 * that?" — which a reader asks across months of reading, not one feed. The index is built from the
 * local caches with the bodies dropped, because the search only ever reads a title, a summary and a
 * source name, and a hundred kilobytes of HTML per row would turn a lookup into a stall.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { t } from '../../lib/i18n'
import { shortSince } from '../../lib/time'
import { compileQuery } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { FilterInput } from '../../components/FilterInput'
import { Modal } from '../../components/overlay'
import type { RssEntry } from '@shared/rss/model'
import { parseRssSearchQuery, rssEntryMatchesAdvancedQuery } from '@shared/rss/query'
import { searchEntries, type ScoredEntry } from './search'
import { api } from '../../lib/api'
import { useRss } from './store'

export function RssSearchPanel({ open, onClose, onPick }: {
  open: boolean
  onClose: () => void
  onPick: (entry: RssEntry) => void
}): ReactElement {
  const [term, setTerm] = useState('')
  const [remote, setRemote] = useState<RssEntry[]>([])
  const library = useRss(state => state.library)
  const loadAllCached = useRss(state => state.loadAllCached)
  const index = useRss(state => state.allCached)
  const pinyinVersion = usePinyinVersion()
  const advanced = useMemo(() => parseRssSearchQuery(term), [term])
  const query = useMemo(() => compileQuery(advanced.text), [advanced.text, pinyinVersion])
  const searching = Boolean(advanced.text || advanced.author || advanced.after || advanced.before || advanced.mark)

  useEffect(() => {
    if (!open || index) return
    void loadAllCached()
  }, [open, index, loadAllCached])

  useEffect(() => {
    if (!open || !searching || advanced.error || query.error) return
    let active = true
    const timer = window.setTimeout(() => {
      void api.rss.search(advanced.text, '', {
        field: advanced.field,
        author: advanced.author,
        after: advanced.after,
        before: advanced.before,
        is: advanced.mark ?? '',
      }).then(result => {
        if (active) setRemote(result.articles)
      }).catch((error: unknown) => {
        if (!active) return
        console.warn('[inkstone] RSS server search failed', error)
        setRemote([])
      })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [open, searching, advanced, query.error])

  const results = useMemo(() => {
    if (!searching || advanced.error || query.error) return []
    const names = new Map(library.feeds.map(feed => [feed.id, feed.title]))
    const matches: ScoredEntry[] = index
      ? query.text ? searchEntries(index, query, names).slice(0, 100) : index.map(entry => ({ entry, ranges: [] }))
      : []
    const marks = {
      read: new Set(library.readIds),
      starred: new Set(library.favorites),
      later: new Set(library.readLater),
    }
    const local = matches.filter(item => rssEntryMatchesAdvancedQuery(item.entry, advanced, marks))
    const merged = new Map<string, ScoredEntry>(remote.map(entry => [entry.id, { entry, ranges: [] }]))
    for (const item of local) if (!merged.has(item.entry.id)) merged.set(item.entry.id, item)
    return [...merged.values()].slice(0, 100)
  }, [index, query, library, pinyinVersion, remote, searching, advanced])

  return (
    <Modal open={open} onClose={onClose} title={t('rss.search_all')} width={620}>
      <div className="space-y-3">
        <FilterInput
          size="panel"
          className="mt-0"
          autoFocus
          escapeWhenEmpty="release"
          value={term}
          onChange={setTerm}
          query={query}
          label={t('rss.search_all')}
          placeholder={t('rss.search_all_placeholder')}
        />
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('rss.search_advanced_hint')}</p>
        {!searching && !query.error && (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {index === null ? t('rss.search_indexing') : t('rss.search_idle', { n: index.length })}
          </p>
        )}
        {advanced.error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('rss.search_invalid')}</p>}
        {searching && !advanced.error && !query.error && (
          <ul className="max-h-[52vh] min-h-0 space-y-1 overflow-y-auto">
            {results.map(({ entry }) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(entry)
                    onClose()
                  }}
                  className="w-full rounded-[var(--r-md)] px-2 py-2 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  <span className="block truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                    {entry.title || t('rss.untitled')}
                  </span>
                  <span className="mt-0.5 block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {library.feeds.find(feed => feed.id === entry.feedId)?.title ?? t('rss.source_unknown')}
                    {entry.publishedTs ? ` · ${shortSince(entry.publishedTs)}` : ''}
                  </span>
                  {entry.summary && (
                    <span className="mt-0.5 line-clamp-2 block text-[length:var(--text-11-5)] leading-[16px] text-[var(--text-tertiary)]">
                      {entry.summary}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {!results.length && <li className="px-2 py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('rss.no_results', { query: term })}</li>}
          </ul>
        )}
      </div>
    </Modal>
  )
}
