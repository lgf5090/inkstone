/**
 * The find box over an open thread.
 *
 * It marks the rendered transcript rather than searching the stored rows, so what it highlights is
 * exactly what the reader is looking at — including the code block they are hunting for. The panel owns
 * its marks: they are made when the query or the thread changes and taken out when it closes, and nothing
 * about the search is written to a store.
 *
 * Three claims it has to keep honest. The count is spoken as a sentence, not only painted: which of the
 * hits is the current one is otherwise a colour, and a ceiling it stopped at is otherwise a total. The
 * page it searched is not the conversation, so a phrase with no hit while older or newer turns are still
 * out of the transcript is said that way, with the control that brings them in — the marks are remade
 * when the thread changes, so loading a page is the way to reach a hit that lives behind it. And the
 * keystroke the panel borrowed is handed back to whatever raised it, which is the rule every other
 * transient surface in the app follows.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { Input } from '../../components/form'
import { Button, IconButton } from '../../components/primitives'
import { clearFindMarks, focusFindHit, markFindHits } from './thread-find'

export function ThreadFinder({ scroller, revision, hasEarlier, hasLater, loadingEarlier, onLoadEarlier, onJumpLatest, onClose }: {
  /** The scrolling element the thread lives in. */
  scroller: RefObject<HTMLElement | null>
  /** Bumped by the thread when its content changes, so the marks are remade over the new answer. */
  revision: number
  /** There are older turns the transcript on screen does not hold yet. */
  hasEarlier: boolean
  /** The reader is standing partway through the thread, so the newest turns are not here either. */
  hasLater: boolean
  /** The older page is on its way, so the control that asked for it is not to be pressed twice. */
  loadingEarlier: boolean
  /** Brings the older page into the transcript. The marks are remade when it arrives. */
  onLoadEarlier: () => void
  /** Reads the thread from its newest turn, which is where the rest of the conversation is. */
  onJumpLatest: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  const [capped, setCapped] = useState(false)
  const marks = useRef<HTMLElement[]>([])
  const field = useRef<HTMLInputElement>(null)
  // Whatever had the keystroke before the panel took it, so closing can hand it back.
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    field.current?.focus()
    field.current?.select()
    // The panel is the thread's, and it leaves no trace: the marks come out and the focus goes back to
    // the control that raised it — if that control is still on the page, since switching threads takes
    // the header row with it and throwing focus at a detached node drops the reader at the document.
    return () => {
      const root = scroller.current
      if (root) clearFindMarks(root)
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    }
  }, [scroller])

  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const found = markFindHits(root, query)
    marks.current = found.marks
    setCount(found.marks.length)
    setCapped(found.truncated)
    setIndex(0)
    focusFindHit(found.marks, 0, root)
  }, [query, revision, scroller])

  // Whether the phrase was searched and not found, which is the one case the unloaded pages are worth
  // naming: a hit on this page is a hit, and the reader is reading it.
  const nothingOnThisPage = query.trim().length > 0 && count === 0
  const outOfScope = nothingOnThisPage && (hasEarlier || hasLater)
  // The sentence the live region speaks. The fraction is what the eye reads; this is what a reader who
  // cannot see the colour of the current hit is told, and a ceiling is never called a total.
  const spoken = count
    ? (capped
      ? t('assistant.chat.find_capped', { count })
      : t('assistant.chat.find_position', { index: index + 1, count }))
    : (outOfScope ? t('assistant.chat.find_unloaded') : nothingOnThisPage ? t('assistant.chat.find_none') : '')
  const shown = count ? `${index + 1}/${count}${capped ? '+' : ''}` : ''

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
      className="absolute right-3 top-2 z-[var(--z-float)] flex max-w-full flex-col items-stretch gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]"
    >
      {/* Wraps rather than overflows: on a phone the sentence below the box is wider than the thread, and
          an absolutely positioned panel that only knows its right edge would be pushed off the screen. */}
      <div className="flex flex-wrap items-center gap-1">
        <Input
          ref={field}
          aria-label={t('assistant.chat.find')}
          placeholder={t('assistant.chat.find')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // A composition owns Enter and Escape first: the keys pick or drop a candidate, and stepping to
            // the next hit while the reader is still typing a search term would move the page under them.
            if (isImeComposing(event)) return
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
        {/* One polite region for the panel, so a step says one thing. The fraction is marked presentational
            and the sentence carries it, or a reader hears `1 slash 3` and the sentence as well. */}
        <span aria-live="polite" className="min-w-0 px-1 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
          {shown && <span aria-hidden="true">{shown}</span>}
          <span className={shown ? 'sr-only' : undefined}>{spoken}</span>
        </span>
        <div className="flex items-center gap-1">
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
      </div>
      {/* The transcript on screen is a page, not the conversation, and the reader cannot tell which one
          they searched. This says so and hands over the same two controls the top and the bottom of the
          thread do — the store's own, so nothing here decides what a page costs. */}
      {outOfScope && (
        <div className="flex items-center justify-end gap-1">
          {hasEarlier && (
            // `loading` rather than a disabled button with nothing said: the label stays the accessible
            // name, and the reader who pressed it hears that the page is on its way instead of finding a
            // control that stopped answering.
            <Button size="sm" variant="ghost" loading={loadingEarlier} onClick={onLoadEarlier}>
              {t('assistant.chat.load_earlier')}
            </Button>
          )}
          {hasLater && (
            <Button size="sm" variant="ghost" onClick={onJumpLatest}>
              {t('assistant.chat.jump_latest')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
