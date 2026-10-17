/**
 * The bar that says which branch of a thread you are reading.
 *
 * A fork copies its turns, so the branch and its parent are two conversations that happen to share a
 * beginning — and after the fork nothing on screen said so. This is the map: the thread it came from, and
 * the other threads forked off the same point, each one a press away. It draws nothing at all for a
 * conversation that is its own root with no forks, because a bar that says "no branches" is a bar the
 * reader has to read to learn there is nothing there.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, GitBranch } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { IconButton } from '../../components/primitives'
import { openConversationInChat } from './start-chat'

interface Branches {
  parent: { id: string, title: string } | null
  siblings: Array<{ id: string, title: string, updatedAt: number }>
}

/** How far one press of an edge arrow takes the row — a little under a chip, so nothing is skipped over. */
const SCROLL_STEP = 160

export function BranchBar({ conversationId }: { conversationId: string | null }) {
  const [branches, setBranches] = useState<Branches | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  // Whether the row is wider than the space it has, and which end is currently at an edge. Both are facts
  // about the measured box, so they are read from it rather than guessed from how many chips there are.
  const [overflowing, setOverflowing] = useState(false)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)

  // Read once per conversation. The tree only changes when the reader forks, and that opens the new
  // thread — which is a different id, so the next read is the one that shows the new sibling.
  useEffect(() => {
    setBranches(null)
    if (!conversationId) return
    let alive = true
    void api.assistant.conversationBranches(conversationId)
      .then((data) => {
        if (alive) setBranches(data)
      })
      .catch(() => {
        // A branch bar is a convenience, not a state the thread depends on: a failed read leaves it out
        // rather than putting an error above the conversation.
        if (alive) setBranches(null)
      })
    return () => {
      alive = false
    }
  }, [conversationId])

  const measure = useCallback(() => {
    const box = scrollerRef.current
    if (!box) return
    const scrollable = box.scrollWidth - box.clientWidth
    setOverflowing(scrollable > 1)
    setAtStart(box.scrollLeft <= 1)
    setAtEnd(box.scrollLeft >= scrollable - 1)
  }, [])

  // The chips are capped and the row is one line tall, so a thread with a few forks hides the rest behind
  // its edge with nothing to say so. Measured on the way in and whenever anything resizes it.
  useEffect(() => {
    measure()
    const box = scrollerRef.current
    if (!box) return
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(box)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, branches])

  const nudge = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  if (!conversationId || !branches) return null
  if (!branches.parent && branches.siblings.length < 2) return null

  const chip = 'max-w-[180px] truncate rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11)] transition-colors duration-[var(--dur-fast)]'
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 text-[var(--text-tertiary)]">
      <GitBranch size={12} className="shrink-0 text-[var(--text-quaternary)]" />
      {/* A named region the keyboard can stop in: a scroll box nobody can focus is unreachable, and arrow
          keys move it once it is. Each chip stays a button, so selecting a branch is never pointer-only. */}
      <div
        ref={scrollerRef}
        role="region"
        aria-label={t('assistant.branch.label')}
        tabIndex={0}
        onScroll={measure}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-[var(--r-sm)] outline-none focus-visible:shadow-[var(--shadow-ring-focus)]"
      >
        {branches.parent && (
          <button
            type="button"
            onClick={() => openConversationInChat(branches.parent!.id)}
            className={cn(chip, 'shrink-0 text-[var(--accent)] hover:bg-[var(--bg-hover)]')}
            title={t('assistant.branch.from', { title: branches.parent.title })}
          >
            {t('assistant.branch.from', { title: branches.parent.title || t('assistant.chat.untitled') })}
          </button>
        )}
        {branches.siblings.map((sibling) => {
          const current = sibling.id === conversationId
          return (
            <button
              key={sibling.id}
              type="button"
              aria-current={current ? 'true' : undefined}
              disabled={current}
              onClick={() => openConversationInChat(sibling.id)}
              className={cn(
                chip,
                current
                  ? 'shrink-0 bg-[var(--bg-inset)] text-[var(--text-primary)]'
                  : 'shrink-0 hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
              )}
              title={sibling.title || t('assistant.chat.untitled')}
            >
              {sibling.title || t('assistant.chat.untitled')}
            </button>
          )
        })}
      </div>
      {/* The edge affordances: drawn only while something is actually out of reach, and stopped at each end
          so a press never pretends to have moved the row. */}
      <IconButton
        label={t('assistant.branch.scroll_back')}
        size="xs"
        hidden={!overflowing}
        disabled={atStart}
        onClick={() => nudge(-SCROLL_STEP)}
      >
        <ChevronLeft size={12} />
      </IconButton>
      <IconButton
        label={t('assistant.branch.scroll_forward')}
        size="xs"
        hidden={!overflowing}
        disabled={atEnd}
        onClick={() => nudge(SCROLL_STEP)}
      >
        <ChevronRight size={12} />
      </IconButton>
    </div>
  )
}
