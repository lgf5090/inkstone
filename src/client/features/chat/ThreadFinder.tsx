/**
 * The find box over an open thread.
 *
 * It marks the rendered transcript rather than searching the stored rows, so what it highlights is
 * exactly what the reader is looking at — including the code block they are hunting for. The panel owns
 * its marks: they are made when the query or the thread changes and taken out when it closes, and
 * nothing about the search is written to a store.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Input } from '../../components/form'
import { IconButton } from '../../components/primitives'
import { clearFindMarks, focusFindHit, markFindHits } from './thread-find'

export function ThreadFinder({ scroller, revision, onClose }: {
  /** The scrolling element the thread lives in. */
  scroller: RefObject<HTMLElement | null>
  /** Bumped by the thread when its content changes, so the marks are remade over the new answer. */
  revision: number
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  const marks = useRef<HTMLElement[]>([])
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const found = markFindHits(root, query)
    marks.current = found
    setCount(found.length)
    setIndex(0)
    focusFindHit(found, 0, root)
  }, [query, revision, scroller])

  // Closing takes the marks out. Every render of the thread that replaces the markup would drop them
  // anyway, but a reader who searched and closed would otherwise be left reading a highlighted page.
  useEffect(() => () => {
    const root = scroller.current
    if (root) clearFindMarks(root)
  }, [scroller])

  const step = (delta: 1 | -1) => {
    const total = marks.current.length
    if (!total) return
    const next = (index + delta + total) % total
    setIndex(next)
    focusFindHit(marks.current, next, scroller.current)
  }

  return (
    <div
      role="search"
      aria-label={t('assistant.chat.find')}
      className="absolute right-3 top-2 z-[var(--z-float)] flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]"
    >
      <Input
        ref={field}
        aria-label={t('assistant.chat.find')}
        placeholder={t('assistant.chat.find')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        className="w-40"
      />
      <span aria-live="polite" className="shrink-0 px-1 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
        {count ? `${index + 1}/${count}` : query ? t('assistant.chat.find_none') : ''}
      </span>
      <IconButton size="xs" label={t('assistant.chat.find_previous')} disabled={!count} onClick={() => step(-1)}>
        <ChevronUp size={13} />
      </IconButton>
      <IconButton size="xs" label={t('assistant.chat.find_next')} disabled={!count} onClick={() => step(1)}>
        <ChevronDown size={13} />
      </IconButton>
      <IconButton size="xs" label={t('common.close')} onClick={onClose}>
        <X size={13} />
      </IconButton>
    </div>
  )
}
