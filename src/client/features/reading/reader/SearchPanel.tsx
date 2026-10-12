/**
 * Searching inside the book.
 *
 * A search that moves the reader away from where they were is a search that costs them their place, so
 * the panel remembers it and offers it back. Enter walks the results and Shift+Enter walks them
 * backwards — the same keys the browser's own find bar uses, which is the only reason to learn them.
 *
 * The panel is told how to search rather than how to read: a flowing book answers with a chapter and an
 * offset, a fixed one with a page, and both arrive as the same hit shape.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { t } from '../../../lib/i18n'
import type { BookPosition } from '../position'

/** A hit in either coordinate space: a chapter of a flowing book or a page of a fixed one. */
export interface PanelHit {
  unit: number
  offset: number
  before: string
  match: string
  after: string
}

export interface SearchPanelProps {
  search: ((query: string) => Promise<PanelHit[]>) | null
  start: BookPosition | null
  onJump: (position: BookPosition) => void
  unitLabel: (unit: number) => string
  /** Which kind of position a jump has to ask for. */
  fixedMode: boolean
}

export function SearchPanel({ search, start, onJump, unitLabel, fixedMode }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PanelHit[] | null>(null)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const runRef = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const jumpTo = useCallback((hit: PanelHit) => {
    onJump(fixedMode
      ? { kind: 'fixed', page: hit.unit }
      : { kind: 'epub', chapter: hit.unit, offset: hit.offset })
  }, [fixedMode, onJump])

  const run = useCallback(async (term: string) => {
    const token = ++runRef.current
    if (!search || !term.trim()) {
      setHits(null)
      return
    }
    const found = await search(term)
    if (token !== runRef.current) return
    setHits(found)
    setIndex(0)
    if (found[0]) jumpTo(found[0])
  }, [jumpTo, search])

  useEffect(() => {
    const timer = window.setTimeout(() => void run(query), query ? 260 : 0)
    return () => window.clearTimeout(timer)
  }, [query, run])

  function step(direction: 1 | -1): void {
    if (!hits?.length) return
    const next = (index + direction + hits.length) % hits.length
    setIndex(next)
    jumpTo(hits[next]!)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 opacity-45" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            }}
            placeholder={t('reading.search_book_placeholder')}
            aria-label={t('reading.search_book')}
            className="h-8 w-full rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-raised)] ps-7 pe-12 text-[12.5px] outline-none"
          />
          <span className="absolute top-1/2 right-2 -translate-y-1/2 text-[10.5px] tabular opacity-60">
            {hits?.length ? `${index + 1}/${hits.length}` : ''}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {!search ? (
          <p className="px-3 py-6 text-center text-[12px] opacity-60">{t('reading.search_unavailable')}</p>
        ) : !query.trim() ? (
          <p className="px-3 py-6 text-center text-[12px] opacity-60">{t('reading.search_hint')}</p>
        ) : hits?.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] opacity-60">{t('reading.no_results')}</p>
        ) : (
          <ul className="space-y-px">
            {(hits ?? []).slice(0, 200).map((hit, at) => (
              <li key={`${hit.unit}-${hit.offset}`}>
                <button
                  type="button"
                  onClick={() => {
                    setIndex(at)
                    jumpTo(hit)
                  }}
                  className={`w-full rounded-[var(--r-sm)] px-2 py-1.5 text-start text-[12px] leading-snug ${at === index ? 'bg-[var(--accent-softer)]' : 'hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]'}`}
                >
                  <span className="block truncate opacity-75">
                    {hit.before}
                    <mark className="bg-transparent font-semibold text-[var(--accent)]">{hit.match}</mark>
                    {hit.after}
                  </span>
                  <span className="block text-[10.5px] tabular opacity-45">{unitLabel(hit.unit)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {start ? (
        <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
          <button
            type="button"
            onClick={() => onJump(start)}
            className="h-8 w-full rounded-[var(--r-sm)] border border-[var(--border-default)] text-[12px]"
          >
            {t('reading.back_to_reading_position')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
