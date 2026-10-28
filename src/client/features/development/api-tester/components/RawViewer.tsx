import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp } from 'lucide-react'
import { IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'

interface MatchRange {
  lineIndex: number
  start: number
  end: number
  index: number
}

export function RawViewer({ text }: { text: string }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeMatch, setActiveMatch] = useState(0)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])

  const lines = useMemo(() => {
    if (!text) return [t('development.apitester.empty_body')]
    return text.replace(/\r\n/g, '\n').split('\n')
  }, [text])

  const matches = useMemo<MatchRange[]>(() => {
    if (!query) return []
    const needle = caseSensitive ? query : query.toLowerCase()
    const found: MatchRange[] = []
    lines.forEach((line, lineIndex) => {
      const haystack = caseSensitive ? line : line.toLowerCase()
      let from = 0
      while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from)
        if (start < 0) break
        found.push({ lineIndex, start, end: start + needle.length, index: found.length })
        from = start + Math.max(needle.length, 1)
      }
    })
    return found
  }, [caseSensitive, lines, query])

  useEffect(() => {
    setActiveMatch(0)
  }, [query, caseSensitive, text])

  useEffect(() => {
    if (matches.length === 0) {
      if (activeMatch !== 0) setActiveMatch(0)
      return
    }
    if (activeMatch >= matches.length) {
      setActiveMatch(0)
      return
    }
    const target = matches[activeMatch]
    if (!target) return
    lineRefs.current[target.lineIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeMatch, matches])

  const jump = (direction: 1 | -1) => {
    if (matches.length === 0) return
    setActiveMatch((current) => (current + direction + matches.length) % matches.length)
  }

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
      ? `${activeMatch + 1}/${matches.length}`
      : t('development.apitester.no_match_found')
    : ''

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
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-[length:var(--text-12)]">
        <div className="flex min-w-full">
          <div
            aria-hidden="true"
            className="sticky left-0 z-10 shrink-0 select-none border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-2 text-right text-[var(--text-quaternary)]"
          >
            {lines.map((_, index) => (
              <div key={index} className="leading-5">
                {index + 1}
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1 px-2 py-2">
            {lines.map((_, index) => (
              <div
                key={index}
                ref={(element) => {
                  lineRefs.current[index] = element
                }}
                className="whitespace-pre-wrap break-all leading-5"
              >
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
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
