/**
 * The book's own table of contents.
 *
 * The entries come from the file rather than from what the reader has seen: an EPUB's nav document names
 * sections the spine may reach mid-document, so the target is resolved to a chapter here rather than
 * cached at import, where a fragment would have been thrown away.
 */
import { useMemo, useState } from 'react'
import { t } from '../../../lib/i18n'
import { compileQuery, queryKeeps } from '../../../lib/query-match'
import { usePinyinVersion } from '../../../lib/pinyin'
import { spineIndexFor, stripFragment, fragmentOf } from '../engine/epub-package'
import type { EpubHandle } from './useEpubHandle'
import type { BookRecord } from '../types'
import type { BookPosition } from '../position'
import { FilterInput } from '../../../components/FilterInput'

export interface TocPanelProps {
  book: BookRecord
  handle: EpubHandle | null
  onJump: (position: BookPosition, fragment?: string) => void
}

export function TocPanel({ handle, onJump }: TocPanelProps) {
  const [query, setQuery] = useState('')
  const filter = useMemo(() => compileQuery(query), [query])
  const pinyinVersion = usePinyinVersion()
  const entries = useMemo(() => {
    if (!handle) return []
    return handle.pkg.toc
      .map((entry) => ({
        label: entry.label,
        level: entry.level,
        slot: spineIndexFor(handle.pkg, stripFragment(entry.href)),
        fragment: fragmentOf(entry.href),
      }))
      .filter((entry) => entry.slot >= 0)
      .filter((entry) => queryKeeps(filter, entry.label))
  }, [filter, handle, pinyinVersion])

  if (!handle?.pkg.toc.length) {
    return <p className="px-3 py-6 text-center text-[12px] opacity-60">{t('reading.no_contents')}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2 pb-1">
        <FilterInput
          value={query}
          onChange={setQuery}
          query={filter}
          label={t('reading.filter_contents')}
          placeholder={t('reading.filter_contents_placeholder')}
          size="panel"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] opacity-60">{t('reading.no_contents_match')}</p>
        ) : (
          <ul className="space-y-px">
            {entries.map((entry, index) => (
              <li key={`${entry.slot}-${entry.label}-${index}`}>
                <button
                  type="button"
                  onClick={() => onJump({ kind: 'epub', chapter: entry.slot, offset: 0 }, entry.fragment || undefined)}
                  className="flex w-full items-start gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12.5px] leading-snug hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)]"
                  style={{ paddingInlineStart: `${8 + Math.min(3, entry.level) * 12}px` }}
                >
                  <span className="min-w-0 flex-1">{entry.label}</span>
                  <span className="shrink-0 text-[10.5px] tabular opacity-50">{entry.slot + 1}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
