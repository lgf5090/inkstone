import { useCallback, useEffect } from 'react'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { parseWikiTarget } from '../../lib/markdown/renderer'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { findTagPage } from '../tags/tagMutations'
import { useSession } from '../../store/session'
import { usePinnedWindows } from '../../store/pinned-windows'
import { withPinnedWindowSize } from '../../lib/pinned-window-size'
import { useLinkHover } from './link-hover'
import type { WikiLinkHoverCardState } from '../../types/hover-card'

export function resolveHoverCandidate(link: HTMLElement, sourceNoteId: string | null): WikiLinkHoverCardState | null {
  // A hashtag only previews anything when the user gave that tag a page; the alternative is a
  // card that duplicates the note the reader is already looking at.
  if (link.dataset.tag !== undefined && link.dataset.wikilink === undefined) {
    const page = findTagPage(decodeDataValue(link.dataset.tag))
    if (!page) return null
    return { anchor: link, title: page.title, noteId: page.id, missing: false, headline: page.title }
  }
  const parsed = parseWikiTarget(decodeDataValue(link.dataset.wikilink))
  const notes = useNotes.getState().notes
  if (parsed.noteTitle) {
    const note = findNoteByTitle(parsed.noteTitle)
    if (note)
      return { anchor: link, title: parsed.alias ?? note.title, noteId: note.id, missing: false, headline: parsed.heading ?? note.title }
    return { anchor: link, title: parsed.alias ?? parsed.noteTitle, noteId: null, missing: true, headline: parsed.heading ?? parsed.noteTitle }
  }
  const summary = sourceNoteId ? notes[sourceNoteId] : undefined
  if (!summary) return null
  return { anchor: link, title: parsed.alias ?? summary.title, noteId: sourceNoteId, missing: false, headline: parsed.heading ?? summary.title }
}

export function useLinkHoverHost(sourceNoteId: string | null) {
  const preview = useSession((s) => s.settings.preview)
  const resolve = useCallback((link: HTMLElement) => resolveHoverCandidate(link, sourceNoteId), [sourceNoteId])
  const hover = useLinkHover({
    resolve,
    delay: preview.linkHoverDelayMs,
    enabled: preview.linkHover,
    armOnNonLink: true,
  })
  const handlePin = useCallback((card: WikiLinkHoverCardState, rect: DOMRect) => {
    usePinnedWindows.getState().pin(card, withPinnedWindowSize(rect))
    hover.hideNow()
  }, [hover.hideNow])

  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target as Element | null
      if (target && typeof target.closest === 'function' && target.closest('[role="tooltip"]')) return
      hover.hideNow()
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover.hideNow])

  const onMouseLeave = useCallback(() => hover.handleMouseLeave(), [hover.handleMouseLeave])

  const onFocus = useCallback((event: React.FocusEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-wikilink], [data-tag]")
    if (!link) return
    hover.propose(link, { immediate: true })
  }, [hover.propose])

  const onBlur = useCallback((event: React.FocusEvent) => {
    const related = event.relatedTarget as Element | null
    if (related && typeof related.closest === 'function' && related.closest('[role="tooltip"]')) {
      hover.clearPendingHide()
      return
    }
    hover.armHide(0)
  }, [hover.clearPendingHide, hover.armHide])

  return { hover, handlePin, onMouseLeave, onFocus, onBlur }
}
