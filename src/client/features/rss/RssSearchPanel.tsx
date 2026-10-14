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
import { searchEntries } from './search'
import { useRss } from './store'

export function RssSearchPanel({ open, onClose, onPick }: {
  open: boolean
  onClose: () => void
  onPick: (entry: RssEntry) => void
}): ReactElement {
  const [term, setTerm] = useState('')
  const [index, setIndex] = useState<RssEntry[] | null>(null)
  const library = useRss(state => state.library)
  const loadAllCached = useRss(state => state.loadAllCached)
  const pinyinVersion = usePinyinVersion()
  const query = useMemo(() => compileQuery(term), [term, pinyinVersion])

  useEffect(() => {
    if (!open || index) return
    void loadAllCached().then(setIndex)
  }, [open, index, loadAllCached])

  const results = useMemo(() => {
    if (!index || !query.text || query.error) return []
    const names = new Map(library.feeds.map(feed => [feed.id, feed.title]))
    return searchEntries(index, query, names).slice(0, 100)
  }, [index, query, library.feeds, pinyinVersion])

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
        {!query.text && !query.error && (
          <p className="text-[12px] text-[var(--text-tertiary)]">
            {index === null ? t('rss.search_indexing') : t('rss.search_idle', { n: index.length })}
          </p>
        )}
        {query.text && !query.error && (
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
                  <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                    {entry.title || t('rss.untitled')}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--text-quaternary)]">
                    {library.feeds.find(feed => feed.id === entry.feedId)?.title ?? t('rss.source_unknown')}
                    {entry.publishedTs ? ` · ${shortSince(entry.publishedTs)}` : ''}
                  </span>
                  {entry.summary && (
                    <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-[16px] text-[var(--text-tertiary)]">
                      {entry.summary}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {!results.length && <li className="px-2 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('rss.no_results', { query: term })}</li>}
          </ul>
        )}
      </div>
    </Modal>
  )
}
