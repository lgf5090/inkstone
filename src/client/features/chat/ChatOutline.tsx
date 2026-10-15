/**
 * Where the reader is in a conversation, and how to get back to any of it.
 *
 * A thread has no headings to navigate by — its structure is the reader's own turns — so the outline is
 * built from those. The rail is a tick per turn with the one being read marked, and the panel names them
 * so a jump can be chosen by what was asked rather than by how far down a scrollbar it sits. The label is
 * the same `titleFromMessage` the conversation list uses on its first turn, so a thread's name in the
 * sidebar and its first row here are one phrase rather than two truncations of it.
 *
 * The rows the panel lists are read out of the DOM rather than handed over as offsets: the thread is a
 * flex column whose heights change as answers stream in, and a measured rectangle is the only thing that
 * stays true through that. Each turn's row carries `data-chat-anchor`, which is the id the runner stored
 * it under, so the jump lands on the row the server knows by the same name.
 */
import { useEffect, useState } from 'react'
import { ListTree } from 'lucide-react'
import { titleFromMessage } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { preferredScrollBehavior } from '../../lib/motion'

/** One turn the reader wrote, as the panel names it. */
export interface ChatAnchor { id: string, text: string }

/**
 * How many turns a thread needs before a rail earns its place.
 *
 * One tick is a scrollbar with a single stop and nothing to choose between, so a thread that holds a
 * single turn draws nothing: the outline appears with the second, which is the first pair a jump can
 * save the reader from scrolling between — and the first thread whose rail a reader may look for.
 */
const MIN_ANCHORS = 2

/**
 * How far below the top of the thread a turn counts as the one being read.
 *
 * A turn whose own top has passed this line has gone behind the reader, and the last such turn is the one
 * the thread is showing — matching the row to the line exactly would flicker between two turns while a
 * streamed answer changes the height above them.
 */
const READING_LINE = 24

export function ChatOutline({ anchors, scrollerRef }: {
  anchors: ChatAnchor[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  // Two kinds of showing, because a pointer rests on something and a press does not: hovering the rail
  // peeks at the panel, and pressing its button keeps it there after the pointer has gone. One flag could
  // not tell them apart, so a press over a hovered rail read as "close" and the button did nothing.
  const [peek, setPeek] = useState(false)
  const [pinned, setPinned] = useState(false)
  const shown = peek || pinned

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => {
      const line = scroller.getBoundingClientRect().top + READING_LINE
      let current: string | null = null
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-chat-anchor]')) {
        if (row.getBoundingClientRect().top <= line) current = row.dataset.chatAnchor ?? current
      }
      // Nothing has passed the line yet — the thread is above its own first turn — so the rail marks the
      // turn that is about to be read rather than nothing at all.
      setActiveId(current ?? anchors[0]?.id ?? null)
    }
    measure()
    // A scroll, a resize and a landed answer all move the line without touching this component.
    scroller.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      scroller.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [anchors, scrollerRef])

  if (anchors.length < MIN_ANCHORS) return null

  const label = (anchor: ChatAnchor) => titleFromMessage(anchor.text) || t('assistant.chat.outline_attachments')

  const jumpTo = (id: string) => {
    const scroller = scrollerRef.current
    const row = scroller?.querySelector<HTMLElement>(`[data-chat-anchor="${CSS.escape(id)}"]`)
    if (!scroller || !row) return
    // Measured against the scroller rather than `scrollIntoView`, which would also move every scrollable
    // ancestor — the notebook behind the assistant is not the reader's destination.
    const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - READING_LINE
    scroller.scrollTo({ top: Math.max(0, top), behavior: preferredScrollBehavior() })
  }

  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-[var(--z-pop)] hidden items-center justify-end lg:flex">
      <div
        className="pointer-events-auto flex max-h-full items-center gap-2 pr-1.5"
        onMouseEnter={() => setPeek(true)}
        onMouseLeave={() => setPeek(false)}
        onFocusCapture={() => setPeek(true)}
        // Focus moving inside the cluster — from the toggle to one of the rows — must not read as leaving
        // it, so the check is against the element the focus went to rather than against the event.
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPeek(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !shown) return
          // Escape closes the panel the reader opened, not the surface behind it, and closes it even while
          // the pointer is still on the rail — the key is taken here and nowhere else.
          event.stopPropagation()
          setPeek(false)
          setPinned(false)
        }}
      >
        {shown && (
          <nav
            aria-label={t('assistant.chat.outline')}
            className="max-h-[70vh] w-64 overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-pop)]"
          >
            {anchors.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                aria-current={anchor.id === activeId ? 'true' : undefined}
                onClick={() => jumpTo(anchor.id)}
                className={cn(
                  'block w-full truncate rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12)] transition-colors duration-[var(--dur-fast)]',
                  anchor.id === activeId
                    ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {label(anchor)}
              </button>
            ))}
          </nav>
        )}
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            aria-label={t('assistant.chat.outline')}
            aria-expanded={shown}
            onClick={() => setPinned((kept) => !kept)}
            className={cn(
              'flex size-6 items-center justify-center rounded-[var(--r-md)] transition-colors duration-[var(--dur-fast)]',
              shown
                ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <ListTree size={13} />
          </button>
          {/* The ticks are the rail's picture of the thread, not controls: the panel above is where a jump
              is chosen, so the same turn is not offered twice to a reader walking the keys. */}
          <div aria-hidden="true" className="flex flex-col items-end gap-[5px]">
            {anchors.map((anchor) => (
              <span
                key={anchor.id}
                className={cn(
                  'block rounded-full transition-[width,background-color] duration-[var(--dur-fast)]',
                  anchor.id === activeId
                    ? 'h-[3px] w-5 bg-[var(--accent)]'
                    : 'h-[2px] w-3 bg-[var(--border-strong)]',
                )}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
