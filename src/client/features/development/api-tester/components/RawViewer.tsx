import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp } from 'lucide-react'
import { IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

/** One rendered line is exactly one 20px row, which is what makes windowing possible. */
const ROW_HEIGHT = 20
/** Rows drawn above and below the viewport so a fast wheel scroll never meets a blank strip. */
const OVERSCAN_ROWS = 16
/** Without a measurable viewport (jsdom, a hidden pane) render this many rows rather than guessing. */
const FALLBACK_ROWS = 80
/** A one-character query on a 5 MB body can match a million times; the list is bounded, the count says so. */
const MAX_MATCHES = 10_000

interface MatchRange {
  lineIndex: number
  start: number
  end: number
  index: number
}

interface FoundMatches {
  ranges: MatchRange[]
  truncated: boolean
}

export function RawViewer({ text }: { text: string }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeMatch, setActiveMatch] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const lines = useMemo(() => {
    if (!text) return [t('development.apitester.empty_body')]
    return text.replace(/\r\n/g, '\n').split('\n')
  }, [text])

  const found = useMemo<FoundMatches>(() => {
    if (!query) return { ranges: [], truncated: false }
    const needle = caseSensitive ? query : query.toLowerCase()
    const ranges: MatchRange[] = []
    let truncated = false
    for (const [lineIndex, line] of lines.entries()) {
      const haystack = caseSensitive ? line : line.toLowerCase()
      let from = 0
      while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from)
        if (start < 0) break
        if (ranges.length >= MAX_MATCHES) {
          truncated = true
          break
        }
        ranges.push({ lineIndex, start, end: start + needle.length, index: ranges.length })
        from = start + Math.max(needle.length, 1)
      }
      if (truncated) break
    }
    return { ranges, truncated }
  }, [caseSensitive, lines, query])

  const matches = found.ranges

  useEffect(() => {
    setActiveMatch(0)
  }, [query, caseSensitive])

  useEffect(() => {
    setActiveMatch(0)
    setScrollTop(0)
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
  }, [text])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => setViewportHeight(scroller.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const target = matches[activeMatch]
    const scroller = scrollerRef.current
    if (!target || !scroller) return
    const top = target.lineIndex * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top >= scroller.scrollTop && bottom <= scroller.scrollTop + scroller.clientHeight) return
    scroller.scrollTop = Math.max(0, top - Math.floor(scroller.clientHeight / 3))
    setScrollTop(scroller.scrollTop)
  }, [activeMatch, matches])

  const matchesByLine = useMemo(() => {
    const grouped = new Map<number, MatchRange[]>()
    for (const match of matches) {
      const line = grouped.get(match.lineIndex) ?? []
      line.push(match)
      grouped.set(match.lineIndex, line)
    }
    return grouped
  }, [matches])

  const lineParts = (lineIndex: number): Array<{ text: string; match: MatchRange | null }> => {
    const line = lines[lineIndex] ?? ''
    if (!query) return [{ text: line || '\u00a0', match: null }]
    const lineMatches = matchesByLine.get(lineIndex)
    if (!lineMatches?.length) return [{ text: line || '\u00a0', match: null }]
    const parts: Array<{ text: string; match: MatchRange | null }> = []
    let cursor = 0
    for (const match of lineMatches) {
      if (match.start > cursor) parts.push({ text: line.slice(cursor, match.start), match: null })
      parts.push({ text: line.slice(match.start, match.end), match })
      cursor = match.end
    }
    if (cursor < line.length) parts.push({ text: line.slice(cursor), match: null })
    return parts
  }

  const matchInfo = query
    ? matches.length > 0
      ? `${activeMatch + 1}/${matches.length}${found.truncated ? '+' : ''}`
      : t('development.apitester.no_match_found')
    : ''

  const visibleRows = viewportHeight > 0 ? Math.ceil(viewportHeight / ROW_HEIGHT) : FALLBACK_ROWS
  // `scrollTop` stays authoritative even when no height can be measured: that is how a jump to a
  // match still renders its row in jsdom, where every element reports a zero-height viewport.
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS)
  const lastRow = Math.min(lines.length, firstRow + visibleRows + OVERSCAN_ROWS * 2)
  const jump = (direction: 1 | -1) => {
    if (matches.length === 0) return
    setActiveMatch((current) => (current + direction + matches.length) % matches.length)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="api-tester-raw-viewer">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('development.apitester.search_response')}
          aria-label={t('development.apitester.search_response')}
          className="h-7 min-w-0 flex-1 font-mono text-[length:var(--text-11-5)]"
        />
        <IconButton
          label={t('development.apitester.case_sensitive')}
          size="xs"
          active={caseSensitive}
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((current) => !current)}
        >
          <CaseSensitive size={13} />
        </IconButton>
        <IconButton
          label={t('development.apitester.prev_match')}
          size="xs"
          disabled={matches.length === 0}
          onClick={() => jump(-1)}
        >
          <ChevronUp size={13} />
        </IconButton>
        <IconButton
          label={t('development.apitester.next_match')}
          size="xs"
          disabled={matches.length === 0}
          onClick={() => jump(1)}
        >
          <ChevronDown size={13} />
        </IconButton>
        {matchInfo && (
          <span className="shrink-0 px-1 font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]">
            {matchInfo}
          </span>
        )}
      </div>
      <div
        ref={scrollerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-[length:var(--text-12)]"
        data-line-count={lines.length}
      >
        <div className="relative" style={{ height: lines.length * ROW_HEIGHT }}>
          <div className="absolute top-0 left-0 w-max min-w-full" style={{ transform: `translateY(${firstRow * ROW_HEIGHT}px)` }}>
            {lines.slice(firstRow, lastRow).map((_, offset) => {
              const index = firstRow + offset
              return (
                <div key={index} className="flex h-5 w-max min-w-full leading-5">
                  <span
                    aria-hidden="true"
                    className="sticky left-0 z-10 w-12 shrink-0 select-none border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] pr-2 text-right tabular-nums text-[var(--text-quaternary)]"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 px-2 whitespace-pre">
                    {lineParts(index).map((part, partIndex) =>
                      part.match ? (
                        <mark
                          key={partIndex}
                          data-match-index={part.match.index}
                          data-active={part.match.index === activeMatch || undefined}
                          className={
                            part.match.index === activeMatch
                              ? 'rounded-[var(--r-xs)] bg-[var(--warning)] px-0.5 text-[var(--text-inverse)]'
                              : 'rounded-[var(--r-xs)] bg-[var(--warning-soft)] px-0.5 text-[var(--text-primary)]'
                          }
                        >
                          {part.text}
                        </mark>
                      ) : (
                        <span key={partIndex}>{part.text}</span>
                      ),
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
